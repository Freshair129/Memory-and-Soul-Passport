// domain/vault-registry: lazy, idempotent Shared / Workspace-Private /
// Global-Private vault provisioning and mount tracking (WP-13 Phase 2,
// Bounded Scope item 1). Depends only on db/ (an already-open connection
// passed in by the composition root) and other domain/ modules
// (domain/ids.mjs, domain/errors.mjs) -- never contracts/ or transport/,
// per ADR-027's layering rule.
//
// Legacy vaults retain their stable ids for compatibility. Principal vaults
// use mintVaultId() below so owner tuples never influence the opaque id.
// (RKOI round-1 WARNING 7 correction: an earlier revision of this comment
// additionally claimed domain/ids.mjs's stableId joins with a plain space
// while its header comment claims NUL-joining -- that claim was itself
// wrong; stableId's `parts.join("\0")` always has NUL-joined, matching its
// own header comment, both before and after the literal-NUL-byte-to-escape
// fix WARNING 7 made to that file's source bytes. domain/entity-store.mjs's
// OWN computeEntityId is the one real space-joined derivation in this
// codebase, a separate function with its own, genuinely different,
// intentionally-unchanged convention -- see that file's own corrected
// comment.) This module reuses the *mechanism* (stableId/mintRef) exactly
// as instructed.
import { MspRuntimeError, VaultProvisionConflictError } from "./errors.mjs";
import { mintRef, mintVaultId, stableId } from "./ids.mjs";

export const PROVISION_ID_MINT_RETRY_LIMIT = 5;

function rowToVault(row) {
  if (!row) return null;
  return {
    vault_id: row.vault_id,
    vault_ref: mintRef("vault", row.vault_id),
    vault_type: row.vault_type,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    tenant_id: row.tenant_id ?? null,
    principal_id: row.principal_id ?? null,
    role: row.role ?? null,
    status: row.status,
    decay_policy: row.decay_policy,
    created_at: row.created_at,
  };
}

function rowToMount(row) {
  if (!row) return null;
  return {
    mount_id: row.mount_id,
    mount_ref: mintRef("vault-mount", row.mount_id),
    vault_id: row.vault_id,
    vault_ref: mintRef("vault", row.vault_id),
    workspace_id: row.workspace_id,
    mount_alias: row.mount_alias,
    access_mode: row.access_mode,
    status: row.status,
    mounted_at: row.mounted_at,
  };
}

export class VaultRegistry {
  #db;
  #selectShared;
  #selectWorkspacePrivate;
  #selectGlobalPrivate;
  #selectById;
  #insertVault;
  #insertPrincipalVault;
  #backfillProjectId;
  #selectMount;
  #selectAnyMount;
  #insertMount;
  #selectActivePrincipalPrivateVault;
  #selectActivePrincipalPassportVault;

  constructor(db) {
    this.#db = db;
    this.#selectShared = db.prepare("SELECT * FROM vaults WHERE vault_type = 'shared' AND project_id = ?");
    this.#selectWorkspacePrivate = db.prepare("SELECT * FROM vaults WHERE vault_type = 'workspace_private' AND workspace_id = ?");
    this.#selectGlobalPrivate = db.prepare("SELECT * FROM vaults WHERE vault_type = 'global_private' AND agent_id = ?");
    this.#selectById = db.prepare("SELECT * FROM vaults WHERE vault_id = ?");
    this.#insertVault = db.prepare(`
      INSERT INTO vaults (vault_id, vault_type, project_id, workspace_id, agent_id, role, status, created_at)
      VALUES (@vault_id, @vault_type, @project_id, @workspace_id, @agent_id, @role, 'active', @created_at)
    `);
    // PH-MEMOS-5 (design §5.2, §12.4): a NEW prepared statement, not a
    // reuse of #insertVault above -- #insertVault's fixed column list
    // omits decay_policy/tenant_id/principal_id entirely,
    // so routing a principal_passport row through it would insert with no
    // decay_policy value, falling to the column's own
    // DEFAULT 'ebbinghaus', which then fails 0011's own
    // decay_policy = 'pinned' CHECK for that type.
    this.#insertPrincipalVault = db.prepare(`
      INSERT INTO vaults (vault_id, vault_type, tenant_id, principal_id, agent_id, workspace_id, decay_policy, status, created_at)
      VALUES (@vault_id, @vault_type, @tenant_id, @principal_id, @agent_id, @workspace_id, @decay_policy, @status, @created_at)
    `);
    this.#backfillProjectId = db.prepare(
      "UPDATE vaults SET project_id = @project_id WHERE vault_id = @vault_id AND project_id IS NULL",
    );
    this.#selectMount = db.prepare("SELECT * FROM vault_mounts WHERE vault_id = ? AND workspace_id = ? AND mount_alias = ?");
    this.#selectAnyMount = db.prepare(
      "SELECT 1 FROM vault_mounts WHERE vault_id = ? AND workspace_id = ? AND status = 'mounted' LIMIT 1",
    );
    this.#insertMount = db.prepare(`
      INSERT INTO vault_mounts (mount_id, vault_id, workspace_id, mount_alias, access_mode, status, mounted_at)
      VALUES (@mount_id, @vault_id, @workspace_id, @mount_alias, @access_mode, 'mounted', @mounted_at)
    `);
    // RKOI round-1 WARNING 8: prepared once, like every other statement in
    // this class -- hasActivePrincipalPrivateVault/PassportVault used to
    // call db.prepare(...) inline on every invocation instead.
    this.#selectActivePrincipalPrivateVault = db.prepare(
      "SELECT 1 FROM vaults WHERE vault_type = 'principal_private' AND tenant_id = ? AND principal_id = ? AND agent_id = ? AND workspace_id = ? AND status = 'active'",
    );
    this.#selectActivePrincipalPassportVault = db.prepare(
      "SELECT 1 FROM vaults WHERE vault_type = 'principal_passport' AND tenant_id = ? AND principal_id = ? AND status = 'active'",
    );
  }

  /**
   * Lazy, idempotent by project_id. Per WP-13 Bounded Scope item 1, a shared
   * vault is provisioned for identity completeness only -- it is never a
   * write target for promotion (msp_memory_promote/msp_knowledge_promote
   * always deny shared-scope writes; see transport/handlers/lifecycle-handlers.mjs).
   */
  provisionSharedVault(projectId) {
    if (!projectId) throw new TypeError("provisionSharedVault requires projectId.");
    const run = this.#db.transaction(() => {
      const existing = this.#selectShared.get(projectId);
      if (existing) return rowToVault(existing);
      const vaultId = stableId("vault", "shared", projectId);
      this.#insertVault.run({
        vault_id: vaultId,
        vault_type: "shared",
        project_id: projectId,
        workspace_id: null,
        agent_id: null,
        // WP-14: `role` is an agent-role/tiering concept (ADR-020, "memory
        // is keyed by role / named-agent"). A Shared vault has no single
        // owning agent, so it has no natural role value -- left null rather
        // than inventing one.
        role: null,
        created_at: new Date().toISOString(),
      });
      return rowToVault(this.#selectById.get(vaultId));
    });
    return run();
  }

  /**
   * Lazy, idempotent by workspace_id. If the vault already exists without a
   * known project_id and one is supplied now, backfills it (registration
   * can happen after an earlier vault-status-only reference).
   */
  provisionWorkspacePrivateVault(workspaceId, { projectId = null } = {}) {
    if (!workspaceId) throw new TypeError("provisionWorkspacePrivateVault requires workspaceId.");
    const run = this.#db.transaction(() => {
      const existing = this.#selectWorkspacePrivate.get(workspaceId);
      if (existing) {
        if (projectId && !existing.project_id) {
          this.#backfillProjectId.run({ vault_id: existing.vault_id, project_id: projectId });
          return rowToVault(this.#selectById.get(existing.vault_id));
        }
        return rowToVault(existing);
      }
      const vaultId = stableId("vault", "workspace-private", workspaceId);
      this.#insertVault.run({
        vault_id: vaultId,
        vault_type: "workspace_private",
        project_id: projectId,
        workspace_id: workspaceId,
        agent_id: null,
        // Same reasoning as provisionSharedVault: a Workspace-Private vault
        // is not agent-role scoped, so `role` is left null.
        role: null,
        created_at: new Date().toISOString(),
      });
      return rowToVault(this.#selectById.get(vaultId));
    });
    return run();
  }

  /**
   * Lazy, idempotent by agent_id.
   *
   * WP-14 `role`: per ADR-020 ("memory is keyed by role / named-agent, not
   * per ephemeral instance"), a Global-Private vault is the one vault_type
   * that genuinely has a role concept -- it belongs to exactly one agent
   * identity. If an explicit `role` is supplied (e.g. a role-aggregate
   * identifier distinct from the raw agent_id), it is recorded as-is; if
   * omitted, this falls back to agentId itself (an honest default: the
   * agent's own identity acts as its own role when no separate role
   * aggregate is known) rather than leaving it unset. Callers cannot
   * supply role today (no msp_* request in this packet's Explicit
   * Exclusions carries one on the wire) -- this parameter exists so
   * domain-level callers and future work packets have it, verified directly
   * by test/vaults-role-column.test.mjs (AC-05).
   */
  provisionGlobalPrivateVault(agentId, { role = null } = {}) {
    if (!agentId) throw new TypeError("provisionGlobalPrivateVault requires agentId.");
    const run = this.#db.transaction(() => {
      const existing = this.#selectGlobalPrivate.get(agentId);
      if (existing) return rowToVault(existing);
      const vaultId = stableId("vault", "global-private", agentId);
      this.#insertVault.run({
        vault_id: vaultId,
        vault_type: "global_private",
        project_id: null,
        workspace_id: null,
        agent_id: agentId,
        role: role ?? agentId,
        created_at: new Date().toISOString(),
      });
      return rowToVault(this.#selectById.get(vaultId));
    });
    return run();
  }

  /**
   * Status for a workspace_id/agent_id pair: lazily provisions and returns
   * whichever vaults are known for this caller. msp_vault_status carries no
   * project_id, so the shared vault is only surfaced when the workspace's
   * own project_id is already known (e.g. from an earlier
   * msp_workspace_register call) -- it is never speculatively provisioned
   * from a status-only call.
   */
  getVaultStatus({ workspaceId = null, agentId = null } = {}) {
    const vaults = [];
    if (workspaceId) {
      const workspaceVault = this.provisionWorkspacePrivateVault(workspaceId);
      vaults.push(workspaceVault);
      if (workspaceVault.project_id) {
        vaults.push(this.provisionSharedVault(workspaceVault.project_id));
      }
    }
    if (agentId) {
      vaults.push(this.provisionGlobalPrivateVault(agentId));
    }
    return { vaults };
  }

  getVaultById(vaultId) {
    return rowToVault(this.#selectById.get(vaultId));
  }

  /**
   * PH-MEMOS-5 (design §5.2), lazy/idempotent, keyed on all four owner
   * fields: two agents serving the same person get two DISTINCT episodic
   * vaults (design §5.5 rule 1), falling directly out of this key, not a
   * separate enforcement path.
   */
  provisionPrincipalPrivateVault({ tenantId, principalId, agentId, workspaceId }) {
    if (!tenantId) throw new TypeError("provisionPrincipalPrivateVault requires tenantId.");
    if (!principalId) throw new TypeError("provisionPrincipalPrivateVault requires principalId.");
    if (!agentId) throw new TypeError("provisionPrincipalPrivateVault requires agentId.");
    if (!workspaceId) throw new TypeError("provisionPrincipalPrivateVault requires workspaceId.");
    return this.#provisionPrincipalVault({
      vaultType: "principal_private",
      activeWhere:
        "vault_type = 'principal_private' AND tenant_id = ? AND principal_id = ? AND agent_id = ? AND workspace_id = ? AND status = 'active'",
      activeParams: [tenantId, principalId, agentId, workspaceId],
      row: {
        vault_type: "principal_private",
        tenant_id: tenantId,
        principal_id: principalId,
        agent_id: agentId,
        workspace_id: workspaceId,
        decay_policy: "ebbinghaus",
      },
    });
  }

  /**
   * PH-MEMOS-5 (design §5.2), lazy/idempotent, keyed on tenantId +
   * principalId only -- agent_id/workspace_id are always null for this
   * type (design §5, §12.4).
   */
  provisionPrincipalPassportVault({ tenantId, principalId }) {
    if (!tenantId) throw new TypeError("provisionPrincipalPassportVault requires tenantId.");
    if (!principalId) throw new TypeError("provisionPrincipalPassportVault requires principalId.");
    return this.#provisionPrincipalVault({
      vaultType: "principal_passport",
      activeWhere: "vault_type = 'principal_passport' AND tenant_id = ? AND principal_id = ? AND status = 'active'",
      activeParams: [tenantId, principalId],
      row: {
        vault_type: "principal_passport",
        tenant_id: tenantId,
        principal_id: principalId,
        agent_id: null,
        workspace_id: null,
        decay_policy: "pinned",
      },
    });
  }

  /**
   * PH-MEMOS-5 (design §5.3): a plain existence read, never a mutation --
   * lets msp_vault_resolve's own handler tell "this call newly provisioned
   * a vault" apart from "this call found an already-active one" for its
   * journal receipt's provisioned_episodic/provisioned_passport booleans,
   * without changing provisionPrincipalPrivateVault/PassportVault's own
   * RKOI-approved return shape (a plain vault row, matching every other
   * provision*Vault method in this class) to smuggle that bit through.
   * Call this BEFORE provisionPrincipalPrivateVault/PassportVault, inside
   * the SAME outer transaction, so the check-then-provision sequence is
   * consistent (no race between the read and the provision, since both run
   * on the same connection inside the same transaction).
   */
  hasActivePrincipalPrivateVault({ tenantId, principalId, agentId, workspaceId }) {
    return Boolean(this.#selectActivePrincipalPrivateVault.get(tenantId, principalId, agentId, workspaceId));
  }

  hasActivePrincipalPassportVault({ tenantId, principalId }) {
    return Boolean(this.#selectActivePrincipalPassportVault.get(tenantId, principalId));
  }

  /**
   * Shared by both principal provisioners. The active-row lookup and the
   * random-id insert run in one immediate transaction, with a bounded retry
   * only for the impossible-but-testable UUID primary-key collision.
   */
  #provisionPrincipalVault({ vaultType, activeWhere, activeParams, row }) {
    const run = this.#db.transaction(() => {
      const existing = this.#db.prepare(`SELECT * FROM vaults WHERE ${activeWhere}`).get(...activeParams);
      if (existing) return rowToVault(existing);

      let vaultId = mintVaultId();
      let attempts = 0;
      for (;;) {
        try {
          this.#insertPrincipalVault.run({
            vault_id: vaultId,
            ...row,
            status: "active",
            created_at: new Date().toISOString(),
          });
          break;
        } catch (err) {
          if (err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
            if (attempts < PROVISION_ID_MINT_RETRY_LIMIT) {
              attempts += 1;
              vaultId = mintVaultId();
              continue;
            }
            throw new VaultProvisionConflictError(
              `mintVaultId() produced a colliding vault_id ${PROVISION_ID_MINT_RETRY_LIMIT + 1} times in a row; retry`,
            );
          }
          if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" || err?.code === "SQLITE_BUSY_SNAPSHOT") {
            throw new VaultProvisionConflictError();
          }
          throw err;
        }
      }
      return rowToVault(this.#db.prepare("SELECT * FROM vaults WHERE vault_id = ?").get(vaultId));
    });
    return run.immediate();
  }

  /**
   * WP-14 AC-04: the ownership/scope check backing `vault_scope_denied`
   * enforcement. Returns a plain boolean -- never throws, never itself
   * shapes an error -- so transport/handlers/*.mjs can pass the result
   * across the contracts/domain boundary as a plain argument into
   * contracts/vault-scope-guard.mjs's assertVaultScope(), keeping
   * contracts/ decoupled from this module (see that file's header comment
   * for the layering rationale).
   *
   * PH-MEMOS-5 (design §5.2): now a thin SELECT-then-delegate wrapper
   * around #isVaultRowAccessibleTo below, the single row-taking branch set
   * this method and classifyPrincipalAccess() both share -- this is
   * mountVault's sole caller and remains fully backward-compatible for
   * every existing {workspaceId, agentId}-only caller.
   */
  isVaultAccessibleTo(vaultId, ctx = {}) {
    const vault = this.#selectById.get(vaultId);
    return this.#isVaultRowAccessibleTo(vault, ctx);
  }

  /**
   * PH-MEMOS-5 (design §5.2), the single normative branch set both
   * isVaultAccessibleTo() and classifyPrincipalAccess() share -- never
   * restated a second time anywhere else in this codebase. Takes an
   * ALREADY-FETCHED row (never performs its own SELECT), so a caller that
   * already has the row in hand (classifyPrincipalAccess, called from a
   * transport handler's own requireKnownVault/getVaultById lookup) never
   * pays for a second one.
   *
   *   - vault not found: false (unchanged).
   *   - vault.status !== 'active': false, checked FIRST, before any tuple
   *     comparison, for every vault type -- an erased principal vault's
   *     still-populated tenant_id/agent_id/workspace_id columns (0011
   *     blanks only principal_id on erasure) must never read as
   *     accessible merely because they still match. This is the single
   *     place this status gate lives; requireKnownVault stays existence-
   *     only by design (API-009 §5.1) and is never asked to check status.
   *   - vault_type === 'principal_private': all four owner fields must be
   *     present AND match exactly.
   *   - vault_type === 'principal_passport': tenantId/principalId must
   *     match AND allowPassport must be exactly true.
   *   - the three legacy branches (workspace-mount short-circuit,
   *     workspace_private, global_private, shared) are unchanged from
   *     before this phase -- reordered only so the two principal branches
   *     above sit ahead of the workspace-mount short-circuit, removing
   *     (at zero behavioral cost, since 0011's vault_mounts triggers
   *     already refuse ever inserting a mount row naming a principal
   *     vault_id) principal-vault isolation's dependency on that
   *     cross-table invariant.
   */
  #isVaultRowAccessibleTo(vault, { workspaceId = null, agentId = null, tenantId = null, principalId = null, allowPassport = false } = {}) {
    if (!vault) return false;
    if (vault.status !== "active") return false;

    if (vault.vault_type === "principal_private") {
      return Boolean(tenantId && principalId && agentId && workspaceId)
        && vault.tenant_id === tenantId
        && vault.principal_id === principalId
        && vault.agent_id === agentId
        && vault.workspace_id === workspaceId;
    }
    if (vault.vault_type === "principal_passport") {
      return Boolean(tenantId && principalId && allowPassport === true)
        && vault.tenant_id === tenantId
        && vault.principal_id === principalId;
    }

    if (workspaceId && this.#selectAnyMount.get(vault.vault_id, workspaceId)) {
      return true;
    }

    if (vault.vault_type === "workspace_private") {
      return Boolean(workspaceId) && vault.workspace_id === workspaceId;
    }
    if (vault.vault_type === "global_private") {
      return Boolean(agentId) && vault.agent_id === agentId;
    }
    if (vault.vault_type === "shared") {
      if (!workspaceId) return false;
      const callerWorkspaceVault = this.#selectWorkspacePrivate.get(workspaceId);
      return Boolean(callerWorkspaceVault?.project_id) && callerWorkspaceVault.project_id === vault.project_id;
    }
    return false;
  }

  /**
   * Classify a verified vault-grant claim set against a principal vault row.
   * The transport layer collapses every non-ok result to its surface-specific
   * refusal; this domain method only compares the already-fetched row.
   */
  classifyPrincipalAccess(vault, claims) {
    if (!vault || (vault.vault_type !== "principal_private" && vault.vault_type !== "principal_passport")) {
      return null;
    }
    if (!claims || typeof claims !== "object") {
      return "access_context_denied";
    }
    const outcome = this.#isVaultRowAccessibleTo(vault, {
      tenantId: claims.tenantId ?? null,
      principalId: claims.principalId ?? null,
      agentId: claims.agentId ?? null,
      workspaceId: claims.workspaceId ?? null,
      allowPassport: claims.allowPassport === true,
    });
    return outcome ? "ok" : "access_context_denied";
  }

  /**
   * Idempotent by (vault_id, workspace_id, mount_alias). Rejects an unknown
   * vault_id (fail closed -- a mount must target a vault this registry
   * actually provisioned, never an arbitrary caller-supplied string).
   */
  mountVault({ vaultId, workspaceId, mountAlias, accessMode }) {
    if (!vaultId) throw new TypeError("mountVault requires vaultId.");
    if (!workspaceId) throw new TypeError("mountVault requires workspaceId.");
    if (!mountAlias) throw new TypeError("mountVault requires mountAlias.");
    const vault = this.getVaultById(vaultId);
    if (!vault) {
      throw new MspRuntimeError(`mountVault: unknown vault_id "${vaultId}".`, "not_found");
    }
    if (vault.vault_type === "principal_private" || vault.vault_type === "principal_passport") {
      throw new MspRuntimeError(`mountVault: unknown vault_id "${vaultId}".`, "not_found");
    }
    if (!["read", "read_write"].includes(accessMode)) {
      throw new MspRuntimeError(
        `mountVault requires accessMode "read" or "read_write", got "${accessMode}".`,
        "invalid_request",
      );
    }

    const run = this.#db.transaction(() => {
      const existing = this.#selectMount.get(vaultId, workspaceId, mountAlias);
      if (existing) return rowToMount(existing);
      const mountId = stableId("vault-mount", vaultId, workspaceId, mountAlias);
      this.#insertMount.run({
        mount_id: mountId,
        vault_id: vaultId,
        workspace_id: workspaceId,
        mount_alias: mountAlias,
        access_mode: accessMode,
        mounted_at: new Date().toISOString(),
      });
      return rowToMount(this.#selectMount.get(vaultId, workspaceId, mountAlias));
    });

    return { mount: run(), vault };
  }
}

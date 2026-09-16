// domain/vault-registry: lazy, idempotent Shared / Workspace-Private /
// Global-Private vault provisioning and mount tracking (WP-13 Phase 2,
// Bounded Scope item 1). Depends only on db/ (an already-open connection
// passed in by the composition root) and other domain/ modules
// (domain/ids.mjs, domain/errors.mjs) -- never contracts/ or transport/,
// per ADR-027's layering rule.
//
// Id minting reuses domain/ids.mjs's stableId/mintRef, following the same
// stableId(prefix, ...parts) call shape packages/govibe-core/src/vaults.mjs
// uses for its own local preview ids (e.g. stableId("vault", "shared",
// projectId)). The two implementations are not byte-identical: vaults.mjs
// joins hash parts with a NUL separator and uses a two-value vault_type
// (shared/private) plus a separate vault_level, while WP-13's schema (see
// 0002_phase2.sql) collapses type+level into a single three-value
// vault_type enum (shared/workspace_private/global_private) and
// domain/ids.mjs's stableId joins parts with a plain space -- a pre-existing
// mismatch already present in WP-12's domain/ids.mjs (its own header
// comment claims NUL-joining, its implementation does not); that is not
// this packet's file to fix. This module reuses the *mechanism*
// (stableId/mintRef) exactly as instructed; it does not claim byte-for-byte
// id parity with vaults.mjs's preview ids.
import { MspRuntimeError, VaultProvisionConflictError } from "./errors.mjs";
import { mintRef, stableId } from "./ids.mjs";

// PH-MEMOS-5 (design §5.2): a generous, fixed bound on
// #provisionPrincipalVault's epoch-probe loop -- never expected to bind
// under correct operation, since a real tuple only ever accumulates one
// generation per erasure. Deliberately internal-only, not a typed/
// client-facing error: BL-MEMOS-061's own proof requirement is a property
// test that this bound cannot be reached under any real erasure count a
// tuple can actually accumulate through shipped tools, plus a forced-
// past-the-bound unit test asserting the exact thrown message.
export const PROVISION_EPOCH_PROBE_LIMIT = 10_000;

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
    provision_epoch: row.provision_epoch,
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
  #selectByVaultId;
  #insertVault;
  #insertPrincipalVault;
  #backfillProjectId;
  #selectMount;
  #selectAnyMount;
  #insertMount;

  constructor(db) {
    this.#db = db;
    this.#selectShared = db.prepare("SELECT * FROM vaults WHERE vault_type = 'shared' AND project_id = ?");
    this.#selectWorkspacePrivate = db.prepare("SELECT * FROM vaults WHERE vault_type = 'workspace_private' AND workspace_id = ?");
    this.#selectGlobalPrivate = db.prepare("SELECT * FROM vaults WHERE vault_type = 'global_private' AND agent_id = ?");
    this.#selectById = db.prepare("SELECT * FROM vaults WHERE vault_id = ?");
    // PH-MEMOS-5 (design §5.2): the epoch-probe loop's own existence check
    // -- a plain SELECT 1, never a lookup keyed on any owner column.
    this.#selectByVaultId = db.prepare("SELECT 1 FROM vaults WHERE vault_id = ?");
    this.#insertVault = db.prepare(`
      INSERT INTO vaults (vault_id, vault_type, project_id, workspace_id, agent_id, role, status, created_at)
      VALUES (@vault_id, @vault_type, @project_id, @workspace_id, @agent_id, @role, 'active', @created_at)
    `);
    // PH-MEMOS-5 (design §5.2, §12.4): a NEW prepared statement, not a
    // reuse of #insertVault above -- #insertVault's fixed column list
    // omits decay_policy/tenant_id/principal_id/provision_epoch entirely,
    // so routing a principal_passport row through it would insert with no
    // decay_policy value, falling to the column's own
    // DEFAULT 'ebbinghaus', which then fails 0011's own
    // decay_policy = 'pinned' CHECK for that type.
    this.#insertPrincipalVault = db.prepare(`
      INSERT INTO vaults (vault_id, vault_type, tenant_id, principal_id, agent_id, workspace_id, decay_policy, status, provision_epoch, created_at)
      VALUES (@vault_id, @vault_type, @tenant_id, @principal_id, @agent_id, @workspace_id, @decay_policy, @status, @provision_epoch, @created_at)
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
      idParts: ["principal-private", tenantId, principalId, agentId, workspaceId],
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
      idParts: ["principal-passport", tenantId, principalId],
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
   * Shared by both provisionPrincipal*Vault methods above (design §5.2,
   * DEC-MEMOS-50). Run inside this.#db.transaction(...), matching the
   * "lazy, idempotent" shape every existing provision*Vault method already
   * establishes.
   *
   * No internal retry loop: a bounded RETRY loop here could only re-enter
   * a SAVEPOINT of an already-open OUTER transaction (msp_vault_resolve's
   * own, when this call is nested inside it) and would therefore read the
   * SAME snapshot taken when that outer transaction began -- structurally
   * unable to observe a commit made by a concurrent winner after that
   * snapshot. Instead: a genuine concurrent first-ever-provision race for
   * one tuple is refused at the transaction-locking layer, before either
   * racer's own INSERT ever executes (SQLite serializes writers) --
   * SQLITE_BUSY if the loser races while the winner's write transaction is
   * still open, SQLITE_BUSY_SNAPSHOT if the loser's own read snapshot
   * (from its probe SELECTs below) is already stale relative to the
   * winner's commit. Only the SQLITE_BUSY_SNAPSHOT case is caught here,
   * exactly, and re-mapped to a typed VaultProvisionConflictError -- a
   * plain SQLITE_BUSY from ordinary lock contention is NOT this specific
   * race and is not remapped, propagating as an untyped driver error,
   * mirroring domain/thread-memory.mjs's close_for_relink precedent for
   * the identical distinction. The retry that actually resolves the race
   * happens one level up, at the caller's own NEXT top-level call, which
   * opens a fresh top-level transaction and snapshot that CAN see the
   * winner's already-committed row.
   *
   * Re-provisioning after erasure: the active-row SELECT below finds
   * nothing for an erased tuple (status = 'erased' never satisfies
   * activeWhere), so the epoch-probe loop runs. It finds the erased row
   * itself at epoch 0 (its vault_id is still exactly what the tuple
   * deterministically derives) and mints a genuinely different vault_id at
   * the next unused epoch -- found by probing vault_id's own PRIMARY KEY
   * existence directly, never by a lookup keyed on any stored column, so
   * this holds regardless of MSP_IDENTITY_HMAC_KEY's state, including a
   * rotation between the original provision and the re-engagement (design
   * §5.2, DEC-MEMOS-50 round 3).
   */
  #provisionPrincipalVault({ vaultType, idParts, activeWhere, activeParams, row }) {
    const run = this.#db.transaction(() => {
      const existing = this.#db.prepare(`SELECT * FROM vaults WHERE ${activeWhere}`).get(...activeParams);
      if (existing) return rowToVault(existing);

      // No active row for this tuple -- either never provisioned, or every
      // prior generation for this tuple is erased. Mint the next
      // generation's id by probing PRIMARY KEY existence directly, epoch 0
      // upward. idParts is the raw tuple THIS CALL already received in
      // plaintext -- it is never read back from a stored row -- so this
      // needs no column that must survive erasure and no column keyed by
      // MSP_IDENTITY_HMAC_KEY: it is immune to both erasure blanking
      // principal_id and to identity-key rotation, because neither is an
      // input to this loop at all.
      let epoch = 0;
      let vaultId = stableId("vault", ...idParts, String(epoch));
      while (this.#selectByVaultId.get(vaultId)) {
        epoch += 1;
        if (epoch > PROVISION_EPOCH_PROBE_LIMIT) {
          // Unreachable under correct operation -- every real tuple has a
          // small, bounded number of prior generations (one per erasure).
          // A loud internal failure here beats a silent infinite loop or a
          // resurrected id; not a client-facing error code (design §14),
          // and deliberately so -- see PROVISION_EPOCH_PROBE_LIMIT's own
          // comment above. Message carries only vaultType, never a
          // tenant/principal/agent/workspace identifier.
          throw new Error(`provisionPrincipalVault: exceeded ${PROVISION_EPOCH_PROBE_LIMIT} generation probes for ${vaultType}`);
        }
        vaultId = stableId("vault", ...idParts, String(epoch));
      }

      try {
        this.#insertPrincipalVault.run({
          vault_id: vaultId,
          ...row,
          status: "active",
          provision_epoch: epoch,
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        // A genuine concurrent first-ever-provision race for this exact
        // tuple never reaches this catch's own constraint branch at all --
        // SQLite serializes writers, so the loser's own attempt to enter
        // this transaction's write phase is refused at the locking layer
        // before its own INSERT ever executes (see this method's own
        // header comment for the real error codes this actually raises,
        // and why this catch is not a retry).
        if (err.code === "SQLITE_BUSY_SNAPSHOT") {
          throw new VaultProvisionConflictError();
        }
        throw err; // includes plain SQLITE_BUSY -- not this race, not remapped
      }
      return rowToVault(this.#db.prepare("SELECT * FROM vaults WHERE vault_id = ?").get(vaultId));
    });
    return run();
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
   * PH-MEMOS-5 (design §5.1, §5.2, DEC-MEMOS-49): the mechanism behind
   * API-009's new access_context amendment -- nine new call sites in
   * apps/msp-server's memory-handlers.mjs, one per msp_memory_* tool, each
   * calling this method directly with the vault row it already has (never
   * a second SELECT). Returns a three-way outcome
   * contracts/vault-scope-guard.mjs's assertAccessContext() consumes:
   *   - null: vault is not a principal type -- access_context is neither
   *     required nor checked, the legacy tools' existing behavior.
   *   - 'access_context_required': vault IS a principal type and
   *     accessContext is absent entirely.
   *   - 'access_context_denied': accessContext was present but
   *     #isVaultRowAccessibleTo(vault, ...) returned false -- a tuple
   *     mismatch, an erased vault, or a principal_passport target missing
   *     allow_passport: true are all this SAME answer, deliberately (no
   *     new oracle a caller could use to distinguish them).
   *   - 'ok': accessContext matched.
   */
  classifyPrincipalAccess(vault, accessContext) {
    if (!vault || (vault.vault_type !== "principal_private" && vault.vault_type !== "principal_passport")) {
      return null;
    }
    if (accessContext === undefined || accessContext === null || typeof accessContext !== "object") {
      return "access_context_required";
    }
    const outcome = this.#isVaultRowAccessibleTo(vault, {
      tenantId: accessContext.tenant_id ?? null,
      principalId: accessContext.principal_id ?? null,
      agentId: accessContext.agent_id ?? null,
      workspaceId: accessContext.workspace_id ?? null,
      allowPassport: accessContext.allow_passport === true,
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
    if (!["read", "read_write"].includes(accessMode)) {
      throw new MspRuntimeError(
        `mountVault requires accessMode "read" or "read_write", got "${accessMode}".`,
        "invalid_request",
      );
    }
    const vault = this.getVaultById(vaultId);
    if (!vault) {
      throw new MspRuntimeError(`mountVault: unknown vault_id "${vaultId}".`, "not_found");
    }
    // PH-MEMOS-5 (design §5.2, DEC-MEMOS-39): the JS-layer half of the
    // never-mountable rule, ahead of #insertMount -- 0011's vault_mounts
    // triggers are the DB-layer half; either alone already refuses every
    // code path this design specifies, deliberate defense in depth.
    if (vault.vault_type === "principal_private" || vault.vault_type === "principal_passport") {
      throw new MspRuntimeError("mountVault: principal vaults are never mountable.", "vault_scope_denied");
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

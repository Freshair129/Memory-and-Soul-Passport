// transport/handlers/vault-handlers: msp_vault_status, msp_vault_mount,
// msp_workspace_register (WP-13 Bounded Scope item 4). Response shapes
// exactly as consumed by getVaultStatus/mountVault in
// scripts/mcp/msp-vault-context-contracts.mjs and registerWorkspace in
// packages/govibe-core/src/msp-client.mjs -- both read directly (not
// paraphrased) as this packet's ground truth.
import { workspaceRef, vaultRegistryRef } from "@freshair129/msp-contracts/refs";
import { ValidationError } from "@freshair129/msp-contracts/errors";
import { assertVaultScope } from "@freshair129/msp-contracts/vault-scope-guard";

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createVaultHandlers({ vaultRegistry, journal }) {
  return {
    // Request fields as built by registerWorkspace in msp-client.mjs:
    // schema_version, actor, workspace_id, project_id, workspace_path,
    // vault_bindings, idempotency_key, run_id, recorded_at, source_hash.
    async msp_workspace_register(args = {}) {
      const actor = requireString(args.actor, "actor");
      const workspaceId = requireString(args.workspace_id, "workspace_id");
      requireString(args.workspace_path, "workspace_path");
      const projectId = optionalString(args.project_id);

      // Lazy provisioning on first reference (WP-13 Bounded Scope item 1):
      // registering a workspace is one of the two events that provisions
      // its workspace_private vault; if a project_id is known, the
      // project's shared vault is also provisioned here for identity
      // completeness -- it is never a write target for promotion.
      vaultRegistry.provisionWorkspacePrivateVault(workspaceId, { projectId });
      if (projectId) vaultRegistry.provisionSharedVault(projectId);

      const workspace_ref = workspaceRef(workspaceId);
      const registry_ref = vaultRegistryRef(workspaceId);

      journal.append({
        actor,
        toolName: "msp_workspace_register",
        ref: workspace_ref,
        workspaceId,
        payload: {
          workspace_id: workspaceId,
          project_id: projectId,
          idempotency_key: args.idempotency_key ?? null,
          run_id: args.run_id ?? null,
        },
        policyDecision: "allow",
      });

      return { workspace_ref, registry_ref };
    },

    // Request fields as built by getVaultStatus in
    // msp-vault-context-contracts.mjs: actor, workspace_id, workspace_path,
    // agent_id.
    async msp_vault_status(args = {}) {
      const actor = requireString(args.actor, "actor");
      const workspaceId = optionalString(args.workspace_id);
      const agentId = optionalString(args.agent_id);

      const { vaults } = vaultRegistry.getVaultStatus({ workspaceId, agentId });

      const workspace_ref = workspaceId ? workspaceRef(workspaceId) : null;
      const registry_ref = workspaceId ? vaultRegistryRef(workspaceId) : null;

      journal.append({
        actor,
        toolName: "msp_vault_status",
        ref: workspace_ref,
        workspaceId,
        payload: { workspace_id: workspaceId, agent_id: agentId, vault_count: vaults.length },
        policyDecision: "allow",
      });

      return {
        workspace_ref,
        registry_ref,
        vaults: vaults.map((vault) => ({
          vault_id: vault.vault_id,
          vault_ref: vault.vault_ref,
          vault_type: vault.vault_type,
          project_id: vault.project_id,
          workspace_id: vault.workspace_id,
          agent_id: vault.agent_id,
          status: vault.status,
        })),
        policy_decision: "allow",
        diagnostics: [],
      };
    },

    // Request fields as built by mountVault in
    // msp-vault-context-contracts.mjs: actor, workspace_id, workspace_path,
    // vault_id, mount_alias, access_mode, reason.
    //
    // WP-14 AC-04: of the tools in this packet's actual delivered surface
    // (see the final report's Bounded-Scope investigation), this is the
    // ONLY one whose request carries a real, caller-supplied vault_id --
    // msp_context_resolve and msp_memory_promote derive their scope from
    // workspace_id/agent_id internally and accept no vault_id parameter
    // (Explicit Exclusion #1 forbids adding one to their wire shape). So
    // vault_scope_denied enforcement is implemented here: reject before the
    // mutating vaultRegistry.mountVault() call (which writes a vault_mounts
    // row) if the caller's workspace does not actually own vault_id, or
    // has not already legitimately mounted it. An unknown vault_id is left
    // to mountVault()'s own existing not_found path, unchanged from WP-13
    // -- it is a different condition from "known vault I don't own".
    async msp_vault_mount(args = {}) {
      const actor = requireString(args.actor, "actor");
      const workspaceId = requireString(args.workspace_id, "workspace_id");
      requireString(args.workspace_path, "workspace_path");
      const vaultId = requireString(args.vault_id, "vault_id");
      const mountAlias = requireString(args.mount_alias, "mount_alias");
      const accessMode = args.access_mode ?? "read";
      const reason = requireString(args.reason, "reason");

      const knownVault = vaultRegistry.getVaultById(vaultId);
      if (knownVault) {
        assertVaultScope(
          vaultRegistry.isVaultAccessibleTo(vaultId, { workspaceId }),
          `vault_scope_denied: vault_id "${vaultId}" is not owned by, or already mounted for, workspace "${workspaceId}".`,
        );
      }

      const { mount, vault } = vaultRegistry.mountVault({ vaultId, workspaceId, mountAlias, accessMode });

      journal.append({
        actor,
        toolName: "msp_vault_mount",
        ref: mount.mount_ref,
        workspaceId,
        payload: { vault_id: vaultId, mount_alias: mountAlias, access_mode: accessMode, reason },
        policyDecision: "allow",
      });

      return {
        mount_ref: mount.mount_ref,
        vault_ref: vault.vault_ref,
        policy_decision: "allow",
        mounted: true,
      };
    },
  };
}

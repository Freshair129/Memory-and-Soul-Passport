const HASH = /^[a-f0-9]{64}$/i;

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return value.trim();
}

function optionalString(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string when provided.`);
  return value.trim();
}

function requireRef(value, prefix, label) {
  const ref = requireString(value, label);
  if (!ref.startsWith(prefix)) throw new Error(`MSP returned an invalid ${label} namespace.`);
  return ref;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`MSP returned an invalid ${label}.`);
  return value.toLowerCase();
}

function requireDecision(value, label = "policy decision") {
  if (!["allow", "deny", "shadow"].includes(value)) throw new Error(`MSP returned an invalid ${label}.`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function rejectCanonicalCandidate(candidate) {
  for (const [key, value] of Object.entries(candidate)) {
    const canonicalKey = /^(canonical_?id|gks_?id|target_?ref)$/i.test(key);
    const canonicalValue = typeof value === "string" && value.toLowerCase().startsWith("gks:");
    if (canonicalKey || canonicalValue) {
      const error = new Error("Provider candidate must not assign a canonical GKS identity.");
      error.code = "provider_canonical_identity_forbidden";
      throw error;
    }
  }
  return candidate;
}

export function createTypedVaultContextMsp(client) {
  if (!client || typeof client.call !== "function") throw new Error("MSP parent capability is unavailable.");

  return {
    async getVaultStatus(input) {
      const result = await client.call("msp_vault_status", {
        actor: requireString(input.actor, "actor"),
        workspace_id: requireString(input.workspaceId, "workspaceId"),
        workspace_path: optionalString(input.workspacePath, "workspacePath"),
        agent_id: optionalString(input.agentId, "agentId"),
      });
      const status = requireObject(result, "vault status response");
      return {
        workspaceRef: status.workspace_ref ? requireRef(status.workspace_ref, "msp:workspace/", "workspace reference") : null,
        registryRef: status.registry_ref ? requireRef(status.registry_ref, "msp:vault-registry/", "vault registry reference") : null,
        vaults: Array.isArray(status.vaults) ? status.vaults : [],
        policyDecision: status.policy_decision ? requireDecision(status.policy_decision) : "allow",
        diagnostics: Array.isArray(status.diagnostics) ? status.diagnostics : [],
      };
    },

    async mountVault(input) {
      const result = await client.call("msp_vault_mount", {
        actor: requireString(input.actor, "actor"),
        workspace_id: requireString(input.workspaceId, "workspaceId"),
        workspace_path: requireString(input.workspacePath, "workspacePath"),
        vault_id: requireString(input.vaultId, "vaultId"),
        mount_alias: requireString(input.mountAlias, "mountAlias"),
        access_mode: input.accessMode ?? "read",
        reason: requireString(input.reason, "reason"),
      });
      const response = requireObject(result, "vault mount response");
      return {
        mountRef: requireRef(response.mount_ref, "msp:vault-mount/", "vault mount reference"),
        vaultRef: requireRef(response.vault_ref, "msp:vault/", "vault reference"),
        policyDecision: requireDecision(response.policy_decision),
        mounted: response.mounted === true,
      };
    },

    async diffContext(input) {
      const result = await client.call("msp_context_diff", {
        actor: requireString(input.actor, "actor"),
        base_context_id: requireString(input.baseContextId, "baseContextId"),
        target_context_id: requireString(input.targetContextId, "targetContextId"),
        include_payload: input.includePayload === true,
      });
      const response = requireObject(result, "context diff response");
      return {
        diffRef: requireRef(response.diff_ref, "msp:context-diff/", "context diff reference"),
        baseContextId: requireString(response.base_context_id, "base context ID"),
        targetContextId: requireString(response.target_context_id, "target context ID"),
        changedRefs: Array.isArray(response.changed_refs) ? response.changed_refs : [],
        sourceHash: response.source_hash ? requireHash(response.source_hash, "context diff hash") : null,
      };
    },

    async auditContext(input) {
      const result = await client.call("msp_context_audit", {
        actor: requireString(input.actor, "actor"),
        context_id: requireString(input.contextId, "contextId"),
        cache_id: optionalString(input.cacheId, "cacheId"),
        injection_id: optionalString(input.injectionId, "injectionId"),
      });
      const response = requireObject(result, "context audit response");
      return {
        auditRef: requireRef(response.audit_ref, "msp:context-audit/", "context audit reference"),
        contextId: requireString(response.context_id, "context ID"),
        replayable: response.replayable === true,
        hashValid: response.hash_valid === true,
        policyDecision: requireDecision(response.policy_decision),
        findings: Array.isArray(response.findings) ? response.findings : [],
      };
    },

    async promoteMemory(input) {
      if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
        throw new TypeError("evidenceRefs must contain at least one reference.");
      }
      const candidate = rejectCanonicalCandidate(requireObject(input.candidate, "candidate"));
      const result = await client.call("msp_memory_promote", {
        schema_version: "govibe-memory-promotion/v1",
        actor: requireString(input.actor, "actor"),
        agent_id: requireString(input.agentId, "agentId"),
        workspace_id: requireString(input.workspaceId, "workspaceId"),
        source_memory_ref: requireString(input.sourceMemoryRef, "sourceMemoryRef"),
        target_scope: requireString(input.targetScope, "targetScope"),
        candidate,
        evidence_refs: input.evidenceRefs.map((ref) => requireString(ref, "evidence reference")),
        reason: requireString(input.reason, "reason"),
        idempotency_key: requireString(input.idempotencyKey, "idempotencyKey"),
      });
      const response = requireObject(result, "memory promotion response");
      return {
        promotionRef: requireRef(response.promotion_ref, "msp:memory-promotion/", "memory promotion reference"),
        targetRef: response.target_ref ? requireString(response.target_ref, "promotion target reference") : null,
        policyDecision: requireDecision(response.policy_decision),
        sourceHash: response.source_hash ? requireHash(response.source_hash, "promoted memory hash") : null,
      };
    },
  };
}

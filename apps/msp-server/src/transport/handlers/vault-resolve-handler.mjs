// transport/handlers/vault-resolve-handler: msp_vault_resolve (API-010,
// PH-MEMOS-5, BL-MEMOS-062). Built to match zuri-ai's shipped, unsigned
// `{actor, access_context, authorization}` caller (`msp-vault-resolver.js`,
// origin/main@4ca28c1d) exactly -- no `grant`/`signature`, on the same
// stdio-only trust boundary every pre-API-011 tool already lives on
// (design §5.3, DEC-MEMOS-40). Composes VaultRegistry's existing legacy
// provision*Vault methods (unchanged) with the two new
// provisionPrincipalPrivateVault/PassportVault methods (design §5.2) in
// ONE outer transaction, so a call that needs to newly provision both the
// episodic vault and (when gated) the passport vault either commits both
// or neither.
import { createHmac } from "node:crypto";

import { IdentityHmacUnconfiguredError, MspRuntimeError, ValidationError } from "@freshair129/msp-contracts/errors";

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`access_context.${label} is required.`);
  }
  return value.trim();
}

// Matches domain/thread-memory.mjs's own hmacRoomRef/hmacPrincipal >=32
// character bar exactly (design §5.3: "reusing the same
// MSP_IDENTITY_HMAC_KEY room-ref hashing mechanism §6.2 already
// establishes"). VaultRegistry itself never reads this key or computes
// this hash (design §5.2) -- both stay this handler's own responsibility.
function assertIdentityHmacKeyConfigured(key) {
  if (typeof key !== "string" || key.length < 32) {
    throw new IdentityHmacUnconfiguredError();
  }
}

// Length-prefixed to remove the delimiter ambiguity a bare
// tenantId + "|" + principalId concatenation would carry (design §5.3,
// WARNING 3): HMAC-SHA256(k, "t1" + "|" + "x|y") and
// HMAC-SHA256(k, "t1|x" + "|" + "y") would otherwise produce the identical
// input string for two different (tenant_id, principal_id) pairs.
function computePrincipalHmac(key, tenantId, principalId) {
  return createHmac("sha256", key).update(`${String(tenantId.length)}:${tenantId}|${principalId}`, "utf8").digest("hex");
}

export function createVaultResolveHandler({ db, vaultRegistry, journal, identityHmacKey }) {
  return {
    async msp_vault_resolve(args = {}) {
      const accessContext = args.access_context && typeof args.access_context === "object" ? args.access_context : null;
      if (!accessContext) {
        throw new ValidationError("access_context is required and must be an object.");
      }
      // Design §5.3: all five of these are required non-empty strings on
      // the wire -- the shipped client-side caller's own required(...)
      // already throws before ever calling transport if any is missing,
      // so every real call MSP receives already carries all five; MSP
      // re-checks server-side, per this codebase's standing "vault
      // isolation is never optional" rule (never trust a client-side gate
      // alone).
      const tenantId = requireString(accessContext.tenant_id, "tenant_id");
      const principalId = requireString(accessContext.principal_id, "principal_id");
      const agentId = requireString(accessContext.agent_id, "agent_id");
      const workspaceId = requireString(accessContext.workspace_id, "workspace_id");
      const projectId = requireString(accessContext.project_id, "project_id");

      const authorization = args.authorization && typeof args.authorization === "object" ? args.authorization : null;
      if (!authorization) {
        throw new ValidationError("authorization is required and must be an object.");
      }

      // Mandatory for this tool AS A WHOLE (design §5.3, DEC-MEMOS-51):
      // principalPrivateVaultId resolves and is lazily provisioned on
      // EVERY well-formed call, unconditionally -- there is no
      // "legacy-only" msp_vault_resolve call, so a deployment lacking this
      // key cannot serve ANY call, before any resolution logic runs
      // (checked ahead of authorization.allowed too, since the key
      // requirement is deployment-wide, not gated by any one call's own
      // authorization claims).
      assertIdentityHmacKeyConfigured(identityHmacKey);

      // authorization.allowed must be exactly true, else vault_scope_denied
      // -- the shipped client-side currentScope() already refuses before
      // ever calling transport when this would be false, but MSP does not
      // trust that client-side gate and re-checks it server-side.
      if (authorization.allowed !== true) {
        throw new MspRuntimeError(
          "vault_scope_denied: authorization.allowed must be exactly true.",
          "vault_scope_denied",
        );
      }

      const allowPassport = authorization.allow_passport === true;

      // Computed once, before any provisioning runs -- a principal vault
      // is never provisioned without a matching, pseudonymized audit
      // trail (design §5.3). No raw principal_id is ever placed in the
      // journal actor.
      const principalHmac = computePrincipalHmac(identityHmacKey, tenantId, principalId);

      const resolve = db.transaction(() => {
        // Legacy resolution: computed exactly as the existing
        // provision*Vault methods already do (unchanged), gated by the
        // corresponding authorization.* flags below. Every one of these
        // five response fields is always present with the correct type,
        // even when a permission is denied (false / [], never omitted) --
        // the shipped, unmodified validateVaultSet throws on a missing or
        // wrongly-typed field.
        const workspacePrivateVault = vaultRegistry.provisionWorkspacePrivateVault(workspaceId, { projectId });
        const sharedVault = vaultRegistry.provisionSharedVault(projectId);
        const globalPrivateVault = vaultRegistry.provisionGlobalPrivateVault(agentId);

        // Principal resolution (design §5.2, §5.3). The existence check
        // runs BEFORE the provisioning call it describes, inside this SAME
        // transaction, so the two can never disagree about whether this
        // call is the one that newly created the row.
        const episodicAlreadyExisted = vaultRegistry.hasActivePrincipalPrivateVault({ tenantId, principalId, agentId, workspaceId });
        const principalPrivateVault = vaultRegistry.provisionPrincipalPrivateVault({ tenantId, principalId, agentId, workspaceId });
        const provisionedEpisodic = !episodicAlreadyExisted;

        let principalPassportVault = null;
        let provisionedPassport = false;
        if (allowPassport) {
          const passportAlreadyExisted = vaultRegistry.hasActivePrincipalPassportVault({ tenantId, principalId });
          principalPassportVault = vaultRegistry.provisionPrincipalPassportVault({ tenantId, principalId });
          provisionedPassport = !passportAlreadyExisted;
        }

        return {
          workspacePrivateVault,
          sharedVault,
          globalPrivateVault,
          principalPrivateVault,
          principalPassportVault,
          provisionedEpisodic,
          provisionedPassport,
        };
      });

      // VaultProvisionConflictError (SQLITE_BUSY_SNAPSHOT on the losing
      // INSERT, domain/vault-registry.mjs's own catch) rolls this whole
      // transaction back and propagates HERE unremapped -- this tool never
      // retries a vault_provision_conflict internally (design §5.2/§5.3);
      // the caller's own NEXT, genuinely top-level call is what resolves
      // the race. No try/catch needed: propagating unremapped IS the
      // correct behavior, not an omission.
      const result = resolve();

      journal.append({
        actor: `principal_hmac:${principalHmac}`,
        toolName: "msp_vault_resolve",
        ref: result.principalPrivateVault.vault_id,
        workspaceId,
        payload: {
          tenant_id: tenantId,
          agent_id: agentId,
          workspace_id: workspaceId,
          provisioned_episodic: result.provisionedEpisodic,
          provisioned_passport: result.provisionedPassport,
          passport_requested: allowPassport,
        },
        policyDecision: "allow",
      });

      return {
        workspacePrivateVaultId: result.workspacePrivateVault.vault_id,
        globalPrivateVaultIds: authorization.allow_global_private === true ? [result.globalPrivateVault.vault_id] : [],
        sharedVaultIds: authorization.allow_shared === true ? [result.sharedVault.vault_id] : [],
        principalPrivateVaultId: result.principalPrivateVault.vault_id,
        principalPassportVaultId: result.principalPassportVault ? result.principalPassportVault.vault_id : null,
        permissions: {
          read: authorization.read === true,
          writePrivate: authorization.write_private === true,
          writeShared: authorization.write_shared === true,
          policyVersion: typeof accessContext.policy_version === "string" ? accessContext.policy_version : "",
          allowPassport,
        },
      };
    },
  };
}

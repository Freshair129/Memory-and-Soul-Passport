// msp_vault_resolve (API-010, PH-MEMOS-5 §5.0.5). Legacy vault fields stay
// unsigned and byte-compatible; the principal half is opt-in behind a
// verified vault grant.
import { createHmac } from "node:crypto";

import { consumeGrantNonce } from "@freshair129/msp-core/grant-nonces";
import {
  GrantPayloadMismatchError,
  IdentityHmacUnconfiguredError,
  MspRuntimeError,
  ValidationError,
} from "@freshair129/msp-contracts/errors";
import { requireGrantNonce, verifyVaultGrant } from "@freshair129/msp-contracts/vault-grant-guard";

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required.`, "validation_failed");
  return value.trim();
}

function assertIdentityHmacKeyConfigured(key) {
  if (typeof key !== "string" || key.length < 32) throw new IdentityHmacUnconfiguredError();
}

function computePrincipalHmac(key, tenantId, principalId) {
  return createHmac("sha256", key).update(`${String(tenantId.length)}:${tenantId}|${principalId}`, "utf8").digest("hex");
}

export function createVaultResolveHandler({ db, vaultRegistry, journal, identityHmacKey, keyFor, now = Date.now }) {
  return {
    async msp_vault_resolve(args = {}) {
      const accessContext = args.access_context && typeof args.access_context === "object" && !Array.isArray(args.access_context)
        ? args.access_context
        : null;
      if (!accessContext) throw new ValidationError("access_context is required and must be an object.", "validation_failed");
      const tenantId = requireString(accessContext.tenant_id, "tenant_id");
      const principalId = requireString(accessContext.principal_id, "principal_id");
      const agentId = requireString(accessContext.agent_id, "agent_id");
      const workspaceId = requireString(accessContext.workspace_id, "workspace_id");
      const projectId = requireString(accessContext.project_id, "project_id");

      const authorization = args.authorization && typeof args.authorization === "object" && !Array.isArray(args.authorization)
        ? args.authorization
        : null;
      if (!authorization) throw new ValidationError("authorization is required and must be an object.", "validation_failed");
      if (authorization.allowed !== true) {
        throw new MspRuntimeError("vault_scope_denied: authorization.allowed must be exactly true.", "vault_scope_denied");
      }

      const { access, ...input } = args;
      const hasAccess = access !== undefined;
      let grant = null;
      let principalGrant = false;
      let allowPassport = false;
      if (hasAccess) {
        grant = verifyVaultGrant("msp_vault_resolve", input, access, keyFor, {
          vaultType: "principal_private",
          now: now(),
        });
        if (
          grant.tenantId !== tenantId ||
          grant.principalId !== principalId ||
          grant.agentId !== agentId ||
          grant.workspaceId !== workspaceId
        ) {
          throw new GrantPayloadMismatchError("The grant claims do not match access_context.");
        }
        requireGrantNonce(grant);
        assertIdentityHmacKeyConfigured(identityHmacKey);
        principalGrant = true;
        allowPassport = authorization.allow_passport === true && grant.allowPassport === true;
      }

      const resolve = db.transaction(() => {
        if (principalGrant) consumeGrantNonce(db, { tenantId: grant.tenantId, nonce: grant.nonce, expiresAt: grant.expiresAt });

        const workspacePrivateVault = vaultRegistry.provisionWorkspacePrivateVault(workspaceId, { projectId });
        const sharedVault = vaultRegistry.provisionSharedVault(projectId);
        const globalPrivateVault = vaultRegistry.provisionGlobalPrivateVault(agentId);
        let principalPrivateVault = null;
        let principalPassportVault = null;
        let provisionedEpisodic = false;
        let provisionedPassport = false;

        if (principalGrant) {
          const episodicAlreadyExisted = vaultRegistry.hasActivePrincipalPrivateVault({ tenantId, principalId, agentId, workspaceId });
          principalPrivateVault = vaultRegistry.provisionPrincipalPrivateVault({ tenantId, principalId, agentId, workspaceId });
          provisionedEpisodic = !episodicAlreadyExisted;
          if (allowPassport) {
            const passportAlreadyExisted = vaultRegistry.hasActivePrincipalPassportVault({ tenantId, principalId });
            principalPassportVault = vaultRegistry.provisionPrincipalPassportVault({ tenantId, principalId });
            provisionedPassport = !passportAlreadyExisted;
          }
        }

        journal.append({
          actor: principalGrant ? `principal_hmac:${computePrincipalHmac(identityHmacKey, tenantId, principalId)}` : "unauthenticated",
          toolName: "msp_vault_resolve",
          ref: principalPrivateVault?.vault_id ?? null,
          workspaceId: principalGrant ? workspaceId : null,
          payload: {
            tenant_id: principalGrant ? tenantId : null,
            agent_id: principalGrant ? agentId : null,
            workspace_id: principalGrant ? workspaceId : null,
            provisioned_episodic: provisionedEpisodic,
            provisioned_passport: provisionedPassport,
            passport_requested: allowPassport,
          },
          policyDecision: "allow",
        });

        return { workspacePrivateVault, sharedVault, globalPrivateVault, principalPrivateVault, principalPassportVault };
      });
      const result = principalGrant ? resolve.immediate() : resolve();

      return {
        workspacePrivateVaultId: result.workspacePrivateVault.vault_id,
        globalPrivateVaultIds: authorization.allow_global_private === true ? [result.globalPrivateVault.vault_id] : [],
        sharedVaultIds: authorization.allow_shared === true ? [result.sharedVault.vault_id] : [],
        principalPrivateVaultId: result.principalPrivateVault?.vault_id ?? null,
        principalPassportVaultId: result.principalPassportVault?.vault_id ?? null,
        permissions: {
          read: authorization.read === true,
          writePrivate: authorization.write_private === true,
          writeShared: authorization.write_shared === true,
          policyVersion: typeof accessContext.policy_version === "string" && accessContext.policy_version.trim() ? accessContext.policy_version : "unspecified",
          allowPassport,
        },
      };
    },
  };
}

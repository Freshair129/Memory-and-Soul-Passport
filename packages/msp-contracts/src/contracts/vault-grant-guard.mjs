import { GrantNonceRequiredError, VaultScopeDeniedError } from "./errors.mjs";
import { verifySignedGrant } from "./signed-grant.mjs";

const PRINCIPAL_CLAIMS = ["tenantId", "principalId"];

export function verifyVaultGrant(name, input, access, keyFor, { vaultType, now = Date.now() } = {}) {
  const requiredClaims = vaultType === "principal_private"
    ? [...PRINCIPAL_CLAIMS, "agentId", "workspaceId"]
    : vaultType === "principal_passport"
      ? PRINCIPAL_CLAIMS
      : vaultType === "global_private"
        ? ["agentId"]
        : PRINCIPAL_CLAIMS;
  // A global_private grant is tenantless.  Do not let an optional tenantId
  // claim steer verification to a tenant key; the signed grant must use the
  // configured global/default key for this scope.
  const resolver = vaultType === "global_private"
    ? (typeof keyFor === "function" ? () => keyFor(undefined) : keyFor)
    : keyFor;
  return verifySignedGrant(name, input, access, resolver, { requiredClaims, now });
}

export function requireGrantNonce(grant) {
  if (grant?.nonce === undefined || grant?.nonce === null) throw new GrantNonceRequiredError();
  if (typeof grant.nonce !== "string" || grant.nonce.length < 1 || grant.nonce.length > 128) {
    throw new GrantNonceRequiredError("The nonce claim must be a string of 1 to 128 characters.");
  }
  return grant.nonce;
}

export function assertGlobalPrivateGrant(vault, grant) {
  if (!grant || grant.agentId !== vault?.agent_id) {
    throw new VaultScopeDeniedError("vault_scope_denied: the grant does not authorize this global_private vault.");
  }
}

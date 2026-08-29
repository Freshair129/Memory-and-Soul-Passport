// contracts/vault-scope-guard: fail-closed vault_scope_denied enforcement
// (WP-14 Bounded Scope item 4 / AC-04).
//
// Layering decision (WP-14 step 4, option (a)): contracts/ may only import
// domain/ids.mjs and domain/errors.mjs (WP-13's dependency-boundary rule,
// unchanged by this packet -- see test/dependency-boundaries.test.mjs).
// Determining whether a vault_id is actually mounted/owned by a caller
// requires reading domain/vault-registry.mjs's mount/ownership records,
// which this module must NOT import directly -- that would couple
// contracts/ to a DB-backed lookup, breaking its role as a pure
// shaping/validation layer with no direct storage access (the same
// boundary contracts/namespace-guard.mjs and contracts/errors.mjs already
// keep). Instead, transport/handlers/*.mjs (which is allowed to import
// domain/ freely) calls domain/vault-registry.mjs's isVaultAccessibleTo(...)
// itself and passes the resulting plain boolean in here. This module's only
// job is turning `isAccessible === false` into the typed, fail-closed
// VaultScopeDeniedError with the exact vault_scope_denied code documented
// in docs/api/API-009-Persistent-Memory-Contract.md §5 -- still enforced
// "before the request reaches domain/" in the sense that matters: the
// mutating domain/ call (e.g. vaultRegistry.mountVault(), which writes a
// vault_mounts row) never runs when this guard throws.
import { VaultScopeDeniedError } from "./errors.mjs";

/**
 * @param {boolean} isAccessible result of domain/vault-registry.mjs's
 *   isVaultAccessibleTo(vaultId, {workspaceId, agentId}), computed by the
 *   caller (a transport/handlers/*.mjs module) before invoking this guard.
 * @param {string} [message] optional, more specific denial message.
 */
export function assertVaultScope(isAccessible, message) {
  if (!isAccessible) {
    throw new VaultScopeDeniedError(message);
  }
}

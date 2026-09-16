// contracts/context-scope-guard: PH-MEMOS-5 (design §5.4, §12.4.1,
// BL-MEMOS-064) -- the scoping half of the `contexts` access_context
// amendment. Pure, no DB access, no import beyond ./errors.mjs (the same
// "no .prepare(/.exec(/.pragma( call anywhere" C-2 structural proof
// vault-scope-guard.mjs already satisfies, enforced by
// tests/contract/dependency-boundaries.test.mjs).
//
// `contexts` has no domain/context-store.mjs of its own (unlike vaults --
// apps/msp-server/src/transport/handlers/context-handlers.mjs's own header
// comment: WP-13's Bounded Scope named exactly two new domain/ modules,
// vault-registry.mjs and journal.mjs, and this file's own bookkeeping
// stays local to the handler that owns it rather than inventing a module
// this design never asked for). A `contexts` row's own scope shape is
// flat and type-uniform (two nullable columns, never a per-vault-type
// branch set the way VaultRegistry's classifyPrincipalAccess needs), so --
// unlike the vault surface's domain/contracts split -- this module is the
// single normative home for BOTH computing the classification AND
// throwing on it; there is no separate domain-layer function this design
// asks KIN to add for `contexts`.
import { AccessContextDeniedError, AccessContextRequiredError, ValidationError } from "./errors.mjs";

/**
 * Cross-column invariant for a row about to be persisted (design §5.4):
 * `contexts.tenant_id` and `contexts.principal_id` must both be null
 * (a legacy/unscoped row) or both be non-null (a scoped row) -- never one
 * without the other. SQLite's own `ALTER TABLE ADD COLUMN` cannot add a
 * multi-column table-level CHECK referencing the pre-existing columns
 * without a full rebuild (migrations/0012_contexts_access_scope.sql's own
 * header comment), so this is the app-layer backstop, mirroring
 * migrations/0006_links.sql's own app-layer-only cross-column precedent.
 * `msp_context_resolve`'s own request-parsing already reads both fields
 * together or neither at all (design §5.4's own handler snippet) -- this
 * is defense in depth against a future write path that does not.
 *
 * @param {string | null} tenantId
 * @param {string | null} principalId
 */
export function assertScopeColumnsConsistent(tenantId, principalId) {
  const tenantPresent = tenantId !== null && tenantId !== undefined;
  const principalPresent = principalId !== null && principalId !== undefined;
  if (tenantPresent !== principalPresent) {
    throw new ValidationError(
      "contexts.tenant_id and contexts.principal_id must both be present (a scoped row) or both be absent (a legacy row).",
    );
  }
}

/**
 * PH-MEMOS-5 (design §5.4): the three-way outcome
 * `msp_context_diff`/`audit`/`replay`'s own access_context re-check
 * consumes, mirroring `domain/vault-registry.mjs#classifyPrincipalAccess`'s
 * own three-way shape for the vault surface.
 *
 *   - null: the row is a LEGACY row (both `tenant_id`/`principal_id` are
 *     null) -- access_context is neither required nor checked, unaffected
 *     by this amendment.
 *   - 'access_context_required': the row IS scoped and accessContext is
 *     absent entirely.
 *   - 'access_context_denied': accessContext was present but its
 *     tenant_id/principal_id do not both exactly match the row's own
 *     stored values.
 *   - 'ok': accessContext matched.
 *
 * @param {{ tenant_id: string | null, principal_id: string | null }} row
 * @param {{ tenant_id?: unknown, principal_id?: unknown } | null | undefined} accessContext
 */
export function classifyContextAccess(row, accessContext) {
  const isScoped = row.tenant_id !== null && row.tenant_id !== undefined && row.principal_id !== null && row.principal_id !== undefined;
  if (!isScoped) return null;
  if (accessContext === undefined || accessContext === null || typeof accessContext !== "object") {
    return "access_context_required";
  }
  const matches = accessContext.tenant_id === row.tenant_id && accessContext.principal_id === row.principal_id;
  return matches ? "ok" : "access_context_denied";
}

/**
 * @param {null | "ok" | "access_context_required" | "access_context_denied"} outcome
 * @param {string} [message]
 */
export function assertContextAccess(outcome, message) {
  if (outcome === null || outcome === "ok") return;
  if (outcome === "access_context_required") {
    throw new AccessContextRequiredError(message);
  }
  if (outcome === "access_context_denied") {
    throw new AccessContextDeniedError(message);
  }
  throw new TypeError(`assertContextAccess: unrecognized outcome "${outcome}".`);
}

/**
 * PH-MEMOS-5 (design §5.4): `include_payload` is refused for
 * `msp_context_diff` UNCONDITIONALLY when either named row is scoped, even
 * with a correctly-matching access_context -- defense in depth against a
 * future state where a scoped row's payload could carry principal-vault-
 * derived content, deliberately a DIFFERENT refusal from the ordinary
 * access_context authorization check above (this is not "you may not read
 * this row at all", it is "you may not read this ONE field of a row you
 * are otherwise allowed to diff"), so it is `validation_failed`
 * (ValidationError), never `access_context_denied`.
 *
 * @param {boolean} includePayloadRequested
 * @param {boolean} eitherRowScoped
 */
export function assertPayloadNotRequestedForScopedDiff(includePayloadRequested, eitherRowScoped) {
  if (includePayloadRequested && eitherRowScoped) {
    throw new ValidationError(
      "msp_context_diff: include_payload is refused when either base_context_id or target_context_id names a scoped context row.",
    );
  }
}

// PH-MEMOS-5, design v0.9.9b §5.0.7: unsigned scope recording on write,
// verified tenant/principal claims on read. This module performs no SQL.
import { ValidationError } from "./errors.mjs";
import { verifySignedGrant } from "./signed-grant.mjs";

export function assertScopeColumnsConsistent(tenantId, principalId) {
  const tenantPresent = tenantId !== null && tenantId !== undefined;
  const principalPresent = principalId !== null && principalId !== undefined;
  if (tenantPresent !== principalPresent) {
    throw new ValidationError(
      "contexts.tenant_id and contexts.principal_id must both be present (a scoped row) or both be absent (a legacy row).",
    );
  }
}

// A half-scoped row is never treated as legacy, even if it was inserted by
// a caller that bypassed assertScopeColumnsConsistent.
export function classifyContextAccess(row, verifiedClaims) {
  if (row.tenant_id == null && row.principal_id == null) return null;
  if (row.tenant_id == null || row.principal_id == null || !verifiedClaims) return "denied";
  return verifiedClaims.tenantId === row.tenant_id && verifiedClaims.principalId === row.principal_id
    ? "ok" : "denied";
}

export function canReadContext(row, name, args, keyFor, now = Date.now()) {
  if (!row) return false;
  // Legacy contexts ignore access entirely, including an invalid grant.
  if (classifyContextAccess(row, null) === null) return true;
  const { access, ...input } = args;
  try {
    const claims = verifySignedGrant(name, input, access, keyFor, {
      requiredClaims: ["tenantId", "principalId"], now,
    });
    return classifyContextAccess(row, claims) === "ok";
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("grant_")) return false;
    throw error;
  }
}

export function assertPayloadNotRequestedForScopedDiff(includePayloadRequested, eitherRowScoped) {
  if (includePayloadRequested && eitherRowScoped) {
    throw new ValidationError(
      "msp_context_diff: include_payload is refused when either base_context_id or target_context_id names a scoped context row.",
    );
  }
}

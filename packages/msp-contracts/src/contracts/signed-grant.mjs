import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  GrantExpiredError,
  GrantPayloadMismatchError,
  GrantSignatureInvalidError,
  GrantUnconfiguredError,
} from "./errors.mjs";

const MAX_CLAIM_LENGTH = 128;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClaimStrings(grant, requiredClaims) {
  for (const claim of requiredClaims) {
    const value = grant[claim];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLAIM_LENGTH) {
      throw new GrantSignatureInvalidError(`The grant is missing a required claim or ${claim} is not a string of at most ${MAX_CLAIM_LENGTH} characters.`);
    }
  }
}

/**
 * Verify a signed grant without coupling the contracts layer to a storage or
 * domain implementation. `input` must already have its top-level `access`
 * member removed before payload hashing.
 */
export function verifySignedGrant(name, input, access, keyFor, { requiredClaims = [], now = Date.now() } = {}) {
  const grant = access?.grant;
  const claimedTenantId = isPlainObject(grant) ? grant.tenantId : undefined;
  const key = typeof keyFor === "function" ? keyFor(claimedTenantId) : keyFor;
  if (typeof key !== "string" || key.length < 32) {
    throw new GrantUnconfiguredError("No thread service key is configured for this grant's claimed tenant.");
  }
  if (!isPlainObject(grant) || grant.operation !== name) {
    throw new GrantSignatureInvalidError("The grant is missing or names a different operation.");
  }

  const actual = Buffer.from(typeof access?.signature === "string" ? access.signature : "", "hex");
  const expected = createHmac("sha256", key).update(JSON.stringify(grant)).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new GrantSignatureInvalidError("The grant signature does not match.");
  }
  if (!Number.isInteger(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + 65_000) {
    throw new GrantExpiredError();
  }
  const expectedPayloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  if (grant.payloadHash !== expectedPayloadHash) {
    throw new GrantPayloadMismatchError();
  }
  assertClaimStrings(grant, requiredClaims);
  return grant;
}

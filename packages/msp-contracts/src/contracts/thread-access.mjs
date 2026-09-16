// API-011 thread memory (TASK-MEMOS-002), C-2 fix: contracts/ stays a pure
// shaping/validation layer with no direct storage access -- the same rule
// contracts/vault-scope-guard.mjs already keeps (see that file's header and
// tests/contract/dependency-boundaries.test.mjs's "decoupled from the
// registry implementation" assertions, mirrored here for this file, and
// (RKOI review, item 13) tests/contract/dependency-boundaries.test.mjs also
// scans every msp-contracts source file for `.prepare(`, `.exec(` and
// `.pragma(`, not only this one file's imports).
//
// The ORIGINAL (unmerged) version of this file read `db.prepare(...)`
// directly to resolve a thread_id/session_id/job_id/inbound_message_id to
// its owning thread and to check participant rows -- a DB-backed lookup
// baked into contracts/, exactly the coupling vault-scope-guard.mjs's own
// header comment explains why contracts/ must never do. That lookup logic
// now lives in msp-core's ThreadRegistry
// (packages/msp-core/src/domain/thread-memory.mjs) and is orchestrated by
// apps/msp-server/src/transport/handlers/thread-guard.mjs, which is allowed
// to import both msp-core and msp-contracts freely. This file keeps only:
//   - signThreadRequest: pure grant construction (test/worker callers).
//   - verifyThreadGrant: pure grant verification -- HMAC, payload hash,
//     expiry, required-claim presence. No DB, no SQL, no msp-core import.
//   - assertThreadScope: throws the typed, fail-closed ThreadScopeDeniedError
//     (code `thread_scope_denied`), mirroring
//     contracts/vault-scope-guard.mjs's assertVaultScope(isAccessible,
//     message) exactly.
import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  ThreadScopeDeniedError,
} from "./errors.mjs";
import { verifySignedGrant } from "./signed-grant.mjs";

/**
 * Signs a thread-tool request with a short-lived grant. Used by the
 * composition root's test/worker callers (e.g. msp_session_sweep,
 * msp_session_compaction_commit) and by any adapter that mints its own
 * grants for a caller it has already authorized. Never used by
 * msp-server itself to authorize an inbound request -- only to construct
 * one going out. zuri-ai's own real signer does not call this function at
 * all (it signs its own grants independently, per §6.1's trust-boundary
 * paragraph) -- this is exclusively MSP's own test suite and MSP's own
 * worker (thread-summary-worker.mjs).
 *
 * PH-MEMOS-3 stage 2 (DEC-MEMOS-20): `nonce` is auto-generated here, the
 * same way `expiresAt`/`payloadHash` already are, unless `claims` supplies
 * its own (including an explicit `undefined`, to test the nonce-required
 * refusal, or a fixed repeated value, to test replay) -- `nonce` MUST be
 * unique per signed request to avoid a spurious `grant_replayed` merely
 * from reusing one test's claims object across several calls, and callers
 * should not have to hand-generate a compliant one (>= 128 random bits,
 * <= 128 characters) themselves. 16 random bytes, hex-encoded, is exactly
 * 128 bits in 32 characters -- well under the ceiling.
 */
export function signThreadRequest(name, input, claims, key, now = Date.now()) {
  if (typeof key !== "string" || key.length < 32) throw new Error("MSP_THREAD_SERVICE_KEY_REQUIRED");
  const grant = {
    nonce: randomBytes(16).toString("hex"),
    ...claims,
    operation: name,
    expiresAt: now + 60_000,
    payloadHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  };
  return { ...input, access: { grant, signature: createHmac("sha256", key).update(JSON.stringify(grant)).digest("hex") } };
}

/**
 * Pure verification of a signed thread grant against the request it was
 * issued for: HMAC signature, operation match, expiry window, payload-hash
 * binding, and presence of the claims every thread tool needs regardless of
 * which one it is. Returns the parsed grant on success. Throws one of the
 * four typed grant errors below (fail-closed) on ANY failure -- there is no
 * partially-valid grant.
 *
 * @param {string} name the tool name the request claims to be for.
 * @param {object} input the request body with `access` already stripped.
 * @param {{grant: object, signature: string}|undefined} access
 * @param {string|((tenantId: string|undefined) => string|undefined)} keyFor
 *   MSP_THREAD_SERVICE_KEY, or a function resolving one per the grant's
 *   CLAIMED (not yet verified) tenantId -- the untrusted claim selects a
 *   candidate key, and that same key must then make the signature verify;
 *   a wrong tenant claim can never produce a valid signature under another
 *   tenant's key. Stage 1 always passes a single plain string (or a
 *   function that ignores its argument and returns one); stage 2 can add a
 *   real per-tenant keyring here without changing this function's shape.
 * @param {number} [now]
 */
export function verifyThreadGrant(name, input, access, keyFor, now = Date.now()) {
  return verifySignedGrant(name, input, access, keyFor, {
    now,
    requiredClaims: ["tenantId", "principalId", "policyRevision", "agentId", "workspaceId"],
  });
}

/**
 * @param {boolean} isAuthorized a plain boolean the caller (a
 *   transport/handlers/*.mjs module) computed itself, from a msp-core
 *   ThreadRegistry lookup and/or a grant-claim comparison. This module never
 *   computes that boolean itself.
 * @param {string} [message] optional, more specific denial message.
 */
export function assertThreadScope(isAuthorized, message) {
  if (!isAuthorized) {
    throw new ThreadScopeDeniedError(message);
  }
}

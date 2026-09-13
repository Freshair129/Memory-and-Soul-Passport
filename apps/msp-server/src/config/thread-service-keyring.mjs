// BL-MEMOS-049 (TASK-MEMOS-002 stage 2, RKOI ruling 2): optional per-tenant
// MSP_THREAD_SERVICE_KEYRING, layered on top of the single-key stage-1
// default (MSP_THREAD_SERVICE_KEY) without changing either
// packages/msp-contracts/src/contracts/thread-access.mjs's verifyThreadGrant
// (it already resolves its HMAC key through an injected
// `keyFor(claimedTenantId)` function -- this module only builds a smarter
// one) or apps/msp-server/src/transport/handlers/thread-guard.mjs.
//
// This lives in apps/msp-server, not packages/msp-contracts: msp-contracts
// stays a pure shaping/validation layer with no env reads of its own (see
// thread-access.mjs's own header comment on why that boundary matters), and
// "parse the env var where MSP_THREAD_SERVICE_KEY is parsed today" is
// server.mjs's composition root.
//
// Opt-in, no fallback, fail-closed at server start:
//   - MSP_THREAD_SERVICE_KEYRING unset (or empty) -> keyFor(tenantId) always
//     returns env.MSP_THREAD_SERVICE_KEY, for every tenant, unchanged from
//     stage 1.
//   - MSP_THREAD_SERVICE_KEYRING set -> parsed and validated ONCE, here,
//     synchronously, at the point resolveThreadServiceKeyFor is called
//     (server.mjs's createServer, before the guard/tool registry exist) --
//     never lazily on first request. A malformed keyring throws
//     ThreadServiceKeyringConfigError immediately, so a bad deployment
//     config never serves a single request; it never degrades to the
//     single-key default either. Once parsed, MSP_THREAD_SERVICE_KEY is
//     never consulted again, for ANY tenant, including one present in
//     process.env but absent from the keyring.
//
// A tenant missing from a configured keyring is handled by the EXISTING
// vocabulary, not a new one: keyFor(tenantId) returning undefined already
// makes verifyThreadGrant throw GrantUnconfiguredError (grant_unconfigured)
// -- the same error a caller gets today when MSP_THREAD_SERVICE_KEY itself
// is unset. Cross-tenant verification is likewise already impossible
// without any change here: a grant claiming tenantId "B" is only ever
// checked against keyFor("B")'s key, so a grant signed under tenant A's key
// but claiming "B" fails verifyThreadGrant's signature comparison, never
// reaching a per-tool authorization decision.
import { MspRuntimeError } from "@freshair129/msp-core/errors";

/**
 * A malformed MSP_THREAD_SERVICE_KEYRING at server start. Distinct from the
 * per-request grant_unconfigured/grant_signature_invalid vocabulary in
 * packages/msp-contracts/src/contracts/errors.mjs: this is a deployment
 * configuration defect the server refuses to start under, not a decision
 * about any one caller's grant. Never includes a key value -- only ever the
 * shape rule that was violated and, where useful, the tenant id (not a
 * secret) that violated it.
 */
export class ThreadServiceKeyringConfigError extends MspRuntimeError {
  constructor(message) {
    super(`thread_keyring_config_invalid: ${message}`, "thread_keyring_config_invalid");
  }
}

/**
 * Parses and validates MSP_THREAD_SERVICE_KEYRING's raw string value into a
 * plain `{ [tenantId]: key }` object. Pure -- no env reads, no I/O -- so it
 * is directly unit-testable against every malformed shape.
 *
 * Format (adopted default, ATHER records it in the API-011 contract doc): a
 * JSON object whose keys are non-empty tenant ids and whose values are
 * strings of at least 32 characters, the same bar MSP_THREAD_SERVICE_KEY
 * and MSP_IDENTITY_HMAC_KEY already hold elsewhere in this contract. Per-
 * tenant key ROTATION (more than one live key per tenant) is explicitly
 * deferred -- this format has no room for it, and none is added here.
 *
 * @param {string} raw the raw MSP_THREAD_SERVICE_KEYRING env value.
 * @returns {Record<string, string>}
 */
export function parseThreadServiceKeyring(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ThreadServiceKeyringConfigError("MSP_THREAD_SERVICE_KEYRING must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ThreadServiceKeyringConfigError("MSP_THREAD_SERVICE_KEYRING must be a JSON object of {tenantId: key}.");
  }
  const keyring = {};
  for (const [tenantId, key] of Object.entries(parsed)) {
    if (typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new ThreadServiceKeyringConfigError("MSP_THREAD_SERVICE_KEYRING has an entry with an empty tenant id.");
    }
    if (typeof key !== "string" || key.length < 32) {
      throw new ThreadServiceKeyringConfigError(`MSP_THREAD_SERVICE_KEYRING's key for tenant "${tenantId}" must be a string of at least 32 characters.`);
    }
    keyring[tenantId] = key;
  }
  return keyring;
}

/**
 * Builds the `keyFor(tenantId)` function
 * packages/msp-contracts/src/contracts/thread-access.mjs's verifyThreadGrant
 * (via apps/msp-server/src/transport/handlers/thread-guard.mjs's `key`
 * option) expects. Called ONCE, synchronously, from server.mjs's
 * createServer -- so a malformed keyring fails the server start itself,
 * never a request.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {(tenantId: string | undefined) => string | undefined}
 */
export function resolveThreadServiceKeyFor(env) {
  const raw = env.MSP_THREAD_SERVICE_KEYRING;
  if (raw === undefined || raw === null || raw === "") {
    // Stage 1, unchanged: every tenant resolves to the single default key.
    return () => env.MSP_THREAD_SERVICE_KEY;
  }
  const keyring = parseThreadServiceKeyring(raw);
  // No fallback: MSP_THREAD_SERVICE_KEY is never consulted again once a
  // keyring is configured, even for a tenant absent from it.
  return (tenantId) => (typeof tenantId === "string" ? keyring[tenantId] : undefined);
}

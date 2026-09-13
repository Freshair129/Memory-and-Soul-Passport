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
//     synchronously, at the point resolveThreadServiceKeyFor is called --
//     server.mjs's createServer calls this BEFORE open(dbPath)/
//     runMigrations, so a malformed keyring never creates or migrates a
//     database file either, and never leaves an open DB handle behind in
//     an in-process caller. A malformed keyring throws
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
//
// RKOI review, CRITICAL: an earlier version of this file quoted the
// (untrusted) tenant id and, in one message, the raw key length threshold
// in its error text. Since the keyring is a caller-authored map of
// {tenantId: key}, a reversed/misconfigured map (a key written where a
// tenant id belongs) makes ANY text drawn from that map potentially BE a
// secret key -- there is no way to tell, from inside this parser, whether
// a given string is "the tenant id" or "the key" once the map itself is
// wrong. Every error below therefore refers to an offending entry ONLY by
// its 1-based position among the keyring's top-level entries (e.g. "entry
// 2"), never by quoting anything read out of the map -- not in the
// message, not in a `cause`, not anywhere an error object exposes text
// (util.inspect(err) prints only the message and stack, both built from
// the same position-only text). bin/msp-server.mjs lets this exception
// reach the process's default uncaught-exception handler, which writes it
// to stderr, and packages/msp-client-js/src/msp-stdio-transport.mjs folds
// a crashed child's stderr tail into the error it raises to the CALLING
// application -- so a leak here would reach not just an operator's log,
// but the very caller the keyring's owner-tenant boundary is trying to
// protect.
import { MspRuntimeError } from "@freshair129/msp-core/errors";

const MIN_KEY_LENGTH = 32;

/**
 * A malformed MSP_THREAD_SERVICE_KEYRING at server start. Distinct from the
 * per-request grant_unconfigured/grant_signature_invalid vocabulary in
 * packages/msp-contracts/src/contracts/errors.mjs: this is a deployment
 * configuration defect the server refuses to start under, not a decision
 * about any one caller's grant. NEVER includes any text read out of the
 * keyring itself (see this module's header comment) -- only the shape rule
 * that was violated and, where useful, the 1-based position of the entry
 * that violated it.
 */
export class ThreadServiceKeyringConfigError extends MspRuntimeError {
  constructor(message) {
    super(`thread_keyring_config_invalid: ${message}`, "thread_keyring_config_invalid");
  }
}

function fail(message) {
  throw new ThreadServiceKeyringConfigError(message);
}

// WARNING 1 (duplicates): a duplicate top-level JSON key cannot be detected
// from the PARSED result, by Object.entries, or by a JSON.parse reviver --
// JSON.parse's own construction step silently keeps only the LAST
// occurrence of a repeated key before a reviver, or anything else, ever
// sees the object. A reviver only ever walks the final, already-
// deduplicated object. Detecting a duplicate (including an escaped
// equivalent of a plain character, e.g. a literal "-" vs its \u002d escape
// in the same source) requires scanning the RAW source's own key tokens,
// decoded, in source order. This tokenizer trusts that `raw` already
// parsed successfully as JSON representing a top-level, non-array object
// (both checked by the caller before this runs) -- it does not attempt to
// validate JSON syntax itself, only to walk it.
function scanTopLevelObjectKeys(raw) {
  const keys = [];
  const len = raw.length;
  let i = 0;

  function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  function skipWhitespace() {
    while (i < len && isWhitespace(raw[i])) i++;
  }

  // Reads a JSON string literal starting at raw[i] === '"', decoding escape
  // sequences, and returns the decoded text with `i` left just past the
  // closing quote.
  function readStringLiteral() {
    i++; // opening quote
    let value = "";
    while (i < len) {
      const ch = raw[i];
      if (ch === "\\") {
        const esc = raw[i + 1];
        switch (esc) {
          case '"':
            value += '"';
            i += 2;
            break;
          case "\\":
            value += "\\";
            i += 2;
            break;
          case "/":
            value += "/";
            i += 2;
            break;
          case "b":
            value += "\b";
            i += 2;
            break;
          case "f":
            value += "\f";
            i += 2;
            break;
          case "n":
            value += "\n";
            i += 2;
            break;
          case "r":
            value += "\r";
            i += 2;
            break;
          case "t":
            value += "\t";
            i += 2;
            break;
          case "u": {
            const hex = raw.slice(i + 2, i + 6);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            break;
          }
          default:
            value += esc;
            i += 2;
        }
        continue;
      }
      if (ch === '"') {
        i++; // closing quote
        break;
      }
      value += ch;
      i++;
    }
    return value;
  }

  // Same traversal as readStringLiteral, but discards the decoded text --
  // used for skipping string VALUES, and string literals nested inside an
  // object/array value, where only correct traversal matters, not content.
  function skipStringLiteral() {
    i++; // opening quote
    while (i < len) {
      const ch = raw[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        break;
      }
      i++;
    }
  }

  function skipValue() {
    skipWhitespace();
    const ch = raw[i];
    if (ch === '"') {
      skipStringLiteral();
      return;
    }
    if (ch === "{" || ch === "[") {
      const open = ch;
      const close = ch === "{" ? "}" : "]";
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        const c = raw[i];
        if (c === '"') {
          skipStringLiteral();
          continue;
        }
        if (c === open) depth++;
        else if (c === close) depth--;
        i++;
      }
      return;
    }
    // number / true / false / null
    while (i < len && raw[i] !== "," && raw[i] !== "}" && raw[i] !== "]" && !isWhitespace(raw[i])) i++;
  }

  skipWhitespace();
  if (raw[i] !== "{") return keys; // not a top-level object; caller already validated this can't happen
  i++; // consume the top-level '{'
  skipWhitespace();
  if (raw[i] === "}") return keys; // empty object
  while (i < len) {
    skipWhitespace();
    if (raw[i] !== '"') break; // malformed; JSON.parse would already have thrown
    keys.push(readStringLiteral());
    skipWhitespace();
    if (raw[i] === ":") i++;
    skipValue();
    skipWhitespace();
    if (raw[i] === ",") {
      i++;
      continue;
    }
    break;
  }
  return keys;
}

/**
 * Parses and validates MSP_THREAD_SERVICE_KEYRING's raw string value into a
 * `{ [tenantId]: key }` map. Pure -- no env reads, no I/O -- so it is
 * directly unit-testable against every malformed shape.
 *
 * Format (adopted default, ATHER records it in the API-011 contract doc): a
 * JSON object whose keys are non-empty tenant ids (no leading/trailing
 * whitespace) and whose values are non-blank strings of at least 32
 * characters (no leading/trailing whitespace either), the same bar
 * MSP_THREAD_SERVICE_KEY and MSP_IDENTITY_HMAC_KEY already hold elsewhere
 * in this contract. Refused outright: invalid JSON; a non-object (array,
 * string, number, null); an EMPTY object (a keyring, once configured, must
 * name at least one tenant); a duplicate tenant id (including an escaped
 * equivalent of the same characters); a tenant id or key with leading or
 * trailing whitespace, or a whitespace-only key; a key shorter than 32
 * characters. The returned map is built with `Object.create(null)`, so an
 * entry literally named "__proto__" (a normal own property on the object
 * JSON.parse itself produced -- JSON.parse never triggers the __proto__
 * SETTER, only a later `{}`-based assignment would) becomes an ordinary
 * data property here too, instead of silently reassigning this object's
 * own prototype.
 *
 * Per-tenant key ROTATION (more than one live key per tenant) is
 * explicitly deferred -- this format has no room for it, and none is
 * added here.
 *
 * @param {string} raw the raw MSP_THREAD_SERVICE_KEYRING env value.
 * @returns {Record<string, string>}
 */
export function parseThreadServiceKeyring(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("MSP_THREAD_SERVICE_KEYRING must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("MSP_THREAD_SERVICE_KEYRING must be a JSON object of {tenantId: key}.");
  }

  const rawKeys = scanTopLevelObjectKeys(raw);
  if (rawKeys.length === 0) {
    return fail("MSP_THREAD_SERVICE_KEYRING must not be empty once configured.");
  }

  const firstPositionOf = new Map();
  rawKeys.forEach((tenantId, index) => {
    if (firstPositionOf.has(tenantId)) {
      fail(`MSP_THREAD_SERVICE_KEYRING has a duplicate tenant id: entry ${firstPositionOf.get(tenantId) + 1} and entry ${index + 1} name the same tenant.`);
    }
    firstPositionOf.set(tenantId, index);
  });

  const keyring = Object.create(null);
  rawKeys.forEach((tenantId, index) => {
    const position = index + 1;
    const key = parsed[tenantId];
    if (tenantId.trim() === "") {
      fail(`MSP_THREAD_SERVICE_KEYRING entry ${position} has an empty tenant id.`);
    }
    if (tenantId.trim() !== tenantId) {
      fail(`MSP_THREAD_SERVICE_KEYRING entry ${position}'s tenant id must not have leading or trailing whitespace.`);
    }
    if (typeof key !== "string") {
      fail(`MSP_THREAD_SERVICE_KEYRING entry ${position}'s key must be a string.`);
    }
    if (key.trim() !== key || key.trim() === "") {
      fail(`MSP_THREAD_SERVICE_KEYRING entry ${position}'s key must not be blank, and must not have leading or trailing whitespace.`);
    }
    if (key.length < MIN_KEY_LENGTH) {
      fail(`MSP_THREAD_SERVICE_KEYRING entry ${position}'s key must be at least ${MIN_KEY_LENGTH} characters.`);
    }
    keyring[tenantId] = key;
  });
  return keyring;
}

/**
 * Builds the `keyFor(tenantId)` function
 * packages/msp-contracts/src/contracts/thread-access.mjs's verifyThreadGrant
 * (via apps/msp-server/src/transport/handlers/thread-guard.mjs's `key`
 * option) expects. Called ONCE, synchronously, from server.mjs's
 * createServer, BEFORE open(dbPath)/runMigrations -- so a malformed
 * keyring fails the server start itself, before a database file is even
 * created, never a request.
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
  // RKOI review, WARNING 2: looked up with Object.hasOwn against a
  // null-prototype map -- "constructor", "toString", "__proto__" and any
  // other Object.prototype member resolve to undefined here directly,
  // never by falling through to the (also-correct, but incidental)
  // downstream `typeof key !== "string"` check in verifyThreadGrant. No
  // fallback: MSP_THREAD_SERVICE_KEY is never consulted again once a
  // keyring is configured, even for a tenant absent from it.
  return (tenantId) => (typeof tenantId === "string" && Object.hasOwn(keyring, tenantId) ? keyring[tenantId] : undefined);
}

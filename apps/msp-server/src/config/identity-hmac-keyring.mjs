import { MspRuntimeError } from "@freshair129/msp-core/errors";
import { scanTopLevelObjectEntries } from "./thread-service-keyring.mjs";

const MIN_KEY_LENGTH = 32;
const MAX_VERSION_LENGTH = 128;

/**
 * A malformed erasure-receipt identity keyring is a deployment defect. Keep
 * the error separate from the request-level identity_hmac_unconfigured code:
 * this is checked before the database opens, so the server must refuse to
 * start rather than accept an invalid rotation configuration.
 */
export class IdentityHmacKeyringConfigError extends MspRuntimeError {
  constructor(message) {
    super(`identity_keyring_config_invalid: ${message}`, "identity_keyring_config_invalid");
  }
}

function fail(message) {
  throw new IdentityHmacKeyringConfigError(message);
}

function validateVersion(version, label) {
  if (typeof version !== "string" || version.length < 1 || version.length > MAX_VERSION_LENGTH) {
    fail(`${label} must be a non-empty string of at most ${MAX_VERSION_LENGTH} characters.`);
  }
  return version;
}

function validateKey(key, label) {
  if (typeof key !== "string" || key.trim() !== key || key.length < MIN_KEY_LENGTH) {
    fail(`${label} must be a string of at least ${MIN_KEY_LENGTH} characters with no leading or trailing whitespace.`);
  }
  return key;
}

/**
 * Parse MSP_IDENTITY_HMAC_KEYRING's JSON object. The returned map has a null
 * prototype so an opaque version such as "__proto__" remains data. The raw
 * scanner is shared with the service-keyring parser so escaped duplicate
 * names are rejected before native JSON object construction can hide them.
 */
export function parseIdentityHmacKeyring(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("MSP_IDENTITY_HMAC_KEYRING must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("MSP_IDENTITY_HMAC_KEYRING must be a JSON object of {identity_key_version: key}.");
  }

  const rawEntries = scanTopLevelObjectEntries(raw);
  if (rawEntries.length === 0) {
    return fail("MSP_IDENTITY_HMAC_KEYRING must not be empty once configured.");
  }
  const firstPositionOf = new Map();
  rawEntries.forEach(({ tenantId: version }, index) => {
    if (firstPositionOf.has(version)) {
      fail(`MSP_IDENTITY_HMAC_KEYRING has a duplicate identity key version: entry ${firstPositionOf.get(version) + 1} and entry ${index + 1} name the same version.`);
    }
    firstPositionOf.set(version, index);
  });

  const keyring = Object.create(null);
  rawEntries.forEach(({ tenantId: version, isString, value }, index) => {
    const position = index + 1;
    validateVersion(version, `MSP_IDENTITY_HMAC_KEYRING entry ${position}'s identity key version`);
    if (!isString) fail(`MSP_IDENTITY_HMAC_KEYRING entry ${position}'s key must be a string.`);
    keyring[version] = validateKey(value, `MSP_IDENTITY_HMAC_KEYRING entry ${position}'s key`);
  });
  return keyring;
}

/**
 * Resolve the identity-hash configuration once at server composition time.
 * MSP_IDENTITY_HMAC_KEY_VERSION is allowed to be absent here because the
 * existing room/journal HMAC paths predate erasure-receipt versioning; the
 * erasure domain method refuses an erase atomically until the active version
 * is present. A malformed optional keyring still refuses startup.
 */
export function resolveIdentityHmacConfig(env = process.env) {
  const version = env.MSP_IDENTITY_HMAC_KEY_VERSION;
  if (version !== undefined && version !== null) validateVersion(version, "MSP_IDENTITY_HMAC_KEY_VERSION");

  const raw = env.MSP_IDENTITY_HMAC_KEYRING;
  const keyring = raw === undefined || raw === null || raw === "" ? Object.create(null) : parseIdentityHmacKeyring(raw);
  return Object.freeze({
    key: env.MSP_IDENTITY_HMAC_KEY ?? null,
    version: version ?? null,
    keyring,
  });
}

export const IDENTITY_HMAC_KEY_VERSION_MAX_LENGTH = MAX_VERSION_LENGTH;
export const IDENTITY_HMAC_KEY_MIN_LENGTH = MIN_KEY_LENGTH;

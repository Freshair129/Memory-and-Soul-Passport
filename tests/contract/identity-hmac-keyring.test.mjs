// BL-MEMOS-076 (design §12.5): pure composition/configuration coverage for
// erasure-receipt key generations. The parser is deliberately tested without
// a server or database so malformed rotation material is rejected before a
// runtime can open or migrate its SQLite file.
import { describe, expect, it } from "vitest";

import {
  IdentityHmacKeyringConfigError,
  IDENTITY_HMAC_KEY_MIN_LENGTH,
  IDENTITY_HMAC_KEY_VERSION_MAX_LENGTH,
  parseIdentityHmacKeyring,
  resolveIdentityHmacConfig,
} from "../../apps/msp-server/src/config/identity-hmac-keyring.mjs";

const KEY_A = "identity-key-generation-a-0123456789";
const KEY_B = "identity-key-generation-b-0123456789";

describe("parseIdentityHmacKeyring", () => {
  it("parses retired generations into a null-prototype map", () => {
    const keyring = parseIdentityHmacKeyring(JSON.stringify({ "identity-v1": KEY_A, "identity-v0": KEY_B }));
    expect(Object.getPrototypeOf(keyring)).toBeNull();
    expect(keyring["identity-v1"]).toBe(KEY_A);
    expect(keyring["identity-v0"]).toBe(KEY_B);
  });

  it("rejects an explicitly configured empty retired-key ring", () => {
    expect(() => parseIdentityHmacKeyring("{}")).toThrow(/must not be empty/);
  });

  it("accepts opaque versions, including Object.prototype-shaped names", () => {
    const keyring = parseIdentityHmacKeyring(JSON.stringify({ ["__proto__"]: KEY_A, constructor: KEY_B }));
    expect(Object.hasOwn(keyring, "__proto__")).toBe(true);
    expect(Object.hasOwn(keyring, "constructor")).toBe(true);
    expect(keyring.__proto__).toBe(KEY_A);
    expect(keyring.constructor).toBe(KEY_B);
  });

  it("rejects invalid JSON and non-object top-level values", () => {
    for (const raw of ["{not json", "null", "[]", JSON.stringify("identity-v1"), "7"]) {
      expect(() => parseIdentityHmacKeyring(raw)).toThrow(IdentityHmacKeyringConfigError);
    }
  });

  it("rejects a non-string, short, or whitespace-padded key", () => {
    expect(() => parseIdentityHmacKeyring(JSON.stringify({ "identity-v1": 7 }))).toThrow(IdentityHmacKeyringConfigError);
    expect(() => parseIdentityHmacKeyring(JSON.stringify({ "identity-v1": "x".repeat(IDENTITY_HMAC_KEY_MIN_LENGTH - 1) }))).toThrow(
      /at least 32 characters/,
    );
    expect(() => parseIdentityHmacKeyring(JSON.stringify({ "identity-v1": ` ${"x".repeat(IDENTITY_HMAC_KEY_MIN_LENGTH)} ` }))).toThrow(
      /leading or trailing whitespace/,
    );
  });

  it("rejects an empty or overlong version", () => {
    expect(() => parseIdentityHmacKeyring(JSON.stringify({ "": KEY_A }))).toThrow(/non-empty/);
    expect(() => parseIdentityHmacKeyring(JSON.stringify({ ["v".repeat(IDENTITY_HMAC_KEY_VERSION_MAX_LENGTH + 1)]: KEY_A }))).toThrow(
      /at most 128 characters/,
    );
  });

  it("rejects literal and escaped-equivalent duplicate versions", () => {
    expect(() => parseIdentityHmacKeyring(`{"identity-v1":"${KEY_A}","identity-v1":"${KEY_B}"}`)).toThrow(/duplicate identity key version/);
    expect(() => parseIdentityHmacKeyring(`{"identity-v1":"${KEY_A}","identity\u002dv1":"${KEY_B}"}`)).toThrow(/duplicate identity key version/);
  });
});

describe("resolveIdentityHmacConfig", () => {
  it("keeps the existing active key optional at startup while resolving version and retired keys once", () => {
    const config = resolveIdentityHmacConfig({
      MSP_IDENTITY_HMAC_KEY: KEY_B,
      MSP_IDENTITY_HMAC_KEY_VERSION: "identity-v2",
      MSP_IDENTITY_HMAC_KEYRING: JSON.stringify({ "identity-v1": KEY_A }),
    });
    expect(config.key).toBe(KEY_B);
    expect(config.version).toBe("identity-v2");
    expect(config.keyring["identity-v1"]).toBe(KEY_A);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("treats an unset or empty-string retired-key ring as no retired generations", () => {
    for (const raw of [undefined, null, ""]) {
      const config = resolveIdentityHmacConfig({ MSP_IDENTITY_HMAC_KEY_VERSION: "identity-v1", MSP_IDENTITY_HMAC_KEYRING: raw });
      expect(Object.keys(config.keyring)).toEqual([]);
      expect(Object.getPrototypeOf(config.keyring)).toBeNull();
    }
    expect(() => resolveIdentityHmacConfig({ MSP_IDENTITY_HMAC_KEY_VERSION: "identity-v1", MSP_IDENTITY_HMAC_KEYRING: "{}" })).toThrow(
      /must not be empty/,
    );
  });

  it("rejects an invalid active version before the server opens its database", () => {
    expect(() => resolveIdentityHmacConfig({ MSP_IDENTITY_HMAC_KEY_VERSION: "v".repeat(IDENTITY_HMAC_KEY_VERSION_MAX_LENGTH + 1) })).toThrow(
      IdentityHmacKeyringConfigError,
    );
  });
});

// BL-MEMOS-049 (TASK-MEMOS-002 stage 2): pure unit/contract coverage of
// apps/msp-server/src/config/thread-service-keyring.mjs's parsing and
// validation -- no server, no DB, no I/O. The real-process, real-grant
// proof (a tenant-A key can never verify a tenant-B grant, a tenant missing
// from the keyring is refused, the old single key stops working once a
// keyring is configured) lives in
// tests/security/thread-service-keyring.security.mjs instead.
import { describe, expect, it } from "vitest";

import {
  parseThreadServiceKeyring,
  resolveThreadServiceKeyFor,
  ThreadServiceKeyringConfigError,
} from "../../apps/msp-server/src/config/thread-service-keyring.mjs";

const KEY_A = "tenant-a-service-key-0123456789ab"; // 33 chars
const KEY_B = "tenant-b-service-key-0123456789cd"; // 33 chars
const SHORT_KEY = "too-short";

describe("parseThreadServiceKeyring", () => {
  it("parses a well-formed keyring into a plain object", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ "tenant-a": KEY_A, "tenant-b": KEY_B }));
    expect(keyring).toEqual({ "tenant-a": KEY_A, "tenant-b": KEY_B });
  });

  it("accepts a keyring with a single tenant", () => {
    expect(parseThreadServiceKeyring(JSON.stringify({ solo: KEY_A }))).toEqual({ solo: KEY_A });
  });

  it("accepts an empty object -- a legal, if extreme, configuration where every tenant is refused", () => {
    expect(parseThreadServiceKeyring("{}")).toEqual({});
  });

  it("rejects invalid JSON", () => {
    expect(() => parseThreadServiceKeyring("{not json")).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring("{not json")).toThrow(/thread_keyring_config_invalid/);
  });

  it("rejects a JSON array", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify([KEY_A, KEY_B]))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a JSON string", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify(KEY_A))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a JSON number", () => {
    expect(() => parseThreadServiceKeyring("5")).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a JSON null", () => {
    expect(() => parseThreadServiceKeyring("null")).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a key shorter than 32 characters", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": SHORT_KEY }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": SHORT_KEY }))).toThrow(/at least 32 characters/);
  });

  it("rejects a non-string key value", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": 12345678901234567890123456789012 }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": null }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": [KEY_A] }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects an empty-string tenant id", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "": KEY_A }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a whitespace-only tenant id", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "   ": KEY_A }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("never includes the offending key's value in its error message", () => {
    try {
      parseThreadServiceKeyring(JSON.stringify({ "tenant-a": SHORT_KEY }));
      throw new Error("expected parseThreadServiceKeyring to throw");
    } catch (error) {
      expect(error.message).not.toContain(SHORT_KEY);
    }
  });
});

describe("resolveThreadServiceKeyFor", () => {
  it("opt-in: with MSP_THREAD_SERVICE_KEYRING unset, every tenant resolves to the single default key, unchanged", () => {
    const keyFor = resolveThreadServiceKeyFor({ MSP_THREAD_SERVICE_KEY: KEY_A });
    expect(keyFor("tenant-a")).toBe(KEY_A);
    expect(keyFor("tenant-b")).toBe(KEY_A);
    expect(keyFor(undefined)).toBe(KEY_A);
  });

  it("opt-in: an empty-string MSP_THREAD_SERVICE_KEYRING is treated the same as unset", () => {
    const keyFor = resolveThreadServiceKeyFor({ MSP_THREAD_SERVICE_KEY: KEY_A, MSP_THREAD_SERVICE_KEYRING: "" });
    expect(keyFor("tenant-a")).toBe(KEY_A);
  });

  it("once configured, resolves each tenant to its own key and never falls back to the single default", () => {
    const keyFor = resolveThreadServiceKeyFor({
      MSP_THREAD_SERVICE_KEY: KEY_A,
      MSP_THREAD_SERVICE_KEYRING: JSON.stringify({ "tenant-a": KEY_A, "tenant-b": KEY_B }),
    });
    expect(keyFor("tenant-a")).toBe(KEY_A);
    expect(keyFor("tenant-b")).toBe(KEY_B);
    // A tenant missing from the keyring resolves to undefined -- never the
    // single default key, even though it is present in env.
    expect(keyFor("tenant-c")).toBeUndefined();
  });

  it("fails closed at the point of resolution (server start), never silently falling back to the single key", () => {
    expect(() => resolveThreadServiceKeyFor({ MSP_THREAD_SERVICE_KEY: KEY_A, MSP_THREAD_SERVICE_KEYRING: "{not json" })).toThrow(
      ThreadServiceKeyringConfigError,
    );
  });
});

// BL-MEMOS-049 (TASK-MEMOS-002 stage 2): pure unit/contract coverage of
// apps/msp-server/src/config/thread-service-keyring.mjs's parsing and
// validation -- no server, no DB, no I/O. The real-process, real-grant
// proof (a tenant-A key can never verify a tenant-B grant, a tenant missing
// from the keyring is refused, the old single key stops working once a
// keyring is configured, and the CRITICAL secrecy checks against a real
// spawned process) lives in
// tests/security/thread-service-keyring.security.mjs instead.
import util from "node:util";

import { describe, expect, it } from "vitest";

import {
  parseThreadServiceKeyring,
  resolveThreadServiceKeyFor,
  ThreadServiceKeyringConfigError,
} from "../../apps/msp-server/src/config/thread-service-keyring.mjs";

const KEY_A = "tenant-a-service-key-0123456789ab"; // 34 chars
const KEY_B = "tenant-b-service-key-0123456789cd"; // 34 chars
const SHORT_KEY = "too-short";

describe("parseThreadServiceKeyring", () => {
  it("parses a well-formed keyring into a map", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ "tenant-a": KEY_A, "tenant-b": KEY_B }));
    expect(keyring["tenant-a"]).toBe(KEY_A);
    expect(keyring["tenant-b"]).toBe(KEY_B);
    expect(Object.keys(keyring).sort()).toEqual(["tenant-a", "tenant-b"]);
  });

  it("accepts a keyring with a single tenant", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ solo: KEY_A }));
    expect(keyring.solo).toBe(KEY_A);
  });

  // RKOI review, WARNING 1: reversed from the original stage-2 revision --
  // once configured, a keyring naming NO tenant can never be honoured
  // (every grant would be refused), so it is refused at the same
  // fail-closed point as any other malformed shape, not accepted as a
  // legal extreme.
  it("rejects an empty object", () => {
    expect(() => parseThreadServiceKeyring("{}")).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring("{}")).toThrow(/must not be empty/);
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

  it("rejects a key shorter than 32 characters, naming the entry by position only", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": SHORT_KEY }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": SHORT_KEY }))).toThrow(/entry 1.*at least 32 characters/);
  });

  it("rejects a non-string key value", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": 12345678901234567890123456789012 }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": null }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": [KEY_A] }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a nested-object key value", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": { k: KEY_A } }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects an empty-string tenant id", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "": KEY_A }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a whitespace-only tenant id", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "   ": KEY_A }))).toThrow(ThreadServiceKeyringConfigError);
  });

  // RKOI review, WARNING 1: a tenant id that differs from its own trimmed
  // form (leading/trailing whitespace) is refused outright -- never
  // silently trimmed, and never accepted as a distinct tenant from its
  // trimmed spelling.
  it("rejects a tenant id with leading or trailing whitespace", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ " tenant-a ": KEY_A }))).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(JSON.stringify({ " tenant-a ": KEY_A }))).toThrow(/leading or trailing whitespace/);
  });

  // RKOI review, WARNING 4: keep the >=32 length rule, but also refuse a
  // key with leading/trailing whitespace, and a whitespace-only key (which
  // is >=32 chars of nothing usable).
  it("rejects a key with leading or trailing whitespace", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": `  ${"x".repeat(30)}  ` }))).toThrow(ThreadServiceKeyringConfigError);
  });

  it("rejects a whitespace-only key even if it meets the length floor", () => {
    expect(() => parseThreadServiceKeyring(JSON.stringify({ "tenant-a": " ".repeat(32) }))).toThrow(ThreadServiceKeyringConfigError);
  });

  // RKOI review, WARNING 1: a JSON reviver -- and Object.entries, which
  // only ever sees the FINAL, already-deduplicated object -- cannot see a
  // duplicate top-level key. JSON.parse itself silently keeps only the
  // last occurrence during construction, before any reviver runs. This
  // must be caught by scanning the raw source's own key tokens.
  it("rejects a literal duplicate tenant id in the raw JSON", () => {
    expect(() => parseThreadServiceKeyring(`{"tenant-a":"${KEY_A}","tenant-a":"${KEY_B}"}`)).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(`{"tenant-a":"${KEY_A}","tenant-a":"${KEY_B}"}`)).toThrow(/duplicate tenant id/);
  });

  it("rejects an escaped-equivalent duplicate tenant id (a plain character vs its \\u escape)", () => {
    const raw = `{"tenant-a":"${KEY_A}","tenant\\u002da":"${KEY_B}"}`;
    expect(() => parseThreadServiceKeyring(raw)).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(raw)).toThrow(/duplicate tenant id/);
  });

  // RKOI review, CRITICAL: an inverted map (a secret key written where a
  // tenant id belongs) must never let that key surface anywhere an error
  // object exposes text -- not the message, not `cause`, not
  // util.inspect's rendering (which prints the message and stack, both
  // built from the same text this module produces).
  it("CRITICAL: an inverted map ({key: tenantId}) never echoes the key anywhere on the thrown error", () => {
    const invertedRaw = JSON.stringify({ [KEY_A]: "tenant-a" });
    let caught;
    try {
      parseThreadServiceKeyring(invertedRaw);
      throw new Error("expected parseThreadServiceKeyring to throw");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ThreadServiceKeyringConfigError);
    expect(caught.message).not.toContain(KEY_A);
    expect(caught.message).toMatch(/entry 1/);
    expect(util.inspect(caught)).not.toContain(KEY_A);
    expect(caught.stack ?? "").not.toContain(KEY_A);
    expect(caught).not.toHaveProperty("cause");
  });

  it("never includes the offending key's value in its error message (short-key case)", () => {
    try {
      parseThreadServiceKeyring(JSON.stringify({ "tenant-a": SHORT_KEY }));
      throw new Error("expected parseThreadServiceKeyring to throw");
    } catch (error) {
      expect(error.message).not.toContain(SHORT_KEY);
      expect(util.inspect(error)).not.toContain(SHORT_KEY);
    }
  });

  it("never includes a tenant id in any error message -- refers to the entry by position only", () => {
    try {
      parseThreadServiceKeyring(JSON.stringify({ "very-identifiable-tenant-name": SHORT_KEY }));
      throw new Error("expected parseThreadServiceKeyring to throw");
    } catch (error) {
      expect(error.message).not.toContain("very-identifiable-tenant-name");
      expect(error.message).toMatch(/entry 1/);
    }
  });

  it("builds the keyring with a null prototype, so a literal \"__proto__\" entry becomes an ordinary property, never a prototype reassignment", () => {
    // Computed key, deliberately -- a plain `{ __proto__: KEY_A }` object
    // LITERAL sets the prototype at construction time and produces NO
    // enumerable own property at all (`JSON.stringify` would serialize it
    // as `{}`). `["__proto__"]` forces a real own enumerable property,
    // matching what a JSON document actually contains on the wire.
    const keyring = parseThreadServiceKeyring(JSON.stringify({ ["__proto__"]: KEY_A }));
    expect(Object.getPrototypeOf(keyring)).toBeNull();
    expect(Object.hasOwn(keyring, "__proto__")).toBe(true);
    expect(keyring.__proto__).toBe(KEY_A);
  });

  it("accepts a literal \"constructor\" tenant id as an ordinary entry", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ constructor: KEY_A }));
    expect(Object.hasOwn(keyring, "constructor")).toBe(true);
    expect(keyring.constructor).toBe(KEY_A);
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

  // RKOI review, WARNING 2: looked up via Object.hasOwn against a
  // null-prototype map -- these must resolve to undefined directly, never
  // by accidentally returning an inherited Object.prototype member that a
  // downstream `typeof key !== "string"` check happens to also catch.
  it("resolves Object.prototype-shaped tenant ids to undefined when they are not actually configured", () => {
    const keyFor = resolveThreadServiceKeyFor({
      MSP_THREAD_SERVICE_KEYRING: JSON.stringify({ "tenant-a": KEY_A }),
    });
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "isPrototypeOf"]) {
      expect(keyFor(name)).toBeUndefined();
    }
  });

  it("still resolves a legitimately configured Object.prototype-shaped tenant id", () => {
    const keyFor = resolveThreadServiceKeyFor({
      MSP_THREAD_SERVICE_KEYRING: JSON.stringify({ ["__proto__"]: KEY_A, constructor: KEY_B }),
    });
    expect(keyFor("__proto__")).toBe(KEY_A);
    expect(keyFor("constructor")).toBe(KEY_B);
  });

  it("resolves a non-string tenantId claim to undefined, never throwing or coercing", () => {
    const keyFor = resolveThreadServiceKeyFor({ MSP_THREAD_SERVICE_KEYRING: JSON.stringify({ "tenant-a": KEY_A }) });
    expect(keyFor(["tenant-a"])).toBeUndefined();
    expect(keyFor(7)).toBeUndefined();
    expect(keyFor(null)).toBeUndefined();
  });

  it("fails closed at the point of resolution (server start), never silently falling back to the single key", () => {
    expect(() => resolveThreadServiceKeyFor({ MSP_THREAD_SERVICE_KEY: KEY_A, MSP_THREAD_SERVICE_KEYRING: "{not json" })).toThrow(
      ThreadServiceKeyringConfigError,
    );
  });
});

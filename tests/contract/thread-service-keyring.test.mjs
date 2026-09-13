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
  scanTopLevelObjectEntries,
  ThreadServiceKeyringConfigError,
} from "../../apps/msp-server/src/config/thread-service-keyring.mjs";

const KEY_A = "tenant-a-service-key-0123456789ab"; // 34 chars
const KEY_B = "tenant-b-service-key-0123456789cd"; // 34 chars
const SHORT_KEY = "too-short";
const QUOTE = '"';
const BACKSLASH = "\\";

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

// GHOST QA finding: on Node v24.19.0, V8's own JSON.parse has a real,
// reproducible engine bug -- after one object has been parsed, a LATER,
// differently-escaped object can come back from JSON.parse with a
// corrupted non-first key name (values are never affected). Concretely,
// parsing `{"-":K,"\\":K}` and then parsing `{"-":K,"\"":K}` in the same
// process can return the second object's second key as `\` instead of
// `"`. This module never trusted native JSON.parse for tenant id identity
// or order in the first place, but until now it DID still read each
// entry's VALUE via `parsed[tenantId]` -- indexing the native result
// object with a key name taken from this file's OWN independent scanner.
// A corrupted native key made that lookup silently miss, which surfaced
// as a false "must be a string" refusal: fail-closed, but wrong. These
// cases exercise exactly the identifiers GHOST's repro and fuzz found
// implicated (a literal quote, a literal backslash, an id ending in a
// backslash, and both orderings of the two together), plus the escaped-
// equivalent duplicate cases the fix must still catch, and the primed,
// cross-parse regression itself.
describe("parseThreadServiceKeyring: quote/backslash tenant ids (V8 JSON.parse non-first-key corruption)", () => {
  it('accepts a tenant id that is a literal quote (")', () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ [QUOTE]: KEY_A }));
    expect(Object.hasOwn(keyring, QUOTE)).toBe(true);
    expect(keyring[QUOTE]).toBe(KEY_A);
  });

  it("accepts a tenant id that is a literal backslash (\\)", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ [BACKSLASH]: KEY_A }));
    expect(Object.hasOwn(keyring, BACKSLASH)).toBe(true);
    expect(keyring[BACKSLASH]).toBe(KEY_A);
  });

  it("accepts a tenant id ending in a backslash", () => {
    const id = "a" + BACKSLASH;
    const keyring = parseThreadServiceKeyring(JSON.stringify({ [id]: KEY_A }));
    expect(Object.hasOwn(keyring, id)).toBe(true);
    expect(keyring[id]).toBe(KEY_A);
  });

  it("accepts quote-then-backslash as two ids in one keyring, each with its own correct key", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ [QUOTE]: KEY_A, [BACKSLASH]: KEY_B }));
    expect(keyring[QUOTE]).toBe(KEY_A);
    expect(keyring[BACKSLASH]).toBe(KEY_B);
  });

  it("accepts backslash-then-quote as two ids in one keyring, each with its own correct key", () => {
    const keyring = parseThreadServiceKeyring(JSON.stringify({ [BACKSLASH]: KEY_A, [QUOTE]: KEY_B }));
    expect(keyring[BACKSLASH]).toBe(KEY_A);
    expect(keyring[QUOTE]).toBe(KEY_B);
  });

  it("refuses a quote id written as \\u0022 as a duplicate of the same character written as a literal \\\" escape", () => {
    const raw = `{"\\u0022":"${KEY_A}","\\"":"${KEY_B}"}`;
    expect(() => parseThreadServiceKeyring(raw)).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(raw)).toThrow(/duplicate tenant id/);
  });

  it("refuses a surrogate-pair-escaped emoji id as a duplicate of the literal emoji", () => {
    const raw = `{"\\ud83d\\ude00":"${KEY_A}","\u{1F600}":"${KEY_B}"}`;
    expect(() => parseThreadServiceKeyring(raw)).toThrow(ThreadServiceKeyringConfigError);
    expect(() => parseThreadServiceKeyring(raw)).toThrow(/duplicate tenant id/);
  });

  // The regression test for the V8 engine bug itself: a first parse call
  // "primes" the engine with a backslash-shaped key, then a second,
  // differently-escaped parse call in the SAME process must still come
  // back correct. This only reproduces when both calls run in the same
  // process (a fresh child process is a fresh V8 instance, which is why
  // this lives here, in-process, rather than as a security/real-process
  // case). Confirmed against the pre-fix implementation (which read
  // `parsed[tenantId]` off the native JSON.parse result): it threw
  // "entry 2's key must be a string" for the second call, because V8
  // handed back the corrupted key `\` instead of `"` for that object's
  // second entry, so `parsed['"']` was `undefined`. This test fails
  // against that implementation and passes against this file's current
  // one.
  it("PRIMED regression: a later, differently-escaped keyring still parses correctly after an earlier backslash-shaped one", () => {
    const priming = JSON.stringify({ "-": KEY_A, [BACKSLASH]: KEY_B });
    const target = JSON.stringify({ "-": KEY_A, [QUOTE]: KEY_B });

    const primed = parseThreadServiceKeyring(priming);
    expect(primed[BACKSLASH]).toBe(KEY_B);

    const result = parseThreadServiceKeyring(target);
    expect(Object.hasOwn(result, QUOTE)).toBe(true);
    expect(result[QUOTE]).toBe(KEY_B);
  });
});

// A short, fast, deterministic (seeded) fuzz pass using this module's own
// scanTopLevelObjectEntries as an INDEPENDENT oracle -- never native
// JSON.parse's Object.keys/Object.entries, which is exactly what this
// investigation showed can be corrupted across calls in this engine.
// Mirrors GHOST's much larger scratch fuzz (20,000 trials, 0 failures);
// this one keeps the trial count small enough to run in the normal suite.
describe("parseThreadServiceKeyring: fuzz (independent-oracle, deterministic seed)", () => {
  it("0 false refusals, 0 missed duplicates, 0 key mismatches across 3000 generated keyrings", () => {
    const B = "\\";
    const Q = '"';
    const NL = "\n";
    const TAB = "\t";
    let seed = 246813579;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const u = (code) => B + "u" + code.toString(16).padStart(4, "0");
    const shortEsc = { [Q]: B + Q, [B]: B + B, "/": B + "/", [NL]: B + "n", [TAB]: B + "t" };
    const encChar = (ch) => {
      if (ch.length === 2) return rnd(2) ? ch : u(ch.charCodeAt(0)) + u(ch.charCodeAt(1));
      const needs = ch === Q || ch === B || ch.charCodeAt(0) < 32;
      const r = rnd(4);
      if (r === 0 && !needs) return ch;
      if (r === 1) return u(ch.charCodeAt(0));
      if (r === 2) return u(ch.charCodeAt(0)).toUpperCase().replace(B + "U", B + "u");
      return shortEsc[ch] ?? (needs ? u(ch.charCodeAt(0)) : ch);
    };
    const encodeKey = (k) => Q + [...k].map(encChar).join("") + Q;
    const alphabet = ["a", "b", "-", "/", Q, B, "{", "}", "[", "]", ":", ",", " ", TAB, NL, "é", "😀", "_", "x"];
    const genId = () => {
      let s = "";
      const n = 1 + rnd(8);
      for (let i = 0; i < n; i++) s += alphabet[rnd(alphabet.length)];
      if (s.trim() !== s || s.trim() === "") s = "t" + s.trim() + "t";
      return s;
    };
    const key = () => Q + "K".repeat(32) + rnd(1e6) + Q;

    const trials = 3000;
    let dupCases = 0;
    const failures = [];
    for (let t = 0; t < trials; t++) {
      const ids = [];
      const n = 1 + rnd(5);
      while (ids.length < n) {
        const id = genId();
        if (!ids.includes(id)) ids.push(id);
      }
      const entries = ids.map((id) => ({ id }));
      const dup = rnd(3) === 0;
      if (dup) {
        entries.splice(rnd(entries.length + 1), 0, { id: entries[rnd(entries.length)].id });
        dupCases++;
      }
      const raw =
        "{" +
        entries
          .map((e) => {
            const ws = [" ", NL, TAB, ""][rnd(4)];
            return ws + encodeKey(e.id) + ws + ":" + ws + key() + ws;
          })
          .join(",") +
        "}";
      try {
        JSON.parse(raw);
      } catch {
        continue; // must be syntactically valid JSON to reach the parser at all
      }

      const oracleEntries = scanTopLevelObjectEntries(raw);
      const oracleIds = oracleEntries.map((e) => e.tenantId);
      const oracleHasDup = new Set(oracleIds).size !== oracleIds.length;

      let result;
      let err;
      try {
        result = parseThreadServiceKeyring(raw);
      } catch (e) {
        err = e;
      }
      if (oracleHasDup) {
        if (!err || !/duplicate/.test(err.message)) failures.push({ tag: "MISSED-DUP", raw });
      } else if (err) {
        failures.push({ tag: "FALSE-REFUSE", raw, message: err.message });
      } else {
        const expectedKeys = [...new Set(oracleIds)].sort().join("|");
        const actualKeys = Object.keys(result).sort().join("|");
        if (expectedKeys !== actualKeys) failures.push({ tag: "KEY-MISMATCH", raw });
      }
    }
    expect(dupCases).toBeGreaterThan(0); // sanity: the generator actually exercises duplicates
    expect(failures.slice(0, 5)).toEqual([]);
    expect(failures).toHaveLength(0);
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

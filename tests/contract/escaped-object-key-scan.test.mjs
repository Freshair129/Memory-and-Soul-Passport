// RKOI ruling (merge-blocking, TASK-MEMOS-002 stage 2): pure unit/contract
// coverage of the engine-independent scanner both
// apps/msp-server/src/transport/escaped-object-key-scan.mjs and
// packages/msp-client-js/src/escaped-object-key-scan.mjs (a deliberate,
// byte-for-byte duplicate -- msp-client-js must stay standalone) use to
// refuse any raw JSON line whose object keys contain an escape sequence,
// BEFORE the real (V8-engine-bugged) JSON.parse ever runs on it. The
// real-process proof (a priming request followed by an escaped-non-first-
// key request is refused at the transport, nothing is stored, the vault is
// unchanged) lives in tests/security/transport-json-parse-hardening.security.mjs;
// the client-side real-process equivalent lives in
// tests/integration/msp-client-escaped-key-scan.test.mjs.
import { describe, expect, it } from "vitest";

import { containsEscapedObjectKey as serverScan } from "../../apps/msp-server/src/transport/escaped-object-key-scan.mjs";
import { containsEscapedObjectKey as clientScan } from "../../packages/msp-client-js/src/escaped-object-key-scan.mjs";

const scanners = { server: serverScan, client: clientScan };

describe.each(Object.entries(scanners))("containsEscapedObjectKey (%s)", (_label, scan) => {
  it("accepts a plain object with no escapes anywhere", () => {
    expect(scan('{"a":"b","c":1,"d":[1,2,3],"e":{"f":"g"}}')).toBe(false);
  });

  it("accepts escapes inside a VALUE (top level)", () => {
    expect(scan('{"a":"line1\\nline2"}')).toBe(false);
    expect(scan('{"a":"quote:\\""}')).toBe(false);
    expect(scan('{"a":"back\\\\slash"}')).toBe(false);
    expect(scan('{"a":"unicode:\\u0041"}')).toBe(false);
  });

  it("refuses an escape inside a top-level KEY", () => {
    expect(scan('{"a\\n":"b"}')).toBe(true);
    expect(scan('{"a\\\\":"b"}')).toBe(true);
    expect(scan('{"\\u0041":"b"}')).toBe(true);
  });

  it("refuses an escape inside a key nested at depth > 1 (object)", () => {
    expect(scan('{"outer":{"inner\\n":"v"}}')).toBe(true);
    expect(scan('{"outer":{"mid":{"deep\\t":"v"}}}')).toBe(true);
  });

  it("refuses an escape inside a key nested inside an array element", () => {
    expect(scan('{"outer":[{"a\\n":"v"}]}')).toBe(true);
    expect(scan('{"outer":[1,2,{"a":1,"b\\n":2}]}')).toBe(true);
  });

  it("accepts a key with a literal (unescaped) non-ASCII character -- Thai and emoji", () => {
    expect(scan('{"ข้อความ":"v"}')).toBe(false);
    expect(scan('{"😀":"v"}')).toBe(false);
    expect(scan('{"café":"v"}')).toBe(false); // literal é, not é
  });

  it("does not confuse a value containing colons, quotes and braces for structure", () => {
    // A value string containing `":`  and brace/bracket characters must not
    // be mistaken for a new key, object, or array boundary.
    const raw = '{"a":"x\\":{}[],y","b":"ok"}';
    expect(scan(raw)).toBe(false);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("accepts a first-position key with an escape only if EVERY other key also merely happens to have none -- still flags it (first-position keys are checked too, defense-in-depth beyond RKOI's narrower finding)", () => {
    expect(scan('{"a\\n":"only key"}')).toBe(true);
  });

  it("does not throw on malformed/non-JSON input -- lets the real JSON.parse report that separately", () => {
    expect(() => scan("not json at all")).not.toThrow();
    expect(() => scan("{unterminated")).not.toThrow();
    expect(() => scan("")).not.toThrow();
  });

  it("refuses the exact shapes from RKOI's real-server probe", () => {
    const K = "K".repeat(40);
    const primer = JSON.stringify({ "-": K, "\\": K });
    const target = JSON.stringify({ "-": K, '"': K });
    expect(scan(primer)).toBe(true);
    expect(scan(target)).toBe(true);
  });
});

// Both copies must behave identically -- if they ever drift, the client
// and server would disagree about what is safe to parse.
describe("server and client scanners agree", () => {
  const cases = [
    '{"a":"b"}',
    '{"a\\n":"b"}',
    '{"a":{"b\\n":"c"}}',
    '{"a":[{"b\\n":"c"}]}',
    '{"é":"x","😀":"y"}',
    '{"a":"x\\":y{}[]"}',
    "not json",
    '{"-":"K","\\\\":"K"}',
    '{"-":"K","\\"":"K"}',
  ];
  it.each(cases)("%s", (raw) => {
    expect(serverScan(raw)).toBe(clientScan(raw));
  });
});

// A short, fast, deterministic (seeded) fuzz pass: the generator itself
// tracks ground truth (whether ANY key it emitted was escape-encoded) as
// it builds the JSON text, which is an INDEPENDENT reference -- never a
// second call to JSON.parse or to the scanner under test.
describe("containsEscapedObjectKey: fuzz (independent ground truth, deterministic seed)", () => {
  it("both scanners agree with ground truth across 3000 generated documents", () => {
    let seed = 135791113;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const B = "\\";
    const Q = '"';
    const u = (code) => B + "u" + code.toString(16).padStart(4, "0");
    const idChars = ["a", "b", "c", "-", "_", "é", "😀", "ก"];
    // Returns { text, escaped } for one identifier, encoded either as a
    // literal (never escaped, even for non-ASCII) or with a \u escape for
    // every character (always escaped) -- ground truth tracked directly.
    function genIdent() {
      const n = 1 + rnd(4);
      let chars = "";
      for (let i = 0; i < n; i++) chars += idChars[rnd(idChars.length)];
      const escape = rnd(2) === 0;
      if (!escape) return { text: chars, escaped: false };
      let out = "";
      for (const ch of chars) {
        const code = ch.codePointAt(0);
        if (code > 0xffff) {
          const c = code - 0x10000;
          out += u(0xd800 + (c >> 10)) + u(0xdc00 + (c & 0x3ff));
        } else {
          out += u(code);
        }
      }
      return { text: out, escaped: true };
    }
    function genValue(depth) {
      const kind = depth > 2 ? 0 : rnd(4);
      if (kind === 0) return { text: Q + "v" + rnd(1000) + Q, escapedKey: false };
      if (kind === 1) {
        const n = 1 + rnd(3);
        const fields = [];
        let escapedKey = false;
        for (let i = 0; i < n; i++) {
          const id = genIdent();
          if (id.escaped) escapedKey = true;
          const val = genValue(depth + 1);
          if (val.escapedKey) escapedKey = true;
          fields.push(Q + id.text + Q + ":" + val.text);
        }
        return { text: "{" + fields.join(",") + "}", escapedKey };
      }
      if (kind === 2) {
        const n = rnd(3);
        const items = [];
        let escapedKey = false;
        for (let i = 0; i < n; i++) {
          const val = genValue(depth + 1);
          if (val.escapedKey) escapedKey = true;
          items.push(val.text);
        }
        return { text: "[" + items.join(",") + "]", escapedKey };
      }
      return { text: String(rnd(1000)), escapedKey: false };
    }

    const trials = 3000;
    const failures = [];
    for (let t = 0; t < trials; t++) {
      const doc = genValue(0);
      let parsedOk = true;
      try {
        JSON.parse(doc.text);
      } catch {
        parsedOk = false;
      }
      if (!parsedOk) continue; // ground truth is only meaningful for valid JSON
      const serverResult = serverScan(doc.text);
      const clientResult = clientScan(doc.text);
      if (serverResult !== doc.escapedKey || clientResult !== doc.escapedKey) {
        failures.push({ doc: doc.text.slice(0, 120), expected: doc.escapedKey, serverResult, clientResult });
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(failures).toHaveLength(0);
  });
});

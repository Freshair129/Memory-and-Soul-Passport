// JANUS CI canary (workspace / packaging / runtime config): the running
// engine's OWN V8 `JSON.parse` non-first-key corruption bug, recorded in
// docs/NOTES.md ("V8 `JSON.parse` non-first-key corruption on Node
// v24.19.0") and RKOI-bisected across engine versions:
//
//   Node <= 22.23 (V8 <= 12.4-era)                       -- clean
//   Node 23 through at least 26.8 (V8 12.4-12.9-era),
//     including this workspace's Node 24.19.0            -- affected
//
// This is not a bug this repo can fix (it lives in V8, not in MSP), so this
// test's job is narrower than "prove the engine is correct": it must MAKE
// engine divergence visible in CI (this file's own name and console line
// carry `process.version`/`process.versions.v8`/`affected` into ordinary
// test output on every matrix leg, clean or affected) and, on an affected
// engine, PROVE the two shipped mitigations are doing their job, rather
// than silently trusting that they still are:
//
//   1. apps/msp-server/src/transport/escaped-object-key-scan.mjs's
//      `containsEscapedObjectKey` -- the transport pre-scan that refuses any
//      inbound JSON line whose object keys contain a backslash escape,
//      before the real (potentially engine-bugged) `JSON.parse` ever runs.
//   2. apps/msp-server/src/config/thread-service-keyring.mjs's
//      `parseThreadServiceKeyring` -- which must decode a keyring's tenant
//      ids and values from the RAW text, never from the native
//      `JSON.parse` object's own (potentially corrupted) keys.
//
// This canary must NEVER fail CI just because the running engine is
// affected -- MSP is mitigated, and a red canary on every Node 23+ leg
// forever would just get ignored. It DOES fail if: the affected-engine
// branch's own detection throws (an unreadable engine state is a hard
// failure, never treated as "clean"), or either mitigation is missing,
// reverted, or broken while the engine is affected.
import { describe, expect, it } from "vitest";

import { containsEscapedObjectKey } from "../../apps/msp-server/src/transport/escaped-object-key-scan.mjs";
import { parseThreadServiceKeyring } from "../../apps/msp-server/src/config/thread-service-keyring.mjs";

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
// >= thread-service-keyring.mjs's MIN_KEY_LENGTH (32); reusing RKOI's own
// repro constant rather than inventing a new one.
const VALUE = "K".repeat(33);

// The exact trigger shape from docs/NOTES.md's repro: a two-key object whose
// FIRST key is a plain "-" and whose SECOND key is `e`, raw (not
// pre-escaped) -- `e` is inserted verbatim between the second pair of
// quotes, so the CALLER controls exactly which escape sequence, if any,
// lands in source position.
function mk(e) {
  return "{" + QUOTE + "-" + QUOTE + ":" + QUOTE + VALUE + QUOTE + "," + QUOTE + e + QUOTE + ":" + QUOTE + VALUE + QUOTE + "}";
}

// Detects whether the CURRENT engine exhibits the corruption. Mirrors
// docs/NOTES.md's repro precisely:
//   - priming call:  second key's raw source is `\\` (decoded: one
//     backslash) -- the trigger requires the earlier key to end in a
//     backslash.
//   - target call:   second key's raw source is `\"` (decoded: one double
//     quote). On a clean engine, `Object.keys(...)[1]` is that decoded
//     quote character (code point 34). On an affected engine it instead
//     comes back as the PRIMER's own key -- a bare backslash (code point
//     92).
function detectAffected() {
  JSON.parse(mk(BACKSLASH + BACKSLASH));
  const secondKey = Object.keys(JSON.parse(mk(BACKSLASH + QUOTE)))[1];
  return secondKey.charCodeAt(0) === BACKSLASH.charCodeAt(0);
}

let affected;
try {
  affected = detectAffected();
} catch (err) {
  // Detection itself must never be treated as "clean" just because it threw
  // -- surface it as a hard, unmissable module-load failure instead.
  throw new Error(`engine-json-parse-canary: detection threw before any test ran (node=${process.version}, v8=${process.versions.v8}): ${err && err.stack ? err.stack : String(err)}`);
}

// Visible in every CI run, on every matrix leg, clean or affected -- this is
// the line the CI job step greps for to fill $GITHUB_STEP_SUMMARY.
// eslint-disable-next-line no-console
console.log(`[engine-json-parse-canary] node=${process.version} v8=${process.versions.v8} affected=${affected}`);

describe("engine canary: V8 JSON.parse non-first-key corruption (docs/NOTES.md)", () => {
  it(`records engine status without failing CI (node=${process.version}, v8=${process.versions.v8}, affected=${affected})`, () => {
    // Always runs, on every engine -- exists purely so the affected/clean
    // status above is attached to a named, always-collected test result,
    // never just a console line that could scroll past unnoticed.
    expect(typeof affected).toBe("boolean");
  });

  // The only branch allowed to fail CI: on an affected engine, MSP's own
  // mitigations (RKOI ruling, TASK-MEMOS-002 stage 2) must be active and
  // correct. `skipIf` marks this annotation-visible (reported as "skipped"
  // rather than silently absent) on a clean engine, where it does not apply.
  it.skipIf(!affected)("on an affected engine, the transport pre-scan and keyring parser mitigations are active", () => {
    // Mitigation 1: the transport pre-scan refuses a non-first escaped key
    // in the exact trigger shape, before the real JSON.parse ever sees it.
    expect(containsEscapedObjectKey(mk(BACKSLASH + QUOTE))).toBe(true);
    // Escapes inside VALUES must remain fully accepted -- the pre-scan must
    // never over-refuse ordinary data.
    expect(containsEscapedObjectKey('{"a":"x","b":"has\\nescape"}')).toBe(false);

    // Mitigation 2: the keyring parser must decode the SECOND tenant id from
    // the raw text, never from the (potentially corrupted) native
    // JSON.parse object -- re-primed immediately beforehand so this
    // assertion does not depend on engine state left over from detection.
    JSON.parse(mk(BACKSLASH + BACKSLASH));
    const keyring = parseThreadServiceKeyring(mk(BACKSLASH + QUOTE));
    expect(keyring["-"]).toBe(VALUE);
    expect(keyring[QUOTE]).toBe(VALUE);
    expect(Object.hasOwn(keyring, BACKSLASH)).toBe(false);
  });

  // The mirror-image annotation on a clean engine: reported as "skipped"
  // there, so CI output always shows exactly one of these two branches ran.
  it.skipIf(affected)("on a clean engine, no mitigation proof is required here", () => {
    expect(affected).toBe(false);
  });
});

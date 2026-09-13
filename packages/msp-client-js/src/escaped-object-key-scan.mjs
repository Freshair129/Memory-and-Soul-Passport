// DUPLICATE, DELIBERATE: byte-for-byte the same scanner as
// apps/msp-server/src/transport/escaped-object-key-scan.mjs. This package
// must stay dependency-free and standalone (it is published and consumed
// outside this monorepo), so it never imports across the package boundary
// -- see msp-stdio-transport.mjs's own use of this file for why the CLIENT
// needs the identical scan applied to what IT parses.
//
// RKOI ruling (merge-blocking for TASK-MEMOS-002 stage 2): a real V8 engine
// regression (introduced between V8 12.4 and 12.9; Node <=22.23 is clean,
// Node 23 through at least 26.8 -- including this workspace's 24.19.0 -- is
// affected) can hand JSON.parse's CALLER a corrupted object key. The
// trigger is narrow (a non-first object key containing an escape sequence,
// after an earlier parse in the SAME process shared the same leading
// key(s)), but RKOI proved real damage on the real server: one tenant's
// `msp_memory_upsert` body can corrupt a LATER, unrelated tenant's upsert
// body -- the corrupted key is what gets persisted and read back, inside
// the second tenant's own vault. Values, and a key in first position, are
// never affected; there is no isolation or auth bypass (every scope
// decision reads VALUES, a corrupted key can never become a clean
// identifier, and grant corruption fails closed as a MAC mismatch) -- but
// storing the wrong key under the right vault is still real damage. The
// same engine bug applies equally to any long-lived process that calls
// JSON.parse repeatedly -- including this client, parsing the server's own
// responses -- which is why this side needs the identical defense, not
// just the server.
//
// The only reliable, engine-independent mitigation is to never hand this
// engine's JSON.parse an object key that needed an escape sequence at all.
// This module is a small, pure, recursive-descent SCANNER (never a parser:
// it never builds a value, only walks the text) over raw JSON text,
// answering one question -- does any object key, at any nesting depth,
// contain a backslash escape? -- before the real `JSON.parse` ever runs.
// Escapes inside VALUES are completely unaffected and remain allowed
// (matching RKOI's finding that only a KEY can be corrupted). A raw,
// literal non-ASCII character in a key (Thai, emoji, anything JSON never
// requires escaping) is not a "backslash escape" and is accepted --
// `JSON.stringify` does not escape those by default, so ordinary user data
// keeps working; only a key that genuinely needed `\n`/`\"`/`\\`/`\uXXXX`
// etc. is refused.
//
// This file has no SQL, no DB, no env reads -- pure text scanning, safe to
// duplicate verbatim into packages/msp-client-js (which must stay
// dependency-free and standalone; see that package's own copy) rather than
// import across the package boundary.

const OPEN_BRACE = "{";
const CLOSE_BRACE = "}";
const OPEN_BRACKET = "[";
const CLOSE_BRACKET = "]";
const QUOTE = '"';
const COMMA = ",";
const COLON = ":";
const BACKSLASH = "\\";

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Scans raw JSON text and reports whether ANY object key, at any nesting
 * depth, contains a backslash escape sequence in its raw source span.
 * Deliberately tolerant of malformed input: this function's only job is to
 * flag a real risk in text that WILL be handed to the real `JSON.parse`
 * next -- if the text is not valid JSON at all, `JSON.parse` itself will
 * reject it with its own (pre-existing, unrelated) error, so a scan that
 * cannot make sense of malformed text simply stops and reports whatever it
 * found so far, rather than throwing a scanner-specific exception into a
 * caller that only expects "true" or "false".
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function containsEscapedObjectKey(raw) {
  const len = raw.length;
  let i = 0;
  let found = false;

  function skipWhitespace() {
    while (i < len && isWhitespace(raw[i])) i++;
  }

  // Consumes a string literal starting at raw[i] === '"'. Never decodes
  // escape sequences (this scanner only ever needs to know THAT a
  // backslash occurred in a key's raw span, never what it decodes to) --
  // it only needs correct traversal so brace/bracket/quote characters
  // inside the string are never mistaken for structural tokens.
  function consumeStringLiteral() {
    let hadBackslash = false;
    i++; // opening quote
    while (i < len) {
      const ch = raw[i];
      if (ch === BACKSLASH) {
        hadBackslash = true;
        i += 2; // the escaped character is never re-examined as its own token
        continue;
      }
      if (ch === QUOTE) {
        i++; // closing quote
        break;
      }
      i++;
    }
    return hadBackslash;
  }

  // Consumes one JSON value at raw[i]. For an object, every key's raw
  // string literal is checked; every value (string, number, boolean,
  // null, nested object/array) is only ever traversed, never checked.
  function consumeValue() {
    skipWhitespace();
    const ch = raw[i];
    if (ch === QUOTE) {
      consumeStringLiteral(); // a value string -- escapes here are fine
      return;
    }
    if (ch === OPEN_BRACE) {
      i++; // consume '{'
      skipWhitespace();
      if (raw[i] === CLOSE_BRACE) {
        i++;
        return;
      }
      while (i < len) {
        skipWhitespace();
        if (raw[i] !== QUOTE) return; // malformed; JSON.parse will reject it
        if (consumeStringLiteral()) found = true; // this string is a KEY
        skipWhitespace();
        if (raw[i] === COLON) i++;
        consumeValue();
        skipWhitespace();
        if (raw[i] === COMMA) {
          i++;
          continue;
        }
        if (raw[i] === CLOSE_BRACE) {
          i++;
        }
        return;
      }
      return;
    }
    if (ch === OPEN_BRACKET) {
      i++; // consume '['
      skipWhitespace();
      if (raw[i] === CLOSE_BRACKET) {
        i++;
        return;
      }
      while (i < len) {
        consumeValue();
        skipWhitespace();
        if (raw[i] === COMMA) {
          i++;
          continue;
        }
        if (raw[i] === CLOSE_BRACKET) {
          i++;
        }
        return;
      }
      return;
    }
    // number / true / false / null -- no escapes possible, nothing to check
    while (i < len && raw[i] !== COMMA && raw[i] !== CLOSE_BRACE && raw[i] !== CLOSE_BRACKET && !isWhitespace(raw[i])) i++;
  }

  consumeValue();
  return found;
}

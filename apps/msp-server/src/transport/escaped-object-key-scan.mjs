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
// storing the wrong key under the right vault is still real damage.
//
// The only reliable, engine-independent mitigation is to never hand this
// engine's JSON.parse an object key that needed an escape sequence at all.
// This module is a small, pure SCANNER (never a parser: it never builds a
// value, only walks the text) over raw JSON text, answering one question --
// does any object key, at any nesting depth, contain a backslash escape? --
// before the real `JSON.parse` ever runs. Escapes inside VALUES are
// completely unaffected and remain allowed (matching RKOI's finding that
// only a KEY can be corrupted). A raw, literal non-ASCII character in a key
// (Thai, emoji, anything JSON never requires escaping) is not a "backslash
// escape" and is accepted -- `JSON.stringify` does not escape those by
// default, so ordinary user data keeps working; only a key that genuinely
// needed `\n`/`\"`/`\\`/`\uXXXX` etc. is refused.
//
// RKOI review (stage-2 revision, CRITICAL): the original version of this
// scanner was RECURSIVE (one JS function call per nesting level), and its
// only caller (stdio-jsonrpc-server.mjs's `rl.on("line", ...)`) had no
// try/catch around it. A single ~40 KB line of ~20,000 nested arrays blew
// the call stack (`RangeError: Maximum call stack size exceeded`),
// uncaught, inside a synchronous event-emitter callback -- readline does
// not wrap listener exceptions, so the whole server process crashed and
// never answered another request. The pre-existing stage-1 transport
// (before this scanner existed at all) had no such limit and handled the
// identical line. Fixed two ways, independently, so a defect in one layer
// cannot regress the other into a crash again:
//   1. This function is now ITERATIVE, with an explicit array-based stack
//      standing in for the JS call stack that recursion used to consume --
//      arbitrarily deep nesting (RKOI's probe used 100,000) costs heap, not
//      call-stack frames, and V8's heap for a stack array of tags is not a
//      practical DoS surface for a request this transport already accepts
//      as syntactically plausible JSON.
//   2. The function's own body is wrapped in try/catch: ANY internal
//      error -- a defect in this state machine, an unexpected engine
//      limit, anything at all -- is treated as "refuse this line," never
//      allowed to escape as an exception. This function's contract to
//      every caller is now unconditional: it always returns a boolean, and
//      never throws.
// Key/value classification is unchanged from the recursive version (RKOI's
// re-run of the original 20,000-case fuzz against this rewrite: 0 wrong
// classifications) -- only the traversal mechanism changed.
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

// Stack-frame tags. Every frame is exactly one of these two container
// kinds; the scanner's current "mode" (see below) tracks phase within a
// frame, so no richer per-frame state is needed.
const FRAME_ARRAY = "ARR";
const FRAME_OBJECT = "OBJ";

// Scanner "mode" -- what should be consumed next, replacing the recursive
// version's implicit call-stack position:
//   VALUE    -- consume the START of a JSON value at raw[i] (string,
//               number/true/false/null, or an opening '{'/'[' that pushes
//               a new frame and immediately becomes VALUE again for that
//               container's first element, or OBJECT_KEY for its first
//               key).
//   OBJECT_KEY -- consume a key string (or '}' via the empty-object
//               fast path already handled at push time) inside the
//               object frame currently on top of the stack.
//   CONTINUE -- a full value was just consumed (simple, or a container
//               that fully closed); look at the frame now on top of the
//               stack (if any) to decide whether a ',' or the closing
//               bracket/brace comes next.
const MODE_VALUE = 0;
const MODE_OBJECT_KEY = 1;
const MODE_CONTINUE = 2;

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
 * found so far.
 *
 * Never throws (see the CRITICAL header note above): any unexpected
 * internal failure is treated as a refusal (`true`), the same fail-closed
 * default this scanner already uses for malformed/truncated input.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function containsEscapedObjectKey(raw) {
  try {
    return scan(raw);
  } catch {
    // Never let a defect in this scanner become an uncaught exception
    // inside a caller's synchronous event handler (stdio-jsonrpc-server.mjs,
    // the client's own stdout listener) -- refuse the line instead of
    // crashing the process that was trying to protect itself.
    return true;
  }
}

function scan(raw) {
  const len = raw.length;
  let i = 0;
  let found = false;
  const stack = [];
  let mode = MODE_VALUE;

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

  for (;;) {
    if (mode === MODE_VALUE) {
      skipWhitespace();
      if (i >= len) return found; // truncated; JSON.parse will reject it
      const ch = raw[i];
      if (ch === QUOTE) {
        consumeStringLiteral(); // a value string -- escapes here are fine
        mode = MODE_CONTINUE;
        continue;
      }
      if (ch === OPEN_BRACE) {
        i++; // consume '{'
        skipWhitespace();
        if (raw[i] === CLOSE_BRACE) {
          i++; // empty object
          mode = MODE_CONTINUE;
          continue;
        }
        stack.push(FRAME_OBJECT);
        mode = MODE_OBJECT_KEY;
        continue;
      }
      if (ch === OPEN_BRACKET) {
        i++; // consume '['
        skipWhitespace();
        if (raw[i] === CLOSE_BRACKET) {
          i++; // empty array
          mode = MODE_CONTINUE;
          continue;
        }
        stack.push(FRAME_ARRAY);
        mode = MODE_VALUE; // first element
        continue;
      }
      // number / true / false / null -- no escapes possible, nothing to
      // check.
      while (i < len && raw[i] !== COMMA && raw[i] !== CLOSE_BRACE && raw[i] !== CLOSE_BRACKET && !isWhitespace(raw[i])) i++;
      mode = MODE_CONTINUE;
      continue;
    }

    if (mode === MODE_OBJECT_KEY) {
      skipWhitespace();
      if (raw[i] !== QUOTE) return found; // malformed; JSON.parse will reject it
      if (consumeStringLiteral()) found = true; // this string is a KEY
      skipWhitespace();
      if (raw[i] === COLON) i++;
      mode = MODE_VALUE; // the value for this key; CONTINUE handles what follows
      continue;
    }

    // mode === MODE_CONTINUE
    if (stack.length === 0) return found; // the single top-level value is fully consumed
    const top = stack[stack.length - 1];
    skipWhitespace();
    if (top === FRAME_ARRAY) {
      if (raw[i] === COMMA) {
        i++;
        mode = MODE_VALUE;
        continue;
      }
      if (raw[i] === CLOSE_BRACKET) {
        i++;
        stack.pop();
        mode = MODE_CONTINUE;
        continue;
      }
      return found; // malformed; JSON.parse will reject it
    }
    // top === FRAME_OBJECT
    if (raw[i] === COMMA) {
      i++;
      mode = MODE_OBJECT_KEY;
      continue;
    }
    if (raw[i] === CLOSE_BRACE) {
      i++;
      stack.pop();
      mode = MODE_CONTINUE;
      continue;
    }
    return found; // malformed; JSON.parse will reject it
  }
}

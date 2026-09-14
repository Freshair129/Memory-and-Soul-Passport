// RKOI ruling (merge-blocking, TASK-MEMOS-002 stage 2): the same V8
// JSON.parse engine bug that can corrupt an object key on the server side
// (apps/msp-server/src/transport/escaped-object-key-scan.mjs's header
// comment has the full finding) applies equally to this long-lived CLIENT
// process, parsing the server's own responses. This proves
// packages/msp-client-js/src/msp-stdio-transport.mjs's two pre-scan call
// sites (the inbound response line, and the `content[].text` JSON.parse
// fallback) both refuse a response whose object keys contain an escape
// sequence, before the real JSON.parse ever runs -- using a minimal,
// caller-controlled fixture server (tests/integration/fixtures/
// escaped-key-stdio-server.mjs) so the test can choose the EXACT wire
// bytes of a response, not whatever JSON.stringify would produce.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createMspStdioCaller } from "../../packages/msp-client-js/src/msp-stdio-transport.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "escaped-key-stdio-server.mjs");

function spawnFixture() {
  return createMspStdioCaller({ command: process.execPath, args: [serverPath], timeoutMs: 5000 });
}

describe("msp-client-js: escaped-object-key pre-scan on inbound responses", () => {
  it("refuses a response line whose structuredContent has an escaped non-first key", async () => {
    const call = spawnFixture();
    try {
      // The first request after the client's own internal "initialize"
      // handshake always carries id 2 -- this fixture's raw_response_line
      // path writes back verbatim, so the id must match what the client
      // is actually waiting on.
      const rawLine = '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"-":"v","\\\\":"corrupt-target"}}}';
      await expect(call("whatever", { raw_response_line: rawLine })).rejects.toThrow(/object keys contain escape sequences/);
    } finally {
      await call.close();
    }
  });

  it("accepts a response whose structuredContent has escapes only inside VALUES", async () => {
    const call = spawnFixture();
    try {
      const rawLine = '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"note":"line1\\nline2"}}}';
      const result = await call("whatever", { raw_response_line: rawLine });
      expect(result.note).toBe("line1\nline2");
    } finally {
      await call.close();
    }
  });

  it("accepts a response with a literal (unescaped) non-ASCII key", async () => {
    const call = spawnFixture();
    try {
      const rawLine = '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"ข้อความ":"v","😀":"w"}}}';
      const result = await call("whatever", { raw_response_line: rawLine });
      expect(result["ข้อความ"]).toBe("v");
      expect(result["😀"]).toBe("w");
    } finally {
      await call.close();
    }
  });

  it("refuses via the content[].text JSON.parse fallback when structuredContent is absent", async () => {
    const call = spawnFixture();
    try {
      const rawText = JSON.stringify({ "-": "v" }).slice(0, -1) + ',"\\\\":"corrupt"}';
      await expect(call("whatever", { raw_text_content: rawText })).rejects.toThrow(/object keys with escape sequences/);
    } finally {
      await call.close();
    }
  });

  it("accepts the content[].text fallback when no key has an escape", async () => {
    const call = spawnFixture();
    try {
      const rawText = JSON.stringify({ a: "b" });
      const result = await call("whatever", { raw_text_content: rawText });
      expect(result).toEqual({ a: "b" });
    } finally {
      await call.close();
    }
  });

  // RKOI review (stage-2 revision, CRITICAL): the scanner used to be
  // recursive, and this client's own stdout `data` listener had no
  // try/catch around it -- a sufficiently deep response line's
  // `RangeError: Maximum call stack size exceeded` would propagate
  // uncaught out of that listener and crash the CALLING application, not
  // just this client's own child process.
  it("a 100,000-depth response line does not crash the calling process -- it is answered (accepted or refused), and the next request is still answered", async () => {
    const call = spawnFixture();
    try {
      const depth = 100_000;
      const deep = "[".repeat(depth) + "1" + "]".repeat(depth);
      const rawLine = `{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"x":${deep}}}}`;
      // Whatever the outcome -- resolved with the deep value, or rejected
      // by the scanner's own defensive try/catch treating an internal
      // failure as a refusal -- this call must SETTLE, not hang, and must
      // never throw a raw RangeError out of this process.
      await Promise.race([
        call("whatever", { raw_response_line: rawLine }).then(
          () => "resolved",
          (error) => {
            if (error instanceof RangeError) throw error;
            return "rejected:" + error.message;
          },
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("deep-nesting call never settled")), 8000)),
      ]);
      // The transport must still be alive and serving afterward.
      const result = await call("whatever", {});
      expect(result).toEqual({ ok: true });
    } finally {
      await call.close();
    }
  });

  // Deliberately NOT tested here: an OUTGOING call whose `params` is
  // already a 100,000-deep-nested real JS object graph (as opposed to
  // TEXT the scanner walks). Building that object at all via
  // `JSON.parse("[".repeat(100000) + ... )` and then re-serializing it
  // with the native `JSON.stringify` throws its own `RangeError` --
  // independent of, and pre-existing before, this scanner's own outbound
  // check (encode()/JSON.stringify(payload) already ran on the exact same
  // object shape before WARNING 5's fix). That is a native JSON.stringify
  // limit on deeply-nested REAL object graphs, not a defect in this
  // scanner (which only ever walks already-serialized TEXT) -- out of
  // scope for this CRITICAL finding.
});

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
});

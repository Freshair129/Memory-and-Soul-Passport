// Minimal NDJSON server used only to hand createMspStdioCaller a
// PRECISE, caller-controlled raw response line -- letting a test choose
// the exact wire bytes of an object key (including one with an escape
// sequence), rather than whatever JSON.stringify would choose. Used to
// prove the CLIENT'S OWN escaped-object-key pre-scan
// (packages/msp-client-js/src/escaped-object-key-scan.mjs, wired into
// msp-stdio-transport.mjs) refuses such a line before the real JSON.parse
// ever runs on it, mirroring the real msp-server's own transport-level
// defense (apps/msp-server/src/transport/stdio-jsonrpc-server.mjs).
function write(line) {
  process.stdout.write(`${line}\n`);
}

let input = Buffer.alloc(0);

function handle(message) {
  if (message.method === "initialize") {
    write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "escaped-key-stdio-server", version: "1" } } }));
    return;
  }
  if (message.method === "tools/call") {
    const rawResponseLine = message.params?.arguments?.raw_response_line;
    if (typeof rawResponseLine === "string") {
      // Written verbatim -- the test supplies the exact id and body.
      write(rawResponseLine);
      return;
    }
    const rawTextLine = message.params?.arguments?.raw_text_content;
    if (typeof rawTextLine === "string") {
      // structuredContent deliberately omitted, so the client's fallback
      // JSON.parse(text) path is the one under test.
      write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: rawTextLine }] } }));
      return;
    }
    const result = { ok: true };
    write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } }));
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const message = JSON.parse(input.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
    input = input.subarray(newline + 1);
    handle(message);
  }
});

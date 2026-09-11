// Minimal NDJSON MCP provider used only to prove what environment the GKS
// child process actually received. Every tools/call answers with the
// requested env var names mapped to their observed values (or null when
// absent) instead of doing any real GKS work.
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reportedEnv(requestedKeys) {
  const report = {};
  for (const key of requestedKeys ?? []) report[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
  return report;
}

let input = Buffer.alloc(0);

function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "env-report-gks-provider", version: "1" } } });
    return;
  }
  if (message.method === "tools/call") {
    const requestedKeys = message.params?.arguments?.report_keys ?? [];
    const result = { received_env: reportedEnv(requestedKeys) };
    write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
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

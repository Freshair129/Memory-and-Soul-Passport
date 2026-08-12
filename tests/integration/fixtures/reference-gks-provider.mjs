// Minimal NDJSON MCP provider used only to prove the MSP framing and
// receipt contract. State survives child-process restarts in the supplied file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let input = Buffer.alloc(0);
const statePath = process.env.GKS_FIXTURE_STATE_PATH;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function load() {
  if (!statePath || !existsSync(statePath)) return {};
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function save(state) {
  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

function resultFor(candidate) {
  if (process.env.GKS_FIXTURE_BAD_RESPONSE === "1") return { knowledge_ref: "not-a-gks-ref", source_hash: "bad", idempotent: "false" };
  const state = load();
  const existing = state[candidate.idempotency_key];
  if (existing) {
    if (existing.source_hash !== candidate.source_snapshot_hash.toLowerCase()) {
      return { isError: true, content: [{ type: "text", text: "idempotency_key is already bound to a different source_snapshot_hash." }] };
    }
    return { ...existing, idempotent: true };
  }
  const record = {
    knowledge_ref: `gks:knowledge/fixture_${createHash("sha256").update(candidate.idempotency_key).digest("hex").slice(0, 16)}`,
    source_hash: candidate.source_snapshot_hash.toLowerCase(),
    idempotent: false,
  };
  state[candidate.idempotency_key] = record;
  save(state);
  return record;
}

function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "reference-gks-provider", version: "1" } } });
    return;
  }
  if (message.method === "tools/call") {
    const result = message.params?.name === "gks_knowledge_promote"
      ? resultFor(message.params.arguments ?? {})
      : { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
    write({ jsonrpc: "2.0", id: message.id, result: result.isError ? result : { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
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

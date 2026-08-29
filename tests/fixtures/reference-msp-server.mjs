import { createHash } from "node:crypto";
import readline from "node:readline";

const mode = process.env.MSP_FIXTURE_MODE ?? "normal";
const seen = new Map();
const HASH = createHash("sha256").update("govibe-reference-msp").digest("hex");

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function success(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function failure(id, message, code = -32000) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(structuredContent) {
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

function stablePromotion(input) {
  const key = input.idempotency_key;
  if (!seen.has(key)) {
    seen.set(key, {
      promotion_ref: `msp:promotion/${key}`,
      memory_ref: `msp:memory/${key}`,
      target_ref: input.target_scope === "shared" ? `gks:memory/${key}` : `msp:vault/global/${key}`,
      source_hash: HASH,
      policy_decision: { decision: "allow", ref: `msp:policy/${key}`, reason: "reference fixture approval" },
    });
  }
  return seen.get(key);
}

async function handle(message) {
  if (message.method === "notifications/initialized") return;
  if (mode === "malformed") {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (mode === "hang") return;

  if (message.method === "initialize") {
    success(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "reference-msp", version: "0.1.0" } });
    return;
  }
  if (message.method !== "tools/call") {
    failure(message.id, `Unsupported method: ${message.method}`, -32601);
    return;
  }

  const name = message.params?.name;
  const input = message.params?.arguments ?? {};
  if (mode === "parent-error") {
    failure(message.id, "reference parent denied request");
    return;
  }

  switch (name) {
    case "msp_context_resolve": {
      const sharedRef = mode === "wrong-namespace" ? "msp:vault/not-gks" : "gks:shared/reference";
      success(message.id, toolResult({
        global_private_vault_refs: [{ ref: "msp:vault/global/reference", source_hash: HASH, version: "1" }],
        workspace_private_vault_refs: [{ ref: "msp:vault/workspace/reference", source_hash: HASH, version: "1" }],
        shared_vault_refs: [{ ref: sharedRef, source_hash: HASH, version: "1" }],
        workflow_ref: input.workflow_ref ?? null,
        diff_ref: "msp:diff/reference",
        policy_decisions: [{ decision: "allow", ref: "msp:policy/context-reference", reason: "reference fixture approval" }],
        diagnostics: [],
      }));
      return;
    }
    case "msp_vault_status":
      success(message.id, toolResult({ workspace_ref: "msp:workspace/reference", vault_refs: ["msp:vault/workspace/reference"], source_hash: HASH, policy_decision: { decision: "allow", ref: "msp:policy/vault-status", reason: "reference fixture approval" } }));
      return;
    case "msp_memory_promote":
      success(message.id, toolResult(stablePromotion(input)));
      return;
    default:
      failure(message.id, `Unknown tool: ${name}`, -32601);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handle(JSON.parse(line));
  } catch (error) {
    failure(null, error instanceof Error ? error.message : String(error), -32700);
  }
});

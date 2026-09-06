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
    // What the real adapter's stage_evidence row binds a promotion to.
    run_id: candidate.run_id ?? null,
    provenance_ref: candidate.provenance_ref ?? "msp:proof/fixture",
  };
  state[candidate.idempotency_key] = record;
  save(state);
  return { knowledge_ref: record.knowledge_ref, source_hash: record.source_hash, idempotent: record.idempotent };
}

// The real GKS's gks_stage_evidence_export, reduced to what the bridge test
// needs: one Stage 9 row per promotion recorded above, cursor-ordered,
// paged by since_cursor/limit, the six metrics present. GKS_FIXTURE_BAD_PAGE
// answers a page the relay must refuse (a row missing a metric).
function evidencePageFor(request) {
  if (process.env.GKS_FIXTURE_BAD_PAGE === "1") {
    return { rows: [{ cursor: 1, pipeline_stage_id: "DPS-KI-ENTITY-RESOLVE", pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1", execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1", run_id: "run-bad", provenance_ref: "msp:proof/bad", evidence_id: "gks:evidence/bad", evidence: {}, metrics: { records_in: 1 }, records: [], produced_at: "2026-09-07T00:00:00.000Z" }], next_cursor: 1 };
  }
  const sinceCursor = request.since_cursor ?? 0;
  const limit = request.limit ?? 100;
  const rows = Object.entries(load()).map(([key, record], index) => ({
    cursor: index + 1,
    evidence_id: `gks:evidence/${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
    pipeline_stage_id: "DPS-KI-ENTITY-RESOLVE",
    pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1",
    execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1",
    run_id: record.run_id ?? null,
    provenance_ref: record.provenance_ref ?? "msp:proof/fixture",
    scope: request.scope,
    evidence: { outcomes: { CREATED: 1 }, knowledge_ref: record.knowledge_ref },
    metrics: { records_in: 1, records_out: 1, records_failed: 0, records_quarantined: 0, processing_time_ms: 3, retry_count: 0 },
    records: [],
    produced_at: "2026-09-07T00:00:00.000Z",
  })).filter((row) => row.cursor > sinceCursor).slice(0, limit);
  return { rows, next_cursor: rows.length ? rows[rows.length - 1].cursor : sinceCursor };
}

function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "reference-gks-provider", version: "1" } } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const result = name === "gks_knowledge_promote"
      ? resultFor(message.params.arguments ?? {})
      : name === "gks_stage_evidence_export"
        ? evidencePageFor(message.params.arguments ?? {})
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

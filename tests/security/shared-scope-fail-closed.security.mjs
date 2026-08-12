// AC-02 / AC-03 (adversarial/boundary tests, per AC-08's guidance: repo
// convention runs these under node:test via `node --test`, not vitest --
// see scripts/mcp/context-authority.security.mjs /
// scripts/mcp/graph-dispatch-authority.security.mjs /
// scripts/mcp/sidecar-server.security.mjs and root package.json's
// "test:security": "node --test scripts/mcp/*.security.mjs" for the
// established pattern this file mirrors, scoped to this package's own
// package.json -- WP-13 does not touch the root package.json's glob, which
// only covers scripts/mcp/*.security.mjs; this package's own `npm test`
// runs this file too, see package.json's "test"/"test:security" scripts).
//
// AC-02: msp_context_resolve's shared_vault_refs is [] in every case; no
// tool in this packet ever returns a gks:-prefixed reference.
// AC-03: msp_knowledge_promote and msp_memory_promote(target_scope=shared)
// always respond with a tool-call error (isError:true) and reason
// gks_provider_unconfigured, never a fabricated success envelope. This is
// checked two ways: (1) through MspClient, the real consumer, which throws
// specifically because msp-stdio-transport.mjs's call() only rejects when
// result.isError is true (packages/govibe-core/src/msp-stdio-transport.mjs
// line ~92) -- the same mechanism WP-12's own
// test/transport-fixture-parity.test.mjs already relies on for its
// "unknown tool surfaces as a tool-call error" assertion; and (2) via a raw
// NDJSON request that inspects the literal {isError:true, ...} envelope
// this packet's transport layer produces, for direct proof beyond the
// client wrapper's behavior.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MspClient } from "@freshair129/msp-client-js";
import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-security-test-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup (Windows file-lock race on child process exit)
      }
    },
  };
}

function spawnRuntime(dbPath) {
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 10_000,
  });
  return { call, client: new MspClient(call) };
}

/**
 * Speaks the raw newline-delimited JSON-RPC 2.0 wire protocol directly
 * (bypassing msp-stdio-transport.mjs's call(), which throws on isError:true
 * rather than returning it) so a tools/call response's literal
 * {isError:true, content, structuredContent} envelope can be asserted on
 * directly.
 */
async function rawToolCall(dbPath, name, args) {
  const child = spawn(process.execPath, [binPath], { env: { ...process.env, MSP_DB_PATH: dbPath }, stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wp13-security-test", version: "0.1.0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const response = await send("tools/call", { name, arguments: args });
    return response.result;
  } finally {
    rl.close();
    child.kill();
  }
}

test("AC-02: msp_context_resolve returns shared_vault_refs: [] across repeated calls, never a gks: reference", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    const authority = {
      schemaVersion: "govibe-context-authority/v1",
      identity: { taskId: "T", agentId: "agent-sec", workspaceId: "workspace-sec", runId: "run-sec", sessionId: "session-sec", turnId: "turn-sec" },
      sources: [{ id: "API-009", version: "0.1.0", hash: "a".repeat(64) }],
      requiredReasonRefs: ["issue:sec"],
      traversal: { relationAllowlist: ["implements"], retrievalRadius: 1, inclusions: [], exclusions: [] },
      knowledgeRefs: [],
      budget: { maxTokens: 1024, compaction: "bounded" },
      lineage: { contextId: "ctx-sec", cacheId: "cache-sec", parentContextId: null },
      unresolvedAssumptions: [],
    };
    for (let i = 0; i < 3; i += 1) {
      const result = await runtime.client.resolveContext({
        workspacePath: "/workspace/sec",
        workspaceId: "workspace-sec",
        agentId: "agent-sec",
        contextProfile: "T-ctx",
        contextAuthority: authority,
      });
      assert.deepEqual(result.sharedVaultRefs, []);
      assert.equal(JSON.stringify(result).toLowerCase().includes("gks:"), false);
    }
  } finally {
    runtime.call.close();
    cleanup();
  }
});

test("AC-03: msp_knowledge_promote always responds isError:true, reason gks_provider_unconfigured, never a fabricated gks: success", async () => {
  const { dbPath, cleanup } = tempDbPath();
  // createMspStdioCaller (spawnRuntime) and rawToolCall's own spawn() each
  // start a child process eagerly, and each child independently runs
  // db/migrate.mjs's runMigrations() against MSP_DB_PATH on startup, before
  // the transport ever accepts a request. Against a brand-new, empty dbPath,
  // two such processes started concurrently race two independent
  // connections' schema_migrations reads/writes -- observed in CI as
  // "SqliteError: duplicate column name: role" (0003_vault_scoping.sql's
  // ALTER TABLE, applied twice). Fixed here by not spawning the second
  // (runtime) process until rawToolCall's ephemeral one has fully exited,
  // so the two processes' migration runs are strictly sequential, never
  // concurrent, against this shared fresh file.
  try {
    const raw = await rawToolCall(dbPath, "msp_knowledge_promote", {
      schema_version: "govibe-knowledge-candidate/v1",
      idempotency_key: "kc-sec-1",
      run_id: "run-sec",
      stage: 1,
      source_snapshot_hash: "a".repeat(64),
      provenance_ref: "msp:proof/sec-1",
    });
    assert.equal(raw.isError, true);
    assert.match(raw.structuredContent.message, /gks_provider_unconfigured/);
    assert.equal(JSON.stringify(raw).toLowerCase().includes("gks:"), false);

    const runtime = spawnRuntime(dbPath);
    try {
      await assert.rejects(
        runtime.client.submitKnowledgeCandidate({
          schema_version: "govibe-knowledge-candidate/v1",
          idempotency_key: "kc-sec-2",
          run_id: "run-sec",
          stage: 1,
          source_snapshot_hash: "a".repeat(64),
          provenance_ref: "msp:proof/sec-2",
        }),
        /gks_provider_unconfigured/,
      );
    } finally {
      runtime.call.close();
    }
  } finally {
    cleanup();
  }
});

test("AC-03: msp_memory_promote(target_scope=shared) always responds isError:true, reason gks_provider_unconfigured, never a fabricated gks: success", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = await rawToolCall(dbPath, "msp_memory_promote", {
      schema_version: "govibe-memory-promotion/v1",
      actor: "boss",
      agent_id: "agent-sec",
      workspace_id: "workspace-sec",
      source_memory_ref: "msp:memory/sec-source",
      target_scope: "shared",
      candidate: { note: "should be denied" },
      evidence_refs: ["msp:proof/sec-3"],
      reason: "security test",
      idempotency_key: "promo-sec-1",
    });
    assert.equal(raw.isError, true);
    assert.match(raw.structuredContent.message, /gks_provider_unconfigured/);
    assert.equal(JSON.stringify(raw).toLowerCase().includes("gks:"), false);
  } finally {
    cleanup();
  }
});

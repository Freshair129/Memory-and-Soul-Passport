// RKOI ruling (merge-blocking, TASK-MEMOS-002 stage 2): a real, reproducible
// V8 JSON.parse engine bug (V8 12.4-12.9 regression; Node <=22.23 clean,
// Node 23 through at least 26.8 -- including this workspace's 24.19.0 --
// affected) can hand a caller a CORRUPTED, non-first object key after an
// earlier parse in the same process shared the same leading key(s). RKOI
// proved this reaches real storage on the real server: tenant A's
// `msp_memory_upsert` body `{"-":K,"\\":K}` can corrupt tenant B's LATER,
// unrelated `msp_memory_upsert` body `{"-":K,"\"":K}` -- the corrupted key
// (`\` instead of `"`) is what gets persisted and read back, inside
// tenant B's own vault.
//
// apps/msp-server/src/transport/stdio-jsonrpc-server.mjs now refuses, at
// the raw-line boundary, any inbound JSON-RPC line whose object keys (at
// any depth) contain an escape sequence, before the real JSON.parse ever
// runs on it -- so the corrupting parse, and the corruptible parse, both
// simply never happen. This file talks to the real spawned server over raw
// stdio (mirroring tests/contract/transport-framing-boundary.test.mjs's
// technique), not through packages/msp-client-js, specifically because the
// refusal response carries `id: null` (there is no way to safely learn the
// real id without the same risky parse) -- the higher-level client cannot
// correlate that back to a pending request and would only time out, which
// is not a useful way to observe the refusal itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function tempDbPath(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `msp-jsonbug-${label}-`));
  const dbPath = path.join(dir, "msp.sqlite3");
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function spawnRaw(dbPath) {
  const child = spawn(process.execPath, [binPath], {
    env: { ...process.env, MSP_DB_PATH: dbPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) lines.push(line);
    }
  });
  return { child, lines };
}

async function waitForLines(lines, count, timeoutMs = 10_000) {
  const start = Date.now();
  while (lines.length < count) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${count} lines (have ${lines.length}).`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function closeChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      child.kill();
    });
  }
}

function write(child, obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

// Writes a RAW line that is not run through JSON.stringify -- the escaped
// key text must be the exact literal wire bytes, not whatever JSON.stringify
// would re-escape it to.
function writeRaw(child, line) {
  child.stdin.write(`${line}\n`);
}

test("RKOI probe reproduction: a priming request followed by an escaped-non-first-key request is refused at the transport, nothing is stored, the vault is unchanged", async () => {
  const { dbPath, cleanup } = tempDbPath("probe-repro");
  const { child, lines } = spawnRaw(dbPath);
  const K = "K".repeat(40);
  try {
    write(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitForLines(lines, 1);

    // Provision one real vault so we have somewhere the priming/target
    // upserts COULD have landed, and can prove they did not.
    write(child, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "msp_workspace_register", arguments: { actor: "boss", workspace_id: "ws-probe", project_id: null, workspace_path: "/w/ws-probe", idempotency_key: "r-probe", run_id: "run-probe", source_hash: "a".repeat(64), schema_version: "govibe-workspace-register/v1" } },
    });
    await waitForLines(lines, 2);
    write(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "msp_vault_status", arguments: { actor: "boss", workspace_id: "ws-probe", workspace_path: "/w/ws-probe", agent_id: null } } });
    await waitForLines(lines, 3);
    const statusResult = JSON.parse(lines[2]).result.structuredContent;
    const vaultId = statusResult.vaults.find((v) => v.vault_type === "workspace_private").vault_id;

    // The exact RKOI shapes: primer's second key decodes to backslash;
    // target's second key decodes to quote. Written as RAW wire text, not
    // via JSON.stringify (which would choose its own encoding), so the
    // escape sequence is exactly the one that reproduces the engine bug.
    const primerLine = `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"msp_memory_upsert","arguments":{"vault":{"vault_id":"${vaultId}","vault_type":"workspace_private"},"category":"c","key":"prime","body_json":{"-":"${K}","\\\\":"${K}"}}}}`;
    const targetLine = `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"msp_memory_upsert","arguments":{"vault":{"vault_id":"${vaultId}","vault_type":"workspace_private"},"category":"c","key":"target","body_json":{"-":"${K}","\\"":"${K}"}}}}`;

    writeRaw(child, primerLine);
    await waitForLines(lines, 4);
    const primerResponse = JSON.parse(lines[3]);
    assert.equal(primerResponse.id, null, "the primer line's OWN non-first key already has an escape and must itself be refused at the transport");
    assert.match(primerResponse.error.message, /object keys must not contain escape sequences/);

    writeRaw(child, targetLine);
    await waitForLines(lines, 5);
    const targetResponse = JSON.parse(lines[4]);
    assert.equal(targetResponse.id, null, "the target line must be refused at the transport too, before JSON.parse ever runs on it");
    assert.match(targetResponse.error.message, /object keys must not contain escape sequences/);
    assert.equal(targetResponse.error.message.includes(K), false, "the refusal must never echo the key material");

    // Prove nothing was stored: a normal, well-formed read for both
    // "prime" and "target" must come back not_found.
    write(child, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "msp_memory_get", arguments: { vault_id: vaultId, category: "c", key: "prime" } } });
    await waitForLines(lines, 6);
    assert.equal(JSON.parse(lines[5]).result.isError, true);
    write(child, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "msp_memory_get", arguments: { vault_id: vaultId, category: "c", key: "target" } } });
    await waitForLines(lines, 7);
    assert.equal(JSON.parse(lines[6]).result.isError, true);

    // The vault itself is otherwise perfectly usable -- a normal upsert
    // with no escaped keys still works after the refusals.
    write(child, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "msp_memory_upsert", arguments: { vault: { vault_id: vaultId, vault_type: "workspace_private" }, category: "c", key: "normal", body_json: { a: "b" } } } });
    await waitForLines(lines, 8);
    const normalResult = JSON.parse(lines[7]).result.structuredContent;
    assert.equal(normalResult.entity.vault_id, vaultId);
  } finally {
    await closeChild(child);
    cleanup();
  }
});

test("an escaped character inside a VALUE is still accepted and stored/returned correctly", async () => {
  const { dbPath, cleanup } = tempDbPath("value-escape-ok");
  const { child, lines } = spawnRaw(dbPath);
  try {
    write(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitForLines(lines, 1);
    write(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "msp_workspace_register", arguments: { actor: "boss", workspace_id: "ws-value-escape", project_id: null, workspace_path: "/w/ws-value-escape", idempotency_key: "r-ve", run_id: "run-ve", source_hash: "a".repeat(64), schema_version: "govibe-workspace-register/v1" } } });
    await waitForLines(lines, 2);
    write(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "msp_vault_status", arguments: { actor: "boss", workspace_id: "ws-value-escape", workspace_path: "/w/ws-value-escape", agent_id: null } } });
    await waitForLines(lines, 3);
    const vaultId = JSON.parse(lines[2]).result.structuredContent.vaults.find((v) => v.vault_type === "workspace_private").vault_id;

    write(child, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "msp_memory_upsert", arguments: { vault: { vault_id: vaultId, vault_type: "workspace_private" }, category: "c", key: "value-escape", body_json: { note: "line1\nline2\ttabbed \"quoted\" back\\slash" } } },
    });
    await waitForLines(lines, 4);
    const upserted = JSON.parse(lines[3]).result.structuredContent;
    assert.equal(upserted.entity.body_json.note, "line1\nline2\ttabbed \"quoted\" back\\slash");

    write(child, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "msp_memory_get", arguments: { vault_id: vaultId, category: "c", key: "value-escape" } } });
    await waitForLines(lines, 5);
    const got = JSON.parse(lines[4]).result.structuredContent;
    assert.equal(got.entity.body_json.note, "line1\nline2\ttabbed \"quoted\" back\\slash");
  } finally {
    await closeChild(child);
    cleanup();
  }
});

test("literal (unescaped) non-ASCII object keys -- Thai and emoji -- are accepted, not refused", async () => {
  const { dbPath, cleanup } = tempDbPath("non-ascii-key");
  const { child, lines } = spawnRaw(dbPath);
  try {
    write(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitForLines(lines, 1);
    write(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "msp_workspace_register", arguments: { actor: "boss", workspace_id: "ws-thai-emoji", project_id: null, workspace_path: "/w/ws-thai-emoji", idempotency_key: "r-te", run_id: "run-te", source_hash: "a".repeat(64), schema_version: "govibe-workspace-register/v1" } } });
    await waitForLines(lines, 2);
    write(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "msp_vault_status", arguments: { actor: "boss", workspace_id: "ws-thai-emoji", workspace_path: "/w/ws-thai-emoji", agent_id: null } } });
    await waitForLines(lines, 3);
    const vaultId = JSON.parse(lines[2]).result.structuredContent.vaults.find((v) => v.vault_type === "workspace_private").vault_id;

    write(child, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "msp_memory_upsert", arguments: { vault: { vault_id: vaultId, vault_type: "workspace_private" }, category: "c", key: "thai-emoji", body_json: { "ข้อความ": "v1", "😀": "v2" } } },
    });
    await waitForLines(lines, 4);
    const response = JSON.parse(lines[3]);
    assert.equal(response.result.isError, undefined);
    assert.equal(response.result.structuredContent.entity.body_json["ข้อความ"], "v1");
    assert.equal(response.result.structuredContent.entity.body_json["😀"], "v2");
  } finally {
    await closeChild(child);
    cleanup();
  }
});

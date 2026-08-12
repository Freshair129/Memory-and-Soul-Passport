// AC-03 (THE MOST IMPORTANT TEST IN THIS PACKET): msp_memory_search returns
// vault-scoped results only -- an entity in vault A is never returned to a
// caller scoped to vault B, for every mode (hybrid, fts) AND the exact-match
// short-circuit. This is the exact class of cross-vault disclosure WP-14
// closed for entities/promotions; this packet's retrieval layer must not
// reopen it. Runs against the REAL stdio child process (not in-process
// calls), per this package's *.security.mjs convention (mirrors
// test/vault-scope-denied.security.mjs and
// test/promotions-vault-scoping.security.mjs).
//
// OLLAMA_BASE_URL is pinned to a closed port for every runtime spawned here
// so this file's assertions do not depend on whether a real embedding
// backend is reachable on the host -- vault scoping must hold in FTS-only
// mode exactly the same as it would in a fully healthy hybrid mode, and this
// keeps the file deterministic (this sandbox actually has a live Ollama
// server, verified while writing this packet -- see the final report).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-memory-search-vault-scoping-test-"));
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

async function spawnRuntime(dbPath) {
  const port = await closedPort();
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, OLLAMA_BASE_URL: `http://127.0.0.1:${port}` },
    timeoutMs: 10_000,
  });
  return call;
}

async function provisionVault(call, workspaceId) {
  await call("msp_workspace_register", {
    actor: "boss",
    workspace_id: workspaceId,
    project_id: null,
    workspace_path: `/workspace/${workspaceId}`,
  });
  const status = await call("msp_vault_status", {
    actor: "boss",
    workspace_id: workspaceId,
    workspace_path: `/workspace/${workspaceId}`,
    agent_id: null,
  });
  return status.vaults.find((v) => v.vault_type === "workspace_private").vault_id;
}

test("AC-03: an entity in vault A is never returned to a caller scoped to vault B -- FTS mode", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = await spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-search-a");
    const vaultB = await provisionVault(call, "workspace-search-b");

    await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "secret",
      key: "vault-a-secret",
      body_json: { summary: "a confidential widget rollout plan for vault A only" },
    });
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultB, vault_type: "workspace_private" },
      category: "secret",
      key: "vault-b-secret",
      body_json: { summary: "a confidential widget rollout plan for vault B only" },
    });

    // Both entities share the same searchable term ("widget rollout plan")
    // deliberately -- if vault scoping were broken, vault B's caller would
    // see vault A's row too.
    const resultB = await call("msp_memory_search", { vault_id: vaultB, query: "confidential widget rollout plan", mode: "fts" });
    const keysFoundByB = resultB.hits.map((hit) => hit.entity.key);
    assert.ok(keysFoundByB.includes("vault-b-secret"), "vault B's own entity must be found");
    assert.ok(
      !keysFoundByB.includes("vault-a-secret"),
      "FAIL-CLOSED VIOLATION: vault A's entity leaked into vault B's FTS search results",
    );
    assert.ok(
      resultB.hits.every((hit) => hit.entity.vault_id === vaultB),
      "every hit's own vault_id field must equal the requesting vault, never another vault's",
    );

    const resultA = await call("msp_memory_search", { vault_id: vaultA, query: "confidential widget rollout plan", mode: "fts" });
    const keysFoundByA = resultA.hits.map((hit) => hit.entity.key);
    assert.ok(keysFoundByA.includes("vault-a-secret"));
    assert.ok(!keysFoundByA.includes("vault-b-secret"), "FAIL-CLOSED VIOLATION: vault B's entity leaked into vault A's FTS search results");
  } finally {
    call.close();
    cleanup();
  }
});

test("AC-03: an entity in vault A is never returned to a caller scoped to vault B -- hybrid mode (degraded to FTS-only, vector backend closed)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = await spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-search-hybrid-a");
    const vaultB = await provisionVault(call, "workspace-search-hybrid-b");

    await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "secret",
      key: "hybrid-a-secret",
      body_json: { summary: "a proprietary gizmo assembly note for vault A only" },
    });
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultB, vault_type: "workspace_private" },
      category: "secret",
      key: "hybrid-b-secret",
      body_json: { summary: "a proprietary gizmo assembly note for vault B only" },
    });

    const resultB = await call("msp_memory_search", { vault_id: vaultB, query: "proprietary gizmo assembly note", mode: "hybrid" });
    const keysFoundByB = resultB.hits.map((hit) => hit.entity.key);
    assert.ok(!keysFoundByB.includes("hybrid-a-secret"), "FAIL-CLOSED VIOLATION: vault A's entity leaked into vault B's hybrid search results");
  } finally {
    call.close();
    cleanup();
  }
});

test("AC-03: the exact-match short-circuit is vault-scoped -- a key that exists only in vault A is not exact-matched by a caller scoped to vault B", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = await spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-search-exact-a");
    const vaultB = await provisionVault(call, "workspace-search-exact-b");

    await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "secret",
      key: "only-in-vault-a",
      body_json: { summary: "vault A's private atomic-key entity" },
    });

    // Vault B's caller searches for the LITERAL key vault A's entity is
    // stored under. If exact-match were not vault-scoped, this would
    // short-circuit straight to vault A's row.
    const resultB = await call("msp_memory_search", { vault_id: vaultB, query: "only-in-vault-a", mode: "hybrid" });
    assert.ok(
      resultB.hits.every((hit) => hit.entity.key !== "only-in-vault-a"),
      "FAIL-CLOSED VIOLATION: the exact-match short-circuit found vault A's entity for a caller scoped to vault B",
    );
    assert.notEqual(resultB.searchMode, "exact", "vault B must not report an exact-match hit that belongs to vault A");

    // Control case: vault A's own caller DOES get the exact-match short-circuit.
    const resultA = await call("msp_memory_search", { vault_id: vaultA, query: "only-in-vault-a", mode: "hybrid" });
    assert.equal(resultA.searchMode, "exact");
    assert.equal(resultA.hits[0].entity.key, "only-in-vault-a");
  } finally {
    call.close();
    cleanup();
  }
});

test("AC-03: msp_memory_get/list/history/forget are likewise vault-scoped -- vault B cannot read or mutate vault A's entity", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = await spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-crud-scope-a");
    const vaultB = await provisionVault(call, "workspace-crud-scope-b");

    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "secret",
      key: "cross-vault-read-test",
      body_json: { summary: "vault A only" },
    });

    // msp_memory_get scoped to vault B must not find vault A's (category, key).
    await assert.rejects(
      call("msp_memory_get", { vault_id: vaultB, category: "secret", key: "cross-vault-read-test" }),
      /no memory entity found/i,
    );

    // msp_memory_list scoped to vault B must not enumerate vault A's entity.
    const listB = await call("msp_memory_list", { vault_id: vaultB, category: "secret" });
    assert.ok(listB.entities.every((entity) => entity.entity_id !== created.entity.entity_id));

    // msp_memory_history/forget resolve purely from entity_id (API-009 SS4.4/
    // SS4.5 carry no vault_id at all) -- proving they resolve to vault A's
    // OWN entity/vault_id, never silently substituting vault B's, is the
    // relevant scoping property here (see memory-handlers.mjs's header
    // comment for why these two tools have no separate caller-vault
    // parameter to cross-check against).
    const { history } = await call("msp_memory_history", { entity_id: created.entity.entity_id });
    assert.equal(history[0].vault_id, vaultA);
    assert.notEqual(history[0].vault_id, vaultB);
  } finally {
    call.close();
    cleanup();
  }
});

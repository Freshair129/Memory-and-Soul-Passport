// AC-05: graceful degradation is proven, not asserted. With the vector leg
// unavailable, msp_memory_search still returns FTS results and reports its
// degraded mode honestly via searchMode: "fts_only" / vector_available:
// false (API-009 SS4.6's documented field, exact name, not invented).
//
// This machine actually has a live Ollama server (with a real bge-m3 model)
// listening on the default port -- verified directly while writing this
// packet (see the final report). Rather than relying on ambient absence,
// OLLAMA_BASE_URL is pinned to a freshly-bound-then-closed TCP port for
// every runtime spawned in this file, guaranteeing a real, deterministic
// ECONNREFUSED regardless of what else is running on the host -- the same
// "point OLLAMA_BASE_URL at a closed port" technique this packet's own
// Ground rule 5 names.
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

const openCallers = [];
const tempDirs = [];

afterEach(() => {
  while (openCallers.length) openCallers.pop().close();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (Windows file-lock race on child process exit)
    }
  }
});

/** Binds an ephemeral TCP server, grabs its port, then closes it immediately --
 * the returned port is guaranteed to refuse connections (ECONNREFUSED) for
 * the rest of this process's lifetime on this host, regardless of whether a
 * real Ollama is also running elsewhere on the machine. */
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

async function spawnRuntimeWithClosedOllama() {
  const port = await closedPort();
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-memory-degradation-test-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "msp.sqlite3");
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, OLLAMA_BASE_URL: `http://127.0.0.1:${port}` },
    timeoutMs: 15_000,
  });
  openCallers.push(call);
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

describe("AC-05: msp_memory_search graceful degradation with the vector leg unavailable", () => {
  it("msp_memory_upsert still succeeds (durable write never fails because the optional embedding enrichment is down)", async () => {
    const call = await spawnRuntimeWithClosedOllama();
    const vaultId = await provisionVault(call, "ws-degrade-upsert");

    const result = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "resilient",
      body_json: { text: "a durable widget note" },
    });
    expect(result.created).toBe(true);
    expect(result.entity.entity_id).toMatch(/^msp:entity\//);
  });

  it("mode:'hybrid' (default): still returns FTS hits, searchMode:'fts_only', vector_available:false -- the exact API-009 SS4.6 field name and values", async () => {
    const call = await spawnRuntimeWithClosedOllama();
    const vaultId = await provisionVault(call, "ws-degrade-hybrid");
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "gizmo-note",
      body_json: { summary: "a gizmo widget rollout plan" },
    });

    const result = await call("msp_memory_search", { vault_id: vaultId, query: "gizmo widget", mode: "hybrid", limit: 20 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].entity.category).toBe("note");
    expect(result.layers_used).toEqual(["fts"]);
    expect(result.vector_available).toBe(false);
    expect(result.searchMode).toBe("fts_only");
  });

  it("mode:'vector' explicitly requested: still degrades honestly to searchMode:'fts_only', vector_available:false, and still returns FTS results", async () => {
    const call = await spawnRuntimeWithClosedOllama();
    const vaultId = await provisionVault(call, "ws-degrade-vector-mode");
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "vector-mode-note",
      body_json: { summary: "a sprocket widget assembly note" },
    });

    const result = await call("msp_memory_search", { vault_id: vaultId, query: "sprocket widget", mode: "vector" });
    expect(result.vector_available).toBe(false);
    expect(result.searchMode).toBe("fts_only");
    expect(result.hits.some((hit) => hit.entity.key === "vector-mode-note")).toBe(true);
  });

  it("mode:'fts' still works normally (unaffected by the vector backend being down, since it never probes it)", async () => {
    const call = await spawnRuntimeWithClosedOllama();
    const vaultId = await provisionVault(call, "ws-degrade-fts-mode");
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "fts-mode-note",
      body_json: { summary: "a widget catalog entry" },
    });

    const result = await call("msp_memory_search", { vault_id: vaultId, query: "widget catalog", mode: "fts" });
    expect(result.searchMode).toBe("fts_only");
    expect(result.vector_available).toBe(false);
    expect(result.hits.some((hit) => hit.entity.key === "fts-mode-note")).toBe(true);
  });

  it("does not hang or exceed a reasonable bound: the circuit breaker/timeout keeps repeated degraded searches fast", async () => {
    const call = await spawnRuntimeWithClosedOllama();
    const vaultId = await provisionVault(call, "ws-degrade-perf");
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "perf-note",
      body_json: { summary: "a perf widget note" },
    });

    const start = Date.now();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await call("msp_memory_search", { vault_id: vaultId, query: "perf widget", mode: "hybrid" });
    }
    const elapsedMs = Date.now() - start;
    // Five sequential degraded searches must not each pay a full embed
    // timeout -- the circuit breaker (default threshold 3) should trip well
    // before the fifth call. Generous bound (10s for 5 calls) to stay
    // robust across slow CI hosts while still catching an unbounded/no-
    // breaker regression.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../apps/msp-server/src/server.mjs";

const servers = [];
const tempDirs = [];

afterEach(() => {
  while (servers.length) servers.pop().close();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function openServer(vectorSetting = undefined) {
  const env = vectorSetting === undefined ? {} : { MSP_VECTOR_ENABLED: vectorSetting };
  const server = createServer({ dbPath: ":memory:", env });
  servers.push(server);
  return server;
}

describe("MSP_VECTOR_ENABLED deployment setting", () => {
  it("defaults to enabled when unset", () => {
    expect(openServer().vectorClient.enabled).toBe(true);
  });

  it("keeps vector enabled for MSP_VECTOR_ENABLED=1", () => {
    expect(openServer("1").vectorClient.enabled).toBe(true);
  });

  it("disables vector for MSP_VECTOR_ENABLED=0", () => {
    expect(openServer("0").vectorClient.enabled).toBe(false);
  });

  it("rejects invalid values before opening the database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "msp-vector-flag-invalid-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "must-not-be-created.sqlite3");

    expect(() => createServer({ dbPath, env: { MSP_VECTOR_ENABLED: "true" } })).toThrow(/MSP_VECTOR_ENABLED must be '0' or '1'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("disabled mode keeps writes and FTS search available without storing embeddings", async () => {
    const server = openServer("0");
    const call = async (name, args) => (await server.toolRegistry.dispatch(name, args)).structuredContent;
    const workspaceId = "ws-vector-disabled";
    const workspacePath = `/workspace/${workspaceId}`;

    await call("msp_workspace_register", {
      actor: "boss",
      workspace_id: workspaceId,
      project_id: null,
      workspace_path: workspacePath,
      idempotency_key: `register-${workspaceId}`,
      run_id: `run-${workspaceId}`,
      source_hash: "a".repeat(64),
      schema_version: "govibe-workspace-register/v1",
    });
    const status = await call("msp_vault_status", {
      actor: "boss",
      workspace_id: workspaceId,
      workspace_path: workspacePath,
      agent_id: null,
    });
    const vaultId = status.vaults.find((vault) => vault.vault_type === "workspace_private").vault_id;

    const stored = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "vector-disabled-note",
      body_json: { summary: "a vector disabled widget note" },
    });
    expect(stored.created).toBe(true);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM embeddings").get().count).toBe(0);

    const result = await call("msp_memory_search", { vault_id: vaultId, query: "disabled widget", mode: "hybrid" });
    expect(result.hits.some((hit) => hit.entity.entity_id === stored.entity.entity_id)).toBe(true);
    expect(result.layers_used).toEqual(["fts"]);
    expect(result.vector_available).toBe(false);
    expect(result.searchMode).toBe("fts_only");
  });
});

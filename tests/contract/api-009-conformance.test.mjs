import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const binPath = path.join(repoRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const schemaPath = path.join(repoRoot, "packages", "msp-contracts", "schemas", "API-009.tools.json");
const expectedTools = [
  "msp_memory_decay_tick",
  "msp_memory_forget",
  "msp_memory_get",
  "msp_memory_history",
  "msp_memory_links_create",
  "msp_memory_links_list",
  "msp_memory_list",
  "msp_memory_search",
  "msp_memory_upsert",
];

let call;
let tempDir;
let vaultId;
let sequence = 0;

async function upsert({ category = "contract", key, body = {} } = {}) {
  sequence += 1;
  return call("msp_memory_upsert", {
    vault: { vault_id: vaultId, vault_type: "workspace_private" },
    category,
    key: key ?? `entity-${sequence}`,
    body_json: body,
    epistemic_state: "hypothesis",
    confidence: 0.6,
    valid_from: "2026-08-04T00:00:00Z",
    valid_to: null,
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "msp-api-009-contract-"));
  call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: {
      ...process.env,
      MSP_DB_PATH: path.join(tempDir, "msp.sqlite3"),
      OLLAMA_BASE_URL: "http://127.0.0.1:1",
    },
    timeoutMs: 15_000,
  });
  await call("msp_workspace_register", {
    actor: "contract-test",
    workspace_id: "workspace-api-009",
    project_id: "project-api-009",
    workspace_path: "/workspace/api-009",
    idempotency_key: "register-api-009",
    run_id: "run-api-009",
    source_hash: "a".repeat(64),
    schema_version: "govibe-workspace-register/v1",
  });
  const status = await call("msp_vault_status", {
    actor: "contract-test",
    workspace_id: "workspace-api-009",
    workspace_path: "/workspace/api-009",
    agent_id: null,
  });
  vaultId = status.vaults.find((vault) => vault.vault_type === "workspace_private").vault_id;
});

afterAll(async () => {
  call?.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("API-009 machine contract", () => {
  it("contains exactly the frozen nine memory tool schemas", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.contract).toMatchObject({
      doc_id: "API-009-PERSISTENT-MEMORY-CONTRACT",
      version: "0.1.1+draft",
    });
    expect(schema.tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
    for (const tool of schema.tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("API-009 request/response conformance over real stdio", () => {
  it("msp_memory_upsert", async () => {
    const result = await upsert({ key: "upsert", body: { value: 1 } });
    expect(result).toMatchObject({ created: true, changed: true });
    expect(result.entity).toMatchObject({ vault_id: vaultId, category: "contract", key: "upsert" });
  });

  it("msp_memory_get", async () => {
    await upsert({ key: "get", body: { value: 2 } });
    const result = await call("msp_memory_get", { vault_id: vaultId, category: "contract", key: "get" });
    expect(result).toMatchObject({ point_in_time: false, entity: { body_json: { value: 2 } } });
  });

  it("msp_memory_list", async () => {
    await upsert({ category: "list-contract", key: "list-1" });
    const result = await call("msp_memory_list", {
      vault_id: vaultId,
      category: "list-contract",
      lifecycle_state: "active",
      page_size: 50,
      page_token: null,
    });
    expect(result).toMatchObject({ entities: [expect.objectContaining({ key: "list-1" })] });
    expect(result).toHaveProperty("next_page_token");
  });

  it("msp_memory_history", async () => {
    const first = await upsert({ key: "history", body: { revision: 1 } });
    await upsert({ key: "history", body: { revision: 2 } });
    const result = await call("msp_memory_history", { entity_id: first.entity.entity_id });
    expect(result.history.map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("msp_memory_forget", async () => {
    const created = await upsert({ key: "forget" });
    const result = await call("msp_memory_forget", {
      entity_id: created.entity.entity_id,
      reason: "API-009 conformance",
    });
    expect(result.entity).toMatchObject({ entity_id: created.entity.entity_id, lifecycle_state: "forgotten" });
  });

  it("msp_memory_search", async () => {
    await upsert({ category: "search-contract", key: "needle", body: { text: "conformance needle" } });
    const result = await call("msp_memory_search", {
      vault_id: vaultId,
      query: "needle",
      mode: "fts",
      limit: 20,
    });
    expect(result.hits[0]).toMatchObject({
      entity: { key: "needle" },
      score: expect.any(Number),
      matched_by: expect.any(Array),
    });
    expect(result).toMatchObject({ vector_available: false, searchMode: "exact" });
  });

  it("msp_memory_decay_tick", async () => {
    const result = await call("msp_memory_decay_tick", { vault_id: vaultId, dry_run: true });
    expect(result).toMatchObject({ evaluated: expect.any(Number), transitioned: expect.any(Array), dry_run: true });
  });

  it("msp_memory_links_create", async () => {
    const from = await upsert({ category: "links-contract", key: "from" });
    const to = await upsert({ category: "links-contract", key: "to" });
    const result = await call("msp_memory_links_create", {
      from_entity_id: from.entity.entity_id,
      to_entity_id: to.entity.entity_id,
      link_type: "relates_to",
    });
    expect(result).toEqual({
      link: {
        from_entity_id: from.entity.entity_id,
        to_entity_id: to.entity.entity_id,
        link_type: "relates_to",
      },
    });
  });

  it("msp_memory_links_list", async () => {
    const from = await upsert({ category: "links-list-contract", key: "from" });
    const to = await upsert({ category: "links-list-contract", key: "to" });
    await call("msp_memory_links_create", {
      from_entity_id: from.entity.entity_id,
      to_entity_id: to.entity.entity_id,
      link_type: "cites",
    });
    const result = await call("msp_memory_links_list", { entity_id: from.entity.entity_id, direction: "outgoing" });
    expect(result).toEqual({
      links: [
        {
          from_entity_id: from.entity.entity_id,
          to_entity_id: to.entity.entity_id,
          link_type: "cites",
        },
      ],
    });
  });
});

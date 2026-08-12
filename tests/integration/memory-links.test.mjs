// AC-01 (WP-17): msp_memory_links_list/msp_memory_links_create (API-009
// SS4.8/SS4.9) round-trip over the REAL stdio child process, matching
// memory-crud.test.mjs's convention.
import { mkdtempSync, rmSync } from "node:fs";
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

function spawnRuntime() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-memory-links-test-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "msp.sqlite3");
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 15_000,
  });
  openCallers.push(call);
  return { call, dbPath };
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

async function upsert(call, vaultId, category, key) {
  const result = await call("msp_memory_upsert", {
    vault: { vault_id: vaultId, vault_type: "workspace_private" },
    category,
    key,
    body_json: {},
  });
  return result.entity.entity_id;
}

describe("AC-01: msp_memory_links_create/list round-trip over the real stdio process", () => {
  it("create() is idempotent and returns the documented {link: {from_entity_id, to_entity_id, link_type}} shape", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-links-create");
    const a = await upsert(call, vaultId, "note", "a");
    const b = await upsert(call, vaultId, "note", "b");

    const first = await call("msp_memory_links_create", { from_entity_id: a, to_entity_id: b, link_type: "relates_to" });
    expect(first).toEqual({ link: { from_entity_id: a, to_entity_id: b, link_type: "relates_to" } });

    const second = await call("msp_memory_links_create", { from_entity_id: a, to_entity_id: b, link_type: "relates_to" });
    expect(second).toEqual(first);
  });

  it("msp_memory_links_create against an unknown from_entity_id or to_entity_id fails closed (not_found)", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-links-notfound");
    const a = await upsert(call, vaultId, "note", "a");

    await expect(call("msp_memory_links_create", { from_entity_id: a, to_entity_id: "msp:entity/does-not-exist", link_type: "x" })).rejects.toThrow(
      /no memory entity found/i,
    );
    await expect(call("msp_memory_links_create", { from_entity_id: "msp:entity/does-not-exist", to_entity_id: a, link_type: "x" })).rejects.toThrow(
      /no memory entity found/i,
    );
  });

  it("msp_memory_links_list (SS4.8): outgoing, incoming, and both -- flat, single-hop only, matching the documented response shape", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-links-list");
    const a = await upsert(call, vaultId, "note", "a");
    const b = await upsert(call, vaultId, "note", "b");
    const c = await upsert(call, vaultId, "note", "c");

    await call("msp_memory_links_create", { from_entity_id: a, to_entity_id: b, link_type: "relates_to" });
    await call("msp_memory_links_create", { from_entity_id: c, to_entity_id: a, link_type: "cites" });

    const outgoing = await call("msp_memory_links_list", { entity_id: a, direction: "outgoing" });
    expect(outgoing).toEqual({ links: [{ from_entity_id: a, to_entity_id: b, link_type: "relates_to" }] });

    const incoming = await call("msp_memory_links_list", { entity_id: a, direction: "incoming" });
    expect(incoming).toEqual({ links: [{ from_entity_id: c, to_entity_id: a, link_type: "cites" }] });

    const both = await call("msp_memory_links_list", { entity_id: a });
    expect(both.links).toHaveLength(2);
  });

  it("msp_memory_links_list against an unknown entity_id fails closed (not_found)", async () => {
    const { call } = spawnRuntime();
    await expect(call("msp_memory_links_list", { entity_id: "msp:entity/does-not-exist" })).rejects.toThrow(/no memory entity found/i);
  });

  it("a successful links_create writes exactly one journal row; the idempotent re-call writes none", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-links-journal");
    const a = await upsert(call, vaultId, "note", "a");
    const b = await upsert(call, vaultId, "note", "b");

    await call("msp_memory_links_create", { from_entity_id: a, to_entity_id: b, link_type: "relates_to" });
    await call("msp_memory_links_create", { from_entity_id: a, to_entity_id: b, link_type: "relates_to" });

    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT * FROM journal WHERE tool_name = 'msp_memory_links_create'").all();
      expect(rows).toHaveLength(1);
      expect(rows[0].policy_decision).toBe("allow");
    } finally {
      db.close();
    }
  });
});

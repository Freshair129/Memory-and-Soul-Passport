// AC-04: the five CRUD tools (API-009 SS4.1-SS4.5) each round-trip over the
// REAL stdio child process via createMspStdioCaller (not in-process calls),
// matching API-009's documented request/response shapes. msp_memory_forget
// is proven to be a soft delete: row persists, lifecycle_state='forgotten',
// absent from default list, still reachable through history.
//
// Runs with no OLLAMA_BASE_URL override, i.e. against whatever
// packages/msp-runtime's default (http://localhost:11434) resolves to on
// this machine -- proving embedding-on-write (Bounded Scope item 7) never
// fails a durable write regardless of whether that default is reachable
// (AC-05's "no Ollama running at all" requirement is exercised more directly
// by test/memory-search-degradation.test.mjs, which pins a guaranteed-closed
// port).
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
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-memory-crud-test-"));
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

async function provisionVault(call, { workspaceId, projectId = null }) {
  await call("msp_workspace_register", {
    actor: "boss",
    workspace_id: workspaceId,
    project_id: projectId,
    workspace_path: `/workspace/${workspaceId}`,
    idempotency_key: `register-${workspaceId}`,
    run_id: `run-${workspaceId}`,
    source_hash: "a".repeat(64),
    schema_version: "govibe-workspace-register/v1",
  });
  const status = await call("msp_vault_status", {
    actor: "boss",
    workspace_id: workspaceId,
    workspace_path: `/workspace/${workspaceId}`,
    agent_id: null,
  });
  return status.vaults.find((v) => v.vault_type === "workspace_private").vault_id;
}

describe("AC-04: msp_memory_* CRUD tools round-trip over the real stdio process", () => {
  it("msp_memory_upsert (SS4.1): first call created:true changed:true; idempotent re-call created:false changed:false", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, { workspaceId: "ws-upsert" });

    const first = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "profile",
      key: "alice",
      body_json: { name: "Alice" },
      epistemic_state: "hypothesis",
      confidence: 0.6,
      valid_from: "2026-08-04T00:00:00Z",
      valid_to: null,
    });
    expect(first.created).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.entity.vault_id).toBe(vaultId);
    expect(first.entity.category).toBe("profile");
    expect(first.entity.key).toBe("alice");
    expect(first.entity.current_version).toBe(1);
    expect(first.entity.lifecycle_state).toBe("active");
    expect(first.entity.entity_id).toMatch(/^msp:entity\//);

    const retry = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "profile",
      key: "alice",
      body_json: { name: "Alice" },
      epistemic_state: "hypothesis",
      confidence: 0.6,
    });
    expect(retry.created).toBe(false);
    expect(retry.changed).toBe(false);
    expect(retry.entity.entity_id).toBe(first.entity.entity_id);
    expect(retry.entity.current_version).toBe(1);

    const changed = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "profile",
      key: "alice",
      body_json: { name: "Alice Updated" },
      confidence: 0.6,
    });
    expect(changed.created).toBe(false);
    expect(changed.changed).toBe(true);
    expect(changed.entity.current_version).toBe(2);
  });

  it("msp_memory_upsert against an unknown vault_id fails closed (not_found), no fabricated entity", async () => {
    const { call } = spawnRuntime();
    await expect(
      call("msp_memory_upsert", {
        vault: { vault_id: "vault_does-not-exist", vault_type: "workspace_private" },
        category: "profile",
        key: "ghost",
        body_json: {},
      }),
    ).rejects.toThrow(/unknown vault_id/i);
  });

  it("msp_memory_get (SS4.2): returns the current entity; not_found for a nonexistent key", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, { workspaceId: "ws-get" });
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "k1",
      body_json: { text: "hello" },
    });

    const got = await call("msp_memory_get", { vault_id: vaultId, category: "note", key: "k1" });
    expect(got.entity.body_json).toEqual({ text: "hello" });
    expect(got.point_in_time).toBe(false);

    await expect(call("msp_memory_get", { vault_id: vaultId, category: "note", key: "nope" })).rejects.toThrow(/no memory entity found/i);
  });

  it("msp_memory_list (SS4.3): paginates, excludes forgotten by default, filters by category", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, { workspaceId: "ws-list" });
    for (let index = 0; index < 3; index += 1) {
      await call("msp_memory_upsert", {
        vault: { vault_id: vaultId, vault_type: "workspace_private" },
        category: "page",
        key: `k${index}`,
        body_json: { index },
      });
    }

    const page = await call("msp_memory_list", { vault_id: vaultId, category: "page", page_size: 2 });
    expect(page.entities).toHaveLength(2);
    expect(page.next_page_token).not.toBeNull();

    const all = await call("msp_memory_list", { vault_id: vaultId, category: "page", page_size: 50 });
    expect(all.entities).toHaveLength(3);
  });

  it("msp_memory_history (SS4.4): ascending version order, includes every recorded version", async () => {
    const { call } = spawnRuntime();
    const vaultId = await provisionVault(call, { workspaceId: "ws-history" });
    const v1 = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "doc",
      key: "spec",
      body_json: { rev: 1 },
    });
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "doc",
      key: "spec",
      body_json: { rev: 2 },
    });

    const { history } = await call("msp_memory_history", { entity_id: v1.entity.entity_id });
    expect(history.map((entry) => entry.version)).toEqual([1, 2]); // ascending, per SS4.4
    expect(history[0].body_json).toEqual({ rev: 1 });
    expect(history[1].body_json).toEqual({ rev: 2 });
  });

  it("msp_memory_history for an unknown entity_id fails closed (not_found)", async () => {
    const { call } = spawnRuntime();
    await expect(call("msp_memory_history", { entity_id: "msp:entity/does-not-exist" })).rejects.toThrow(/no memory entity found/i);
  });

  it("msp_memory_forget (SS4.5) is a soft delete: row persists, lifecycle_state='forgotten', absent from default list, still reachable through history", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, { workspaceId: "ws-forget" });
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "to-forget",
      body_json: { text: "gdpr me" },
    });

    const forgotten = await call("msp_memory_forget", { entity_id: created.entity.entity_id, reason: "gdpr-request" });
    expect(forgotten.entity.lifecycle_state).toBe("forgotten");

    // Absent from default list.
    const list = await call("msp_memory_list", { vault_id: vaultId, category: "note" });
    expect(list.entities.find((entity) => entity.entity_id === created.entity.entity_id)).toBeUndefined();

    // Still reachable through list with an explicit lifecycle_state filter.
    const forgottenList = await call("msp_memory_list", { vault_id: vaultId, category: "note", lifecycle_state: "forgotten" });
    expect(forgottenList.entities.map((entity) => entity.entity_id)).toContain(created.entity.entity_id);

    // Still reachable through history.
    const { history } = await call("msp_memory_history", { entity_id: created.entity.entity_id });
    expect(history[history.length - 1].change_reason).toBe("gdpr-request");

    // Row still physically exists in the database -- no DELETE was ever issued.
    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const row = db.prepare("SELECT lifecycle_state FROM entities WHERE entity_id = ?").get(created.entity.entity_id);
      expect(row).toBeTruthy();
      expect(row.lifecycle_state).toBe("forgotten");
    } finally {
      db.close();
    }
  });

  it("msp_memory_forget for an unknown entity_id fails closed (not_found)", async () => {
    const { call } = spawnRuntime();
    await expect(call("msp_memory_forget", { entity_id: "msp:entity/does-not-exist", reason: "x" })).rejects.toThrow(/no memory entity found/i);
  });

  it("a mutating call (upsert) writes exactly one journal row, reachable via msp_context_audit-style journal read", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, { workspaceId: "ws-journal" });
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "audited",
      body_json: { v: 1 },
    });

    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT * FROM journal WHERE tool_name = 'msp_memory_upsert' AND ref = ?").all(created.entity.entity_id);
      expect(rows).toHaveLength(1);
      expect(rows[0].policy_decision).toBe("allow");
    } finally {
      db.close();
    }
  });
});

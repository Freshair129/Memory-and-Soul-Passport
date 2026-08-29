// AC-06 (WP-16): msp_memory_decay_tick is vault-scoped -- a sweep scoped to
// vault A never alters an entity in vault B. This is the same isolation
// class WP-14 closed for entities/promotions and WP-15 closed for search
// (test/memory-search-vault-scoping.security.mjs); this file closes it for
// the decay sweep. Runs against the REAL stdio child process, per this
// package's *.security.mjs convention.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-decay-vault-scoping-test-"));
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
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 10_000,
  });
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

// Backdates created_at (and clears last_accessed_at) via a second
// connection so the entity is guaranteed decayed by the time a real
// msp_memory_decay_tick call runs -- msp_memory_decay_tick's wire request
// (API-009 SS4.7) carries no `now` override, so this is how a real,
// deterministic transition is driven regardless of the actual current date.
function backdateEntity(dbPath, entityId) {
  const db = open(dbPath);
  try {
    db.prepare("UPDATE entities SET created_at = ?, last_accessed_at = NULL WHERE entity_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      entityId,
    );
  } finally {
    db.close();
  }
}

function readLifecycleState(dbPath, entityId) {
  const db = open(dbPath);
  try {
    return db.prepare("SELECT lifecycle_state FROM entities WHERE entity_id = ?").get(entityId)?.lifecycle_state;
  } finally {
    db.close();
  }
}

test("AC-06: a decay sweep scoped to vault A never alters an equally-decayable entity in vault B", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-decay-a");
    const vaultB = await provisionVault(call, "workspace-decay-b");

    const entityA = await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "note",
      key: "ancient-a",
      body_json: {},
    });
    const entityB = await call("msp_memory_upsert", {
      vault: { vault_id: vaultB, vault_type: "workspace_private" },
      category: "note",
      key: "ancient-b",
      body_json: {},
    });
    backdateEntity(dbPath, entityA.entity.entity_id);
    backdateEntity(dbPath, entityB.entity.entity_id);

    const result = await call("msp_memory_decay_tick", { vault_id: vaultA, dry_run: false });

    assert.ok(
      result.transitioned.some((t) => t.entity_id === entityA.entity.entity_id),
      "vault A's own entity must be evaluated and transitioned by a sweep scoped to vault A",
    );
    assert.ok(
      !result.transitioned.some((t) => t.entity_id === entityB.entity.entity_id),
      "FAIL-CLOSED VIOLATION: a sweep scoped to vault A transitioned an entity belonging to vault B",
    );

    assert.notStrictEqual(readLifecycleState(dbPath, entityA.entity.entity_id), "active", "vault A's entity should have decayed");
    assert.strictEqual(
      readLifecycleState(dbPath, entityB.entity.entity_id),
      "active",
      "FAIL-CLOSED VIOLATION: vault B's entity was mutated by a sweep scoped to vault A",
    );

    // Symmetric check the other direction.
    const resultB = await call("msp_memory_decay_tick", { vault_id: vaultB, dry_run: false });
    assert.ok(resultB.transitioned.some((t) => t.entity_id === entityB.entity.entity_id));
    assert.strictEqual(resultB.evaluated, 1, "a vault-B-scoped sweep must only evaluate vault B's own entities");
  } finally {
    call.close();
    cleanup();
  }
});

test("AC-06: dry_run:true against vault A reports no transitions for vault B's entities, even when both are equally decayed", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-decay-dryrun-a");
    const vaultB = await provisionVault(call, "workspace-decay-dryrun-b");

    const entityA = await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "note",
      key: "a",
      body_json: {},
    });
    const entityB = await call("msp_memory_upsert", {
      vault: { vault_id: vaultB, vault_type: "workspace_private" },
      category: "note",
      key: "b",
      body_json: {},
    });
    backdateEntity(dbPath, entityA.entity.entity_id);
    backdateEntity(dbPath, entityB.entity.entity_id);

    const dry = await call("msp_memory_decay_tick", { vault_id: vaultA, dry_run: true });

    assert.strictEqual(dry.evaluated, 1);
    assert.ok(dry.transitioned.some((t) => t.entity_id === entityA.entity.entity_id));
    assert.ok(!dry.transitioned.some((t) => t.entity_id === entityB.entity.entity_id));
  } finally {
    call.close();
    cleanup();
  }
});

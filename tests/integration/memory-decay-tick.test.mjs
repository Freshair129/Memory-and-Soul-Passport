// AC-05/AC-07/AC-09 (WP-16): msp_memory_decay_tick (API-009 SS4.7) round-trips
// over the REAL stdio child process, matching memory-crud.test.mjs's
// convention. Covers: dry_run non-persistence and dry_run:false persistence
// (proven end-to-end by directly backdating an entity's created_at far into
// the past via a second DB connection -- the handler itself has no `now`
// override on the wire, per API-009 SS4.7's documented request shape, so
// "far in the past" rather than an injected clock is how this file drives a
// real transition deterministically regardless of the actual current date),
// unknown-vault_id fail-closed, journal auditing for both dry_run values,
// archived-entity default-recall exclusion (still reachable via an explicit
// lifecycle_state filter and via history), and reinforcement-on-access
// (touch()) wired into msp_memory_get/msp_memory_search.
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
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-decay-tick-test-"));
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

// Directly backdates created_at (and clears last_accessed_at) via a second
// connection so the entity is guaranteed to have decayed to (near) zero
// retention by the time a real msp_memory_decay_tick call runs, regardless
// of the actual wall-clock date this test suite runs on.
async function backdateEntity(dbPath, entityId) {
  const { open } = await import("@freshair129/msp-storage/connection");
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

describe("AC-05/AC-07: msp_memory_decay_tick round-trips over the real stdio process", () => {
  it("dry_run: true reports the transition but does not persist it; dry_run: false persists it", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-decay-dryrun");
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "ancient",
      body_json: { text: "old memory" },
    });
    await backdateEntity(dbPath, created.entity.entity_id);

    const dry = await call("msp_memory_decay_tick", { vault_id: vaultId, dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.evaluated).toBeGreaterThanOrEqual(1);
    const dryTransition = dry.transitioned.find((t) => t.entity_id === created.entity.entity_id);
    expect(dryTransition).toBeTruthy();
    expect(dryTransition.from).toBe("active");
    expect(["decayed", "archived"]).toContain(dryTransition.to);

    // Nothing persisted by the dry run -- checked via a direct DB read
    // rather than msp_memory_get, since a real get() call would itself
    // touch() the entity (WP-16 Bounded Scope item 3) and reset its decay
    // clock, invalidating this test's next assertion.
    {
      const { open } = await import("@freshair129/msp-storage/connection");
      const db = open(dbPath);
      try {
        const row = db.prepare("SELECT lifecycle_state FROM entities WHERE entity_id = ?").get(created.entity.entity_id);
        expect(row.lifecycle_state).toBe("active");
      } finally {
        db.close();
      }
    }

    const real = await call("msp_memory_decay_tick", { vault_id: vaultId, dry_run: false });
    expect(real.dry_run).toBe(false);
    const realTransition = real.transitioned.find((t) => t.entity_id === created.entity.entity_id);
    expect(realTransition).toBeTruthy();
    expect(realTransition.to).toBe(dryTransition.to); // same elapsed time, same computed outcome

    // Now list with an explicit lifecycle_state filter proves it persisted
    // (default list() below covers the archived-exclusion case; this is
    // the round-trip proof that the write actually happened).
    const listFiltered = await call("msp_memory_list", { vault_id: vaultId, category: "note", lifecycle_state: realTransition.to });
    expect(listFiltered.entities.map((e) => e.entity_id)).toContain(created.entity.entity_id);
  });

  it("against an unknown vault_id fails closed (not_found)", async () => {
    const { call } = spawnRuntime();
    await expect(call("msp_memory_decay_tick", { vault_id: "vault_does-not-exist", dry_run: true })).rejects.toThrow(
      /unknown vault_id/i,
    );
  });

  it("writes exactly one journal row for a dry_run:true call, and one for a dry_run:false call (both are auditable events)", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-decay-journal");
    await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "audited",
      body_json: {},
    });

    await call("msp_memory_decay_tick", { vault_id: vaultId, dry_run: true });
    await call("msp_memory_decay_tick", { vault_id: vaultId, dry_run: false });

    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT * FROM journal WHERE tool_name = 'msp_memory_decay_tick' ORDER BY journal_id ASC").all();
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].payload_json).dry_run).toBe(true);
      expect(JSON.parse(rows[1].payload_json).dry_run).toBe(false);
      expect(rows[0].policy_decision).toBe("allow");
    } finally {
      db.close();
    }
  });

  it("archived entities are excluded from default msp_memory_list and msp_memory_search, remain reachable via an explicit lifecycle_state filter, and remain fully present in msp_memory_history; no row is hard-deleted", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-decay-archived-recall");
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "will-archive",
      body_json: { text: "fade away" },
    });
    await backdateEntity(dbPath, created.entity.entity_id);
    const tick = await call("msp_memory_decay_tick", { vault_id: vaultId, dry_run: false });
    const transition = tick.transitioned.find((t) => t.entity_id === created.entity.entity_id);
    expect(transition).toBeTruthy();

    if (transition.to !== "archived") {
      // Deterministic given the ~26-year backdate, but guard explicitly
      // rather than silently asserting exclusion behavior that was never
      // actually exercised.
      throw new Error(`Expected the backdated entity to reach 'archived' in one tick, got '${transition.to}'.`);
    }

    // Excluded from default list.
    const defaultList = await call("msp_memory_list", { vault_id: vaultId, category: "note" });
    expect(defaultList.entities.map((e) => e.entity_id)).not.toContain(created.entity.entity_id);

    // Reachable via explicit lifecycle_state filter.
    const archivedList = await call("msp_memory_list", { vault_id: vaultId, category: "note", lifecycle_state: "archived" });
    expect(archivedList.entities.map((e) => e.entity_id)).toContain(created.entity.entity_id);

    // Excluded from default search (exact-match short-circuit path).
    const search = await call("msp_memory_search", { vault_id: vaultId, query: "will-archive", mode: "fts" });
    expect(search.hits.map((h) => h.entity.entity_id)).not.toContain(created.entity.entity_id);

    // Always present in history.
    const { history } = await call("msp_memory_history", { entity_id: created.entity.entity_id });
    expect(history.length).toBeGreaterThanOrEqual(1);

    // Row still physically exists -- no DELETE was ever issued.
    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const row = db.prepare("SELECT lifecycle_state FROM entities WHERE entity_id = ?").get(created.entity.entity_id);
      expect(row).toBeTruthy();
      expect(row.lifecycle_state).toBe("archived");
    } finally {
      db.close();
    }
  });
});

describe("WP-16 Bounded Scope item 3: reinforcement on access (touch())", () => {
  it("msp_memory_get on a current-state read bumps access_count and last_accessed_at", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-decay-touch-get");
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "touched-by-get",
      body_json: {},
    });
    expect(created.entity.access_count).toBe(0);

    await call("msp_memory_get", { vault_id: vaultId, category: "note", key: "touched-by-get" });

    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const row = db.prepare("SELECT access_count, last_accessed_at FROM entities WHERE entity_id = ?").get(created.entity.entity_id);
      expect(row.access_count).toBe(1);
      expect(row.last_accessed_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("msp_memory_search hits bump access_count for every returned entity", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-decay-touch-search");
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "findme-unique-token",
      body_json: { text: "findme-unique-token appears in the body too" },
    });

    await call("msp_memory_search", { vault_id: vaultId, query: "findme-unique-token", mode: "fts" });

    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const row = db.prepare("SELECT access_count FROM entities WHERE entity_id = ?").get(created.entity.entity_id);
      expect(row.access_count).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it("msp_memory_get with a point-in-time (as_of) read does NOT reinforce access_count", async () => {
    const { call, dbPath } = spawnRuntime();
    const vaultId = await provisionVault(call, "ws-decay-touch-pit");
    const created = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "workspace_private" },
      category: "note",
      key: "pit-read",
      body_json: { v: 1 },
      valid_from: "2020-01-01T00:00:00Z",
    });

    await call("msp_memory_get", {
      vault_id: vaultId,
      category: "note",
      key: "pit-read",
      as_of_valid_at: "2020-06-01T00:00:00Z",
      as_of_recorded_at: created.entity.recorded_at,
    });

    openCallers.pop().close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const row = db.prepare("SELECT access_count FROM entities WHERE entity_id = ?").get(created.entity.entity_id);
      expect(row.access_count).toBe(0);
    } finally {
      db.close();
    }
  });
});

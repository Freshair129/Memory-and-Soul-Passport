// AC-02/AC-03/AC-04/AC-07 (WP-16): domain/decay-engine.mjs's pure scorer,
// full lifecycle sweep, dry_run non-persistence, and the forgotten-state
// reconciliation, tested directly against a real (temp-file) SQLite database
// -- mirrors test/entity-store.test.mjs's in-process convention (no stdio
// child process needed for pure domain-layer logic).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { DEFAULT_DECAY_THRESHOLDS, recomputeDecayScore, runDecayTick, touch } from "@freshair129/msp-core/decay-engine";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
const VAULT_ID = "vault_decay-engine-test";
const OTHER_VAULT_ID = "vault_decay-engine-test-other";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-decay-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = open(path.join(dir, "db.sqlite3"));
  cleanups.push(() => db.close());
  runMigrations(db, migrationsDir);
  for (const vaultId of [VAULT_ID, OTHER_VAULT_ID]) {
    db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'workspace_private', 'active', ?)").run(
      vaultId,
      "2020-01-01T00:00:00.000Z",
    );
  }
  return db;
}

let entitySeq = 0;
function insertEntity(
  db,
  { vaultId = VAULT_ID, createdAt, lastAccessedAt = null, accessCount = 0, lifecycleState = "active", decayScore = 1.0 },
) {
  entitySeq += 1;
  const entityId = `msp:entity/decay-test-${entitySeq}`;
  db.prepare(
    `INSERT INTO entities
       (entity_id, vault_id, category, key, body_json, current_version, valid_from, recorded_at,
        lifecycle_state, decay_score, access_count, last_accessed_at, source_hash, created_at, updated_at)
     VALUES
       (@entity_id, @vault_id, 'note', @key, '{}', 1, @created_at, @created_at,
        @lifecycle_state, @decay_score, @access_count, @last_accessed_at, 'deadbeef', @created_at, @created_at)`,
  ).run({
    entity_id: entityId,
    vault_id: vaultId,
    key: entityId,
    created_at: createdAt,
    lifecycle_state: lifecycleState,
    decay_score: decayScore,
    access_count: accessCount,
    last_accessed_at: lastAccessedAt,
  });
  return entityId;
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function readEntity(db, entityId) {
  return db.prepare("SELECT * FROM entities WHERE entity_id = ?").get(entityId);
}

function dumpAllEntities(db) {
  return db.prepare("SELECT * FROM entities ORDER BY entity_id").all();
}

const T0 = "2026-01-01T00:00:00.000Z";

describe("domain/decay-engine: recomputeDecayScore (AC-02)", () => {
  it("is a pure, deterministic function of its inputs: identical inputs produce identical scores across repeated calls", () => {
    const entity = { lastAccessedAt: T0, createdAt: T0, accessCount: 3 };
    const now = addDays(T0, 4);
    const first = recomputeDecayScore(entity, now);
    const second = recomputeDecayScore(entity, now);
    const third = recomputeDecayScore(entity, now);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("a never-accessed entity decays from its createdAt, not epoch zero", () => {
    const score = recomputeDecayScore({ lastAccessedAt: null, createdAt: T0, accessCount: 0 }, addDays(T0, 3));
    // stability=3 days, elapsed=3 days -> e^-1 ~= 0.3679
    expect(score).toBeCloseTo(Math.exp(-1), 10);
  });

  it("a just-accessed entity (elapsed ~0) scores at essentially full retention", () => {
    const now = addDays(T0, 30); // createdAt is old, but lastAccessedAt is "now"
    const score = recomputeDecayScore({ lastAccessedAt: now, createdAt: T0, accessCount: 0 }, now);
    expect(score).toBeCloseTo(1, 10);
  });

  it("scores exactly at the 'decayed' and 'archived' threshold boundaries", () => {
    // stability(accessCount=0) = 3 days. Solve elapsedDays = -stability * ln(threshold)
    // so recomputeDecayScore lands on the threshold value itself.
    const stability = 3;
    for (const threshold of [DEFAULT_DECAY_THRESHOLDS.decayed, DEFAULT_DECAY_THRESHOLDS.archived]) {
      const elapsedDays = -stability * Math.log(threshold);
      const now = addDays(T0, elapsedDays);
      const score = recomputeDecayScore({ lastAccessedAt: null, createdAt: T0, accessCount: 0 }, now);
      expect(score).toBeCloseTo(threshold, 9);
    }
  });

  it("a high-access_count entity decays more slowly than a low-access_count entity of the same age", () => {
    const now = addDays(T0, 6);
    const lowAccess = recomputeDecayScore({ lastAccessedAt: null, createdAt: T0, accessCount: 0 }, now);
    const highAccess = recomputeDecayScore({ lastAccessedAt: null, createdAt: T0, accessCount: 10 }, now);
    expect(highAccess).toBeGreaterThan(lowAccess);
  });

  it("throws without an explicit `now` -- no internal Date.now() fallback", () => {
    expect(() => recomputeDecayScore({ createdAt: T0 }, undefined)).toThrow(/now/);
  });
});

describe("domain/decay-engine: runDecayTick full lifecycle (AC-03)", () => {
  it("an untouched entity crosses active -> decayed -> archived at the expected thresholds, while a periodically-touched entity stays active", () => {
    const db = freshDb();
    const untouched = insertEntity(db, { createdAt: T0 });
    const touched = insertEntity(db, { createdAt: T0 });

    const tick1 = addDays(T0, 5); // untouched: e^(-5/3) ~= 0.189 -> below 'decayed' (0.5), above 'archived' (0.15)
    touch(db, touched, addDays(T0, 4.9)); // reinforced just before tick1: elapsed ~0.1 days -> stays active
    const result1 = runDecayTick(db, { vaultId: VAULT_ID, now: tick1 });

    expect(readEntity(db, untouched).lifecycle_state).toBe("decayed");
    expect(readEntity(db, touched).lifecycle_state).toBe("active");
    expect(result1.transitioned).toEqual([{ entity_id: untouched, from: "active", to: "decayed" }]);

    const tick2 = addDays(T0, 15); // untouched: e^(-15/3) ~= 0.0067 -> below 'archived' (0.15)
    touch(db, touched, addDays(T0, 14.9));
    const result2 = runDecayTick(db, { vaultId: VAULT_ID, now: tick2 });

    expect(readEntity(db, untouched).lifecycle_state).toBe("archived");
    expect(readEntity(db, touched).lifecycle_state).toBe("active");
    expect(result2.transitioned).toEqual([{ entity_id: untouched, from: "decayed", to: "archived" }]);
  });

  it("only evaluates the requested vault -- a sweep scoped to one vault never touches another vault's entities", () => {
    const db = freshDb();
    const inScope = insertEntity(db, { vaultId: VAULT_ID, createdAt: T0 });
    const otherVault = insertEntity(db, { vaultId: OTHER_VAULT_ID, createdAt: T0 });

    const result = runDecayTick(db, { vaultId: VAULT_ID, now: addDays(T0, 15) });

    expect(result.evaluated).toBe(1);
    expect(readEntity(db, inScope).lifecycle_state).toBe("archived");
    expect(readEntity(db, otherVault).lifecycle_state).toBe("active"); // untouched by the vault-A sweep
  });
});

describe("domain/decay-engine: dry_run non-persistence (AC-04)", () => {
  it("dry_run: true changes nothing -- entities table is identical before and after", () => {
    const db = freshDb();
    insertEntity(db, { createdAt: T0 });
    insertEntity(db, { createdAt: T0, accessCount: 20 });

    const before = dumpAllEntities(db);
    const result = runDecayTick(db, { vaultId: VAULT_ID, dryRun: true, now: addDays(T0, 15) });
    const after = dumpAllEntities(db);

    expect(after).toEqual(before);
    // The dry run still reports what WOULD have happened.
    expect(result.evaluated).toBe(2);
    expect(result.transitioned.length).toBeGreaterThan(0);
  });

  it("dry_run: false actually persists the computed transitions", () => {
    const db = freshDb();
    const entityId = insertEntity(db, { createdAt: T0 });

    const before = readEntity(db, entityId);
    runDecayTick(db, { vaultId: VAULT_ID, dryRun: false, now: addDays(T0, 15) });
    const after = readEntity(db, entityId);

    expect(after.lifecycle_state).toBe("archived");
    expect(after.decay_score).toBeLessThan(before.decay_score);
  });
});

describe("domain/decay-engine: forgotten-state reconciliation (AC-07)", () => {
  it("a forgotten entity is excluded from the sweep entirely -- not evaluated, not transitioned", () => {
    const db = freshDb();
    const forgotten = insertEntity(db, { createdAt: T0, lifecycleState: "forgotten" });
    const active = insertEntity(db, { createdAt: T0 });

    const result = runDecayTick(db, { vaultId: VAULT_ID, now: addDays(T0, 15) });

    expect(result.evaluated).toBe(1); // forgotten excluded, only `active` counted
    expect(readEntity(db, forgotten).lifecycle_state).toBe("forgotten"); // untouched
    expect(readEntity(db, active).lifecycle_state).toBe("archived");
  });

  it("an already-archived entity, decayed arbitrarily far past the archived threshold, never auto-transitions to 'forgotten'", () => {
    const db = freshDb();
    const entityId = insertEntity(db, { createdAt: T0, lifecycleState: "archived", decayScore: 0.01 });

    const result = runDecayTick(db, { vaultId: VAULT_ID, now: addDays(T0, 3650) }); // ~10 years elapsed

    expect(readEntity(db, entityId).lifecycle_state).toBe("archived");
    expect(result.transitioned.find((t) => t.entity_id === entityId)).toBeUndefined();
  });
});

describe("domain/decay-engine: touch (reinforcement on access)", () => {
  it("bumps access_count and sets last_accessed_at", () => {
    const db = freshDb();
    const entityId = insertEntity(db, { createdAt: T0 });
    expect(readEntity(db, entityId).access_count).toBe(0);
    expect(readEntity(db, entityId).last_accessed_at).toBeNull();

    const now = addDays(T0, 1);
    touch(db, entityId, now);

    const row = readEntity(db, entityId);
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).toBe(now);

    touch(db, entityId, addDays(T0, 2));
    expect(readEntity(db, entityId).access_count).toBe(2);
  });
});

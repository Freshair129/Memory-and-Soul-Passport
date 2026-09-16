// BL-MEMOS-070/073: migration 0015 schema and append-only/redaction
// invariants. This file exercises both an empty database and a populated
// database so additive defaults, foreign keys, and retrieval cleanup are
// proven against the real migration runner.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";

const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function migrationCopy({ maxVersion = 14, include = [] } = {}) {
  const dir = tempDir("msp-phase6-migration-");
  const included = new Set(include);
  for (const name of readdirSync(rootMigrationsDir).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))) {
    const version = Number(name.slice(0, 4));
    if (version <= maxVersion || included.has(version)) {
      writeFileSync(path.join(dir, name), readFileSync(path.join(rootMigrationsDir, name)));
    }
  }
  return dir;
}

function freshDb() {
  const db = open(path.join(tempDir("msp-phase6-db-"), "msp.sqlite3"));
  cleanups.push(() => db.close());
  return db;
}

function seedEntity(db, { vaultId, entityId, category = "preference", key = "coffee", body = '{"text":"private secret"}' }) {
  const now = "2026-09-17T00:00:00.000Z";
  db.prepare("INSERT INTO vaults (vault_id, vault_type, status, decay_policy, tenant_id, principal_id, agent_id, workspace_id, created_at) VALUES (?, 'principal_private', 'active', 'ebbinghaus', 'tenant-p6', 'principal-p6', 'agent-p6', 'workspace-p6', ?)").run(vaultId, now);
  db.prepare(`INSERT INTO entities
    (entity_id, vault_id, category, key, body_json, epistemic_state, confidence, current_version,
     valid_from, recorded_at, lifecycle_state, decay_score, access_count, source_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'confirmed', 0.75, 1, ?, ?, 'active', 1, 0, ?, ?, ?)`)
    .run(entityId, vaultId, category, key, body, now, now, "hash", now, now);
  db.prepare(`INSERT INTO entity_history
    (entity_id, version, body_json, epistemic_state, confidence, valid_from, recorded_at, actor, source_hash)
    VALUES (?, 1, ?, 'confirmed', 0.75, ?, ?, 'test', 'hash')`)
    .run(entityId, body, now, now);
}

describe("Phase 6 migration 0015", () => {
  it("creates the confidence/provenance/redaction schema on a fresh database", () => {
    const db = freshDb();
    const result = runMigrations(db, rootMigrationsDir);

    expect(result.currentVersion).toBe(15);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("PRAGMA table_info(protected_memory_records)").all().map((column) => column.name)).toContain("confidence");
    expect(db.prepare("PRAGMA table_info(entity_history)").all().map((column) => column.name)).toContain("redaction_state");
    expect(db.prepare("PRAGMA table_info(entity_provenance)").all().map((column) => column.name)).toEqual([
      "provenance_id", "tenant_id", "operation", "source_record_id", "source_thread_id", "source_session_id",
      "source_message_refs_json", "target_vault_id", "target_entity_id", "decision", "confidence",
      "confirmed_session_count", "policy_version", "idempotency_key", "source_set_hash", "recorded_at", "redaction_state",
    ]);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_entities_fts_au'").get().sql).toMatch(/lifecycle_state != 'forgotten'/);
  });

  it("preserves populated rows and permits only the documented redactions", () => {
    const db = freshDb();
    const migrationsDir = migrationCopy({ include: [15] });
    runMigrations(db, migrationCopy({ maxVersion: 14 }));
    seedEntity(db, { vaultId: "vault-p6-populated", entityId: "entity-p6-populated" });

    const entity = db.prepare("SELECT entity_id FROM entities WHERE entity_id = 'entity-p6-populated'").get();
    expect(entity).toEqual({ entity_id: "entity-p6-populated" });
    expect(runMigrations(db, migrationsDir).currentVersion).toBe(15);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT confidence FROM protected_memory_records LIMIT 1").get()).toBeUndefined();
    expect(db.prepare("SELECT redaction_state FROM entity_history WHERE entity_id = ?").get("entity-p6-populated")).toEqual({ redaction_state: "none" });

    db.prepare("INSERT INTO embeddings (entity_id, vector, content_hash, created_at) VALUES (?, ?, ?, ?)").run("entity-p6-populated", Buffer.from("v"), "hash", "2026-09-17T00:00:00.000Z");
    db.prepare(`INSERT INTO entity_provenance
      (provenance_id, tenant_id, operation, source_record_id, source_thread_id, source_session_id,
       source_message_refs_json, target_vault_id, target_entity_id, decision, confidence,
       confirmed_session_count, policy_version, idempotency_key, source_set_hash, recorded_at)
      VALUES ('prov-p6', 'tenant-p6', 'msp_memory_consolidate', 'record-p6', 'thread-p6', 'session-p6',
       '["message-p6"]', 'vault-p6-populated', 'entity-p6-populated', 'consolidated', 0.75,
       1, 'phase6-v1', 'idem-p6', 'set-p6', '2026-09-17T00:00:00.000Z')`).run();

    expect(() => db.prepare("UPDATE entity_history SET confidence = 0.1 WHERE entity_id = 'entity-p6-populated'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM entity_history WHERE entity_id = 'entity-p6-populated'").run()).toThrow(/may never be deleted/);
    db.prepare("UPDATE entity_history SET redaction_state = 'tombstoned', body_json = '{}', epistemic_state = 'deprecated', confidence = 0 WHERE entity_id = 'entity-p6-populated'").run();
    expect(db.prepare("SELECT redaction_state, body_json, epistemic_state, confidence FROM entity_history WHERE entity_id = 'entity-p6-populated'").get()).toEqual({ redaction_state: "tombstoned", body_json: "{}", epistemic_state: "deprecated", confidence: 0 });
    expect(() => db.prepare("UPDATE entity_provenance SET source_record_id = 'other' WHERE provenance_id = 'prov-p6'").run()).toThrow(/append-only/);
    db.prepare("UPDATE entity_provenance SET redaction_state = 'tombstoned', source_message_refs_json = '[]' WHERE provenance_id = 'prov-p6'").run();
    expect(db.prepare("SELECT redaction_state, source_message_refs_json FROM entity_provenance WHERE provenance_id = 'prov-p6'").get()).toEqual({ redaction_state: "tombstoned", source_message_refs_json: "[]" });
    expect(() => db.prepare("DELETE FROM entity_provenance WHERE provenance_id = 'prov-p6'").run()).toThrow(/may never be deleted/);

    expect(db.prepare("SELECT entity_id FROM entities_fts WHERE entities_fts MATCH 'private'").all()).toHaveLength(1);
    db.prepare("UPDATE entities SET lifecycle_state = 'forgotten', body_json = '{}', epistemic_state = 'deprecated', confidence = 0 WHERE entity_id = 'entity-p6-populated'").run();
    expect(db.prepare("SELECT entity_id FROM entities_fts WHERE entity_id = 'entity-p6-populated'").all()).toHaveLength(0);
    db.prepare("UPDATE entities SET lifecycle_state = 'active', body_json = '{\"text\":\"restored\"}', epistemic_state = 'confirmed', confidence = 0.5 WHERE entity_id = 'entity-p6-populated'").run();
    expect(db.prepare("SELECT entity_id FROM entities_fts WHERE entity_id = 'entity-p6-populated'").all()).toHaveLength(1);
  });
});

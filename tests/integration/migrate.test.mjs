// AC-03: migrations apply idempotently, schema_migrations records applied
// migrations with a checksum, a checksum-drift guard rejects a modified
// already-applied migration file, and a downgrade guard rejects a database
// whose recorded schema version is higher than any migration file present.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations, SchemaVersionError } from "@freshair129/msp-storage/migrate";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-migrate-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setupMigrationsDir(files) {
  const dir = tempDir();
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

function freshDb() {
  const db = open(path.join(tempDir(), "db.sqlite3"));
  cleanups.push(() => db.close());
  return db;
}

const migration1 = "CREATE TABLE t1 (id INTEGER PRIMARY KEY);";
const migration2 = "CREATE TABLE t2 (id INTEGER PRIMARY KEY);";

describe("db/migrate (AC-03)", () => {
  it("applies all migration files in order and records them with a checksum in schema_migrations", () => {
    const migrationsDir = setupMigrationsDir({ "0001_a.sql": migration1, "0002_b.sql": migration2 });
    const db = freshDb();

    const result = runMigrations(db, migrationsDir);

    expect(result.appliedCount).toBe(2);
    const rows = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
    expect(rows).toHaveLength(2);
    expect(rows[0].version).toBe(1);
    expect(rows[1].version).toBe(2);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(db.pragma("user_version", { simple: true })).toBe(2);

    // The migrations actually ran (not just recorded).
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('t1','t2')").all()).toHaveLength(2);
  });

  it("re-running migrations against an already-migrated database is a no-op", () => {
    const migrationsDir = setupMigrationsDir({ "0001_a.sql": migration1 });
    const db = freshDb();

    runMigrations(db, migrationsDir);
    const second = runMigrations(db, migrationsDir);

    expect(second.appliedCount).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count).toBe(1);
  });

  it("throws SchemaVersionError when an already-applied migration file's checksum has drifted", () => {
    const migrationsDir = setupMigrationsDir({ "0001_a.sql": migration1 });
    const db = freshDb();

    runMigrations(db, migrationsDir);

    // Tamper with the already-applied migration file after the fact.
    writeFileSync(path.join(migrationsDir, "0001_a.sql"), `${migration1}\n-- tampered`, "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/checksum drift/i);
  });

  it("throws SchemaVersionError when PRAGMA user_version exceeds the newest migration file present (downgrade guard)", () => {
    const migrationsDir = setupMigrationsDir({ "0001_a.sql": migration1 });
    const db = freshDb();

    db.pragma("user_version = 999");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/downgrade|newer than the newest/i);
  });

  it("applies the real packaged migrations (0001-0007, including canonical knowledge receipts) without error", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
          "('entities','entity_history','vaults','vault_mounts','contexts','journal','state','promotions','embeddings','links')",
      )
      .all();
    expect(tables).toHaveLength(10);
    // WP-15: entities_fts is a virtual table (type='table' in sqlite_master
    // for FTS5's shadow-table implementation detail is not guaranteed
    // portable, so check by name against the sqlite_master rows FTS5 itself
    // registers instead).
    const ftsRows = db.prepare("SELECT name FROM sqlite_master WHERE name = 'entities_fts'").all();
    expect(ftsRows).toHaveLength(1);

    // WP-14 AC-01/AC-05: the new columns this migration adds are present.
    const entityCols = db.prepare("PRAGMA table_info(entities)").all().map((col) => col.name);
    expect(entityCols).toContain("vault_id");
    const promotionCols = db.prepare("PRAGMA table_info(promotions)").all().map((col) => col.name);
    expect(promotionCols).toContain("vault_id");
    const vaultCols = db.prepare("PRAGMA table_info(vaults)").all().map((col) => col.name);
    expect(vaultCols).toContain("role");

    // WP-16 AC-01: last_accessed_at exists.
    expect(entityCols).toContain("last_accessed_at");

    // WP-17 AC-01: links table exists with its documented columns.
    const linkCols = db.prepare("PRAGMA table_info(links)").all().map((col) => col.name);
    expect(linkCols).toEqual(
      expect.arrayContaining(["link_id", "vault_id", "from_entity_id", "to_entity_id", "link_type", "confidence", "valid_from", "valid_to", "recorded_at", "created_at"]),
    );
  });

  it("re-applying the packaged migrations directory a second time is a no-op (AC-01: migrations apply idempotently)", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    runMigrations(db, migrationsDir);
    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(0);
    expect(second.currentVersion).toBe(12);
  });

  // TASK-MEMOS-002 stage 1: 0008_thread_memory.sql is a real, non-directive
  // migration whose new tables (threads, thread_participants, ...) sit
  // alongside 0001-0007's existing entities/vaults schema. Both a fresh
  // database and one already populated through 0007 must apply 0008 with
  // an EMPTY PRAGMA foreign_key_check and with every pre-existing row
  // intact -- 0008 rebuilds nothing from an earlier migration.
  it("0008_thread_memory.sql applies cleanly on a fresh database: 0001-0008 in order, zero foreign_key_check violations", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    expect(result.currentVersion).toBe(12);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const threadTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
          "('threads','thread_participants','chat_sessions','thread_messages','protected_memory_records'," +
          "'session_compaction_jobs','session_summaries','thread_delivery_receipts','thread_injection_receipts'," +
          "'thread_pending_deliveries','thread_summary_invalidations')",
      )
      .all();
    expect(threadTables).toHaveLength(11);
  });

  // TASK-MEMOS-002 stage 2: 0009_thread_agents.sql is a real, non-directive
  // migration whose new tables (thread_agents, grant_nonces) and ALTERed
  // columns (protected_memory_records.agent_id/visibility,
  // thread_pending_deliveries.agent_id/workspace_id) sit alongside 0008's
  // existing thread-memory schema. Both a fresh database and one already
  // populated through 0008 (with real thread-memory rows, not just
  // 0001-0007's entities/vaults) must apply 0009 with an EMPTY
  // PRAGMA foreign_key_check and with every pre-existing row intact -- 0009
  // rebuilds nothing from an earlier migration.
  it("0009_thread_agents.sql applies cleanly on a fresh database: 0001-0009 in order, zero foreign_key_check violations", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    expect(result.currentVersion).toBe(12);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const agentTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('thread_agents','grant_nonces')")
      .all();
    expect(agentTables).toHaveLength(2);
    const recordCols = db.prepare("PRAGMA table_info(protected_memory_records)").all().map((col) => col.name);
    expect(recordCols).toEqual(expect.arrayContaining(["agent_id", "visibility"]));
    const pendingCols = db.prepare("PRAGMA table_info(thread_pending_deliveries)").all().map((col) => col.name);
    expect(pendingCols).toEqual(expect.arrayContaining(["agent_id", "workspace_id"]));
  });

  it("0009_thread_agents.sql applies cleanly on a database already populated through 0008: pre-existing thread-memory rows survive, zero foreign_key_check violations", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNamesThrough0008 = readdirSync(rootMigrationsDir)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .filter((name) => !name.startsWith("0009_"))
      .filter((name) => !name.startsWith("0010_"))
      .filter((name) => !name.startsWith("0011_"))
      .filter((name) => !name.startsWith("0012_"));
    expect(migrationFileNamesThrough0008).toHaveLength(8);
    const filesThrough0008 = Object.fromEntries(migrationFileNamesThrough0008.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]));
    const migrationsDir0009 = setupMigrationsDir(filesThrough0008);
    const db0009 = freshDb();

    const first0009 = runMigrations(db0009, migrationsDir0009);
    expect(first0009.appliedCount).toBe(8);

    // Populate a real thread, an ACTIVE protected_memory_records row, and a
    // pending delivery through the 0001-0008 schema before 0009 ever runs.
    const nowIso = "2026-01-01T00:00:00.000Z";
    db0009.prepare(
      "INSERT INTO threads(thread_id, thread_kind, channel_type, channel_account_id, external_room_ref_hmac, tenant_id, business_id, status, created_at, updated_at) VALUES (?,'DIRECT','LINE','oa','hash-precedes-0009','tenant-precedes-0009',NULL,'ACTIVE',?,?)",
    ).run("thread-precedes-0009", nowIso, nowIso);
    db0009.prepare(
      "INSERT INTO chat_sessions(session_id, tenant_id, thread_id, status, opened_at, idle_deadline, policy_revision) VALUES (?,?,?,'OPEN',?,?, 'p')",
    ).run("session-precedes-0009", "tenant-precedes-0009", "thread-precedes-0009", nowIso, nowIso);
    db0009.prepare(
      "INSERT INTO thread_participants(membership_id, tenant_id, thread_id, speaker_id, speaker_kind, identity_assurance, joined_at) VALUES (?,?,?, 'alice','HUMAN','VERIFIED',?)",
    ).run("membership-precedes-0009", "tenant-precedes-0009", "thread-precedes-0009", nowIso);
    db0009.prepare(
      "INSERT INTO protected_memory_records(record_id, tenant_id, thread_id, session_id, kind, asserted_by_speaker_id, subject_person_id, scope_json, body_json, source_message_refs_json, status, verification_state, version, created_at, updated_at) VALUES (?,?,?,?,'PREFERENCE','alice','alice','{}','{}','[]','ACTIVE','CANDIDATE',1,?,?)",
    ).run("record-precedes-0009", "tenant-precedes-0009", "thread-precedes-0009", "session-precedes-0009", nowIso, nowIso);
    db0009.prepare(
      "INSERT INTO thread_pending_deliveries(receipt_id, inbound_message_id, source_event_id, tenant_id, business_id, channel_account_id, external_room_ref_hmac, outcome, text, recorded_at) VALUES (?,?,?,?,NULL,?,?,'ACCEPTED','pending-before-0009',?)",
    ).run("receipt-precedes-0009", "inbound-precedes-0009", "inbound-precedes-0009:assistant", "tenant-precedes-0009", "oa", "hash-precedes-0009", nowIso);

    writeFileSync(path.join(migrationsDir0009, "0009_thread_agents.sql"), readFileSync(path.join(rootMigrationsDir, "0009_thread_agents.sql"), "utf8"), "utf8");
    const second0009 = runMigrations(db0009, migrationsDir0009);
    expect(second0009.appliedCount).toBe(1);
    expect(second0009.currentVersion).toBe(9);
    expect(db0009.pragma("foreign_key_check")).toEqual([]);

    // The pre-existing rows are untouched -- 0009 never rebuilds an
    // earlier migration's table -- and the ALTERed columns backfill to
    // their documented defaults (NULL agent_id, 'THREAD' visibility).
    const record = db0009.prepare("SELECT agent_id, visibility FROM protected_memory_records WHERE record_id = ?").get("record-precedes-0009");
    expect(record).toEqual({ agent_id: null, visibility: "THREAD" });
    const pending = db0009.prepare("SELECT agent_id, workspace_id, text FROM thread_pending_deliveries WHERE receipt_id = ?").get("receipt-precedes-0009");
    expect(pending).toEqual({ agent_id: null, workspace_id: null, text: "pending-before-0009" });
  });

  // PH-MEMOS-4 (TASK-MEMOS-004): 0010_erasure_receipts.sql is a real,
  // non-directive migration -- an additive trigger replacement on
  // protected_memory_records (REQUIRES 0009, since the recreated trigger's
  // body references the agent_id/visibility columns 0009 adds) plus one
  // brand-new table (erasure_receipts). Both a fresh database and one
  // already populated through 0009 (with a real ACTIVE protected_memory_
  // records row) must apply 0010 with an EMPTY PRAGMA foreign_key_check
  // and with every pre-existing row intact -- 0010 rebuilds nothing from
  // an earlier migration (no table is dropped, only a trigger).
  it("0010_erasure_receipts.sql applies cleanly on a fresh database: 0001-0010 in order, zero foreign_key_check violations", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    expect(result.currentVersion).toBe(12);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const erasureTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'erasure_receipts'").all();
    expect(erasureTables).toHaveLength(1);
    const erasureCols = db.prepare("PRAGMA table_info(erasure_receipts)").all().map((col) => col.name);
    expect(erasureCols).toEqual(
      expect.arrayContaining(["erasure_receipt_id", "tenant_id", "principal_id", "idempotency_key", "requested_by_agent_id", "tables_affected_json", "created_at"]),
    );
  });

  it("0010_erasure_receipts.sql applies cleanly on a database already populated through 0009: pre-existing rows survive, rootpage unchanged, zero foreign_key_check violations", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNamesThrough0009 = readdirSync(rootMigrationsDir)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .filter((name) => !name.startsWith("0010_"))
      .filter((name) => !name.startsWith("0011_"))
      .filter((name) => !name.startsWith("0012_"));
    expect(migrationFileNamesThrough0009).toHaveLength(9);
    const filesThrough0009 = Object.fromEntries(migrationFileNamesThrough0009.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]));
    const migrationsDir0010 = setupMigrationsDir(filesThrough0009);
    const db0010 = freshDb();

    const first0010 = runMigrations(db0010, migrationsDir0010);
    expect(first0010.appliedCount).toBe(9);

    // Populate a real thread and an ACTIVE protected_memory_records row
    // through the 0001-0009 schema before 0010 ever runs.
    const nowIso = "2026-01-01T00:00:00.000Z";
    db0010.prepare(
      "INSERT INTO threads(thread_id, thread_kind, channel_type, channel_account_id, external_room_ref_hmac, tenant_id, business_id, status, created_at, updated_at) VALUES (?,'DIRECT','LINE','oa','hash-precedes-0010','tenant-precedes-0010',NULL,'ACTIVE',?,?)",
    ).run("thread-precedes-0010", nowIso, nowIso);
    db0010.prepare(
      "INSERT INTO chat_sessions(session_id, tenant_id, thread_id, status, opened_at, idle_deadline, policy_revision) VALUES (?,?,?,'OPEN',?,?, 'p')",
    ).run("session-precedes-0010", "tenant-precedes-0010", "thread-precedes-0010", nowIso, nowIso);
    db0010.prepare(
      "INSERT INTO thread_participants(membership_id, tenant_id, thread_id, speaker_id, speaker_kind, identity_assurance, joined_at) VALUES (?,?,?, 'alice','HUMAN','VERIFIED',?)",
    ).run("membership-precedes-0010", "tenant-precedes-0010", "thread-precedes-0010", nowIso);
    db0010.prepare(
      "INSERT INTO protected_memory_records(record_id, tenant_id, thread_id, session_id, kind, asserted_by_speaker_id, subject_person_id, scope_json, body_json, source_message_refs_json, status, verification_state, version, created_at, updated_at) VALUES (?,?,?,?,'PREFERENCE','alice','alice','{\"raw\":true}','{}','[]','ACTIVE','CANDIDATE',1,?,?)",
    ).run("record-precedes-0010", "tenant-precedes-0010", "thread-precedes-0010", "session-precedes-0010", nowIso, nowIso);

    // REGRESSION GUARD: before 0010 ships, the shipped 0009 trigger still
    // pins scope_json unchanged even on its tombstone branch -- an erasure-
    // shaped UPDATE that also blanks scope_json is refused.
    expect(() =>
      db0010
        .prepare("UPDATE protected_memory_records SET redaction_state = 'tombstoned', body_json = '{}', scope_json = '{}' WHERE record_id = ?")
        .run("record-precedes-0010"),
    ).toThrow(/may only be superseded|tombstoned/i);

    // rootpage-unchanged proof, same style as 0009's own drop+recreate
    // acceptance -- this is a trigger-only replacement, no table rebuild.
    const rootpageBefore = db0010.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='protected_memory_records'").get().rootpage;

    writeFileSync(path.join(migrationsDir0010, "0010_erasure_receipts.sql"), readFileSync(path.join(rootMigrationsDir, "0010_erasure_receipts.sql"), "utf8"), "utf8");
    const second0010 = runMigrations(db0010, migrationsDir0010);
    expect(second0010.appliedCount).toBe(1);
    expect(second0010.currentVersion).toBe(10);
    expect(db0010.pragma("foreign_key_check")).toEqual([]);

    const rootpageAfter = db0010.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='protected_memory_records'").get().rootpage;
    expect(rootpageAfter).toBe(rootpageBefore);

    // The pre-existing row is untouched -- 0010 never rebuilds an earlier
    // migration's table.
    const before = db0010.prepare("SELECT scope_json, redaction_state FROM protected_memory_records WHERE record_id = ?").get("record-precedes-0010");
    expect(before).toEqual({ scope_json: '{"raw":true}', redaction_state: "none" });

    // Now the SAME erasure-shaped UPDATE the regression guard above
    // refused is accepted -- the recreated trigger's tombstone branch now
    // also permits scope_json -> '{}'.
    db0010
      .prepare("UPDATE protected_memory_records SET redaction_state = 'tombstoned', body_json = '{}', scope_json = '{}' WHERE record_id = ?")
      .run("record-precedes-0010");
    const after = db0010.prepare("SELECT scope_json, body_json, redaction_state FROM protected_memory_records WHERE record_id = ?").get("record-precedes-0010");
    expect(after).toEqual({ scope_json: "{}", body_json: "{}", redaction_state: "tombstoned" });

    // erasure_receipts exists, is insertable, and is immutable/no-delete.
    db0010
      .prepare("INSERT INTO erasure_receipts (erasure_receipt_id, tenant_id, principal_id, idempotency_key, requested_by_agent_id, tables_affected_json, created_at) VALUES (?,?,?,?,?,?,?)")
      .run("receipt-0010", "tenant-precedes-0010", "alice", "key-1", "agent-1", "{}", nowIso);
    expect(() => db0010.prepare("UPDATE erasure_receipts SET principal_id = 'bob' WHERE erasure_receipt_id = ?").run("receipt-0010")).toThrow(/immutable/i);
    expect(() => db0010.prepare("DELETE FROM erasure_receipts WHERE erasure_receipt_id = ?").run("receipt-0010")).toThrow(/never be deleted/i);
  });

  // PH-MEMOS-5 (design v0.9.1b §12.4, BL-MEMOS-060/067): 0011_principal_vaults.sql
  // rebuilds `vaults` on a database that is NOT empty -- every migration
  // since 0002 provisions vaults, so a populated `vaults` (plus its four
  // real child tables: vault_mounts, entities, promotions, links) is the
  // expected case, not an edge case. Both a fresh database and one already
  // populated through 0010 must apply 0011 cleanly.
  it("0011_principal_vaults.sql applies cleanly on a fresh database: widened CHECK and new indexes", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const vaultCols = db.prepare("PRAGMA table_info(vaults)").all().map((col) => col.name);
    expect(vaultCols).toEqual(
      expect.arrayContaining(["tenant_id", "principal_id", "decay_policy", "status"]),
    );
    // No principal_hmac or provision_epoch columns: principal ids are random
    // and carry no owner-keyed correlation or generation counter.
    expect(vaultCols).not.toContain("principal_hmac");

    // A direct INSERT/UPDATE producing an unexpected vaults.status value
    // outside ('active', 'erased') is refused by the widened CHECK.
    expect(() =>
      db.prepare(
        "INSERT INTO vaults (vault_id, vault_type, project_id, status, decay_policy, created_at) VALUES (?,?,?,?,?,?)",
      ).run("vault-bad-status", "shared", "project-bad-status", "pending", "ebbinghaus", "2026-01-01T00:00:00.000Z"),
    ).toThrow();
  });

  it("0011_principal_vaults.sql applies cleanly on a database already populated through 0010: pre-existing rows survive and child REFERENCES still name vaults", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNamesThrough0010 = readdirSync(rootMigrationsDir)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .filter((name) => !name.startsWith("0011_"))
      .filter((name) => !name.startsWith("0012_"));
    expect(migrationFileNamesThrough0010).toHaveLength(10);
    const filesThrough0010 = Object.fromEntries(
      migrationFileNamesThrough0010.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]),
    );
    const migrationsDir0011 = setupMigrationsDir(filesThrough0010);
    const db0011 = freshDb();

    const first0011 = runMigrations(db0011, migrationsDir0011);
    expect(first0011.appliedCount).toBe(10);

    // Populate real rows through the 0001-0010 schema before 0011 ever
    // runs: a shared vault (legacy), a mounted workspace_private vault, an
    // entity, a promotion and a link -- exercising all four real child
    // tables 0011's own header comment names.
    const nowIso = "2026-01-01T00:00:00.000Z";
    db0011.prepare("INSERT INTO vaults (vault_id, vault_type, project_id, status, created_at) VALUES (?, 'shared', 'project-precedes-0011', 'active', ?)").run(
      "vault-shared-precedes-0011",
      nowIso,
    );
    db0011.prepare("INSERT INTO vaults (vault_id, vault_type, workspace_id, project_id, status, created_at) VALUES (?, 'workspace_private', 'workspace-precedes-0011', 'project-precedes-0011', 'active', ?)").run(
      "vault-workspace-precedes-0011",
      nowIso,
    );
    db0011.prepare(
      "INSERT INTO vault_mounts (mount_id, vault_id, workspace_id, mount_alias, access_mode, status, mounted_at) VALUES (?,?,?,?,'read','mounted',?)",
    ).run("mount-precedes-0011", "vault-workspace-precedes-0011", "workspace-precedes-0011", "primary", nowIso);
    db0011.prepare(
      `INSERT INTO entities
        (entity_id, vault_id, category, key, body_json, current_version, valid_from, recorded_at,
         lifecycle_state, decay_score, access_count, source_hash, created_at, updated_at)
       VALUES (?, ?, 'note', 'pre-0011', '{}', 1, ?, ?, 'active', 1.0, 0, ?, ?, ?)`,
    ).run("entity-precedes-0011", "vault-workspace-precedes-0011", nowIso, nowIso, "a".repeat(64), nowIso, nowIso);
    db0011.prepare(
      "INSERT INTO promotions (promotion_ref, vault_id, idempotency_key, source_memory_ref, target_scope, target_ref, policy_decision, source_hash, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("promotion-precedes-0011", "vault-workspace-precedes-0011", "key-precedes-0011", "msp:proof/x", "global_private", "entity-precedes-0011", "allow", "a".repeat(64), nowIso);
    db0011.prepare(
      `INSERT INTO entities
        (entity_id, vault_id, category, key, body_json, current_version, valid_from, recorded_at,
         lifecycle_state, decay_score, access_count, source_hash, created_at, updated_at)
       VALUES (?, ?, 'note', 'pre-0011-b', '{}', 1, ?, ?, 'active', 1.0, 0, ?, ?, ?)`,
    ).run("entity-precedes-0011-b", "vault-workspace-precedes-0011", nowIso, nowIso, "b".repeat(64), nowIso, nowIso);
    db0011.prepare(
      "INSERT INTO links (link_id, vault_id, from_entity_id, to_entity_id, link_type, confidence, valid_from, recorded_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("link-precedes-0011", "vault-workspace-precedes-0011", "entity-precedes-0011", "entity-precedes-0011-b", "relates_to", 1.0, nowIso, nowIso, nowIso);

    writeFileSync(path.join(migrationsDir0011, "0011_principal_vaults.sql"), readFileSync(path.join(rootMigrationsDir, "0011_principal_vaults.sql"), "utf8"), "utf8");
    const second0011 = runMigrations(db0011, migrationsDir0011);
    expect(second0011.appliedCount).toBe(1);
    expect(second0011.currentVersion).toBe(11);
    expect(db0011.pragma("foreign_key_check")).toEqual([]);

    // Every pre-existing row survives with its legacy owner fields intact;
    // principal-only columns are not added to legacy rows.
    const sharedRow = db0011.prepare("SELECT status, tenant_id, principal_id FROM vaults WHERE vault_id = ?").get("vault-shared-precedes-0011");
    expect(sharedRow).toEqual({ status: "active", tenant_id: null, principal_id: null });
    const workspaceRow = db0011.prepare("SELECT status, decay_policy FROM vaults WHERE vault_id = ?").get("vault-workspace-precedes-0011");
    expect(workspaceRow).toEqual({ status: "active", decay_policy: "ebbinghaus" });
    expect(db0011.prepare("SELECT entity_id FROM entities WHERE entity_id = ?").get("entity-precedes-0011")).toBeTruthy();
    expect(db0011.prepare("SELECT promotion_ref FROM promotions WHERE promotion_ref = ?").get("promotion-precedes-0011")).toBeTruthy();
    expect(db0011.prepare("SELECT link_id FROM links WHERE link_id = ?").get("link-precedes-0011")).toBeTruthy();
    expect(db0011.prepare("SELECT mount_id FROM vault_mounts WHERE mount_id = ?").get("mount-precedes-0011")).toBeTruthy();

    // vault_mounts.vault_id / entities.vault_id / promotions.vault_id /
    // links.vault_id REFERENCES vaults (vault_id) still name `vaults`, not
    // a dropped `vaults_old` -- the exact "rename away" mistake
    // docs/MIGRATION.md documents. Confirmed by reading each child table's
    // own foreign_key_list, not merely by the absence of a foreign_key_check
    // violation (which would also be silent about a target that resolves
    // to nothing at all).
    for (const child of ["vault_mounts", "entities", "promotions", "links"]) {
      const foreignKeys = db0011.pragma(`foreign_key_list(${child})`);
      const vaultForeignKey = foreignKeys.find((fk) => fk.from === "vault_id");
      expect(vaultForeignKey?.table, `${child}.vault_id must still reference "vaults"`).toBe("vaults");
    }
    expect(db0011.prepare("SELECT name FROM sqlite_schema WHERE name = 'vaults_old'").all()).toEqual([]);

    // A legacy project_id backfill attempted against a principal-type row
    // is refused by trg_vaults_update_guard's branch (a) type predicate --
    // exercised end to end with a real principal_private row below.
    const principalVaultId = "vault-principal-precedes-0011-test";
    db0011.prepare(
      "INSERT INTO vaults (vault_id, vault_type, tenant_id, principal_id, agent_id, workspace_id, decay_policy, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(principalVaultId, "principal_private", "tenant-1", "principal-1", "agent-1", "workspace-1", "ebbinghaus", "active", nowIso);
    expect(() =>
      db0011.prepare("UPDATE vaults SET project_id = ? WHERE vault_id = ?").run("some-project", principalVaultId),
    ).toThrow(/vaults rows may only backfill project_id/);

    // A direct INSERT INTO vault_mounts naming a principal_private vault_id
    // is refused before any application code runs.
    expect(() =>
      db0011.prepare(
        "INSERT INTO vault_mounts (mount_id, vault_id, workspace_id, mount_alias, access_mode, status, mounted_at) VALUES (?,?,?,?,'read','mounted',?)",
      ).run("mount-principal-refused", principalVaultId, "workspace-1", "alias", nowIso),
    ).toThrow(/never be mountable|never mountable/);

    // The active -> erased transition (principal_id blanked) succeeds, and
    // an UPDATE that also blanks tenant_id/agent_id/workspace_id alongside
    // principal_id succeeds too -- the widened branch (b), not merely its
    // text.
    db0011.prepare("UPDATE vaults SET status = 'erased', principal_id = NULL WHERE vault_id = ?").run(principalVaultId);
    const erasedRow = db0011.prepare("SELECT status, principal_id, tenant_id, agent_id, workspace_id FROM vaults WHERE vault_id = ?").get(principalVaultId);
    expect(erasedRow.status).toBe("erased");
    expect(erasedRow.principal_id).toBeNull();
    expect(erasedRow.tenant_id).toBe("tenant-1");

    const principalVaultId2 = "vault-principal-precedes-0011-test-2";
    db0011.prepare(
      "INSERT INTO vaults (vault_id, vault_type, tenant_id, principal_id, agent_id, workspace_id, decay_policy, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(principalVaultId2, "principal_private", "tenant-2", "principal-2", "agent-2", "workspace-2", "ebbinghaus", "active", nowIso);
    db0011.prepare(
      "UPDATE vaults SET status = 'erased', principal_id = NULL, tenant_id = NULL, agent_id = NULL, workspace_id = NULL WHERE vault_id = ?",
    ).run(principalVaultId2);
    const widenedErasedRow = db0011.prepare("SELECT status, principal_id, tenant_id, agent_id, workspace_id FROM vaults WHERE vault_id = ?").get(principalVaultId2);
    expect(widenedErasedRow).toEqual({ status: "erased", principal_id: null, tenant_id: null, agent_id: null, workspace_id: null });

    // A direct DELETE FROM vaults WHERE vault_id = ? against ANY row --
    // active, erased, legacy or principal-type -- is refused: the
    // statement THROWS (RAISE(ABORT, 'vaults rows may never be deleted')),
    // asserted by catching that throw, not by reading a `changes` count
    // the throw never returns. Run once against the erased principal_private
    // row specifically.
    expect(() => db0011.prepare("DELETE FROM vaults WHERE vault_id = ?").run(principalVaultId)).toThrow(/vaults rows may never be deleted/);
    expect(() => db0011.prepare("DELETE FROM vaults WHERE vault_id = ?").run("vault-shared-precedes-0011")).toThrow(/vaults rows may never be deleted/);
  });

  // PH-MEMOS-5 (design v0.9.1b §12.4.1, BL-MEMOS-064/067): additive-only,
  // no foreign-keys=off directive needed -- contexts is not referenced by
  // any other table's foreign key.
  it("0012_contexts_access_scope.sql applies cleanly on top of 0011, additive nullable columns, no rebuild", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const contextCols = db.prepare("PRAGMA table_info(contexts)").all().map((col) => col.name);
    expect(contextCols).toEqual(expect.arrayContaining(["tenant_id", "principal_id"]));

    const nowIso = "2026-01-01T00:00:00.000Z";
    // A legacy (both columns null) row is unaffected.
    db.prepare(
      "INSERT INTO contexts (context_id, cache_id, workspace_id, agent_id, refs_json, source_hash, policy_decision, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("context-legacy-0012", "cache-legacy-0012", "workspace-1", "agent-1", "{}", "a".repeat(64), "allow", nowIso);
    const legacyRow = db.prepare("SELECT tenant_id, principal_id FROM contexts WHERE context_id = ?").get("context-legacy-0012");
    expect(legacyRow).toEqual({ tenant_id: null, principal_id: null });

    // A scoped (both columns non-null) row can be written directly.
    db.prepare(
      "INSERT INTO contexts (context_id, cache_id, workspace_id, agent_id, tenant_id, principal_id, refs_json, source_hash, policy_decision, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("context-scoped-0012", "cache-scoped-0012", "workspace-1", "agent-1", "tenant-1", "principal-1", "{}", "b".repeat(64), "allow", nowIso);
    const scopedRow = db.prepare("SELECT tenant_id, principal_id FROM contexts WHERE context_id = ?").get("context-scoped-0012");
    expect(scopedRow).toEqual({ tenant_id: "tenant-1", principal_id: "principal-1" });

    const indexRows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_contexts_tenant_principal'").all();
    expect(indexRows).toHaveLength(1);
  });

  it("0008_thread_memory.sql applies cleanly on a database already populated through 0007: pre-existing rows survive, zero foreign_key_check violations", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNames = readdirSync(rootMigrationsDir)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .filter((name) => !name.startsWith("0008_"))
      .filter((name) => !name.startsWith("0009_"))
      .filter((name) => !name.startsWith("0010_"))
      .filter((name) => !name.startsWith("0011_"))
      .filter((name) => !name.startsWith("0012_"));
    expect(migrationFileNames).toHaveLength(7);
    const files = Object.fromEntries(migrationFileNames.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]));
    const migrationsDir = setupMigrationsDir(files);
    const db = freshDb();

    const first = runMigrations(db, migrationsDir);
    expect(first.appliedCount).toBe(7);

    // Populate a real row through the 0001-0007 schema before 0008 ever runs.
    db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'shared', 'active', ?)").run(
      "vault-precedes-0008",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO entities
        (entity_id, vault_id, category, key, body_json, current_version, valid_from, recorded_at,
         lifecycle_state, decay_score, access_count, source_hash, created_at, updated_at)
       VALUES (?, ?, 'note', 'pre-0008', '{}', 1, ?, ?, 'active', 1.0, 0, ?, ?, ?)`,
    ).run("entity-precedes-0008", "vault-precedes-0008", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "a".repeat(64), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    writeFileSync(path.join(migrationsDir, "0008_thread_memory.sql"), readFileSync(path.join(rootMigrationsDir, "0008_thread_memory.sql"), "utf8"), "utf8");
    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(1);
    expect(second.currentVersion).toBe(8);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    // The pre-existing rows are untouched -- 0008 never rebuilds an
    // earlier migration's table.
    expect(db.prepare("SELECT vault_id FROM vaults WHERE vault_id = ?").get("vault-precedes-0008")).toBeTruthy();
    expect(db.prepare("SELECT entity_id FROM entities WHERE entity_id = ?").get("entity-precedes-0008")).toBeTruthy();
  });

  it("WP-16 AC-01: the lifecycle_state CHECK constraint rejects an out-of-enum value", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    runMigrations(db, migrationsDir);
    db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'workspace_private', 'active', ?)").run(
      "vault_check-constraint-test",
      "2020-01-01T00:00:00.000Z",
    );
    expect(() => {
      db.prepare(
        `INSERT INTO entities
           (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, lifecycle_state, source_hash, created_at, updated_at)
         VALUES ('msp:entity/bad-lifecycle', 'vault_check-constraint-test', 'cat', 'k', '{}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'not-a-real-state', 'deadbeef', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
      ).run();
    }).toThrow(/CHECK constraint failed/i);
  });

  it("WP-16 AC-01: entities_fts triggers survive migration 0005's rebuild of entities -- a post-migration mutation still projects into entities_fts", () => {
    const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const db = freshDb();
    runMigrations(db, migrationsDir);
    db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'workspace_private', 'active', ?)").run(
      "vault_fts-survival-test",
      "2020-01-01T00:00:00.000Z",
    );

    db.prepare(
      `INSERT INTO entities
         (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
       VALUES ('msp:entity/fts-survival', 'vault_fts-survival-test', 'cat', 'searchable-key', '{"hello":"world"}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'deadbeef', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
    ).run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM entities_fts WHERE entity_id = ?").get("msp:entity/fts-survival").count).toBe(1);

    db.prepare("UPDATE entities SET body_json = '{\"hello\":\"updated\"}' WHERE entity_id = ?").run("msp:entity/fts-survival");
    const afterUpdate = db.prepare("SELECT body_text FROM entities_fts WHERE entity_id = ?").get("msp:entity/fts-survival");
    expect(afterUpdate.body_text).toBe('{"hello":"updated"}');

    db.prepare("DELETE FROM entities WHERE entity_id = ?").run("msp:entity/fts-survival");
    expect(db.prepare("SELECT COUNT(*) AS count FROM entities_fts WHERE entity_id = ?").get("msp:entity/fts-survival").count).toBe(0);
  });
});

// WP-E0: a migration file whose first line is exactly
// "-- msp-migration: foreign-keys=off" gets the standard SQLite 12-step
// parent-table rebuild procedure (PRAGMA foreign_keys=OFF outside the
// transaction, PRAGMA foreign_key_check inside it before commit, PRAGMA
// foreign_keys restored in a finally). These tests use their own temporary
// migration directories -- the root migrations/ files are never touched;
// their checksums are lineage evidence (docs/GATE-A.md).
const FOREIGN_KEYS_OFF_DIRECTIVE = "-- msp-migration: foreign-keys=off";

// 0001: a parent table with a narrow CHECK and a child table with a NOT
// NULL foreign key into it.
const parentChildInit = [
  "CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a')));",
  "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
].join("\n");

// The 12-step rebuild body (steps 3-9 collapsed to what this schema needs):
// create parent_new with a widened CHECK, copy every row, drop parent,
// rename parent_new to parent. `excludeId` optionally drops one row from
// the INSERT...SELECT to produce an orphaned child for the rollback case.
function parentRebuildBody({ excludeId } = {}) {
  const selectClause = excludeId ? ` WHERE id <> '${excludeId}'` : "";
  return [
    "CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a', 'b')));",
    `INSERT INTO parent_new (id, kind) SELECT id, kind FROM parent${selectClause};`,
    "DROP TABLE parent;",
    "ALTER TABLE parent_new RENAME TO parent;",
  ].join("\n");
}

function withDirective(body) {
  return `${FOREIGN_KEYS_OFF_DIRECTIVE}\n${body}`;
}

// The UNSAFE "rename the old table away" rebuild order. SQLite rewrites a
// child table's REFERENCES clause to follow a RENAME of the table it
// names, regardless of PRAGMA foreign_keys, so this leaves `child` pointing
// at `parent_old`, which is then dropped -- PRAGMA foreign_key_check alone
// cannot catch this when `child` is empty, since it only inspects existing
// rows. This is exactly what the structural check exists to reject.
function renameAwayRebuildBody() {
  return [
    "ALTER TABLE parent RENAME TO parent_old;",
    "CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a', 'b')));",
    "INSERT INTO parent (id, kind) SELECT id, kind FROM parent_old;",
    "DROP TABLE parent_old;",
  ].join("\n");
}

function seedParentAndChildRows(db) {
  db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();
  db.prepare("INSERT INTO parent (id, kind) VALUES ('p2', 'a')").run();
  db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 'p1')").run();
  db.prepare("INSERT INTO child (id, parent_id) VALUES (2, 'p2')").run();
}

// Applies migration 0001 alone (the parent/child schema), seeds rows into
// it, then drops migration 0002 into the same directory so it is applied
// against an already-populated database -- exactly the ordering that makes
// the foreign-keys=off mode necessary in the first place.
function initAndPopulate(migrationsDir, db) {
  runMigrations(db, migrationsDir);
  seedParentAndChildRows(db);
}

function addMigration0002(migrationsDir, sql) {
  writeFileSync(path.join(migrationsDir, "0002_widen_parent_kind.sql"), sql, "utf8");
}

describe("db/migrate foreign-keys=off mode (WP-E0)", () => {
  it("rebuilds a populated parent table: every parent/child row survives, foreign_key_check is empty, the FK still resolves, foreign_keys is restored to 1, user_version is 2, and both migrations are recorded", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()));

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);

    expect(db.prepare("SELECT id, kind FROM parent ORDER BY id").all()).toEqual([
      { id: "p1", kind: "a" },
      { id: "p2", kind: "a" },
    ]);
    expect(db.prepare("SELECT id, parent_id FROM child ORDER BY id").all()).toEqual([
      { id: 1, parent_id: "p1" },
      { id: 2, parent_id: "p2" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(2);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }, { version: 2 }]);

    // The rebuilt parent table's REFERENCES clause on child still resolves:
    // a bogus parent_id is refused.
    expect(() => db.prepare("INSERT INTO child (id, parent_id) VALUES (3, 'does-not-exist')").run()).toThrow(
      /FOREIGN KEY constraint failed/i,
    );

    // The widened CHECK actually took effect.
    expect(() => db.prepare("INSERT INTO parent (id, kind) VALUES ('p3', 'b')").run()).not.toThrow();
  });

  it("rolls back a rebuild that would orphan a child row: throws SchemaVersionError prefixed migration_foreign_key_check_failed, naming the table, leaves schema_migrations/user_version/table contents unchanged, and restores foreign_keys to 1", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    // Rebuild that drops 'p1' from the copy while child row 1 still
    // references it -- an orphan.
    addMigration0002(migrationsDir, withDirective(parentRebuildBody({ excludeId: "p1" })));

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:.*"child"/s);

    // Not recorded, not bumped.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);

    // Table contents unchanged -- both parent rows and both child rows.
    expect(db.prepare("SELECT id, kind FROM parent ORDER BY id").all()).toEqual([
      { id: "p1", kind: "a" },
      { id: "p2", kind: "a" },
    ]);
    expect(db.prepare("SELECT id, parent_id FROM child ORDER BY id").all()).toEqual([
      { id: 1, parent_id: "p1" },
      { id: 2, parent_id: "p2" },
    ]);

    // The whole transaction rolled back, not just the parts that failed: no
    // leftover parent_new, and the original narrow CHECK is back in force.
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'parent_new'").all()).toEqual([]);
    expect(() => db.prepare("INSERT INTO parent (id, kind) VALUES ('p3', 'b')").run()).toThrow(/CHECK constraint failed/i);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("rejects the unsafe rename-away rebuild order even with an EMPTY child table -- PRAGMA foreign_key_check alone cannot catch this", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    runMigrations(db, migrationsDir);
    // Populate ONLY parent -- child stays empty, which is exactly the case
    // the row-level PRAGMA foreign_key_check cannot catch on its own.
    db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM child").get().count).toBe(0);

    addMigration0002(migrationsDir, withDirective(renameAwayRebuildBody()));

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:.*"child".*"parent_old"/s);

    // Not recorded, not bumped.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);

    // Rolled back: child's schema still says REFERENCES parent, not
    // parent_old, and parent itself is still the original table.
    const childSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'child'").get();
    expect(childSchema.sql).toMatch(/REFERENCES parent\s*\(\s*id\s*\)/);
    expect(db.prepare("SELECT id, kind FROM parent").all()).toEqual([{ id: "p1", kind: "a" }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("refuses to blame a directive migration for a pre-existing foreign-key violation it did not create", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);

    // Corrupt the database out-of-band, unrelated to any migration: delete
    // a referenced parent row directly while foreign keys are off, so the
    // violation predates this migration entirely.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM parent WHERE id = 'p1'").run();
    db.pragma("foreign_keys = ON");
    expect(db.pragma("foreign_key_check")).toHaveLength(1);

    // A directive migration that does not even touch parent or child.
    addMigration0002(migrationsDir, withDirective("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);"));

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_preexisting_foreign_key_violation:.*"child"/s);

    // The migration never got the chance to run -- not recorded, and its
    // CREATE TABLE never executed.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("refuses a directive migration that runs while the connection is already inside a transaction, prefixed migration_in_transaction_refused (not migration_foreign_key_check_failed, since no check ran), and records nothing", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()));

    expect(() =>
      db.transaction(() => {
        runMigrations(db, migrationsDir);
      })(),
    ).toThrow(/^migration_in_transaction_refused:.*already inside a transaction/s);

    // Nothing recorded, nothing bumped -- the check never even ran.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });

  it("without the directive, the same populated rebuild fails on the plain path -- this is the reason the mode exists", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, parentRebuildBody());

    expect(() => runMigrations(db, migrationsDir)).toThrow(/FOREIGN KEY constraint failed/i);

    // Rolled back: only 0001 is recorded, and the original parent table
    // (narrow CHECK, original rows) is still in place.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(() => db.prepare("INSERT INTO parent (id, kind) VALUES ('p3', 'b')").run()).toThrow(/CHECK constraint failed/i);
  });

  it("a directive not on the first line is not a directive -- it is refused outright as misplaced, not silently run on the plain path", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(
      migrationsDir,
      ["-- a leading comment pushes the directive off the first line", FOREIGN_KEYS_OFF_DIRECTIVE, parentRebuildBody()].join(
        "\n",
      ),
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_directive_misplaced:.*"0002_widen_parent_kind\.sql"/s,
    );

    // Never even attempted: not recorded, user_version unchanged, parent
    // table untouched.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("a UTF-8 BOM before an otherwise-exact directive on line 1 is refused as misplaced too", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, `﻿${withDirective(parentRebuildBody())}`);

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_directive_misplaced:/);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("trailing whitespace after an otherwise-exact directive on line 1 is refused as misplaced", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()).replace(FOREIGN_KEYS_OFF_DIRECTIVE, `${FOREIGN_KEYS_OFF_DIRECTIVE} `));

    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_directive_misplaced:/);
  });

  it("a leading space after '--' (not before it) on an otherwise-exact directive line is refused as misplaced, not accepted", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    // One extra space right after the "--" prefix, before "msp-migration".
    const extraSpaceAfterDashes = `--  msp-migration: foreign-keys=off`;
    addMigration0002(migrationsDir, `${extraSpaceAfterDashes}\n${parentRebuildBody()}`);

    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_directive_misplaced:/);
  });

  it("different casing on an otherwise-exact directive line is refused as misplaced, not accepted case-insensitively", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()).toUpperCase());

    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_directive_misplaced:/);
  });

  it("an exact directive on line 1 ends header scanning; a later marker comment does not override the directive", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(
      migrationsDir,
      [FOREIGN_KEYS_OFF_DIRECTIVE, "-- msp-migration: later header text", parentRebuildBody()].join("\n"),
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT id, kind FROM parent ORDER BY id").all()).toEqual([{ id: "p1", kind: "a" }, { id: "p2", kind: "a" }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  // RKOI review of WP-E0, warning 2: classifyForeignKeysDirective() used to
  // compare a whole header line against the exact directive text, so any
  // near-miss spelling was classified "plain" and applied silently on the
  // path with no structural FK check -- exactly the outage this mode exists
  // to prevent. Each near-miss below must be refused as misplaced instead.
  const NEAR_MISS_DIRECTIVE_LINES = [
    ["no space after '--'", "--msp-migration: foreign-keys=off"],
    ["underscore instead of a hyphen", "-- msp-migration: foreign_keys=off"],
    ["spaces around '='", "-- msp-migration: foreign-keys = off"],
    ["missing space after the colon", "-- msp-migration:foreign-keys=off"],
    ["doubled space after the colon", "-- msp-migration:  foreign-keys=off"],
  ];

  it.each(NEAR_MISS_DIRECTIVE_LINES)(
    "near-miss spelling (%s) is refused as misplaced, not silently applied on the plain path",
    (_description, nearMissLine) => {
      const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
      const db = freshDb();

      initAndPopulate(migrationsDir, db);
      // The unsafe rebuild order: if this were misclassified "plain" and
      // applied, it would either throw a plain FOREIGN KEY error (masking
      // the real problem) or, worse, silently corrupt the schema on an
      // empty child table. It must never reach that path at all.
      addMigration0002(migrationsDir, `${nearMissLine}\n${renameAwayRebuildBody()}`);

      expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
      expect(() => runMigrations(db, migrationsDir)).toThrow(
        /^migration_directive_misplaced:.*"0002_widen_parent_kind\.sql"/s,
      );

      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([{ version: 1 }]);
      expect(db.pragma("user_version", { simple: true })).toBe(1);
    },
  );

  it("a prose comment in the header that merely mentions 'msp-migration' is refused as misplaced -- the header is reserved for the runner (documented in docs/MIGRATION.md)", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(
      migrationsDir,
      ["-- see msp-migration directive docs", parentRebuildBody()].join("\n"),
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_directive_misplaced:.*"0002_widen_parent_kind\.sql"/s,
    );

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });

  it("'msp-migration' appearing only after the file's first SQL statement is not scanned -- the migration runs on the plain path", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    // The leading comment block ends at the first non-comment line (the
    // CREATE TABLE below); everything after that, including a comment that
    // mentions "msp-migration", is outside it and must not be scanned.
    addMigration0002(
      migrationsDir,
      ["CREATE TABLE unrelated_after_first_statement (id INTEGER PRIMARY KEY);", "-- msp-migration: not a directive here"].join(
        "\n",
      ),
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated_after_first_statement'").all()).toHaveLength(1);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("the real root migrations 0001-0007, copied into a temp directory, apply with no directive classification error -- none of their leading comment blocks mentions msp-migration", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNames = readdirSync(rootMigrationsDir).filter((name) => /^\d{4}_.*\.sql$/.test(name));
    expect(migrationFileNames).toHaveLength(12);

    const files = Object.fromEntries(
      migrationFileNames.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]),
    );
    const migrationsDir = setupMigrationsDir(files);
    const db = freshDb();

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);
    expect(result.currentVersion).toBe(12);
  });

  it("idempotency: a second runMigrations over the same directory applies 0 migrations and leaves foreign_keys at 1", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()));
    runMigrations(db, migrationsDir);

    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("the checksum-drift guard covers the directive line itself", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()));
    runMigrations(db, migrationsDir);

    // Rewrite the already-applied 0002 file with the directive removed --
    // same rebuild SQL, different first line -- and the checksum no longer
    // matches what was recorded when it was applied.
    addMigration0002(migrationsDir, parentRebuildBody());

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/checksum drift/i);
  });

  it("restores foreign_keys to whatever it was before the migration ran, even when that was already OFF", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    initAndPopulate(migrationsDir, db);
    addMigration0002(migrationsDir, withDirective(parentRebuildBody()));

    db.pragma("foreign_keys = OFF");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // Restored to what it was BEFORE this migration ran, not forced to ON.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  });
});

// RKOI follow-up warning 2: scanning migration headers can never catch
// every mistake. A C-style comment header, a comment ahead of the
// directive, a leading real PRAGMA statement, or a marker misspelling that
// doesn't even contain the substring "msp-migration" all still classify
// "plain" and reach the plain path with no directive at all -- and the
// plain path had no structural check of its own. These tests use their own
// temporary migration directories; the root migrations/ files are never
// touched.
describe("db/migrate structural foreign-key check on the plain path (RKOI follow-up warning 2)", () => {
  it("refuses the unsafe rename-away rebuild on the plain path with a populated parent and an EMPTY child and no directive at all -- this is the outage case", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    runMigrations(db, migrationsDir);
    // Populate ONLY parent -- child stays empty, which is exactly the case
    // a row-level check cannot catch and the plain path never even ran one.
    db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM child").get().count).toBe(0);

    addMigration0002(migrationsDir, renameAwayRebuildBody());

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:.*"child".*"parent_old"/s);

    // Not recorded, not bumped.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);

    // Rolled back: child's schema still says REFERENCES parent, not
    // parent_old.
    const childSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'child'").get();
    expect(childSchema.sql).toMatch(/REFERENCES parent\s*\(\s*id\s*\)/);
    expect(db.prepare("SELECT id, kind FROM parent").all()).toEqual([{ id: "p1", kind: "a" }]);
  });

  // Each of these headers fails to be recognized as either the exact
  // directive OR a near-miss "misplaced" line: a C-style comment isn't a
  // "--" line at all, a leading PRAGMA statement isn't a comment at all,
  // and the underscore spelling doesn't contain the marker substring
  // "msp-migration". All four therefore reach the plain path with no
  // directive -- and now refuse there instead of silently applying.
  const PLAIN_PATH_MISS_SHAPE_HEADERS = [
    ["a C-style /* msp-migration: foreign-keys=off */ header on line 1", "/* msp-migration: foreign-keys=off */"],
    ["a /* header */ comment ahead of the directive", "/* header */\n-- msp-migration: foreign-keys=off"],
    ["a leading real PRAGMA foreign_keys = OFF; statement", "PRAGMA foreign_keys = OFF;"],
    ["the underscore spelling msp_migration (no \"msp-migration\" substring at all)", "-- msp_migration: foreign-keys=off"],
  ];

  it.each(PLAIN_PATH_MISS_SHAPE_HEADERS)(
    "%s still refuses the unsafe rebuild -- through whichever path it reaches, the prefix is what matters",
    (_description, header) => {
      const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
      const db = freshDb();

      runMigrations(db, migrationsDir);
      db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();

      addMigration0002(migrationsDir, `${header}\n${renameAwayRebuildBody()}`);

      expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
      expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:/);

      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([{ version: 1 }]);
      expect(db.pragma("user_version", { simple: true })).toBe(1);
    },
  );

  it("applies the safe-order rebuild on the plain path with an empty child and no directive -- no false rejection", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    runMigrations(db, migrationsDir);
    db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM child").get().count).toBe(0);

    addMigration0002(migrationsDir, parentRebuildBody());

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT id, kind FROM parent").all()).toEqual([{ id: "p1", kind: "a" }]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("refuses a plain migration adding a foreign key to a column that is not a key on the target table (no PK, no UNIQUE index) -- via SQLite's own parent-side resolution, not a raw SqliteError", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": "CREATE TABLE parent (code TEXT NOT NULL);" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // SQLite itself does not refuse CREATE TABLE for this -- the mismatch
    // only surfaces when something actually checks the key, which is
    // exactly what this test exercises.
    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL REFERENCES parent(code));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    // The parent-side probe (`findParentSideForeignKeyProbeFailure`) names
    // the PARENT table it prepared the DELETE against, not the child, and
    // quotes SQLite's own "foreign key mismatch" message verbatim.
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"parent".*foreign key mismatch.*"child".*"parent"/s,
    );

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a partial UNIQUE index as an FK target on the plain path, as a prefixed SchemaVersionError, never a raw SqliteError", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE TABLE parent (id TEXT NOT NULL);",
        "CREATE UNIQUE INDEX parent_id_partial ON parent(id) WHERE id IS NOT NULL;",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:/);
  });

  it("refuses a partial UNIQUE index as an FK target on the directive path too, as a prefixed SchemaVersionError, never a raw SqliteError", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE TABLE parent (id TEXT NOT NULL);",
        "CREATE UNIQUE INDEX parent_id_partial ON parent(id) WHERE id IS NOT NULL;",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:/);
  });

  it("refuses a collation-mismatched UNIQUE index (COLLATE NOCASE on a BINARY column) as an FK target, prefixed", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE TABLE parent (id TEXT NOT NULL);",
        "CREATE UNIQUE INDEX parent_id_nocase ON parent(id COLLATE NOCASE);",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:/);
  });

  it("applies the real root migrations 0001-0007 cleanly under the new plain-path structural check, then a follow-on plain migration 0008 too -- an ordinary follow-on migration is not rejected", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNames = readdirSync(rootMigrationsDir).filter((name) => /^\d{4}_.*\.sql$/.test(name));
    expect(migrationFileNames).toHaveLength(12);
    const files = Object.fromEntries(
      migrationFileNames.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]),
    );
    const migrationsDir = setupMigrationsDir(files);
    const db = freshDb();

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);

    writeFileSync(
      path.join(migrationsDir, "0013_trivial_followup.sql"),
      "CREATE TABLE trivial_followup (id INTEGER PRIMARY KEY);",
      "utf8",
    );
    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(1);
    expect(second.currentVersion).toBe(13);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'trivial_followup'").all()).toHaveLength(1);
  });

  // RKOI review (same follow-up, 1 critical): a hand-written parser that
  // decided the "is this a real key, with matching collation" question by
  // re-reading CREATE TABLE text disagreed with SQLite on 7 of 27 real
  // parent-key shapes. That question is now delegated to SQLite itself
  // (`checkForeignKeysResolveOnPlainPath` on the plain path,
  // `runForeignKeyCheck` on the directive path) instead of a parser.
  it("refuses a table-level PRIMARY KEY (id COLLATE NOCASE) target on a BINARY column, on the plain path, with an EMPTY child", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": "CREATE TABLE parent (id TEXT, PRIMARY KEY (id COLLATE NOCASE));",
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:/);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses the same table-level PRIMARY KEY (id COLLATE NOCASE) target on the directive path too, with an EMPTY child", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": "CREATE TABLE parent (id TEXT, PRIMARY KEY (id COLLATE NOCASE));",
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:/);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  // Every one of these is a real, valid parent key that SQLite itself
  // accepts -- and every one of these is a shape the retired hand-written
  // parser (see the module header comment) used to falsely REJECT, because
  // the text merely looked like it might mention COLLATE, or because a
  // quoted column literally named "check" was mistaken for the
  // table-constraint keyword CHECK.
  const VALID_PARENT_KEY_SHAPES_SQLITE_ACCEPTS = [
    [
      "COLLATE appears only inside a CHECK expression, not a real column collation",
      "CREATE TABLE parent (code TEXT UNIQUE CHECK (code = code COLLATE NOCASE));",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL REFERENCES parent(code));",
    ],
    [
      "a DEFAULT string literal that merely contains the text COLLATE NOCASE",
      "CREATE TABLE parent (code TEXT UNIQUE DEFAULT 'x COLLATE NOCASE');",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL REFERENCES parent(code));",
    ],
    [
      "a block comment mentioning COLLATE NOCASE",
      "CREATE TABLE parent (code TEXT UNIQUE /* COLLATE NOCASE */);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL REFERENCES parent(code));",
    ],
    [
      'a quoted "check" column name, not the table-constraint keyword CHECK',
      'CREATE TABLE parent ("check" TEXT COLLATE NOCASE UNIQUE);',
      'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_check TEXT NOT NULL COLLATE NOCASE REFERENCES parent("check"));',
    ],
    [
      "a -- comment containing an apostrophe ahead of the real column",
      "CREATE TABLE parent (\n  a TEXT, -- vault's note\n  code TEXT COLLATE NOCASE UNIQUE\n);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL COLLATE NOCASE REFERENCES parent(code));",
    ],
    [
      "a -- comment containing an open paren ahead of the real column",
      "CREATE TABLE parent (\n  a TEXT, -- see (note\n  code TEXT COLLATE NOCASE UNIQUE\n);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL COLLATE NOCASE REFERENCES parent(code));",
    ],
    [
      "a NOCASE column with a unique index that declares no collation of its own (it inherits NOCASE from the column)",
      "CREATE TABLE parent (code TEXT COLLATE NOCASE);\nCREATE UNIQUE INDEX parent_code_idx ON parent(code);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL COLLATE NOCASE REFERENCES parent(code));",
    ],
  ];

  it.each(VALID_PARENT_KEY_SHAPES_SQLITE_ACCEPTS)(
    "accepts a real, valid parent key even with %s -- SQLite decides, not a parser",
    (_description, parentSql, childSql) => {
      const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentSql });
      const db = freshDb();
      runMigrations(db, migrationsDir);

      writeFileSync(path.join(migrationsDir, "0002_child.sql"), childSql, "utf8");

      const result = runMigrations(db, migrationsDir);
      expect(result.appliedCount).toBe(1);
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
    },
  );
});

// RKOI review (same critical, second revision): the FIRST fix for the
// collation-parser critical replaced it with a per-constraint, CHILD-side
// `UPDATE ... WHERE 0` probe guarded by a JS pre-filter (table/column
// existence, "is this a key" by column-NAME matching) that ran BEFORE
// SQLite was ever consulted -- and that pre-filter itself disagreed with
// SQLite on five more real, valid shapes, all case- or generated-column
// related. The fix: JS keeps exactly one check (missing target table,
// case-insensitive), and the probe moves to the PARENT side
// (`DELETE FROM "<target>" WHERE 0`), which names no column at all and so
// cannot mismatch on casing or a generated column. These tests use their
// own temporary migration directories; the root migrations/ files are
// never touched.
describe("db/migrate case-insensitive resolution and generated columns are not false rejections (RKOI critical, second revision)", () => {
  // Every shape below is a real, valid parent key or FK that SQLite itself
  // accepts, and every one is a shape the retired child-side-probe-plus-JS-
  // prefilter revision used to falsely REJECT.
  const CASE_AND_GENERATED_SHAPES_SQLITE_ACCEPTS = [
    [
      "a case-different target column (REFERENCES parent(ID), actual column id)",
      "CREATE TABLE parent (id TEXT PRIMARY KEY);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(ID));",
    ],
    [
      "a case-different target table (REFERENCES Parent(id), actual table parent)",
      "CREATE TABLE parent (id TEXT PRIMARY KEY);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES Parent(id));",
    ],
    [
      "a case-different UNIQUE index column (index on Code, FK names code)",
      "CREATE TABLE parent (Code TEXT);\nCREATE UNIQUE INDEX parent_code_idx ON parent(Code);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL REFERENCES parent(code));",
    ],
    [
      "a GENERATED ... UNIQUE parent key column",
      "CREATE TABLE parent (raw TEXT, code TEXT GENERATED ALWAYS AS (raw) STORED UNIQUE);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_code TEXT NOT NULL REFERENCES parent(code));",
    ],
    [
      "a GENERATED child FK column",
      "CREATE TABLE parent (id TEXT PRIMARY KEY);",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, raw TEXT, parent_id TEXT GENERATED ALWAYS AS (raw) STORED REFERENCES parent(id));",
    ],
  ];

  it.each(CASE_AND_GENERATED_SHAPES_SQLITE_ACCEPTS)(
    "accepts %s on the plain path",
    (_description, parentSql, childSql) => {
      const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentSql });
      const db = freshDb();
      runMigrations(db, migrationsDir);

      writeFileSync(path.join(migrationsDir, "0002_child.sql"), childSql, "utf8");

      const result = runMigrations(db, migrationsDir);
      expect(result.appliedCount).toBe(1);
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
    },
  );

  it.each(CASE_AND_GENERATED_SHAPES_SQLITE_ACCEPTS)(
    "accepts %s on the directive path",
    (_description, parentSql, childSql) => {
      const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentSql });
      const db = freshDb();
      runMigrations(db, migrationsDir);

      writeFileSync(path.join(migrationsDir, "0002_child.sql"), withDirective(childSql), "utf8");

      const result = runMigrations(db, migrationsDir);
      expect(result.appliedCount).toBe(1);
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
    },
  );

  // A dangling reference is still refused when the dropped table's name
  // differs only in case from what the child's REFERENCES clause ends up
  // pointing at -- `findMissingForeignKeyTargetTable`'s case-insensitive
  // comparison must not accidentally treat a genuinely-missing table as
  // present just because SOME differently-cased name would have matched.
  function renameAwayCaseVariantRebuildBody() {
    return [
      'ALTER TABLE parent RENAME TO "PARENT_OLD";',
      "CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a', 'b')));",
      'INSERT INTO parent (id, kind) SELECT id, kind FROM "PARENT_OLD";',
      'DROP TABLE "PARENT_OLD";',
    ].join("\n");
  }

  it("refuses a case-variant dangling reference (REFERENCES \"PARENT_OLD\") on the plain path, with an empty child", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    runMigrations(db, migrationsDir);
    db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM child").get().count).toBe(0);

    addMigration0002(migrationsDir, renameAwayCaseVariantRebuildBody());

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*PARENT_OLD/is,
    );

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses the same case-variant dangling reference on the directive path too, with an empty child", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent_child.sql": parentChildInit });
    const db = freshDb();

    runMigrations(db, migrationsDir);
    db.prepare("INSERT INTO parent (id, kind) VALUES ('p1', 'a')").run();

    addMigration0002(migrationsDir, withDirective(renameAwayCaseVariantRebuildBody()));

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*PARENT_OLD/is,
    );

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("wraps a raw SqliteError from the parent-side probe in the prefixed SchemaVersionError -- a parent-table DELETE trigger referencing a table dropped by this same migration", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
        "CREATE TABLE audit_log (msg TEXT);",
        "CREATE TRIGGER parent_audit AFTER DELETE ON parent BEGIN INSERT INTO audit_log(msg) VALUES ('deleted'); END;",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // This migration's own SQL breaks the trigger: it drops the table the
    // trigger body references, without touching the trigger itself.
    writeFileSync(path.join(migrationsDir, "0002_drop_audit.sql"), "DROP TABLE audit_log;", "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    // Never a raw SqliteError -- always the prefixed error, naming the
    // parent table and quoting SQLite's own message. The trigger failure is
    // not a "foreign key mismatch", so the message says the parent table
    // cannot be deleted from -- never "refuses to resolve", which is
    // reserved for an actual foreign key mismatch (RKOI final review).
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"parent".*cannot be deleted from.*no such table.*audit_log/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/refuses to resolve/i);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    // The DROP itself rolled back too -- the whole transaction, not just
    // the parts that failed.
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'audit_log'").all()).toHaveLength(1);
  });
});

// RKOI review (same follow-up round, warning 1): a structural defect that
// predates a given migration -- introduced out-of-band, or by an earlier
// migration -- must not be blamed on an unrelated pending migration that
// merely happens to run next.
describe("db/migrate pre-existing structural foreign-key violation is not blamed on an unrelated migration (RKOI follow-up warning 1)", () => {
  it("refuses with a distinct prefix and never runs the unrelated migration's SQL when the schema was already structurally broken out-of-band", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent_child.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // Corrupt the schema out-of-band, entirely unrelated to any migration:
    // rename parent away (SQLite rewrites child's REFERENCES clause to
    // follow the rename, regardless of PRAGMA foreign_keys) and then drop
    // the renamed table, leaving child's REFERENCES clause pointing at a
    // table that no longer exists.
    db.pragma("foreign_keys = OFF");
    db.exec("ALTER TABLE parent RENAME TO parent_gone;");
    db.exec("DROP TABLE parent_gone;");
    db.pragma("foreign_keys = ON");
    const childSchemaBefore = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'child'").get();
    expect(childSchemaBefore.sql).toMatch(/REFERENCES "?parent_gone"?\s*\(/);

    // An unrelated, otherwise-unremarkable pending plain migration.
    writeFileSync(path.join(migrationsDir, "0002_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"child".*"parent_gone"/s,
    );
    // The distinct prefix, not the post-migration one -- this migration's
    // SQL never ran, so it must not be blamed as if it had.
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/^migration_foreign_key_check_failed:/);

    // 0002's SQL never executed at all.
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses with the same distinct prefix on the directive path too, before the directive migration's SQL ever runs", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent_child.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    db.pragma("foreign_keys = OFF");
    db.exec("ALTER TABLE parent RENAME TO parent_gone;");
    db.exec("DROP TABLE parent_gone;");
    db.pragma("foreign_keys = ON");

    writeFileSync(
      path.join(migrationsDir, "0002_unrelated.sql"),
      withDirective("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"child".*"parent_gone"/s,
    );

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    // The directive path's own foreign_keys restoration is unaffected --
    // this guard runs before it ever toggles the pragma off.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  // Corrupts the schema out-of-band into a table-level PK collation
  // mismatch (see the module header comment: this is the exact false
  // ACCEPTANCE the retired parser used to let through) rather than a
  // missing table, so this specifically proves the pre-existing check's
  // PARENT-SIDE PROBE half -- not just its missing-table half -- also runs
  // before an unrelated migration and is not blamed on it.
  function corruptParentIntoPkCollateMismatch(db) {
    // The SAFE rebuild order (see docs/MIGRATION.md): only `parent_new` is
    // ever renamed, so child's `REFERENCES parent(id)` clause is never
    // rewritten and still names "parent" throughout -- unlike renaming
    // `parent` itself away, which would leave child pointing at a missing
    // table instead of at the real, mismatched one this test needs.
    db.pragma("foreign_keys = OFF");
    db.exec("CREATE TABLE parent_new (id TEXT, PRIMARY KEY (id COLLATE NOCASE));");
    db.exec("INSERT INTO parent_new (id) SELECT id FROM parent;");
    db.exec("DROP TABLE parent;");
    db.exec("ALTER TABLE parent_new RENAME TO parent;");
    db.pragma("foreign_keys = ON");
  }

  it("reports a pre-existing table-level PRIMARY KEY (id COLLATE NOCASE) mismatch distinctly on the plain path, and never runs the unrelated migration's SQL", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent_child.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    corruptParentIntoPkCollateMismatch(db);

    writeFileSync(path.join(migrationsDir, "0002_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"parent".*foreign key mismatch/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/^migration_foreign_key_check_failed:/);

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("reports the same pre-existing PRIMARY KEY (id COLLATE NOCASE) mismatch on the directive path too, before the directive migration's SQL ever runs", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent_child.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    corruptParentIntoPkCollateMismatch(db);

    writeFileSync(
      path.join(migrationsDir, "0002_unrelated.sql"),
      withDirective("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"parent".*foreign key mismatch/is,
    );

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    // This guard ran before the directive path ever toggled foreign_keys
    // off, so it is unaffected and restored to ON.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

// RKOI final review of the plain-path structural FK check: "does the target
// table exist" is not the same question as "is the target a TABLE". A
// foreign key's target can resolve to a VIEW, an FTS5-style VIRTUAL TABLE,
// or one of that virtual table's own SHADOW tables (`PRAGMA table_list`'s
// `type` column distinguishes all four), and the case-insensitive
// existence check alone got three of the four wrong: a view was refused
// but misreported as "does not exist"; a virtual table was WRONGLY
// ACCEPTED on the plain path (a DELETE prepare against it compiles no
// foreign-key code, so nothing catches it until the first real write
// throws at runtime); and a shadow table was WRONGLY REFUSED (FTS5's
// "defensive mode" makes even a bare `DELETE ... WHERE 0` fail to prepare,
// even though SQLite genuinely resolves and enforces a real foreign key to
// one at actual write time). These tests use their own temporary migration
// directories -- the root migrations/ files are never touched.
describe("db/migrate foreign-key target type resolution via PRAGMA table_list (RKOI final review, four warnings)", () => {
  it("refuses a foreign key to a VIEW on the plain path, naming the type -- never 'does not exist' -- with an EMPTY child", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": "CREATE VIEW v AS SELECT 1 AS id;" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES v(id));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"v".*a view, not a table/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/does not exist/i);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a foreign key to a VIEW on the directive path too, naming the type", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": "CREATE VIEW v AS SELECT 1 AS id;" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES v(id));"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"v".*a view, not a table/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/does not exist/i);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a pre-existing VIEW foreign-key target as migration_preexisting_structural_violation, and never runs the unrelated migration's SQL", () => {
    const migrationsDir = setupMigrationsDir({ "0001_init.sql": "CREATE TABLE placeholder (id INTEGER PRIMARY KEY);" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // Out-of-band, unrelated to any migration.
    db.pragma("foreign_keys = OFF");
    db.exec("CREATE VIEW v AS SELECT 1 AS id;");
    db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES v(id));");
    db.pragma("foreign_keys = ON");

    writeFileSync(path.join(migrationsDir, "0002_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"child".*"v".*a view, not a table/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/^migration_foreign_key_check_failed:/);

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a foreign key to an FTS5 VIRTUAL TABLE on the plain path with an EMPTY child -- this used to commit silently and only fail on the first real write", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": "CREATE VIRTUAL TABLE items_fts USING fts5(body);" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_id INTEGER REFERENCES items_fts(rowid));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"items_fts".*a virtual table, not a table/is,
    );

    // Rolled back -- the migration never committed, so `child` must not
    // exist at all, unlike the pre-fix behavior where it would.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'child'").all()).toEqual([]);
  });

  it("refuses a foreign key to an FTS5 VIRTUAL TABLE on the directive path too, naming the type", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": "CREATE VIRTUAL TABLE items_fts USING fts5(body);" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective("CREATE TABLE child (id INTEGER PRIMARY KEY, fk_id INTEGER REFERENCES items_fts(rowid));"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"items_fts".*a virtual table, not a table/is,
    );

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a pre-existing VIRTUAL TABLE foreign-key target as migration_preexisting_structural_violation, and never runs the unrelated directive migration's SQL", () => {
    const migrationsDir = setupMigrationsDir({ "0001_init.sql": "CREATE TABLE placeholder (id INTEGER PRIMARY KEY);" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    db.pragma("foreign_keys = OFF");
    db.exec("CREATE VIRTUAL TABLE items_fts USING fts5(body);");
    db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, fk_id INTEGER REFERENCES items_fts(rowid));");
    db.pragma("foreign_keys = ON");

    writeFileSync(
      path.join(migrationsDir, "0002_unrelated.sql"),
      withDirective("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"child".*"items_fts".*a virtual table, not a table/is,
    );

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    // This guard ran before the directive path ever toggled foreign_keys
    // off, so it is unaffected and restored to ON.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("accepts a foreign key to an FTS5 shadow table (<fts>_data) on the plain path -- a real child insert succeeds, and a follow-on unrelated migration is not blamed for a pre-existing violation", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE VIRTUAL TABLE items_fts USING fts5(body);",
        "INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // FTS5's own shadow storage assigns this row an id in items_fts_data;
    // verified against real SQLite rather than assumed.
    const shadowRow = db.prepare("SELECT id FROM items_fts_data LIMIT 1").get();
    expect(shadowRow).toBeTruthy();

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      [
        "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_id INTEGER REFERENCES items_fts_data(id));",
        `INSERT INTO child (fk_id) VALUES (${shadowRow.id});`,
      ].join("\n"),
      "utf8",
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    // The real write this whole check exists to permit actually happened.
    expect(db.prepare("SELECT fk_id FROM child").all()).toEqual([{ fk_id: shadowRow.id }]);

    // A follow-on unrelated migration also applies -- the shadow-table
    // foreign key is not mistaken for a pre-existing structural violation
    // (the old defensive-mode DELETE-prepare probe used to do exactly
    // that).
    writeFileSync(path.join(migrationsDir, "0003_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");
    const followOn = runMigrations(db, migrationsDir);
    expect(followOn.appliedCount).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toHaveLength(1);
  });

  it("accepts the same FTS5 shadow-table foreign key on the directive path too, with a real child insert", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE VIRTUAL TABLE items_fts USING fts5(body);",
        "INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);
    const shadowRow = db.prepare("SELECT id FROM items_fts_data LIMIT 1").get();

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective(
        [
          "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_id INTEGER REFERENCES items_fts_data(id));",
          `INSERT INTO child (fk_id) VALUES (${shadowRow.id});`,
        ].join("\n"),
      ),
      "utf8",
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT fk_id FROM child").all()).toEqual([{ fk_id: shadowRow.id }]);
  });

  it("refuses post-exec, prefixed migration_foreign_key_check_failed, when a directive migration drops a table a parent's DELETE trigger references -- the next migration is never reached", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
        "CREATE TABLE side (msg TEXT);",
        "CREATE TRIGGER parent_audit AFTER DELETE ON parent BEGIN INSERT INTO side(msg) VALUES ('deleted'); END;",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // This migration's own SQL breaks the trigger: it drops the table the
    // trigger body references, without touching the trigger itself.
    // Neither PRAGMA foreign_key_check nor the structural type check
    // inspects trigger bodies -- only the parent-side probe's DELETE
    // prepare against `parent` does, since compiling that trigger is not
    // gated by PRAGMA foreign_keys.
    writeFileSync(path.join(migrationsDir, "0002_drop_side.sql"), withDirective("DROP TABLE side;"), "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"parent".*cannot be deleted from.*no such table.*side/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/refuses to resolve/i);

    // Rolled back: not recorded, user_version unchanged, side table still
    // exists, and foreign_keys is restored to ON.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'side'").all()).toHaveLength(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // The next pending migration is never even reached: 0002 still fails
    // every time this is run, so 0003's SQL never executes.
    writeFileSync(path.join(migrationsDir, "0003_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");
    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
  });

  it("applies the real root migrations 0001-0007 -- including the real entities_fts virtual table and its shadow tables -- then a follow-on plain migration and a follow-on directive migration too, under the new type-aware check", () => {
    const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
    const migrationFileNames = readdirSync(rootMigrationsDir).filter((name) => /^\d{4}_.*\.sql$/.test(name));
    expect(migrationFileNames).toHaveLength(12);
    const files = Object.fromEntries(
      migrationFileNames.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]),
    );
    const migrationsDir = setupMigrationsDir(files);
    const db = freshDb();

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(12);

    // entities_fts is a real FTS5 virtual table with real shadow tables --
    // confirm at least one shadow table is present and typed correctly by
    // PRAGMA table_list, not just by name.
    const tableList = db.pragma("table_list");
    const ftsEntry = tableList.find((row) => row.name === "entities_fts");
    expect(ftsEntry?.type).toBe("virtual");
    const shadowEntries = tableList.filter((row) => row.name.startsWith("entities_fts_") && row.type === "shadow");
    expect(shadowEntries.length).toBeGreaterThan(0);

    writeFileSync(path.join(migrationsDir, "0013_trivial_plain_followup.sql"), "CREATE TABLE trivial_plain_followup (id INTEGER PRIMARY KEY);", "utf8");
    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(1);
    expect(second.currentVersion).toBe(13);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'trivial_plain_followup'").all()).toHaveLength(1);

    writeFileSync(
      path.join(migrationsDir, "0014_trivial_directive_followup.sql"),
      withDirective("CREATE TABLE trivial_directive_followup (id INTEGER PRIMARY KEY);"),
      "utf8",
    );
    const third = runMigrations(db, migrationsDir);
    expect(third.appliedCount).toBe(1);
    expect(third.currentVersion).toBe(14);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'trivial_directive_followup'").all()).toHaveLength(1);
  });
});

// RKOI pre-merge fixup of the final review (warning 1, required): skipping
// `shadow` targets in the parent-side DELETE probe (because the probe
// itself false-rejects them under this connection's defensive mode) only
// means the probe cannot ask whether a shadow-targeting foreign key
// resolves -- it does not mean every such foreign key resolves. One that
// names a shadow table's own NON-key column (or a column that does not
// exist on it at all) is still invalid and was wrongly ACCEPTED on the
// plain path. These tests use their own temporary migration directories --
// the root migrations/ files are never touched.
describe("db/migrate a foreign key to a shadow table's own NON-key column is refused, not silently accepted (RKOI pre-merge fixup, warning 1)", () => {
  it("refuses a foreign key to an FTS5 shadow table's own NON-key column (<fts>_data(block)) on the plain path -- this used to commit silently", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE VIRTUAL TABLE items_fts USING fts5(body);",
        "INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val TEXT REFERENCES items_fts_data(block));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*foreign key mismatch.*items_fts_data/is,
    );

    // Rolled back -- the migration never committed, matching every other
    // structural refusal in this file.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'child'").all()).toEqual([]);
  });

  it("refuses the same FTS5 shadow-table non-key column on the directive path too", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE VIRTUAL TABLE items_fts USING fts5(body);",
        "INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective("CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val TEXT REFERENCES items_fts_data(block));"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*foreign key mismatch.*items_fts_data/is,
    );

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  // Two more non-key shapes SQLite itself refuses to resolve the same way,
  // confirmed against real SQLite: a column that does not exist at all on
  // the shadow table, and the `_content` shadow table's own non-key
  // column. Plain path only -- the directive path's behavior is already
  // covered above and is not shape-sensitive (the same whole-database
  // `PRAGMA foreign_key_check` catches all of these).
  const SHADOW_NON_KEY_EXTRA_SHAPES = [
    ["a column that does not exist at all on an FTS5 shadow table (<fts>_data(nope))", "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val TEXT REFERENCES items_fts_data(nope));"],
    ["an FTS5 _content shadow table's own non-key column (<fts>_content(c0))", "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val TEXT REFERENCES items_fts_content(c0));"],
  ];

  it.each(SHADOW_NON_KEY_EXTRA_SHAPES)("also refuses %s on the plain path", (_description, childSql) => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE VIRTUAL TABLE items_fts USING fts5(body);",
        "INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(path.join(migrationsDir, "0002_child.sql"), childSql, "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:.*"child".*foreign key mismatch/is);
  });

  // rtree is compiled into the better-sqlite3 build this workspace pins in
  // the supported test environment. If a different SQLite build omits it,
  // keep the test visible as skipped rather than silently changing the shape
  // under test to an FTS5 case.
  function probeRtreeAvailable() {
    const db = freshDb();
    try {
      db.exec("CREATE VIRTUAL TABLE __rtree_availability_probe USING rtree(id, minX, maxX);");
      return true;
    } catch {
      return false;
    }
  }

  const rtreeAvailable = probeRtreeAvailable();

  it.skipIf(!rtreeAvailable)("refuses a foreign key to an rtree virtual table's own shadow table's non-key column (geo_node_node(data)) on the plain path", () => {
    const parentSql = "CREATE VIRTUAL TABLE geo_node USING rtree(id, minX, maxX, minY, maxY);";
    const childSql = "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val REFERENCES geo_node_node(data));";

    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentSql });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(path.join(migrationsDir, "0002_child.sql"), childSql, "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:.*"child".*foreign key mismatch/is);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it.skipIf(!rtreeAvailable)("refuses the same rtree non-key shadow column on the directive path too", () => {
    const parentSql = "CREATE VIRTUAL TABLE geo_node USING rtree(id, minX, maxX, minY, maxY);";
    const childSql = "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val REFERENCES geo_node_node(data));";

    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentSql });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(path.join(migrationsDir, "0002_child.sql"), withDirective(childSql), "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(/^migration_foreign_key_check_failed:.*foreign key mismatch/is);
  });

  it("refuses a pre-existing shadow-table non-key mismatch as migration_preexisting_structural_violation, and never runs the unrelated migration's SQL", () => {
    const migrationsDir = setupMigrationsDir({ "0001_init.sql": "CREATE TABLE placeholder (id INTEGER PRIMARY KEY);" });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // Out-of-band, unrelated to any migration.
    db.pragma("foreign_keys = OFF");
    db.exec("CREATE VIRTUAL TABLE items_fts USING fts5(body);");
    db.exec("INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');");
    db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, fk_val TEXT REFERENCES items_fts_data(block));");
    db.pragma("foreign_keys = ON");

    writeFileSync(path.join(migrationsDir, "0002_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"child".*foreign key mismatch.*items_fts_data/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/^migration_foreign_key_check_failed:/);

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("the shadow-table PRIMARY KEY acceptance case (RKOI final review) is still accepted, with a real child insert and a follow-on migration -- this fix must not reintroduce that false rejection", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent.sql": [
        "CREATE VIRTUAL TABLE items_fts USING fts5(body);",
        "INSERT INTO items_fts(rowid, body) VALUES (1, 'hello world');",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);
    const shadowRow = db.prepare("SELECT id FROM items_fts_data LIMIT 1").get();
    expect(shadowRow).toBeTruthy();

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      [
        "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_id INTEGER REFERENCES items_fts_data(id));",
        `INSERT INTO child (fk_id) VALUES (${shadowRow.id});`,
      ].join("\n"),
      "utf8",
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT fk_id FROM child").all()).toEqual([{ fk_id: shadowRow.id }]);

    writeFileSync(path.join(migrationsDir, "0003_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");
    const followOn = runMigrations(db, migrationsDir);
    expect(followOn.appliedCount).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toHaveLength(1);
  });
});

// RKOI pre-merge fixup of the final review (warning 2, included): every
// unqualified object name this module asks SQLite to resolve is resolved
// under SQLite's ordinary name-resolution rules, where a `temp` object of
// the same name takes priority over one in `main`. Confirmed against real
// SQLite: a `TEMP VIEW` sharing a `main` parent table's name, created on
// the SAME connection BEFORE a migration runs, used to make an unqualified
// `PRAGMA foreign_key_list`/`DELETE ... WHERE 0` silently target the temp
// object instead, misreporting the real table. These tests use their own
// temporary migration directories -- the root migrations/ files are never
// touched.
describe("db/migrate schema-qualifies every foreign-key lookup, so a same-named TEMP object cannot shadow a real main table (RKOI pre-merge fixup, warning 2)", () => {
  it("still applies a migration referencing a main parent table when the connection holds a same-named TEMP VIEW", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent_child.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    // Simulate some other part of the process creating a scratch TEMP VIEW
    // on this same connection that happens to share the main `parent`
    // table's name. Before the fix, an unqualified DELETE-probe against
    // "parent" would resolve to THIS view and fail with "cannot modify
    // parent because it is a view".
    db.exec("CREATE TEMP VIEW parent AS SELECT 1 AS id;");

    writeFileSync(
      path.join(migrationsDir, "0002_child2.sql"),
      "CREATE TABLE child2 (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      "utf8",
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'child2'").all()).toHaveLength(1);
  });

  it("still applies the same migration on the directive path too, with the same TEMP VIEW present", () => {
    const migrationsDir = setupMigrationsDir({
      "0001_parent_child.sql": [
        "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      ].join("\n"),
    });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    db.exec("CREATE TEMP VIEW parent AS SELECT 1 AS id;");

    writeFileSync(
      path.join(migrationsDir, "0002_child2.sql"),
      withDirective("CREATE TABLE child2 (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));"),
      "utf8",
    );

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'child2'").all()).toHaveLength(1);
  });
});

// RKOI pre-merge fixup of the final review (warning 3, included): a
// foreign key naming one of SQLite's own internal `sqlite_*` catalog
// tables (e.g. `sqlite_sequence`, the AUTOINCREMENT bookkeeping table) is
// correctly refused, but `mainSchemaEntries` deliberately excludes
// `sqlite_*` names from its lookups, so it used to fall through to the
// "missing" case and claim the table does not exist, when it is very much
// present. These tests use their own temporary migration directories --
// the root migrations/ files are never touched.
describe("db/migrate a foreign key to an internal SQLite table is attributed correctly, never reported as missing (RKOI pre-merge fixup, warning 3)", () => {
  const parentWithAutoincrementSql = ["CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT);", "INSERT INTO parent DEFAULT VALUES;"].join("\n");

  it("refuses a foreign key to sqlite_sequence on the plain path, naming it as an internal SQLite table -- never 'does not exist'", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentWithAutoincrementSql });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      "CREATE TABLE child (id INTEGER PRIMARY KEY, fk_name TEXT REFERENCES sqlite_sequence(name));",
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"sqlite_sequence".*an internal SQLite table/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/does not exist/i);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses the same sqlite_sequence foreign key on the directive path too", () => {
    const migrationsDir = setupMigrationsDir({ "0001_parent.sql": parentWithAutoincrementSql });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    writeFileSync(
      path.join(migrationsDir, "0002_child.sql"),
      withDirective("CREATE TABLE child (id INTEGER PRIMARY KEY, fk_name TEXT REFERENCES sqlite_sequence(name));"),
      "utf8",
    );

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"sqlite_sequence".*an internal SQLite table/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/does not exist/i);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("refuses a pre-existing foreign key to sqlite_sequence as migration_preexisting_structural_violation, and never runs the unrelated migration's SQL", () => {
    const migrationsDir = setupMigrationsDir({ "0001_init.sql": parentWithAutoincrementSql });
    const db = freshDb();
    runMigrations(db, migrationsDir);

    db.pragma("foreign_keys = OFF");
    db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, fk_name TEXT REFERENCES sqlite_sequence(name));");
    db.pragma("foreign_keys = ON");

    writeFileSync(path.join(migrationsDir, "0002_unrelated.sql"), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);", "utf8");

    expect(() => runMigrations(db, migrationsDir)).toThrow(SchemaVersionError);
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_preexisting_structural_violation:.*"child".*"sqlite_sequence".*an internal SQLite table/is,
    );
    expect(() => runMigrations(db, migrationsDir)).not.toThrow(/does not exist/i);

    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'").all()).toEqual([]);
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });
});

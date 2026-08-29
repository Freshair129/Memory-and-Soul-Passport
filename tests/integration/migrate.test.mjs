// AC-03: migrations apply idempotently, schema_migrations records applied
// migrations with a checksum, a checksum-drift guard rejects a modified
// already-applied migration file, and a downgrade guard rejects a database
// whose recorded schema version is higher than any migration file present.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(result.appliedCount).toBe(7);
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
    expect(second.currentVersion).toBe(7);
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

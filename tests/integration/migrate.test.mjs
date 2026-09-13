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

  it("trailing whitespace after an otherwise-exact directive on line 1 is refused as misplaced, not accepted via trim()", () => {
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
    expect(migrationFileNames).toHaveLength(7);

    const files = Object.fromEntries(
      migrationFileNames.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]),
    );
    const migrationsDir = setupMigrationsDir(files);
    const db = freshDb();

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(7);
    expect(result.currentVersion).toBe(7);
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

  it("refuses a plain migration adding a foreign key to a column that is not a key on the target table (no PK, no UNIQUE index)", () => {
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
    expect(() => runMigrations(db, migrationsDir)).toThrow(
      /^migration_foreign_key_check_failed:.*"child".*"parent" columns \(code\)/s,
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
    expect(migrationFileNames).toHaveLength(7);
    const files = Object.fromEntries(
      migrationFileNames.map((name) => [name, readFileSync(path.join(rootMigrationsDir, name), "utf8")]),
    );
    const migrationsDir = setupMigrationsDir(files);
    const db = freshDb();

    const result = runMigrations(db, migrationsDir);
    expect(result.appliedCount).toBe(7);

    writeFileSync(
      path.join(migrationsDir, "0008_trivial_followup.sql"),
      "CREATE TABLE trivial_followup (id INTEGER PRIMARY KEY);",
      "utf8",
    );
    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(1);
    expect(second.currentVersion).toBe(8);
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
});

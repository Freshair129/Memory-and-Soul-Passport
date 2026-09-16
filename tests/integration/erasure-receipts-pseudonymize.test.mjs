// BL-MEMOS-076 (design §12.5): migration proof for the guarded rebuild of
// erasure_receipts. The test deliberately runs against a copied migration
// directory so it can verify both the empty-table success path and the
// non-empty fail-closed precondition without mutating the packaged files.
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

function migrationCopy({ maxVersion = 12, include = [] } = {}) {
  const destination = tempDir("msp-erasure-migration-");
  const included = new Set(include);
  for (const name of readdirSync(rootMigrationsDir).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))) {
    const version = Number(name.slice(0, 4));
    if (version <= maxVersion || included.has(version)) {
      writeFileSync(path.join(destination, name), readFileSync(path.join(rootMigrationsDir, name)));
    }
  }
  return destination;
}

function freshDb() {
  const db = open(path.join(tempDir("msp-erasure-db-"), "msp.sqlite3"));
  cleanups.push(() => db.close());
  return db;
}

describe("0014_erasure_receipts_pseudonymize.sql", () => {
  it("rebuilds an empty erasure_receipts table with pseudonym columns, tenant index, and immutable triggers", () => {
    const db = freshDb();
    const migrationsDir = migrationCopy({ include: [14] });

    const result = runMigrations(db, migrationsDir);

    expect(result.appliedCount).toBe(13);
    expect(result.currentVersion).toBe(14);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'erasure_receipts_migration_guard'").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'trg_erasure_receipts_migration_guard'").get().count).toBe(0);

    const columns = db.prepare("PRAGMA table_info(erasure_receipts)").all().map((column) => column.name);
    expect(columns).toEqual([
      "erasure_receipt_id",
      "tenant_id",
      "principal_hmac",
      "principal_hmac_salt",
      "identity_key_version",
      "idempotency_key",
      "requested_by_agent_id",
      "tables_affected_json",
      "created_at",
    ]);
    expect(columns).not.toContain("principal_id");

    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'erasure_receipts' ORDER BY name")
      .all();
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining(["idx_erasure_receipts_tenant", "sqlite_autoindex_erasure_receipts_1"]));
    expect(indexes.map((index) => index.name)).not.toContain("idx_erasure_receipts_principal");

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'erasure_receipts' ORDER BY name")
      .all()
      .map((trigger) => trigger.name);
    expect(triggers).toEqual(["trg_erasure_receipts_no_delete", "trg_erasure_receipts_no_update"]);

    db.prepare(
      `INSERT INTO erasure_receipts
        (erasure_receipt_id, tenant_id, principal_hmac, principal_hmac_salt,
         identity_key_version, idempotency_key, requested_by_agent_id,
         tables_affected_json, created_at)
       VALUES ('receipt-1', 'tenant-1', 'a', 'b', 'identity-v1', 'erase-1', 'agent-1', '{}', '2026-09-17T00:00:00.000Z')`,
    ).run();
    expect(() => db.prepare("UPDATE erasure_receipts SET principal_hmac = 'b' WHERE erasure_receipt_id = 'receipt-1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM erasure_receipts WHERE erasure_receipt_id = 'receipt-1'").run()).toThrow(/may never be deleted/);
  });

  it("aborts before rebuilding when a pre-existing raw receipt row exists", () => {
    const db = freshDb();
    const migrationsDir = migrationCopy();
    runMigrations(db, migrationsDir);
    db.prepare(
      `INSERT INTO erasure_receipts
        (erasure_receipt_id, tenant_id, principal_id, idempotency_key,
         requested_by_agent_id, tables_affected_json, created_at)
       VALUES ('receipt-raw', 'tenant-1', 'alice', 'erase-raw', 'agent-1', '{}', '2026-09-17T00:00:00.000Z')`,
    ).run();

    const migrationSql = readFileSync(path.join(rootMigrationsDir, "0014_erasure_receipts_pseudonymize.sql"));
    writeFileSync(path.join(migrationsDir, "0014_erasure_receipts_pseudonymize.sql"), migrationSql);

    expect(() => runMigrations(db, migrationsDir)).toThrow(/erasure_receipts is not empty/);
    expect(db.pragma("user_version", { simple: true })).toBe(12);
    expect(db.prepare("SELECT principal_id FROM erasure_receipts WHERE erasure_receipt_id = 'receipt-raw'").get()).toEqual({ principal_id: "alice" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count).toBe(12);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('erasure_receipts_migration_guard', 'trg_erasure_receipts_migration_guard')").get().count).toBe(0);
  });
});

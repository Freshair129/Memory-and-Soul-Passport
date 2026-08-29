// WP-14 AC-01 / AC-02: migration 0003 applies idempotently; entities.vault_id
// exists with a foreign-key reference to vaults; UNIQUE(vault_id, category,
// key) replaces the old UNIQUE(category, key) constraint (two different
// vaults can hold an entity with the same (category, key) without conflict,
// the same vault cannot); domain/entity-store.mjs's entity-id derivation
// includes vault_id (two entities with identical category/key in different
// vaults receive different entity_id values).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { EntityStore } from "@freshair129/msp-core/entity-store";
import { VaultRegistry } from "@freshair129/msp-core/vault-registry";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-vault-scoping-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = open(path.join(dir, "db.sqlite3"));
  cleanups.push(() => db.close());
  return db;
}

describe("WP-14 AC-01: migration 0003_vault_scoping.sql", () => {
  it("applies idempotently against a fresh database (seven migrations, no error, no duplicate application)", () => {
    const db = freshDb();
    const first = runMigrations(db, migrationsDir);
    expect(first.appliedCount).toBe(7);
    expect(first.currentVersion).toBe(7);

    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(0);
    expect(second.currentVersion).toBe(7);

    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows[2].name).toBe("0003_vault_scoping.sql");
    expect(rows[3].name).toBe("0004_retrieval.sql");
    expect(rows[4].name).toBe("0005_decay_lifecycle.sql");
    expect(rows[5].name).toBe("0006_links.sql");
  });

  it("entities.vault_id exists, is NOT NULL, and foreign-key-references vaults(vault_id)", () => {
    const db = freshDb();
    runMigrations(db, migrationsDir);

    const columns = db.prepare("PRAGMA table_info(entities)").all();
    const vaultIdColumn = columns.find((col) => col.name === "vault_id");
    expect(vaultIdColumn).toBeTruthy();
    expect(vaultIdColumn.notnull).toBe(1);

    const fks = db.prepare("PRAGMA foreign_key_list(entities)").all();
    const vaultFk = fks.find((fk) => fk.from === "vault_id");
    expect(vaultFk).toBeTruthy();
    expect(vaultFk.table).toBe("vaults");
    expect(vaultFk.to).toBe("vault_id");

    // A real, enforced FK: inserting an entity against an unknown vault_id
    // is rejected under PRAGMA foreign_keys=ON (db/connection.mjs sets this
    // on every connection).
    expect(() => {
      db.prepare(
        `INSERT INTO entities
           (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
         VALUES ('msp:entity/orphan', 'vault_unknown', 'c', 'k', '{}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'h', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
      ).run();
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("UNIQUE(vault_id, category, key) replaces UNIQUE(category, key): two different vaults may share (category, key); the same vault may not", () => {
    const db = freshDb();
    runMigrations(db, migrationsDir);

    const insertVault = db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'workspace_private', 'active', ?)");
    insertVault.run("vault-a", new Date().toISOString());
    insertVault.run("vault-b", new Date().toISOString());

    const insertEntity = db.prepare(`
      INSERT INTO entities
        (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
      VALUES (@entity_id, @vault_id, @category, @key, '{}', @now, @now, 'h', @now, @now)
    `);
    const now = new Date().toISOString();

    // Two different vaults, identical (category, key): must not conflict.
    expect(() => insertEntity.run({ entity_id: "msp:entity/a1", vault_id: "vault-a", category: "profile", key: "same", now })).not.toThrow();
    expect(() => insertEntity.run({ entity_id: "msp:entity/b1", vault_id: "vault-b", category: "profile", key: "same", now })).not.toThrow();

    // Same vault, identical (category, key): must conflict.
    expect(() =>
      insertEntity.run({ entity_id: "msp:entity/a2", vault_id: "vault-a", category: "profile", key: "same", now }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("entity_history requires no schema change: UNIQUE(entity_id, version) already presupposes a vault-scoped entity_id, unaffected by this migration", () => {
    const db = freshDb();
    runMigrations(db, migrationsDir);
    const columns = db.prepare("PRAGMA table_info(entity_history)").all().map((col) => col.name);
    expect(columns).not.toContain("vault_id");
    const indexList = db.prepare("PRAGMA index_list(entity_history)").all();
    // The UNIQUE(entity_id, version) autoindex from 0001_init.sql is still
    // exactly one unique index, unchanged.
    expect(indexList.filter((idx) => idx.unique === 1)).toHaveLength(1);
  });
});

describe("WP-14 AC-02: domain/entity-store.mjs entity-id derivation folds in vault_id", () => {
  function freshStoreWithVaults() {
    const db = freshDb();
    runMigrations(db, migrationsDir);
    const vaultRegistry = new VaultRegistry(db);
    const store = new EntityStore(db);
    return { db, store, vaultRegistry };
  }

  it("two entities with identical category/key in different vaults receive different entity_id values (direct function test)", () => {
    const { store, vaultRegistry } = freshStoreWithVaults();
    const vaultA = vaultRegistry.provisionWorkspacePrivateVault("workspace-a");
    const vaultB = vaultRegistry.provisionWorkspacePrivateVault("workspace-b");
    expect(vaultA.vault_id).not.toBe(vaultB.vault_id);

    const resultA = store.upsert({ vaultId: vaultA.vault_id, category: "profile", key: "same-key", bodyJson: { v: 1 }, actor: "test" });
    const resultB = store.upsert({ vaultId: vaultB.vault_id, category: "profile", key: "same-key", bodyJson: { v: 1 }, actor: "test" });

    expect(resultA.entity.entity_id).not.toBe(resultB.entity.entity_id);
    expect(resultA.entity.entity_id).toMatch(/^msp:entity\//);
    expect(resultB.entity.entity_id).toMatch(/^msp:entity\//);
  });

  it("entity_id derivation is deterministic per (vault_id, category, key): re-deriving via a fresh upsert call resolves to the same existing row, not a new one", () => {
    const { store, vaultRegistry } = freshStoreWithVaults();
    const vault = vaultRegistry.provisionWorkspacePrivateVault("workspace-det");

    const first = store.upsert({ vaultId: vault.vault_id, category: "cat", key: "k", bodyJson: { v: 1 }, actor: "test" });
    const second = store.upsert({ vaultId: vault.vault_id, category: "cat", key: "k", bodyJson: { v: 1 }, actor: "test" });

    expect(second.entity.entity_id).toBe(first.entity.entity_id);
    expect(second.created).toBe(false);
  });

  it("cross-vault reads via get()/list() are correctly scoped: vault A cannot see vault B's entity for the same (category, key)", () => {
    const { store, vaultRegistry } = freshStoreWithVaults();
    const vaultA = vaultRegistry.provisionWorkspacePrivateVault("workspace-read-a");
    const vaultB = vaultRegistry.provisionWorkspacePrivateVault("workspace-read-b");

    store.upsert({ vaultId: vaultB.vault_id, category: "secret", key: "shared-key-name", bodyJson: { owner: "B" }, actor: "test" });

    expect(store.get({ vaultId: vaultA.vault_id, category: "secret", key: "shared-key-name" })).toBeNull();
    expect(store.list({ vaultId: vaultA.vault_id, category: "secret" }).entities).toHaveLength(0);
    expect(store.list({ vaultId: vaultB.vault_id, category: "secret" }).entities).toHaveLength(1);
  });
});

// AC-01: migration 0004_retrieval.sql applies idempotently; entities_fts
// stays in sync with entities across insert, update, and delete (verified by
// mutating entities directly, then via domain/entity-store.mjs's real
// upsert/forget paths, and asserting the FTS projection followed). Also
// covers retrieval/fts.mjs's ftsSearch (WP-15 Bounded Scope item 2):
// vault-scoping, lifecycle_state exclusion, empty-query/empty-vaultIds
// short-circuit, and category filtering.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { EntityStore } from "@freshair129/msp-core/entity-store";
import { ftsSearch } from "@freshair129/msp-retrieval/fts";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-fts-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = open(path.join(dir, "db.sqlite3"));
  cleanups.push(() => db.close());
  runMigrations(db, migrationsDir);
  return db;
}

function insertVault(db, vaultId) {
  db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'workspace_private', 'active', ?)").run(
    vaultId,
    new Date().toISOString(),
  );
}

function ftsRowCount(db, entityId) {
  return db.prepare("SELECT COUNT(*) AS count FROM entities_fts WHERE entity_id = ?").get(entityId).count;
}

describe("AC-01: migration 0004_retrieval.sql applies idempotently", () => {
  it("applies cleanly as migration version 4, alongside the prior three (and WP-16/WP-17's 0005/0006 that now follow it)", () => {
    const db = freshDb();
    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows[3].name).toBe("0004_retrieval.sql");
    expect(db.pragma("user_version", { simple: true })).toBe(7);
  });

  it("re-running migrations against an already-migrated database is a no-op (idempotent)", () => {
    const db = freshDb();
    const second = runMigrations(db, migrationsDir);
    expect(second.appliedCount).toBe(0);
    expect(second.currentVersion).toBe(7);
  });

  it("entities_fts and embeddings tables exist with the documented columns", () => {
    const db = freshDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'entities_fts'").all()).toHaveLength(1);
    const embeddingsCols = db.prepare("PRAGMA table_info(embeddings)").all().map((col) => col.name);
    expect(embeddingsCols).toEqual(
      expect.arrayContaining(["entity_id", "collection", "model", "dim", "vector", "content_hash", "created_at"]),
    );
  });
});

describe("AC-01: entities_fts stays in sync with entities across insert/update/delete", () => {
  it("AFTER INSERT: a direct INSERT into entities produces a matching entities_fts row", () => {
    const db = freshDb();
    insertVault(db, "vault-direct");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
       VALUES ('msp:entity/direct-1', 'vault-direct', 'profile', 'alice', '{"name":"Alice Widget"}', ?, ?, 'h', ?, ?)`,
    ).run(now, now, now, now);

    expect(ftsRowCount(db, "msp:entity/direct-1")).toBe(1);
    const ftsRow = db.prepare("SELECT category, key, body_text, vault_id FROM entities_fts WHERE entity_id = ?").get("msp:entity/direct-1");
    expect(ftsRow.category).toBe("profile");
    expect(ftsRow.key).toBe("alice");
    expect(ftsRow.vault_id).toBe("vault-direct");
    expect(ftsRow.body_text).toContain("Widget");
  });

  it("AFTER UPDATE: an UPDATE to entities replaces (not duplicates) the entities_fts row with new content", () => {
    const db = freshDb();
    insertVault(db, "vault-direct");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
       VALUES ('msp:entity/direct-2', 'vault-direct', 'profile', 'bob', '{"role":"engineer"}', ?, ?, 'h1', ?, ?)`,
    ).run(now, now, now, now);
    expect(ftsRowCount(db, "msp:entity/direct-2")).toBe(1);

    db.prepare("UPDATE entities SET body_json = ?, source_hash = ?, updated_at = ? WHERE entity_id = ?").run(
      '{"role":"manager-promoted-widget"}',
      "h2",
      now,
      "msp:entity/direct-2",
    );

    expect(ftsRowCount(db, "msp:entity/direct-2")).toBe(1); // replaced, not duplicated
    const ftsRow = db.prepare("SELECT body_text FROM entities_fts WHERE entity_id = ?").get("msp:entity/direct-2");
    expect(ftsRow.body_text).toContain("manager-promoted-widget");
  });

  it("AFTER DELETE: a hard DELETE from entities removes the entities_fts row", () => {
    const db = freshDb();
    insertVault(db, "vault-direct");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
       VALUES ('msp:entity/direct-3', 'vault-direct', 'profile', 'carol', '{}', ?, ?, 'h', ?, ?)`,
    ).run(now, now, now, now);
    expect(ftsRowCount(db, "msp:entity/direct-3")).toBe(1);

    db.prepare("DELETE FROM entities WHERE entity_id = ?").run("msp:entity/direct-3");
    expect(ftsRowCount(db, "msp:entity/direct-3")).toBe(0);
  });

  it("real domain/entity-store.mjs upsert()/forget() calls keep entities_fts synced end to end", () => {
    const db = freshDb();
    insertVault(db, "vault-store");
    const store = new EntityStore(db);

    const created = store.upsert({
      vaultId: "vault-store",
      category: "note",
      key: "widget-spec",
      bodyJson: { summary: "a gizmo widget design note" },
      actor: "test",
    });
    expect(ftsRowCount(db, created.entity.entity_id)).toBe(1);

    const updated = store.upsert({
      vaultId: "vault-store",
      category: "note",
      key: "widget-spec",
      bodyJson: { summary: "a revised gadget widget design note" },
      actor: "test",
    });
    expect(updated.entity.entity_id).toBe(created.entity.entity_id);
    expect(ftsRowCount(db, created.entity.entity_id)).toBe(1); // still exactly one row, content replaced
    const afterUpdate = db.prepare("SELECT body_text FROM entities_fts WHERE entity_id = ?").get(created.entity.entity_id);
    expect(afterUpdate.body_text).toContain("gadget");

    // forget() is a soft delete (UPDATE lifecycle_state='forgotten'), which
    // fires the AFTER UPDATE trigger -- entities_fts keeps a row (the
    // exclusion from search results is ftsSearch's job, via a JOIN back to
    // entities.lifecycle_state, not entities_fts deletion).
    store.forget({ vaultId: "vault-store", category: "note", key: "widget-spec", reason: "done", actor: "test" });
    expect(ftsRowCount(db, created.entity.entity_id)).toBe(1);
  });
});

describe("retrieval/fts.mjs ftsSearch (WP-15 Bounded Scope item 2)", () => {
  function seeded() {
    const db = freshDb();
    insertVault(db, "vault-a");
    insertVault(db, "vault-b");
    const store = new EntityStore(db);
    const a = store.upsert({
      vaultId: "vault-a",
      category: "note",
      key: "a1",
      bodyJson: { summary: "widget alpha rollout plan" },
      actor: "test",
    }).entity;
    const b = store.upsert({
      vaultId: "vault-b",
      category: "note",
      key: "b1",
      bodyJson: { summary: "widget alpha rollout plan" },
      actor: "test",
    }).entity;
    return { db, store, a, b };
  }

  it("empty query returns [] rather than matching everything", () => {
    const { db } = seeded();
    expect(ftsSearch(db, { query: "", vaultIds: ["vault-a"] })).toEqual([]);
    expect(ftsSearch(db, { query: "   ", vaultIds: ["vault-a"] })).toEqual([]);
  });

  it("empty vaultIds returns [] rather than throwing or matching everything", () => {
    const { db } = seeded();
    expect(ftsSearch(db, { query: "widget", vaultIds: [] })).toEqual([]);
    expect(ftsSearch(db, { query: "widget", vaultIds: undefined })).toEqual([]);
  });

  it("scopes results strictly to the supplied vaultIds", () => {
    const { db, a } = seeded();
    const hits = ftsSearch(db, { query: "widget", vaultIds: ["vault-a"] });
    expect(hits).toHaveLength(1);
    expect(hits[0].entity.entity_id).toBe(a.entity_id);
    expect(hits[0].matchedBy).toBe("fts");
  });

  it("excludes forgotten entities", () => {
    const { db, store, a } = seeded();
    store.forget({ vaultId: "vault-a", category: "note", key: "a1", reason: "x", actor: "test" });
    const hits = ftsSearch(db, { query: "widget", vaultIds: ["vault-a"] });
    expect(hits.find((hit) => hit.entity.entity_id === a.entity_id)).toBeUndefined();
  });

  it("filters by category when supplied", () => {
    const { db, store } = seeded();
    store.upsert({ vaultId: "vault-a", category: "other", key: "a2", bodyJson: { summary: "widget beta" }, actor: "test" });
    const hits = ftsSearch(db, { query: "widget", vaultIds: ["vault-a"], category: "other" });
    expect(hits).toHaveLength(1);
    expect(hits[0].entity.category).toBe("other");
  });

  it("safely handles query tokens containing FTS5 special characters without throwing", () => {
    const { db } = seeded();
    expect(() => ftsSearch(db, { query: '-widget "alpha" OR NOT', vaultIds: ["vault-a"] })).not.toThrow();
  });
});

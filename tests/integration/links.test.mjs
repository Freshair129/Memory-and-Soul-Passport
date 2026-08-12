// AC-01 (WP-17): domain/links.mjs's flat create/list store, tested directly
// against a real (temp-file) SQLite database -- mirrors
// test/entity-store.test.mjs's in-process convention.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { LinksStore } from "@freshair129/msp-core/links";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
const VAULT_ID = "vault_links-test";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-links-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = open(path.join(dir, "db.sqlite3"));
  cleanups.push(() => db.close());
  runMigrations(db, migrationsDir);
  db.prepare("INSERT INTO vaults (vault_id, vault_type, status, created_at) VALUES (?, 'workspace_private', 'active', ?)").run(
    VAULT_ID,
    new Date().toISOString(),
  );
  return { db, store: new LinksStore(db), vaultId: VAULT_ID };
}

function insertEntity(db, vaultId, key) {
  const entityId = `msp:entity/links-test-${key}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO entities (entity_id, vault_id, category, key, body_json, valid_from, recorded_at, source_hash, created_at, updated_at)
     VALUES (?, ?, 'note', ?, '{}', ?, ?, 'deadbeef', ?, ?)`,
  ).run(entityId, vaultId, key, now, now, now, now);
  return entityId;
}

describe("domain/links (AC-01)", () => {
  it("create() is idempotent by (vaultId, fromEntityId, toEntityId, linkType)", () => {
    const { store, db, vaultId } = freshStore();
    const a = insertEntity(db, vaultId, "a");
    const b = insertEntity(db, vaultId, "b");

    const first = store.create({ vaultId, fromEntityId: a, toEntityId: b, linkType: "relates_to" });
    expect(first.created).toBe(true);
    expect(first.link.from_entity_id).toBe(a);
    expect(first.link.to_entity_id).toBe(b);
    expect(first.link.link_type).toBe("relates_to");
    expect(first.link.link_id).toMatch(/^msp:link\//);

    const second = store.create({ vaultId, fromEntityId: a, toEntityId: b, linkType: "relates_to" });
    expect(second.created).toBe(false);
    expect(second.link.link_id).toBe(first.link.link_id);

    // A different link_type between the same pair is a distinct edge.
    const third = store.create({ vaultId, fromEntityId: a, toEntityId: b, linkType: "supersedes" });
    expect(third.created).toBe(true);
    expect(third.link.link_id).not.toBe(first.link.link_id);
  });

  it("list() returns outgoing, incoming, or both, flat and single-hop only", () => {
    const { store, db, vaultId } = freshStore();
    const a = insertEntity(db, vaultId, "a2");
    const b = insertEntity(db, vaultId, "b2");
    const c = insertEntity(db, vaultId, "c2");

    store.create({ vaultId, fromEntityId: a, toEntityId: b, linkType: "relates_to" });
    store.create({ vaultId, fromEntityId: c, toEntityId: a, linkType: "cites" });

    const outgoing = store.list({ entityId: a, direction: "outgoing" });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].to_entity_id).toBe(b);

    const incoming = store.list({ entityId: a, direction: "incoming" });
    expect(incoming).toHaveLength(1);
    expect(incoming[0].from_entity_id).toBe(c);

    const both = store.list({ entityId: a, direction: "both" });
    expect(both).toHaveLength(2);

    // b only has one incoming link, nothing outgoing.
    expect(store.list({ entityId: b, direction: "outgoing" })).toHaveLength(0);
  });

  it("enforces PRAGMA foreign_keys=ON: a link referencing a nonexistent entity_id is rejected", () => {
    const { store, vaultId } = freshStore();
    expect(() => store.create({ vaultId, fromEntityId: "msp:entity/does-not-exist", toEntityId: "msp:entity/also-missing", linkType: "relates_to" })).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
  });

  it("requires vaultId/fromEntityId/toEntityId/linkType", () => {
    const { store, db, vaultId } = freshStore();
    const a = insertEntity(db, vaultId, "a3");
    const b = insertEntity(db, vaultId, "b3");
    expect(() => store.create({ fromEntityId: a, toEntityId: b, linkType: "x" })).toThrow(/vaultId/);
    expect(() => store.create({ vaultId, toEntityId: b, linkType: "x" })).toThrow(/fromEntityId/);
    expect(() => store.create({ vaultId, fromEntityId: a, linkType: "x" })).toThrow(/toEntityId/);
    expect(() => store.create({ vaultId, fromEntityId: a, toEntityId: b })).toThrow(/linkType/);
    expect(() => store.list({})).toThrow(/entityId/);
  });

  it("rejects an invalid direction value", () => {
    const { store, vaultId } = freshStore();
    expect(() => store.list({ entityId: "msp:entity/x", direction: "sideways" })).toThrow(/direction/);
  });
});

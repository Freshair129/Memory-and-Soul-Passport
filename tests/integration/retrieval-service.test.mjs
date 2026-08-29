// WP-15 Bounded Scope item 5: retrieval/retrieval-service.mjs's façade --
// exact-match short-circuit -> FTS -> vector (mode-gated) -> RRF fuse,
// reporting which legs ran. Uses an injected vectorClient stub throughout,
// so this suite never touches the network (no Ollama dependency, AC-05).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { EntityStore } from "@freshair129/msp-core/entity-store";
import { createRetrievalService } from "@freshair129/msp-retrieval/retrieval-service";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-retrieval-service-test-"));
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

// Stub vectorClient: never touches the network. `available` controls
// whether embed()/vectorSearch() report the leg as healthy.
function stubVectorClient({ available = false, hits = [] } = {}) {
  return {
    async embed() {
      return available ? { vector: [1, 0, 0], available: true, diagnostic: null } : { vector: null, available: false, diagnostic: "stub_unavailable" };
    },
    vectorSearch() {
      return { hits, available, diagnostic: available ? null : "stub_unavailable" };
    },
  };
}

describe("retrieval/retrieval-service.mjs createRetrievalService (WP-15 Bounded Scope item 5)", () => {
  function seeded() {
    const db = freshDb();
    insertVault(db, "vault-a");
    insertVault(db, "vault-b");
    const store = new EntityStore(db);
    const a = store.upsert({
      vaultId: "vault-a",
      category: "note",
      key: "widget-key",
      bodyJson: { summary: "an alpha widget rollout note" },
      actor: "test",
    }).entity;
    const b = store.upsert({
      vaultId: "vault-b",
      category: "note",
      key: "gadget-key",
      bodyJson: { summary: "an alpha widget rollout note" },
      actor: "test",
    }).entity;
    return { db, store, a, b };
  }

  it("empty query / empty vaultIds returns no hits, no layers used", async () => {
    const { db } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient() });
    const empty1 = await service.search({ vaultIds: ["vault-a"], query: "" });
    expect(empty1).toEqual({ hits: [], layersUsed: [], vectorAvailable: false, searchMode: "hybrid" });
    const empty2 = await service.search({ vaultIds: [], query: "widget" });
    expect(empty2.hits).toEqual([]);
  });

  it("exact-match short-circuit: query equal to a real key in the vault returns immediately with matched_by ['exact'], no FTS/vector legs run", async () => {
    const { db, a } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient({ available: true }) });
    const result = await service.search({ vaultIds: ["vault-a"], query: "widget-key" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].entity.entity_id).toBe(a.entity_id);
    expect(result.hits[0].matchedBy).toEqual(["exact"]);
    expect(result.layersUsed).toEqual(["exact"]);
    expect(result.vectorAvailable).toBe(false); // vector leg never even probed
    expect(result.searchMode).toBe("exact");
  });

  it("exact-match short-circuit is vault-scoped: a key that exists only in a DIFFERENT vault does not short-circuit", async () => {
    const { db } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient() });
    // "gadget-key" only exists in vault-b; searching vault-a must not
    // exact-match it.
    const result = await service.search({ vaultIds: ["vault-a"], query: "gadget-key" });
    expect(result.searchMode).not.toBe("exact");
  });

  it("falls through to FTS when no exact key match exists", async () => {
    const { db, a } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient() });
    const result = await service.search({ vaultIds: ["vault-a"], query: "alpha widget", mode: "fts" });
    expect(result.hits.some((hit) => hit.entity.entity_id === a.entity_id)).toBe(true);
    expect(result.layersUsed).toEqual(["fts"]);
    expect(result.searchMode).toBe("fts_only");
    expect(result.vectorAvailable).toBe(false);
  });

  it("mode:'fts' skips the vector leg entirely, even when the vector backend reports healthy", async () => {
    const { db, a } = seeded();
    const healthyVector = stubVectorClient({ available: true, hits: [{ entity: a, rank: 1, score: 0.9, matchedBy: "vector" }] });
    let vectorSearchCalled = false;
    healthyVector.vectorSearch = (...args) => {
      vectorSearchCalled = true;
      return { hits: [{ entity: a, rank: 1, score: 0.9, matchedBy: "vector" }], available: true, diagnostic: null };
    };
    const service = createRetrievalService({ db, vectorClient: healthyVector });
    const result = await service.search({ vaultIds: ["vault-a"], query: "alpha widget", mode: "fts" });
    expect(vectorSearchCalled).toBe(false);
    expect(result.searchMode).toBe("fts_only");
    expect(result.layersUsed).not.toContain("vector");
  });

  it("hybrid mode with a healthy vector backend fuses FTS and vector hits and reports both layers", async () => {
    const { db, a } = seeded();
    const vectorClient = stubVectorClient({ available: true, hits: [{ entity: a, rank: 1, score: 0.95, matchedBy: "vector" }] });
    const service = createRetrievalService({ db, vectorClient });
    const result = await service.search({ vaultIds: ["vault-a"], query: "alpha widget", mode: "hybrid" });
    expect(result.layersUsed).toEqual(expect.arrayContaining(["fts", "vector"]));
    expect(result.vectorAvailable).toBe(true);
    expect(result.searchMode).toBe("hybrid");
    const hit = result.hits.find((h) => h.entity.entity_id === a.entity_id);
    expect(hit.matchedBy).toEqual(expect.arrayContaining(["fts", "vector"]));
  });

  it("hybrid mode with an UNHEALTHY vector backend degrades to fts_only and reports vectorAvailable:false honestly", async () => {
    const { db, a } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient({ available: false }) });
    const result = await service.search({ vaultIds: ["vault-a"], query: "alpha widget", mode: "hybrid" });
    expect(result.hits.some((hit) => hit.entity.entity_id === a.entity_id)).toBe(true);
    expect(result.layersUsed).toEqual(["fts"]);
    expect(result.vectorAvailable).toBe(false);
    expect(result.searchMode).toBe("fts_only");
  });

  it("results never cross a vault boundary (AC-03 core property, in-process proof)", async () => {
    const { db, b } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient() });
    const result = await service.search({ vaultIds: ["vault-a"], query: "alpha widget rollout" });
    expect(result.hits.every((hit) => hit.entity.entity_id !== b.entity_id)).toBe(true);
  });

  it("an unrecognized mode value falls back to hybrid rather than throwing", async () => {
    const { db } = seeded();
    const service = createRetrievalService({ db, vectorClient: stubVectorClient() });
    const result = await service.search({ vaultIds: ["vault-a"], query: "alpha widget", mode: "not-a-real-mode" });
    expect(result.searchMode === "hybrid" || result.searchMode === "fts_only").toBe(true);
  });
});

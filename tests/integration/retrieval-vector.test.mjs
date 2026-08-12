// WP-15 Bounded Scope item 3 / Ground rule 5: retrieval/vector.mjs must
// never throw and never block a request on a slow/dead embedding backend --
// every failure mode (connection refusal, timeout, non-200, malformed
// payload, dimension mismatch) resolves to {available:false, diagnostic},
// plus a circuit breaker so repeated failures short-circuit instead of
// paying the full timeout every time. Uses an injected fetchImpl throughout
// -- no real network call anywhere in this file, so this suite has no
// dependency on Ollama actually running (AC-05).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { EntityStore } from "@freshair129/msp-core/entity-store";
import { createCircuitBreaker, createVectorClient, vectorToBlob } from "@freshair129/msp-retrieval/vector";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-vector-test-"));
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

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

describe("retrieval/vector.mjs embed() -- never throws (AC-05 / Ground rule 5)", () => {
  it("returns {available:false} for empty text without ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    const client = createVectorClient({ fetchImpl });
    const result = await client.embed("");
    expect(result).toEqual({ vector: null, available: false, diagnostic: expect.stringContaining("empty_text") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("connection refused (fetch rejects) resolves to {available:false}, never throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }));
    const client = createVectorClient({ fetchImpl });
    const result = await client.embed("hello");
    expect(result.available).toBe(false);
    expect(result.vector).toBeNull();
    expect(result.diagnostic).toMatch(/connection_error/);
  });

  it("a timeout (AbortError) resolves to {available:false}, never throws or hangs", async () => {
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const client = createVectorClient({ fetchImpl, timeoutMs: 20 });
    const result = await client.embed("hello");
    expect(result.available).toBe(false);
    expect(result.diagnostic).toMatch(/timeout/);
  });

  it("a non-200 response resolves to {available:false}, never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));
    const client = createVectorClient({ fetchImpl });
    const result = await client.embed("hello");
    expect(result.available).toBe(false);
    expect(result.diagnostic).toMatch(/ollama_http_500/);
  });

  it("a malformed payload (no embedding field) resolves to {available:false}, never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ notEmbedding: true }));
    const client = createVectorClient({ fetchImpl, dim: 4 });
    const result = await client.embed("hello");
    expect(result.available).toBe(false);
    expect(result.diagnostic).toMatch(/dimension_mismatch_or_malformed/);
  });

  it("a dimension mismatch resolves to {available:false}, never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ embedding: [0.1, 0.2, 0.3] }));
    const client = createVectorClient({ fetchImpl, dim: 1024 });
    const result = await client.embed("hello");
    expect(result.available).toBe(false);
    expect(result.diagnostic).toMatch(/dimension_mismatch_or_malformed/);
  });

  it("a well-formed response of the right dimension is available:true with the vector", async () => {
    const vector = new Array(4).fill(0).map((_, index) => index / 4);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ embedding: vector }));
    const client = createVectorClient({ fetchImpl, dim: 4 });
    const result = await client.embed("hello");
    expect(result).toEqual({ vector, available: true, diagnostic: null });
  });

  it("malformed JSON body (json() throws) resolves to {available:false}, never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    const client = createVectorClient({ fetchImpl });
    const result = await client.embed("hello");
    expect(result.available).toBe(false);
    expect(result.diagnostic).toMatch(/malformed_response/);
  });
});

describe("retrieval/vector.mjs circuit breaker (WP-15 Bounded Scope item 3)", () => {
  it("opens after N consecutive failures and skips subsequent calls without invoking fetch", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });
    const client = createVectorClient({ fetchImpl, breaker });

    await client.embed("first"); // failure 1
    await client.embed("second"); // failure 2 -> trips breaker
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const third = await client.embed("third");
    expect(third.available).toBe(false);
    expect(third.diagnostic).toMatch(/circuit_breaker_open/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // not called a third time -- breaker short-circuited it
  });

  it("closes again after a success and resumes calling fetch", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    let shouldFail = true;
    const fetchImpl = vi.fn(async () => {
      if (shouldFail) throw new Error("down");
      return jsonResponse({ embedding: [1, 2] });
    });
    const client = createVectorClient({ fetchImpl, breaker, dim: 2 });

    await client.embed("fails"); // trips breaker (threshold 1)
    const blocked = await client.embed("blocked");
    expect(blocked.diagnostic).toMatch(/circuit_breaker_open/);

    // Simulate cooldown elapsing and Ollama coming back healthy.
    breaker.recordSuccess();
    shouldFail = false;
    const recovered = await client.embed("recovered");
    expect(recovered.available).toBe(true);
  });

  it("cooldown elapsing allows a half-open retry attempt even without an explicit reset", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1 });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const client = createVectorClient({ fetchImpl, breaker });

    await client.embed("fails"); // trips breaker
    await new Promise((resolve) => setTimeout(resolve, 15)); // cooldown elapses
    await client.embed("half-open-retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // second call was NOT skipped by the breaker
  });
});

describe("retrieval/vector.mjs vectorSearch() (WP-15 Bounded Scope item 3)", () => {
  function seededDb() {
    const db = freshDb();
    insertVault(db, "vault-a");
    insertVault(db, "vault-b");
    const store = new EntityStore(db);
    const a = store.upsert({ vaultId: "vault-a", category: "note", key: "a1", bodyJson: { v: 1 }, actor: "test" }).entity;
    const b = store.upsert({ vaultId: "vault-b", category: "note", key: "b1", bodyJson: { v: 2 }, actor: "test" }).entity;

    const insertEmbedding = db.prepare(
      `INSERT INTO embeddings (entity_id, collection, model, dim, vector, content_hash, created_at)
       VALUES (@entity_id, 'msp-memory', 'bge-m3', 3, @vector, 'h', @now)`,
    );
    insertEmbedding.run({ entity_id: a.entity_id, vector: vectorToBlob([1, 0, 0]), now: new Date().toISOString() });
    insertEmbedding.run({ entity_id: b.entity_id, vector: vectorToBlob([0, 1, 0]), now: new Date().toISOString() });
    return { db, store, a, b };
  }

  it("returns [] with available:true for an empty vaultIds list (no error)", () => {
    const { db } = seededDb();
    const client = createVectorClient({});
    const result = client.vectorSearch(db, { queryVector: [1, 0, 0], vaultIds: [] });
    expect(result).toEqual({ hits: [], available: true, diagnostic: null });
  });

  it("returns available:false with a diagnostic for a missing/empty query vector, never throws", () => {
    const { db } = seededDb();
    const client = createVectorClient({});
    expect(client.vectorSearch(db, { queryVector: [], vaultIds: ["vault-a"] }).available).toBe(false);
    expect(client.vectorSearch(db, { queryVector: undefined, vaultIds: ["vault-a"] }).available).toBe(false);
  });

  it("scopes cosine-similarity results strictly to the supplied vaultIds", () => {
    const { db, a } = seededDb();
    const client = createVectorClient({});
    const result = client.vectorSearch(db, { queryVector: [1, 0, 0], vaultIds: ["vault-a"] });
    expect(result.available).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].entity.entity_id).toBe(a.entity_id);
    expect(result.hits[0].score).toBeCloseTo(1, 5); // identical vector -> cosine similarity 1
  });

  it("ranks best cosine match first across multiple vaults it is scoped to", () => {
    const { db, a, b } = seededDb();
    const client = createVectorClient({});
    const result = client.vectorSearch(db, { queryVector: [0.9, 0.1, 0], vaultIds: ["vault-a", "vault-b"] });
    expect(result.hits.map((hit) => hit.entity.entity_id)).toEqual([a.entity_id, b.entity_id]);
  });

  it("excludes forgotten entities from the scan", () => {
    const { db, store, a } = seededDb();
    store.forget({ vaultId: "vault-a", category: "note", key: "a1", reason: "x", actor: "test" });
    const client = createVectorClient({});
    const result = client.vectorSearch(db, { queryVector: [1, 0, 0], vaultIds: ["vault-a"] });
    expect(result.hits.find((hit) => hit.entity.entity_id === a.entity_id)).toBeUndefined();
  });

  it("never throws even against a database missing the embeddings table -- resolves to {available:false}", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-vector-noschema-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = open(path.join(dir, "db.sqlite3"));
    cleanups.push(() => db.close());
    // Deliberately no runMigrations() call -- embeddings/entities tables do not exist.
    const client = createVectorClient({});
    expect(() => client.vectorSearch(db, { queryVector: [1, 0, 0], vaultIds: ["vault-a"] })).not.toThrow();
    const result = client.vectorSearch(db, { queryVector: [1, 0, 0], vaultIds: ["vault-a"] });
    expect(result).toEqual({ hits: [], available: false, diagnostic: expect.stringContaining("vector_search_failed") });
  });
});

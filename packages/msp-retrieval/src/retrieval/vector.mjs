// retrieval/vector: bge-m3 embeddings via Ollama HTTP, plus a vault-scoped
// cosine-similarity scan over `embeddings` (WP-15 Bounded Scope item 3).
// ADR-027 layering: retrieval/ may import db/ and domain/ (entity-store.mjs's
// rowToEntity) -- never contracts/ or transport/.
//
// The hard requirement this whole module is built around (WP-15 Bounded
// Scope item 3 / AC-05): this module must NEVER throw and NEVER block a
// request on a slow/dead Ollama. Every failure mode -- connection refusal,
// timeout, non-200, malformed payload, dimension mismatch -- resolves to a
// plain {available:false, diagnostic} value the caller can degrade on, plus
// a circuit breaker so a dead Ollama does not cost every subsequent request
// its full timeout.
import { rowToEntity } from "@freshair129/msp-core/entity-store";

const DEFAULT_MODEL = "bge-m3";
const DEFAULT_DIM = 1024;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_COLLECTION = "msp-memory";

/**
 * A minimal consecutive-failure circuit breaker. Open after
 * `failureThreshold` consecutive failures; stays open until `cooldownMs` has
 * elapsed since the failure that tripped it, then allows one half-open
 * attempt (a subsequent failure re-opens it and restarts the cooldown, a
 * success closes it and resets the failure count).
 */
export function createCircuitBreaker({
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  let consecutiveFailures = 0;
  let openedAt = null;

  return {
    isOpen() {
      if (openedAt === null) return false;
      if (Date.now() - openedAt >= cooldownMs) return false; // half-open: allow a retry
      return true;
    },
    recordSuccess() {
      consecutiveFailures = 0;
      openedAt = null;
    },
    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        openedAt = Date.now();
      }
    },
    state() {
      return { consecutiveFailures, open: this.isOpen() };
    },
  };
}

function toBlob(vector) {
  return Buffer.from(new Float32Array(vector).buffer);
}

function fromBlob(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
  return Array.from(floats);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] defaults to OLLAMA_BASE_URL env var,
 *   then http://localhost:11434 -- resolved at client-construction time
 *   (not per-call), matching the rest of this runtime's launch-time
 *   configuration convention.
 * @param {typeof fetch} [options.fetchImpl] injectable for tests.
 */
export function createVectorClient({
  baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  model = DEFAULT_MODEL,
  dim = DEFAULT_DIM,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  breaker = createCircuitBreaker(),
} = {}) {
  /**
   * @param {string} text
   * @returns {Promise<{vector: number[]|null, available: boolean, diagnostic: string|null}>}
   *   Never throws.
   */
  async function embed(text) {
    if (typeof text !== "string" || !text.trim()) {
      return { vector: null, available: false, diagnostic: "empty_text: nothing to embed." };
    }
    if (breaker.isOpen()) {
      return {
        vector: null,
        available: false,
        diagnostic:
          "circuit_breaker_open: the embedding backend failed repeatedly and is being skipped until its cooldown elapses.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/api/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: text }),
          signal: controller.signal,
        });
      } catch (error) {
        breaker.recordFailure();
        const reason = error?.name === "AbortError" ? "timeout" : "connection_error";
        return {
          vector: null,
          available: false,
          diagnostic: `${reason}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (!response.ok) {
        breaker.recordFailure();
        return {
          vector: null,
          available: false,
          diagnostic: `ollama_http_${response.status}: embedding request returned a non-200 response.`,
        };
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        breaker.recordFailure();
        return {
          vector: null,
          available: false,
          diagnostic: `malformed_response: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const vector = payload?.embedding;
      const isValidVector =
        Array.isArray(vector) && vector.length === dim && vector.every((value) => typeof value === "number" && Number.isFinite(value));
      if (!isValidVector) {
        breaker.recordFailure();
        return {
          vector: null,
          available: false,
          diagnostic: `dimension_mismatch_or_malformed: expected a ${dim}-dimensional numeric vector.`,
        };
      }

      breaker.recordSuccess();
      return { vector, available: true, diagnostic: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Vault-scoped cosine-similarity scan over `embeddings` joined back to
   * `entities`. Never throws: a query-level failure (e.g. schema not yet
   * migrated) resolves to {hits:[], available:false, diagnostic}, matching
   * embed()'s fail-soft contract.
   * @param {import("better-sqlite3").Database} db
   * @param {object} options
   * @param {number[]} options.queryVector
   * @param {string[]} options.vaultIds
   * @param {string} [options.collection]
   * @param {number} [options.limit]
   */
  function vectorSearch(db, { queryVector, vaultIds, collection = DEFAULT_COLLECTION, limit = 20 } = {}) {
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      return { hits: [], available: false, diagnostic: "no_query_vector: nothing to search with." };
    }
    if (!Array.isArray(vaultIds) || vaultIds.length === 0) {
      return { hits: [], available: true, diagnostic: null };
    }

    try {
      const vaultPlaceholders = vaultIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT em.vector AS embedding_vector, e.*
           FROM embeddings em
           JOIN entities e ON e.entity_id = em.entity_id
           WHERE em.collection = ?
             AND e.vault_id IN (${vaultPlaceholders})
             AND e.lifecycle_state NOT IN ('archived', 'forgotten')`,
        )
        .all(collection, ...vaultIds);

      const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
      const scored = rows
        .map((row) => ({ entity: rowToEntity(row), score: cosineSimilarity(queryVector, fromBlob(row.embedding_vector)) }))
        .filter((item) => Number.isFinite(item.score));
      scored.sort((a, b) => b.score - a.score);

      const hits = scored.slice(0, boundedLimit).map((item, index) => ({
        entity: item.entity,
        rank: index + 1,
        score: item.score,
        matchedBy: "vector",
      }));
      return { hits, available: true, diagnostic: null };
    } catch (error) {
      return {
        hits: [],
        available: false,
        diagnostic: `vector_search_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { embed, vectorSearch, breaker, model, dim, baseUrl };
}

/** Serializes a numeric vector to the BLOB shape `embeddings.vector` stores (Float32Array bytes). */
export function vectorToBlob(vector) {
  return toBlob(vector);
}

// Module-level default client (WP-15 Bounded Scope item 3's literal
// embed(text)/vectorSearch(db, {...}) function names). Reads
// OLLAMA_BASE_URL at module-load time, matching every other launch-time
// configuration value in this runtime (MSP_DB_PATH, etc.) -- each spawned
// msp-runtime process picks up its own environment once, at startup.
const defaultClient = createVectorClient();

export function embed(text) {
  return defaultClient.embed(text);
}

export function vectorSearch(db, options) {
  return defaultClient.vectorSearch(db, options);
}

export const defaultVectorClient = defaultClient;

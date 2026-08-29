// retrieval/retrieval-service: the msp_memory_search façade (WP-15 Bounded
// Scope item 5). Pipeline: exact-match short-circuit -> FTS -> vector (only
// if mode !== "fts" and an embedding can be produced) -> RRF fuse. Reports
// which legs actually ran so the transport handler can build API-009 SS4.6's
// {hits, layers_used, vector_available, searchMode} response honestly.
//
// Documented design decision (recorded in this packet's final report as a
// resolved ambiguity, not a silent guess): API-009 SS4.6's msp_memory_search
// request carries only {vault_id, query, mode, limit} -- there is no
// separate category/key field for an "exact category+key hit" the way this
// packet's own prose describes the short-circuit. This implementation
// treats `query` as a candidate literal `key` and matches it across every
// category within the supplied vault(s); a query that happens to equal a
// real key short-circuits straight to that entity with matched_by: ["exact"]
// and no FTS/vector legs run, exactly as "returns immediately" requires.
//
// ADR-027 layering: retrieval/ may import db/ and domain/ (rowToEntity) --
// never contracts/ or transport/.
import { rowToEntity } from "@freshair129/msp-core/entity-store";
import { ftsSearch } from "./fts.mjs";
import { rrfFuse } from "./fusion.mjs";

const DEFAULT_LIMIT = 20;
const VALID_MODES = new Set(["hybrid", "fts", "vector"]);

/**
 * @param {object} options
 * @param {import("better-sqlite3").Database} options.db
 * @param {{embed: Function, vectorSearch: Function}} options.vectorClient
 */
export function createRetrievalService({ db, vectorClient }) {
  if (!db) throw new TypeError("createRetrievalService requires db.");
  if (!vectorClient || typeof vectorClient.embed !== "function" || typeof vectorClient.vectorSearch !== "function") {
    throw new TypeError("createRetrievalService requires a vectorClient with embed() and vectorSearch().");
  }

  // WP-16 Bounded Scope item 6: archived entities are excluded from default
  // msp_memory_search results, same as forgotten -- this exact-match
  // short-circuit and the FTS/vector legs below (retrieval/fts.mjs,
  // retrieval/vector.mjs) all apply the same NOT IN ('archived', 'forgotten')
  // exclusion. Unlike msp_memory_list, API-009 SS4.6's msp_memory_search
  // request carries no lifecycle_state override field -- inventing one would
  // widen the wire shape beyond what's documented (the same restraint
  // memory-handlers.mjs's header comment already applies to caller
  // identity), so search has no explicit-filter escape hatch; archived
  // results always remain reachable through msp_memory_list's explicit
  // lifecycle_state filter or msp_memory_history.
  const selectExactByKey = db.prepare(
    "SELECT * FROM entities WHERE vault_id = ? AND key = ? AND lifecycle_state NOT IN ('archived', 'forgotten')",
  );

  function findExactMatch(vaultIds, query) {
    for (const vaultId of vaultIds) {
      const row = selectExactByKey.get(vaultId, query);
      if (row) return rowToEntity(row);
    }
    return null;
  }

  function matchedByFor(entityId, ftsHits, vectorHits) {
    const matched = [];
    if (ftsHits.some((hit) => hit.entity.entity_id === entityId)) matched.push("fts");
    if (vectorHits.some((hit) => hit.entity.entity_id === entityId)) matched.push("vector");
    return matched;
  }

  /**
   * @param {object} options
   * @param {string[]} options.vaultIds vault-scoped candidate set. Empty
   *   (or non-array) returns no results rather than throwing or searching
   *   unscoped -- AC-03's core guarantee.
   * @param {string} options.query
   * @param {"hybrid"|"fts"|"vector"} [options.mode]
   * @param {number} [options.limit]
   */
  async function search({ vaultIds, query, mode = "hybrid", limit = DEFAULT_LIMIT } = {}) {
    const requestedMode = VALID_MODES.has(mode) ? mode : "hybrid";
    const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));

    if (!Array.isArray(vaultIds) || vaultIds.length === 0 || typeof query !== "string" || !query.trim()) {
      return { hits: [], layersUsed: [], vectorAvailable: false, searchMode: requestedMode === "fts" ? "fts_only" : requestedMode };
    }
    const trimmedQuery = query.trim();

    // 1. Exact-match short-circuit: returns immediately, no FTS/vector legs run.
    const exactEntity = findExactMatch(vaultIds, trimmedQuery);
    if (exactEntity) {
      return {
        hits: [{ entity: exactEntity, score: 1, matchedBy: ["exact"] }],
        layersUsed: ["exact"],
        vectorAvailable: false,
        searchMode: "exact",
      };
    }

    // 2. FTS.
    const ftsHits = ftsSearch(db, { query: trimmedQuery, vaultIds, limit: boundedLimit });

    // 3. Vector -- skipped entirely when mode is the explicit "fts" fallback,
    // regardless of Ollama health (WP-15 Bounded Scope item 5).
    let vectorHits = [];
    let vectorAvailable = false;
    if (requestedMode !== "fts") {
      const embedResult = await vectorClient.embed(trimmedQuery);
      if (embedResult.available) {
        const vectorResult = vectorClient.vectorSearch(db, {
          queryVector: embedResult.vector,
          vaultIds,
          limit: boundedLimit,
        });
        vectorAvailable = vectorResult.available;
        if (vectorResult.available) vectorHits = vectorResult.hits;
      }
    }

    // 4. RRF fuse.
    const rankedLists = [];
    if (ftsHits.length > 0) rankedLists.push(ftsHits.map((hit) => ({ id: hit.entity.entity_id, entity: hit.entity })));
    if (vectorHits.length > 0) rankedLists.push(vectorHits.map((hit) => ({ id: hit.entity.entity_id, entity: hit.entity })));

    const fused = rrfFuse(rankedLists);
    const hits = fused.slice(0, boundedLimit).map((item) => ({
      entity: item.entity,
      score: item.score,
      matchedBy: matchedByFor(item.id, ftsHits, vectorHits),
    }));

    const layersUsed = [];
    if (ftsHits.length > 0) layersUsed.push("fts");
    if (vectorHits.length > 0) layersUsed.push("vector");

    // API-009 SS4.6: searchMode is "fts_only" whenever the vector leg did
    // not actually contribute -- either because "fts" mode explicitly
    // skipped it, or because hybrid/vector was requested but the embedding
    // backend was unhealthy. Otherwise it echoes the requested mode
    // ("hybrid" or "vector") since the vector leg genuinely ran.
    let searchMode;
    if (requestedMode === "fts" || !vectorAvailable) {
      searchMode = "fts_only";
    } else {
      searchMode = requestedMode;
    }

    return { hits, layersUsed, vectorAvailable, searchMode };
  }

  return { search };
}

// retrieval/fusion: Reciprocal Rank Fusion (WP-15 Bounded Scope item 4).
// Pure function, no I/O, no DB handle -- exhaustively unit-testable without
// any fixture (AC-02). ADR-027 layering: retrieval/ may import db/ and
// domain/, but this module deliberately imports neither -- it operates only
// on the ranked lists it is handed.
//
// Standard RRF: for each ranked list, item at 1-based rank r contributes
// 1/(k+r) to that item's fused score; contributions from every list an item
// appears in are summed. k defaults to 60, the conventional RRF constant
// (also SDD SS3's "retrieval/fusion.mjs -- Reciprocal Rank Fusion, k=60").
//
// @param {Array<Array<{id: string, [key: string]: unknown}>>} hitLists each
//   list is already rank-ordered (best match first); every item must carry
//   a stable `id` used to merge the same candidate across lists. Lists may
//   be empty or absent (falsy/non-array entries are skipped, not thrown on)
//   so callers can pass `[ftsHits, vectorHits]` without pre-filtering empty
//   legs.
// @param {{k?: number}} [options]
// @returns {Array<{id: string, score: number, [key: string]: unknown}>}
//   sorted by descending fused score. Ties break by the id's own string
//   ordering so the result is fully deterministic regardless of Map
//   insertion order or engine-specific stable-sort behavior.
export function rrfFuse(hitLists, { k = 60 } = {}) {
  if (!Array.isArray(hitLists)) {
    throw new TypeError("rrfFuse requires an array of ranked lists.");
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new TypeError("rrfFuse requires a positive finite k.");
  }

  const fused = new Map(); // id -> { ...item, score }

  for (const list of hitLists) {
    if (!Array.isArray(list)) continue;
    list.forEach((item, index) => {
      if (!item || typeof item.id === "undefined" || item.id === null) {
        throw new TypeError("Every item in a hit list passed to rrfFuse must carry a non-null id.");
      }
      const rank = index + 1; // 1-based rank, per RRF's definition
      const contribution = 1 / (k + rank);
      const existing = fused.get(item.id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(item.id, { ...item, score: contribution });
      }
    });
  }

  return [...fused.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.id).localeCompare(String(b.id));
  });
}

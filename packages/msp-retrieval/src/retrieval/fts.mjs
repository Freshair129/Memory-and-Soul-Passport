// retrieval/fts: FTS5 keyword search over `entities_fts` (WP-15 Bounded
// Scope item 2). ADR-027 layering: retrieval/ may import db/ and domain/
// (entity-store.mjs's rowToEntity, reused rather than duplicated) -- never
// contracts/ or transport/.
import { rowToEntity } from "@freshair129/msp-core/entity-store";

// FTS5 query syntax treats bareword input as an expression language
// (operators like AND/OR/NOT/-/*/"..."), so forwarding a caller's free-text
// `query` unescaped risks a syntax error on ordinary input (e.g. a leading
// "-", an unbalanced quote). Tokenizing on whitespace and quoting each token
// as an FTS5 string literal (doubling embedded quotes), then ANDing them
// together, keeps every token a literal match target regardless of what
// punctuation it contains, while still requiring all query tokens to be
// present (a reasonable keyword-search default).
function toMatchExpression(query) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {object} options
 * @param {string} options.query
 * @param {string[]} options.vaultIds caller-authorized vault ids to scope
 *   this search to. An empty (or non-array) list returns [] rather than
 *   throwing or matching every vault -- WP-15 Bounded Scope item 2.
 * @param {string|null} [options.category]
 * @param {number} [options.limit]
 * @returns {Array<{entity: object, rank: number, matchedBy: "fts"}>}
 *   rank is 1-based, best match first (FTS5's own bm25-derived `rank`).
 */
export function ftsSearch(db, { query, vaultIds, category = null, limit = 20 } = {}) {
  if (typeof query !== "string" || !query.trim()) return [];
  if (!Array.isArray(vaultIds) || vaultIds.length === 0) return [];

  const matchExpression = toMatchExpression(query);
  if (!matchExpression) return [];

  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  const vaultPlaceholders = vaultIds.map(() => "?").join(", ");
  const params = [matchExpression, ...vaultIds];

  let categoryClause = "";
  if (category) {
    categoryClause = "AND e.category = ?";
    params.push(category);
  }
  params.push(boundedLimit);

  // Note: the MATCH constraint is written against the virtual table's own
  // name (entities_fts), not its "f" alias -- better-sqlite3/SQLite's FTS5
  // integration resolves whole-table `MATCH` only via the real table name
  // (verified directly: `f MATCH ?` raises "no such column: f" once the FTS5
  // table is joined under an alias, while `entities_fts MATCH ?` resolves
  // correctly against the same aliased FROM clause). `f.` is still used for
  // every ordinary column reference (vault_id) below.
  const rows = db
    .prepare(
      `SELECT e.*
       FROM entities_fts f
       JOIN entities e ON e.entity_id = f.entity_id
       WHERE entities_fts MATCH ?
         AND f.vault_id IN (${vaultPlaceholders})
         AND e.lifecycle_state NOT IN ('archived', 'forgotten')
         ${categoryClause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params);

  return rows.map((row, index) => ({
    entity: rowToEntity(row),
    rank: index + 1,
    matchedBy: "fts",
  }));
}

// domain/links: a flat entity-link store (WP-17 Phase 5 Stage A, Bounded
// Scope item 1). Create/list only -- no traversal, no backlink
// materialization, no graph query. Depends only on db/ (an already-open
// connection) and other domain/ modules (domain/ids.mjs), never retrieval/
// or contracts/, per ADR-027's layering rule.
//
// Cross-vault rejection is NOT enforced here. This store trusts its caller
// to have already resolved both endpoints and confirmed they share a
// vault_id -- exactly the same layering choice domain/entity-store.mjs makes
// for vault scoping (the store takes a vaultId argument; it is
// transport/handlers/memory-handlers.mjs that resolves entity_id -> vault_id
// and enforces the cross-vault check via contracts/vault-scope-guard.mjs
// before calling in, matching WP-17 Bounded Scope item 2).
import { mintRef, sha256Hex } from "./ids.mjs";

function computeLinkId(vaultId, fromEntityId, toEntityId, linkType) {
  const digest = sha256Hex(["link", vaultId, fromEntityId, toEntityId, linkType].join(" ")).slice(0, 24);
  return mintRef("link", digest);
}

function rowToLink(row) {
  if (!row) return null;
  return {
    link_id: row.link_id,
    vault_id: row.vault_id,
    from_entity_id: row.from_entity_id,
    to_entity_id: row.to_entity_id,
    link_type: row.link_type,
    confidence: row.confidence,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    recorded_at: row.recorded_at,
    created_at: row.created_at,
  };
}

export class LinksStore {
  #db;
  #selectByKey;
  #insertLink;
  #selectOutgoing;
  #selectIncoming;

  constructor(db) {
    this.#db = db;
    this.#selectByKey = db.prepare(
      "SELECT * FROM links WHERE vault_id = ? AND from_entity_id = ? AND to_entity_id = ? AND link_type = ?",
    );
    this.#insertLink = db.prepare(`
      INSERT INTO links
        (link_id, vault_id, from_entity_id, to_entity_id, link_type, confidence, valid_from, valid_to, recorded_at, created_at)
      VALUES
        (@link_id, @vault_id, @from_entity_id, @to_entity_id, @link_type, @confidence, @valid_from, @valid_to, @recorded_at, @created_at)
    `);
    this.#selectOutgoing = db.prepare("SELECT * FROM links WHERE from_entity_id = ?");
    this.#selectIncoming = db.prepare("SELECT * FROM links WHERE to_entity_id = ?");
  }

  /**
   * Idempotent by (vaultId, fromEntityId, toEntityId, linkType), matching the
   * UNIQUE constraint migration 0006_links.sql establishes: recreating the
   * exact same typed edge is a no-op returning the existing row, not a
   * duplicate or a raw constraint-violation crash.
   */
  create({ vaultId, fromEntityId, toEntityId, linkType, confidence = 0.5, validFrom, validTo = null }) {
    if (!vaultId) throw new TypeError("links.create requires vaultId.");
    if (!fromEntityId) throw new TypeError("links.create requires fromEntityId.");
    if (!toEntityId) throw new TypeError("links.create requires toEntityId.");
    if (!linkType) throw new TypeError("links.create requires linkType.");

    const now = new Date().toISOString();
    const run = this.#db.transaction(() => {
      const existing = this.#selectByKey.get(vaultId, fromEntityId, toEntityId, linkType);
      if (existing) return { link: rowToLink(existing), created: false };

      const linkId = computeLinkId(vaultId, fromEntityId, toEntityId, linkType);
      this.#insertLink.run({
        link_id: linkId,
        vault_id: vaultId,
        from_entity_id: fromEntityId,
        to_entity_id: toEntityId,
        link_type: linkType,
        confidence,
        valid_from: validFrom || now,
        valid_to: validTo,
        recorded_at: now,
        created_at: now,
      });
      return { link: rowToLink(this.#selectByKey.get(vaultId, fromEntityId, toEntityId, linkType)), created: true };
    });

    return run();
  }

  /**
   * Flat, single-hop listing only -- no traversal, no depth/path parameter,
   * matching API-009 SS4.8's documented request shape exactly.
   */
  list({ entityId, direction = "both" }) {
    if (!entityId) throw new TypeError("links.list requires entityId.");
    if (!["outgoing", "incoming", "both"].includes(direction)) {
      throw new TypeError(`links.list requires direction to be one of "outgoing", "incoming", "both"; got "${direction}".`);
    }

    const outgoing = direction !== "incoming" ? this.#selectOutgoing.all(entityId) : [];
    const incoming = direction !== "outgoing" ? this.#selectIncoming.all(entityId) : [];
    return [...outgoing, ...incoming].map(rowToLink);
  }
}

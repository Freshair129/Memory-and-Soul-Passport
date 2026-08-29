-- 0006_links.sql
--
-- WP-17 Phase 5 Stage A, Bounded Scope item 1: a flat entity-link table.
-- Create/list only in this packet -- no traversal, no backlink
-- materialization, no graph query. The table accumulates data now so a
-- future graph layer has history to work with; nothing here walks it.
--
-- Bi-temporal columns (valid_from/valid_to/recorded_at) are consistent with
-- domain/temporal-engine.mjs's semantics and mirror entities/entity_history's
-- naming, even though this packet's LinksStore never performs a bitemporal
-- point read against them -- that is intentionally left for a future graph
-- phase, not invented here.
--
-- Both endpoints are entity_id foreign keys, so a link can never reference a
-- nonexistent entity. Cross-vault rejection (a link whose two endpoints
-- belong to different vaults must be refused) is NOT a schema-level
-- constraint here -- entity_id alone does not tell SQLite which vault a
-- *different* entity_id belongs to without a subquery this migration does
-- not add -- it is enforced in transport/handlers/memory-handlers.mjs before
-- domain/links.mjs is ever called (see that file's comment).
--
-- UNIQUE(vault_id, from_entity_id, to_entity_id, link_type) makes
-- msp_memory_links_create idempotent: recreating the exact same typed edge
-- is a no-op, not a duplicate row or a constraint-violation crash.
CREATE TABLE links (
  link_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults (vault_id),
  from_entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  to_entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  link_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (vault_id, from_entity_id, to_entity_id, link_type)
);

CREATE INDEX idx_links_vault_id ON links (vault_id);
CREATE INDEX idx_links_from_entity_id ON links (from_entity_id);
CREATE INDEX idx_links_to_entity_id ON links (to_entity_id);

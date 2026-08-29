-- 0004_retrieval.sql
--
-- WP-15 Phase 3: hybrid retrieval schema. Adds the two tables
-- docs/architecture/SDD-Persistent-Memory-MSP-Runtime.md Section 5 documents
-- as still-deferred through WP-14 -- `entities_fts` (FTS5 keyword index) and
-- `embeddings` (bge-m3 dense vectors) -- plus the triggers that keep
-- `entities_fts` in sync with `entities` on every insert/update/delete.
--
-- IMPORTANT for any FUTURE migration that rebuilds `entities` (following
-- 0003_vault_scoping.sql's "12-step" CREATE-new/INSERT-SELECT/DROP/RENAME
-- rebuild pattern): a table rebuild (DROP TABLE entities; ...) also drops
-- every trigger defined against `entities`, including the three
-- trg_entities_fts_* triggers below. Any future migration that rebuilds
-- `entities` MUST recreate these three triggers (and re-verify
-- `entities_fts` stays in sync) as part of that same migration, or FTS
-- silently stops tracking writes. This mirrors 0003's own header comment
-- about entity_history's foreign key re-attaching automatically by table
-- name -- triggers do NOT re-attach automatically the way FK references do;
-- they must be re-issued explicitly.
--
-- entities_fts indexes the minimum searchable projection WP-15 Bounded Scope
-- item 1 requires: category, key, and the text of body_json (FTS5 tokenizes
-- the raw JSON text; this is "the text extracted from body_json" at the
-- minimum bar the packet asks for -- a smarter per-field JSON text
-- extraction is not requested and would add scope this phase does not need).
-- entity_id and vault_id are carried UNINDEXED (stored but not tokenized) so
-- retrieval/fts.mjs can vault-filter and join back to `entities` for the
-- full MemoryEntity projection and lifecycle_state check without a second
-- lookup table.
CREATE VIRTUAL TABLE entities_fts USING fts5(
  category,
  key,
  body_text,
  entity_id UNINDEXED,
  vault_id UNINDEXED
);

-- Sync triggers. entities_fts is a standalone (non-external-content) FTS5
-- table, so INSERT/UPDATE/DELETE are driven explicitly here rather than via
-- FTS5's "external content table" mechanism -- entities' primary key
-- (entity_id) is TEXT, not a rowid-friendly INTEGER, so content-table
-- rowid-correlation is not a clean fit; delete-then-insert by entity_id
-- (an UNINDEXED, but still filterable, column) keeps this simple and
-- correct at this table's expected size.
CREATE TRIGGER trg_entities_fts_ai
AFTER INSERT ON entities
BEGIN
  INSERT INTO entities_fts (category, key, body_text, entity_id, vault_id)
  VALUES (new.category, new.key, new.body_json, new.entity_id, new.vault_id);
END;

CREATE TRIGGER trg_entities_fts_au
AFTER UPDATE ON entities
BEGIN
  DELETE FROM entities_fts WHERE entity_id = old.entity_id;
  INSERT INTO entities_fts (category, key, body_text, entity_id, vault_id)
  VALUES (new.category, new.key, new.body_json, new.entity_id, new.vault_id);
END;

CREATE TRIGGER trg_entities_fts_ad
AFTER DELETE ON entities
BEGIN
  DELETE FROM entities_fts WHERE entity_id = old.entity_id;
END;

-- embeddings: one row per embedded entity, per WP-15 Bounded Scope item 1's
-- exact column list. UNIQUE(entity_id, collection) matches "one row per
-- embedded entity" per collection -- a re-embed (e.g. after a content
-- change) is an upsert against this constraint, not a growing history (only
-- the current entity content is ever embedded; see Explicit Exclusions:
-- historical-version search is out of scope).
CREATE TABLE embeddings (
  entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  collection TEXT NOT NULL DEFAULT 'msp-memory',
  model TEXT NOT NULL DEFAULT 'bge-m3',
  dim INTEGER NOT NULL DEFAULT 1024,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (entity_id, collection)
);

CREATE INDEX idx_embeddings_entity_id ON embeddings (entity_id);

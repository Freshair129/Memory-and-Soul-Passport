-- 0005_decay_lifecycle.sql
--
-- WP-16 Phase 4: Ebbinghaus-style decay scoring and the
-- active -> decayed -> archived -> forgotten lifecycle. Two schema changes:
--
--   1. entities.last_accessed_at (nullable TEXT): NULL means "never read
--      since creation" -- domain/decay-engine.mjs's recomputeDecayScore()
--      handles that explicitly (falling back to created_at as the decay
--      reference point) rather than coercing it to epoch zero.
--   2. A table-level CHECK constraint restricting entities.lifecycle_state to
--      ('active', 'decayed', 'archived', 'forgotten'). SQLite cannot add a
--      CHECK constraint via ALTER TABLE, so -- exactly as
--      0003_vault_scoping.sql's header comment documents and this packet's
--      Bounded Scope item 1 requires -- this migration follows the same
--      "12-step" rebuild procedure (CREATE new / INSERT SELECT / DROP /
--      RENAME) rather than inventing a different strategy.
--
-- entities.decay_score, entities.lifecycle_state, and entities.access_count
-- already exist (added in 0001_init.sql, carried through 0003's rebuild) --
-- this migration does NOT re-add them, only adds last_accessed_at and the
-- CHECK constraint.
--
-- IMPORTANT, called out by 0004_retrieval.sql's own header comment: a table
-- rebuild (DROP TABLE entities; ...) drops every trigger defined against
-- entities, including the three trg_entities_fts_* triggers 0004 created.
-- Triggers do not re-attach automatically the way entity_history's and
-- embeddings' FK references do (those resolve by table name at check time,
-- confirmed by 0003's header comment) -- they are re-issued explicitly below,
-- in the same migration, so entities_fts does not silently stop tracking
-- writes. entities_fts itself (the FTS5 virtual table) is not touched or
-- rebuilt here -- only the ordinary triggers defined on `entities` that fed
-- it need to be recreated; its own rows survive this migration untouched.
--
-- No pre-existing entities row needs to be preserved in practice, for the
-- same reason 0003 documented: every test and this package's own runtime
-- usage opens MSP_DB_PATH against a fresh temp-file database, and no
-- .sqlite* file is committed to this repo. The INSERT ... SELECT step below
-- supplies NULL for the new last_accessed_at column of any pre-existing row
-- (nullable, so this is not a fail-closed NOT NULL rejection the way 0003's
-- vault_id backfill was -- last_accessed_at legitimately means "never
-- accessed" for a pre-existing row too).

CREATE TABLE entities_new (
  entity_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults (vault_id),
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  body_json TEXT NOT NULL,
  epistemic_state TEXT NOT NULL DEFAULT 'hypothesis'
    CHECK (epistemic_state IN ('hypothesis', 'confirmed', 'contested', 'deprecated')),
  confidence REAL NOT NULL DEFAULT 0.5,
  current_version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_at TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'decayed', 'archived', 'forgotten')),
  decay_score REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (vault_id, category, key)
);

INSERT INTO entities_new
  (entity_id, vault_id, category, key, body_json, epistemic_state, confidence, current_version,
   valid_from, valid_to, recorded_at, superseded_at, lifecycle_state, decay_score, access_count,
   last_accessed_at, source_hash, created_at, updated_at)
SELECT
  entity_id, vault_id, category, key, body_json, epistemic_state, confidence, current_version,
  valid_from, valid_to, recorded_at, superseded_at, lifecycle_state, decay_score, access_count,
  NULL, source_hash, created_at, updated_at
FROM entities;

DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;

-- entity_history.entity_id and embeddings.entity_id REFERENCE entities
-- (entity_id): both resolve by table name at check time, so they re-attach
-- to the rebuilt `entities` table automatically once the rename above
-- completes, exactly as 0003's header comment documents for entity_history.

CREATE INDEX idx_entities_category ON entities (category);
CREATE INDEX idx_entities_lifecycle_state ON entities (lifecycle_state);
CREATE INDEX idx_entities_vault_id ON entities (vault_id);

-- Supports domain/decay-engine.mjs's runDecayTick() sweep query
-- (WHERE vault_id = ? AND lifecycle_state != 'forgotten'), which then
-- inspects decay_score per candidate row.
CREATE INDEX idx_entities_decay_sweep ON entities (vault_id, lifecycle_state, decay_score);

-- Re-create the three entities_fts sync triggers dropped by the rebuild
-- above (verbatim from 0004_retrieval.sql -- see that file's header comment
-- for why a standalone, non-external-content FTS5 table needs these driven
-- explicitly rather than via FTS5's external-content mechanism).
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

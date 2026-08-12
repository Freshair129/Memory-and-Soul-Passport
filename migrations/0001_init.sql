-- 0001_init.sql
--
-- Phase 1 storage foundation. Only the tables domain/entity-store actually
-- needs to work standalone: `entities` (current-state projection) and
-- `entity_history` (append-only bi-temporal ledger). `schema_migrations` is
-- created separately by db/migrate.mjs before this file runs.
--
-- Deferred to a later phase (see WP-12 Bounded Scope / Explicit Exclusions,
-- and the final report for the full rationale): `vaults` / `vault_mounts`
-- (vault-registry is out of scope for Phase 1), `embeddings` / `entities_fts`
-- (retrieval is Phase 3), `journal` (audit trail backs msp_context_audit,
-- Phase 2), `state` (KV+TTL store, no Phase 1 consumer), `links` (graph
-- edges, no Phase 1 consumer).

CREATE TABLE entities (
  entity_id TEXT PRIMARY KEY,
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
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  decay_score REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (category, key)
);

CREATE INDEX idx_entities_category ON entities (category);
CREATE INDEX idx_entities_lifecycle_state ON entities (lifecycle_state);

-- entity_history is append-only: no code path outside a future migration
-- may UPDATE or DELETE a row here (see domain/entity-store.mjs). The
-- REFERENCES clause below is what makes `PRAGMA foreign_keys=ON`
-- meaningfully testable per AC-04 (a history row for a nonexistent
-- entity_id is rejected).
CREATE TABLE entity_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  epistemic_state TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_at TEXT,
  change_reason TEXT,
  actor TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  UNIQUE (entity_id, version)
);

CREATE INDEX idx_entity_history_entity_id ON entity_history (entity_id);

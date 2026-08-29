-- 0003_vault_scoping.sql
--
-- WP-14: closes the HIGH-severity vault-scoping gap recorded during WP-13's
-- gate review (see docs/api/API-009-Persistent-Memory-Contract.md §6's
-- amendment note and WP-13's Deviations section, Deviation 2). Three schema
-- changes:
--
--   1. entities.vault_id (FK -> vaults), replacing entities' old
--      UNIQUE(category, key) with UNIQUE(vault_id, category, key), so two
--      different vaults can hold an entity with the same (category, key)
--      without conflict, and domain/entity-store.mjs's computeEntityId can
--      fold vault_id into entity_id derivation (see that file for the other
--      half of this fix).
--   2. promotions.vault_id (FK -> vaults), replacing promotions' old
--      UNIQUE(idempotency_key) with UNIQUE(vault_id, idempotency_key) --
--      this is the direct fix for the cross-agent Global-Private disclosure
--      this packet exists to close: two different vaults (agents) reusing
--      the same idempotency_key no longer collide.
--   3. vaults.role, per docs/architecture/SDD-Persistent-Memory-MSP-Runtime.md
--      §5's Data Model table (vaults row already documents `role` as a
--      canonical column the implementation had not yet added).
--
-- entity_history is deliberately NOT touched here. Its uniqueness shape is
-- UNIQUE(entity_id, version), which already presupposes a vault-scoped
-- entity_id -- and after domain/entity-store.mjs's computeEntityId change,
-- entity_id IS vault-scoped (folding vault_id into the hash input), so
-- entity_history's existing constraint is already correct with no schema
-- change needed. Adding entity_history.vault_id would be a redundant
-- denormalization this packet does not need: every entity_history row is
-- reachable only via its (already vault-scoped) entity_id.
--
-- Migration strategy for entities/promotions (recorded here per WP-14's
-- Explicit Exclusions, which forbid silently assuming a backfill strategy):
-- both packages/msp-runtime/test/*.mjs and this package's actual runtime
-- usage always open MSP_DB_PATH against a fresh temp-file database (every
-- test uses mkdtempSync(...)/db.sqlite3, and no .sqlite* file is committed
-- to this repo -- verified by inspection of test/*.mjs and a repo search).
-- There is therefore no pre-existing entities/promotions row this migration
-- needs to preserve in practice. Rather than silently assume that and use a
-- plain ALTER TABLE ADD COLUMN ... NOT NULL (which SQLite only permits when
-- the table has zero rows, and would otherwise need an invented default
-- vault_id that does not correspond to any real vault), both tables use the
-- standard SQLite "12-step" rebuild procedure (create a new table with the
-- final shape, copy across, drop the old table, rename). The INSERT ...
-- SELECT step deliberately supplies NULL for the new NOT NULL vault_id
-- column of any pre-existing row: if either table is genuinely empty (the
-- verified case), this is a zero-row no-op and the migration succeeds; if
-- either table unexpectedly already has rows at migration time, the NOT
-- NULL constraint rejects the NULL and the migration fails closed with a
-- loud constraint-violation error instead of silently fabricating a
-- default vault_id or dropping data -- exactly the "decided and recorded,
-- not silently assumed" posture WP-14's Explicit Exclusions require.
-- entity_history/journal are unaffected and untouched by this migration.

-- ---------------------------------------------------------------------
-- entities: add vault_id, re-key UNIQUE(category, key) -> UNIQUE(vault_id, category, key)
-- ---------------------------------------------------------------------
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
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  decay_score REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (vault_id, category, key)
);

INSERT INTO entities_new
  (entity_id, vault_id, category, key, body_json, epistemic_state, confidence, current_version,
   valid_from, valid_to, recorded_at, superseded_at, lifecycle_state, decay_score, access_count,
   source_hash, created_at, updated_at)
SELECT
  entity_id, NULL, category, key, body_json, epistemic_state, confidence, current_version,
  valid_from, valid_to, recorded_at, superseded_at, lifecycle_state, decay_score, access_count,
  source_hash, created_at, updated_at
FROM entities;

DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;

CREATE INDEX idx_entities_category ON entities (category);
CREATE INDEX idx_entities_lifecycle_state ON entities (lifecycle_state);
CREATE INDEX idx_entities_vault_id ON entities (vault_id);

-- entity_history.entity_id REFERENCES entities (entity_id): SQLite resolves
-- this foreign key by table name at check time, so it re-attaches to the
-- rebuilt `entities` table automatically once the rename above completes;
-- entity_history itself is not recreated.

-- ---------------------------------------------------------------------
-- promotions: add vault_id, re-key UNIQUE(idempotency_key) -> UNIQUE(vault_id, idempotency_key)
-- ---------------------------------------------------------------------
CREATE TABLE promotions_new (
  promotion_ref TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults (vault_id),
  idempotency_key TEXT NOT NULL,
  source_memory_ref TEXT NOT NULL,
  target_scope TEXT NOT NULL,
  target_ref TEXT,
  policy_decision TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (vault_id, idempotency_key)
);

INSERT INTO promotions_new
  (promotion_ref, vault_id, idempotency_key, source_memory_ref, target_scope, target_ref,
   policy_decision, source_hash, recorded_at)
SELECT
  promotion_ref, NULL, idempotency_key, source_memory_ref, target_scope, target_ref,
  policy_decision, source_hash, recorded_at
FROM promotions;

DROP TABLE promotions;
ALTER TABLE promotions_new RENAME TO promotions;

CREATE INDEX idx_promotions_vault_id ON promotions (vault_id);

-- ---------------------------------------------------------------------
-- vaults.role: additive, nullable column. A plain ALTER TABLE ADD COLUMN is
-- safe here regardless of existing row count (no NOT NULL constraint), so
-- no rebuild is needed for this one. Nullable, no default: per
-- SDD-Persistent-Memory-MSP-Runtime.md §5 the vaults row already documents
-- `role` as a key column, but neither the SDD nor domain/vault-registry.mjs's
-- pre-WP-14 provisioning code establishes a universal non-null default for
-- every vault_type -- see domain/vault-registry.mjs's provisionGlobalPrivateVault
-- for the one provisioning path this packet gives a real (agent-scoped)
-- default to, per ADR-020's "memory is keyed by role / named-agent" framing.
ALTER TABLE vaults ADD COLUMN role TEXT;

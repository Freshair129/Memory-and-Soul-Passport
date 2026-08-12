-- 0002_phase2.sql
--
-- WP-13 Phase 2 storage: vault registry, append-only audit journal, a
-- minimal KV+TTL state store, and the persisted `contexts` row that
-- msp_context_diff/msp_context_audit/msp_context_replay act on instead of
-- fabricating a response on the fly. See WP-13's "What to build" section for
-- the exact column list this migration must match.
--
-- Still deferred to a later phase (unchanged from 0001_init.sql's note):
-- `embeddings` / `entities_fts` (retrieval is Phase 3), `links` (graph
-- edges, no Phase 2 consumer), decay/lifecycle columns beyond what
-- 0001_init.sql already added to `entities` (Phase 4).

-- Vault registry: scoping root for Shared / Workspace-Private / Global-
-- Private vaults (domain/vault-registry.mjs). Lazily provisioned, never
-- pre-seeded -- see WP-13 Bounded Scope item 1.
CREATE TABLE vaults (
  vault_id TEXT PRIMARY KEY,
  vault_type TEXT NOT NULL CHECK (vault_type IN ('shared', 'workspace_private', 'global_private')),
  project_id TEXT,
  workspace_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_vaults_project_id ON vaults (project_id);
CREATE INDEX idx_vaults_workspace_id ON vaults (workspace_id);
CREATE INDEX idx_vaults_agent_id ON vaults (agent_id);

-- Mount linkage between a caller's workspace and a vault_id, consumed by
-- msp_vault_mount / msp_vault_status.
CREATE TABLE vault_mounts (
  mount_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults (vault_id),
  workspace_id TEXT NOT NULL,
  mount_alias TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read', 'read_write')),
  status TEXT NOT NULL DEFAULT 'mounted',
  mounted_at TEXT NOT NULL
);

CREATE INDEX idx_vault_mounts_vault_workspace ON vault_mounts (vault_id, workspace_id);

-- Persisted context-resolve results: minimal columns so msp_context_diff,
-- msp_context_audit, and msp_context_replay have something real to act on
-- (WP-13 Bounded Scope item 5), not fabricated per-call.
CREATE TABLE contexts (
  context_id TEXT PRIMARY KEY,
  cache_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  policy_decision TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_contexts_workspace_id ON contexts (workspace_id);
CREATE INDEX idx_contexts_cache_id ON contexts (cache_id);

-- Append-only audit trail backing msp_context_audit. Immutability is
-- enforced at the database layer (BEFORE UPDATE / BEFORE DELETE triggers
-- RAISE(ABORT)), mirroring entity_history's "no UPDATE/DELETE path outside
-- migrations" convention from 0001_init.sql, but here enforced by triggers
-- rather than by application-code discipline alone -- SDD-Persistent-Memory-
-- MSP-Runtime.md's Security and Governance section requires this so even a
-- future application-layer bug cannot silently rewrite audit history.
CREATE TABLE journal (
  journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  ref TEXT,
  workspace_id TEXT,
  payload_json TEXT NOT NULL,
  policy_decision TEXT NOT NULL,
  reason TEXT
);

CREATE INDEX idx_journal_ref ON journal (ref);
CREATE INDEX idx_journal_workspace_id ON journal (workspace_id);

CREATE TRIGGER trg_journal_no_update
BEFORE UPDATE ON journal
BEGIN
  SELECT RAISE(ABORT, 'journal is append-only');
END;

CREATE TRIGGER trg_journal_no_delete
BEFORE DELETE ON journal
BEGIN
  SELECT RAISE(ABORT, 'journal is append-only');
END;

-- Minimal KV + TTL store. msp_context_injection_record writes a row here
-- keyed "injection:<id>".
CREATE TABLE state (
  state_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

-- Real, deduplicated msp_memory_promote(target_scope=global_private)
-- results. idempotency_key is UNIQUE so a retry with the same key is
-- answered from this table without a second entity-store write (AC-04).
CREATE TABLE promotions (
  promotion_ref TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_memory_ref TEXT NOT NULL,
  target_scope TEXT NOT NULL,
  target_ref TEXT,
  policy_decision TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

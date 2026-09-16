-- 0015_phase6_consolidation.sql (PH-MEMOS-6, BL-MEMOS-070..073)
--
-- Phase 6 provenance and vault-erasure storage. This migration is additive
-- after the 0013 nonce amendment and 0014 erasure-receipt pseudonymization.
-- It keeps every entity, history, and provenance identifier stable and
-- permits only the explicitly documented redaction transitions.

ALTER TABLE protected_memory_records
  ADD COLUMN confidence REAL NOT NULL DEFAULT 0
  CHECK (confidence >= 0 AND confidence <= 1);

-- SQLite triggers are immutable. The existing trigger must pin the new
-- confidence column on both its already-shipped update shapes, otherwise a
-- direct UPDATE could silently rewrite the source-confidence fact.
DROP TRIGGER trg_protected_memory_records_update_guard;
CREATE TRIGGER trg_protected_memory_records_update_guard
BEFORE UPDATE ON protected_memory_records
BEGIN
  SELECT CASE WHEN NOT (
    (
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'none'
      AND OLD.status = 'ACTIVE' AND NEW.status IN ('SUPERSEDED', 'REVOKED')
      AND NEW.version = OLD.version + 1
      AND NEW.record_id IS OLD.record_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.thread_id IS OLD.thread_id AND NEW.session_id IS OLD.session_id
      AND NEW.kind IS OLD.kind AND NEW.asserted_by_speaker_id IS OLD.asserted_by_speaker_id
      AND NEW.subject_person_id IS OLD.subject_person_id AND NEW.scope_json IS OLD.scope_json
      AND NEW.body_json IS OLD.body_json AND NEW.source_message_refs_json IS OLD.source_message_refs_json
      AND NEW.supersedes_record_id IS OLD.supersedes_record_id AND NEW.verification_state IS OLD.verification_state
      AND NEW.created_at IS OLD.created_at AND NEW.agent_id IS OLD.agent_id AND NEW.visibility IS OLD.visibility
      AND NEW.confidence IS OLD.confidence
    ) OR (
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned'
      AND NEW.body_json = '{}' AND NEW.scope_json = '{}'
      AND NEW.record_id IS OLD.record_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.thread_id IS OLD.thread_id AND NEW.session_id IS OLD.session_id
      AND NEW.kind IS OLD.kind AND NEW.status IS OLD.status AND NEW.asserted_by_speaker_id IS OLD.asserted_by_speaker_id
      AND NEW.subject_person_id IS OLD.subject_person_id
      AND NEW.source_message_refs_json IS OLD.source_message_refs_json AND NEW.supersedes_record_id IS OLD.supersedes_record_id
      AND NEW.verification_state IS OLD.verification_state AND NEW.version IS OLD.version AND NEW.created_at IS OLD.created_at
      AND NEW.agent_id IS OLD.agent_id AND NEW.visibility IS OLD.visibility AND NEW.confidence IS OLD.confidence
    )
  ) THEN RAISE(ABORT, 'protected_memory_records rows may only be superseded (ACTIVE -> SUPERSEDED/REVOKED) or tombstoned (body and scope blanked)')
  END;
END;

ALTER TABLE entity_history
  ADD COLUMN redaction_state TEXT NOT NULL DEFAULT 'none'
  CHECK (redaction_state IN ('none', 'tombstoned'));

-- entity_history remains append-only except for the one-way redaction
-- transition required by BL073. Every identity, temporal, actor, and source
-- column is pinned during that transition.
CREATE TRIGGER trg_entity_history_update_guard
BEFORE UPDATE ON entity_history
BEGIN
  SELECT CASE WHEN NOT (
    OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned'
    AND NEW.body_json = '{}' AND NEW.epistemic_state = 'deprecated' AND NEW.confidence = 0
    AND NEW.history_id IS OLD.history_id AND NEW.entity_id IS OLD.entity_id AND NEW.version IS OLD.version
    AND NEW.valid_from IS OLD.valid_from AND NEW.valid_to IS OLD.valid_to AND NEW.recorded_at IS OLD.recorded_at
    AND NEW.superseded_at IS OLD.superseded_at AND NEW.change_reason IS OLD.change_reason
    AND NEW.actor IS OLD.actor AND NEW.source_hash IS OLD.source_hash
  ) THEN RAISE(ABORT, 'entity_history rows are append-only except a none -> tombstoned redaction')
  END;
END;

CREATE TRIGGER trg_entity_history_no_delete
BEFORE DELETE ON entity_history
BEGIN
  SELECT RAISE(ABORT, 'entity_history rows may never be deleted');
END;

CREATE TABLE entity_provenance (
  provenance_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('msp_memory_consolidate', 'msp_memory_passport_promote')),
  source_record_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_message_refs_json TEXT NOT NULL,
  target_vault_id TEXT NOT NULL REFERENCES vaults (vault_id),
  target_entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  decision TEXT NOT NULL CHECK (decision IN ('consolidated', 'promoted')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  confirmed_session_count INTEGER NOT NULL CHECK (confirmed_session_count >= 0),
  policy_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_set_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  redaction_state TEXT NOT NULL DEFAULT 'none'
    CHECK (redaction_state IN ('none', 'tombstoned')),
  UNIQUE (tenant_id, operation, idempotency_key, source_record_id),
  UNIQUE (tenant_id, operation, source_record_id, target_entity_id)
);

CREATE INDEX idx_entity_provenance_target
  ON entity_provenance (tenant_id, target_vault_id, target_entity_id);
CREATE INDEX idx_entity_provenance_source
  ON entity_provenance (tenant_id, source_record_id, target_entity_id);

CREATE TRIGGER trg_entity_provenance_update_guard
BEFORE UPDATE ON entity_provenance
BEGIN
  SELECT CASE WHEN NOT (
    OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned'
    AND NEW.source_message_refs_json = '[]'
    AND NEW.provenance_id IS OLD.provenance_id AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.operation IS OLD.operation AND NEW.source_record_id IS OLD.source_record_id
    AND NEW.source_thread_id IS OLD.source_thread_id AND NEW.source_session_id IS OLD.source_session_id
    AND NEW.target_vault_id IS OLD.target_vault_id AND NEW.target_entity_id IS OLD.target_entity_id
    AND NEW.decision IS OLD.decision AND NEW.confidence IS OLD.confidence
    AND NEW.confirmed_session_count IS OLD.confirmed_session_count AND NEW.policy_version IS OLD.policy_version
    AND NEW.idempotency_key IS OLD.idempotency_key AND NEW.source_set_hash IS OLD.source_set_hash
    AND NEW.recorded_at IS OLD.recorded_at
  ) THEN RAISE(ABORT, 'entity_provenance rows are append-only except a none -> tombstoned redaction')
  END;
END;

CREATE TRIGGER trg_entity_provenance_no_delete
BEFORE DELETE ON entity_provenance
BEGIN
  SELECT RAISE(ABORT, 'entity_provenance rows may never be deleted');
END;

-- Forgotten entities must disappear from keyword retrieval immediately. The
-- explicit erasure DELETE in the domain transaction remains defense in
-- depth for old projections and for a repeated erasure call.
DROP TRIGGER trg_entities_fts_au;
CREATE TRIGGER trg_entities_fts_au
AFTER UPDATE ON entities
BEGIN
  DELETE FROM entities_fts WHERE entity_id = old.entity_id;
  INSERT INTO entities_fts (category, key, body_text, entity_id, vault_id)
  SELECT new.category, new.key, new.body_json, new.entity_id, new.vault_id
  WHERE new.lifecycle_state != 'forgotten';
END;

-- 0010_erasure_receipts.sql (API-011, PH-MEMOS-4, TASK-MEMOS-004) -- REQUIRES
-- 0009, not merely 0008 (design v0.5.4b Sec.12.3, RKOI PH-MEMOS-4 review
-- round 2, WARNING 7): the trigger body below references the agent_id/
-- visibility columns 0009 adds to protected_memory_records. SQLite resolves
-- trigger bodies lazily, so this migration would apply cleanly on top of
-- 0008 alone and only fail the first time the trigger actually fires --
-- stated explicitly here so the runner's ordering is never in doubt, the
-- same way 0009's own header states its own dependency on 0008.
--
-- DEC-MEMOS-07/14's merge-order rule (already used once by 0009's own
-- header): this file claims 0010 only because nothing else has merged
-- ahead of it as of this writing. If another migration merges first, this
-- file is renumbered to whatever number the runner actually assigns at
-- merge time.
--
-- Two pieces of new schema, both additive against main's already-shipped,
-- checksum-locked 0008/0009 -- neither edits either file in place:
--   1. An ADDITIVE TRIGGER REPLACEMENT (drop+recreate, no table rebuild, no
--      rootpage change, no foreign-keys=off directive needed -- the exact
--      same pattern 0009 already used twice on this same table's own guard
--      and on thread_pending_deliveries' guard) so
--      trg_protected_memory_records_update_guard's tombstone branch also
--      permits scope_json -> '{}' alongside body_json -> '{}'. Without
--      this, msp_thread_principal_erase's own scope_json blanking write is
--      refused, since protected_memory_records can carry personal content
--      in scope_json, not only body_json (design Sec.11.1).
--   2. A NEW TABLE, erasure_receipts, backing msp_thread_principal_erase's
--      idempotency-key replay behavior (design Sec.11.2, DEC-MEMOS-27/28).

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
      AND NEW.created_at IS OLD.created_at
      AND NEW.agent_id IS OLD.agent_id AND NEW.visibility IS OLD.visibility
    ) OR (
      -- The ONLY change from 0009's version: this branch now also permits
      -- NEW.scope_json = '{}' alongside NEW.body_json = '{}', instead of
      -- pinning scope_json unchanged (design Sec.11.2, CRITICAL 4 item 1).
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.body_json = '{}' AND NEW.scope_json = '{}'
      AND NEW.record_id IS OLD.record_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.thread_id IS OLD.thread_id AND NEW.session_id IS OLD.session_id
      AND NEW.kind IS OLD.kind AND NEW.status IS OLD.status AND NEW.asserted_by_speaker_id IS OLD.asserted_by_speaker_id
      AND NEW.subject_person_id IS OLD.subject_person_id
      AND NEW.source_message_refs_json IS OLD.source_message_refs_json AND NEW.supersedes_record_id IS OLD.supersedes_record_id
      AND NEW.verification_state IS OLD.verification_state AND NEW.version IS OLD.version AND NEW.created_at IS OLD.created_at
      AND NEW.agent_id IS OLD.agent_id AND NEW.visibility IS OLD.visibility
    )
  ) THEN RAISE(ABORT, 'protected_memory_records rows may only be superseded (ACTIVE -> SUPERSEDED/REVOKED) or tombstoned (body and scope blanked)')
  END;
END;

-- NEW TABLE. Idempotency and audit record for msp_thread_principal_erase
-- (design Sec.11.2). Stores the RAW principal_id, like every other content
-- table's speaker/person columns -- W5 pseudonymization is scoped to the
-- JOURNAL entry for the erasure event (design Sec.11.2), not to this table
-- (DEC-MEMOS-28).
CREATE TABLE erasure_receipts (
  erasure_receipt_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  requested_by_agent_id TEXT NOT NULL,
  tables_affected_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_erasure_receipts_principal ON erasure_receipts (tenant_id, principal_id);

-- Pure audit record: never updated, matching thread_summary_invalidations'
-- own two-trigger immutability shape (design Sec.12.1) exactly.
CREATE TRIGGER trg_erasure_receipts_no_update
BEFORE UPDATE ON erasure_receipts
BEGIN
  SELECT RAISE(ABORT, 'erasure_receipts rows are immutable');
END;

CREATE TRIGGER trg_erasure_receipts_no_delete
BEFORE DELETE ON erasure_receipts
BEGIN
  SELECT RAISE(ABORT, 'erasure_receipts rows may never be deleted');
END;

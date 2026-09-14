-- 0009_thread_agents.sql (API-011, TASK-MEMOS-002 stage 2, PH-MEMOS-3)
--
-- Multi-agent attachment, replay-nonce bookkeeping, and per-agent
-- visibility for protected memory records -- taken verbatim from
-- docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md v0.4.3b Sec.12.2 (RKOI
-- stage-2 review rounds 1 and 2, both fully folded in). DEC-MEMOS-14
-- (confirmed by the owner 2026-09-14) already settled that this
-- migration's number is assigned in merge order, not pre-bound -- this
-- file claims 0009 since nothing else has merged into main ahead of it.
--
-- Every statement below is either a brand-new CREATE TABLE or an
-- additive ALTER TABLE / DROP TRIGGER+CREATE TRIGGER pair against the
-- already-shipped, checksum-locked 0008 -- nothing here rebuilds an
-- existing table, so 0008's own header comment about the runner's
-- foreign-keys=off directive not applying (see docs/MIGRATION.md) holds
-- for this migration too, unchanged.

-- NEW TABLE. Structural analogue of thread_participants (0008) for
-- agents instead of HUMAN speakers: append-only, one open row per
-- (thread_id, agent_id, workspace_id), no DELETE. Design Sec.8.1.
CREATE TABLE thread_agents (
  agent_attachment_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT
);

CREATE UNIQUE INDEX idx_thread_agents_open ON thread_agents (thread_id, agent_id, workspace_id) WHERE left_at IS NULL;
CREATE INDEX idx_thread_agents_thread ON thread_agents (thread_id, left_at);

-- Design Sec.8.1 rule 3: same tenant-consistency shape every other
-- thread-scoped table in 0008 already has.
CREATE TRIGGER trg_thread_agents_tenant_consistency
BEFORE INSERT ON thread_agents
BEGIN
  SELECT RAISE(ABORT, 'thread_agents.tenant_id must match its thread''s tenant_id')
  WHERE NEW.tenant_id IS NOT (SELECT tenant_id FROM threads WHERE thread_id = NEW.thread_id);
END;

-- Design Sec.8.1 rule 2: append-only, exactly like trg_thread_participants_append_only.
CREATE TRIGGER trg_thread_agents_append_only
BEFORE UPDATE ON thread_agents
BEGIN
  SELECT CASE WHEN NOT (
    OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
    AND NEW.agent_attachment_id IS OLD.agent_attachment_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.thread_id IS OLD.thread_id
    AND NEW.agent_id IS OLD.agent_id
    AND NEW.workspace_id IS OLD.workspace_id
    AND NEW.joined_at IS OLD.joined_at
  ) THEN RAISE(ABORT, 'thread_agents rows are append-only: only left_at NULL -> NOT NULL is permitted')
  END;
END;

CREATE TRIGGER trg_thread_agents_no_delete
BEFORE DELETE ON thread_agents
BEGIN
  SELECT RAISE(ABORT, 'thread_agents rows may never be deleted');
END;

-- NEW TABLE. Anti-replay bookkeeping for the nonce claim (design Sec.6.1.1).
-- Keyed (tenant_id, nonce) rather than a surrogate PRIMARY KEY, so the
-- INSERT itself is the uniqueness check -- a PRIMARY KEY conflict IS the
-- replay signal the handler catches and re-raises as grant_replayed.
CREATE TABLE grant_nonces (
  tenant_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, nonce)
);

-- Supports both the replay check's own lookup shape and the pruning
-- statement below.
CREATE INDEX idx_grant_nonces_expiry ON grant_nonces (expires_at);

-- ALTER, additive, no rebuild (design Sec.9.4). visibility's own DEFAULT
-- satisfies its own CHECK, and neither column is a PRIMARY KEY or UNIQUE
-- constraint -- both are within SQLite's ALTER TABLE ADD COLUMN rules.
ALTER TABLE protected_memory_records ADD COLUMN agent_id TEXT;
ALTER TABLE protected_memory_records ADD COLUMN visibility TEXT NOT NULL DEFAULT 'THREAD' CHECK (visibility IN ('AGENT', 'THREAD'));

-- REQUIRED: 0008's trg_protected_memory_records_update_guard cannot be
-- ALTERed in place (SQLite triggers are immutable once created) -- it
-- must be dropped and recreated so both of its permitted UPDATE shapes
-- (supersession, tombstone) also pin the two new columns, exactly as
-- every column that trigger already protects. This is NOT the only
-- drop+recreate in this migration -- trg_thread_pending_deliveries_update_guard
-- below needs the identical treatment, for the identical reason, once
-- thread_pending_deliveries also gains two columns whose pinned-column
-- list this trigger governs.
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
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.body_json = '{}'
      AND NEW.record_id IS OLD.record_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.thread_id IS OLD.thread_id AND NEW.session_id IS OLD.session_id
      AND NEW.kind IS OLD.kind AND NEW.status IS OLD.status AND NEW.asserted_by_speaker_id IS OLD.asserted_by_speaker_id
      AND NEW.subject_person_id IS OLD.subject_person_id AND NEW.scope_json IS OLD.scope_json
      AND NEW.source_message_refs_json IS OLD.source_message_refs_json AND NEW.supersedes_record_id IS OLD.supersedes_record_id
      AND NEW.verification_state IS OLD.verification_state AND NEW.version IS OLD.version AND NEW.created_at IS OLD.created_at
      AND NEW.agent_id IS OLD.agent_id AND NEW.visibility IS OLD.visibility
    )
  ) THEN RAISE(ABORT, 'protected_memory_records rows may only be superseded (ACTIVE -> SUPERSEDED/REVOKED) or tombstoned (body blanked)')
  END;
END;

-- NEW, defense in depth (design Sec.9.4, RKOI stage-2 review round 1, item
-- 9). A cross-column rule like the first check below cannot be a table-
-- level CHECK added via ALTER TABLE -- SQLite has no ADD CONSTRAINT form
-- at all -- so both rules are a single new BEFORE INSERT trigger instead.
CREATE TRIGGER trg_protected_memory_records_agent_rules
BEFORE INSERT ON protected_memory_records
BEGIN
  SELECT RAISE(ABORT, 'protected_memory_records: visibility=AGENT requires a non-NULL agent_id')
  WHERE NEW.visibility = 'AGENT' AND NEW.agent_id IS NULL;

  SELECT RAISE(ABORT, 'protected_memory_records.agent_id must have attached to thread_id at some point')
  WHERE NEW.agent_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM thread_agents WHERE thread_id = NEW.thread_id AND agent_id = NEW.agent_id);
END;

-- ALTER, additive, no rebuild (design Sec.8.2's delivery pending-path fix,
-- CRITICAL 1). Both columns are nullable at the schema level -- a
-- pre-stage-2 pending row, if one is still in flight at cutover, has
-- neither -- but required by the stage-2 handler on every new insert.
ALTER TABLE thread_pending_deliveries ADD COLUMN agent_id TEXT;
ALTER TABLE thread_pending_deliveries ADD COLUMN workspace_id TEXT;

-- REQUIRED, NEW (RKOI stage-2 review round 2, finding 2): without this,
-- a reconcile UPDATE (or any other write reaching this trigger) could
-- silently rewrite the stored agent_id/workspace_id between the moment
-- a pending delivery is queued and the moment it drains, defeating the
-- drain-time agent re-check (design Sec.8.2) by rewriting the very value
-- that check reads. Same drop+recreate shape as
-- trg_protected_memory_records_update_guard above, same reason: SQLite
-- triggers cannot be ALTERed in place, and both of this trigger's
-- existing permitted UPDATE shapes (reconcile, tombstone) must now also
-- pin the two new columns.
DROP TRIGGER trg_thread_pending_deliveries_update_guard;
CREATE TRIGGER trg_thread_pending_deliveries_update_guard
BEFORE UPDATE ON thread_pending_deliveries
BEGIN
  SELECT CASE WHEN NOT (
    (
      OLD.reconcile_state = 'pending' AND NEW.reconcile_state = 'reconciled' AND NEW.redaction_state IS OLD.redaction_state
      AND NEW.receipt_id IS OLD.receipt_id AND NEW.inbound_message_id IS OLD.inbound_message_id AND NEW.source_event_id IS OLD.source_event_id
      AND NEW.tenant_id IS OLD.tenant_id AND NEW.business_id IS OLD.business_id AND NEW.channel_account_id IS OLD.channel_account_id
      AND NEW.external_room_ref_hmac IS OLD.external_room_ref_hmac AND NEW.outcome IS OLD.outcome AND NEW.text IS OLD.text
      AND NEW.provider_ref IS OLD.provider_ref AND NEW.recorded_at IS OLD.recorded_at
      AND NEW.agent_id IS OLD.agent_id AND NEW.workspace_id IS OLD.workspace_id
    ) OR (
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.text = '' AND NEW.reconcile_state IS OLD.reconcile_state
      AND NEW.receipt_id IS OLD.receipt_id AND NEW.inbound_message_id IS OLD.inbound_message_id AND NEW.source_event_id IS OLD.source_event_id
      AND NEW.tenant_id IS OLD.tenant_id AND NEW.business_id IS OLD.business_id AND NEW.channel_account_id IS OLD.channel_account_id
      AND NEW.external_room_ref_hmac IS OLD.external_room_ref_hmac AND NEW.outcome IS OLD.outcome
      AND NEW.provider_ref IS OLD.provider_ref AND NEW.recorded_at IS OLD.recorded_at
      AND NEW.agent_id IS OLD.agent_id AND NEW.workspace_id IS OLD.workspace_id
    )
  ) THEN RAISE(ABORT, 'thread_pending_deliveries rows permit only a pending -> reconciled transition or a tombstone redaction')
  END;
END;

-- 0008_thread_memory.sql (API-011, TASK-MEMOS-002 stage 1)
--
-- Unified thread, speaker, session and compacted-memory state. Folds the
-- unmerged origin/codex/msp-thread-memory branch's 0008+0009 design into a
-- single migration -- nothing past 0007 has ever shipped, so no corrective
-- migration is needed. Every statement below is a brand-new CREATE TABLE;
-- nothing here rebuilds an existing table, so the foreign-keys-off directive
-- documented in packages/msp-storage/src/db/migrate.mjs and docs/MIGRATION.md
-- does not apply to this file. This migration is checksum-locked once
-- merged (packages/msp-storage/src/db/migrate.mjs's drift guard) -- every
-- correction RKOI's review requested is folded in here rather than shipped
-- as a follow-up migration.
--
-- Zuri owns channel identity and authorization; MSP owns the durable thread
-- lifecycle, speaker references, bounded recent exchanges and the
-- provenance of compacted session memory. Raw channel identifiers are never
-- stored: every external room reference is HMAC-SHA256'd under an injected
-- identity key before it reaches a column, and every journal actor is the
-- HMAC of the raw speaker id, never the id itself. A method that needs to
-- hash a value with no key configured throws IdentityHmacUnconfiguredError
-- and writes nothing.
--
-- Every uniqueness key that identifies a caller-owned resource is
-- tenant-scoped, and every denormalized tenant_id column carried on a child
-- row is pinned to its parent thread's own tenant_id by a BEFORE INSERT
-- trigger -- a duplicate source_event_id, or a child row naming a foreign
-- tenant, must never collide with, or leak the existence of, another
-- tenant's row.
--
-- thread_messages, session_summaries, protected_memory_records,
-- thread_delivery_receipts and thread_pending_deliveries are durable
-- provenance/evidence: never deleted, and rewritten only through a one-way
-- `redaction_state` ('none' -> 'tombstoned') transition that blanks their
-- content column and pins everything else. Erasure itself is a later,
-- separately reviewed packet -- this migration only makes room for it.

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  thread_kind TEXT NOT NULL CHECK (thread_kind IN ('DIRECT', 'GROUP', 'ROOM')),
  channel_type TEXT NOT NULL,
  channel_account_id TEXT NOT NULL,
  external_room_ref_hmac TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Only ONE ACTIVE thread may exist per channel binding at a time -- not a
-- blanket unique. A DIRECT thread's person can be relinked: the old thread
-- is CLOSED (a later lifecycle packet; this migration only makes the schema
-- allow it) and the SAME binding mints a brand new thread_id for the new
-- principal, who never inherits the old thread's history.
CREATE UNIQUE INDEX idx_threads_active_binding ON threads (tenant_id, channel_account_id, external_room_ref_hmac) WHERE status = 'ACTIVE';
CREATE INDEX idx_threads_tenant_business ON threads (tenant_id, business_id);
CREATE INDEX idx_threads_status ON threads (status);

-- A thread's identity is immutable once minted: only `status`, `business_id`
-- and `updated_at` may ever change.
CREATE TRIGGER trg_threads_pin_identity
BEFORE UPDATE ON threads
BEGIN
  SELECT CASE WHEN NOT (
    NEW.thread_id IS OLD.thread_id AND NEW.thread_kind IS OLD.thread_kind AND NEW.channel_type IS OLD.channel_type
    AND NEW.tenant_id IS OLD.tenant_id AND NEW.channel_account_id IS OLD.channel_account_id
    AND NEW.external_room_ref_hmac IS OLD.external_room_ref_hmac AND NEW.created_at IS OLD.created_at
  ) THEN RAISE(ABORT, 'threads.thread_kind/channel_type/tenant_id/channel_account_id/external_room_ref_hmac/created_at are immutable')
  END;
END;

-- Append-only membership rows. A row's identity, thread, speaker and join
-- time never change once written; the only permitted UPDATE closes it
-- (left_at NULL -> NOT NULL). Re-establishing membership after leaving, or
-- upgrading identity_assurance/person_id, requires a NEW row.
CREATE TABLE thread_participants (
  membership_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  speaker_id TEXT NOT NULL,
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('HUMAN', 'AGENT', 'OPERATOR', 'UNKNOWN')),
  person_id TEXT,
  identity_assurance TEXT NOT NULL CHECK (identity_assurance IN ('VERIFIED', 'PENDING', 'UNRESOLVED')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  source_ref TEXT
);

-- At most one OPEN membership row per (thread_id, speaker_id) at a time.
CREATE UNIQUE INDEX idx_thread_participants_open ON thread_participants (thread_id, speaker_id) WHERE left_at IS NULL;
CREATE INDEX idx_thread_participants_person ON thread_participants (tenant_id, person_id);
CREATE INDEX idx_thread_participants_thread ON thread_participants (thread_id, speaker_kind);

CREATE TRIGGER trg_thread_participants_append_only
BEFORE UPDATE ON thread_participants
BEGIN
  SELECT CASE WHEN NOT (
    OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
    AND NEW.membership_id IS OLD.membership_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.thread_id IS OLD.thread_id
    AND NEW.speaker_id IS OLD.speaker_id
    AND NEW.speaker_kind IS OLD.speaker_kind
    AND NEW.person_id IS OLD.person_id
    AND NEW.identity_assurance IS OLD.identity_assurance
    AND NEW.joined_at IS OLD.joined_at
    AND NEW.source_ref IS OLD.source_ref
  ) THEN RAISE(ABORT, 'thread_participants rows are append-only: only left_at NULL -> NOT NULL is permitted')
  END;
END;

CREATE TRIGGER trg_thread_participants_no_delete
BEFORE DELETE ON thread_participants
BEGIN
  SELECT RAISE(ABORT, 'thread_participants rows may never be deleted');
END;

-- A DIRECT thread may only ever have ONE human participant, for its whole
-- lifetime -- a second, distinct HUMAN speaker_id is refused even after the
-- first participant has left (left_at set), and even after a relink closes
-- the thread (a relink mints a NEW thread_id, so this trigger never has to
-- reason about it). This is the last line of defense against a second
-- person ever reading (or becoming eligible to read) a DIRECT thread's
-- private transcript.
CREATE TRIGGER trg_thread_participants_direct_single_human
BEFORE INSERT ON thread_participants
WHEN NEW.speaker_kind = 'HUMAN'
  AND EXISTS (SELECT 1 FROM threads t WHERE t.thread_id = NEW.thread_id AND t.thread_kind = 'DIRECT')
  AND EXISTS (
    SELECT 1 FROM thread_participants p
    WHERE p.thread_id = NEW.thread_id AND p.speaker_kind = 'HUMAN' AND p.speaker_id <> NEW.speaker_id
  )
BEGIN
  SELECT RAISE(ABORT, 'a DIRECT thread may only ever have one HUMAN participant for its lifetime');
END;

CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSING', 'CLOSED')),
  opened_at TEXT NOT NULL,
  last_human_at TEXT,
  idle_deadline TEXT NOT NULL,
  closed_at TEXT,
  latest_sequence INTEGER NOT NULL DEFAULT 0,
  summary_watermark INTEGER NOT NULL DEFAULT 0,
  policy_revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_chat_sessions_thread_status ON chat_sessions (thread_id, status);
CREATE INDEX idx_chat_sessions_idle ON chat_sessions (status, idle_deadline);

CREATE TRIGGER trg_chat_sessions_tenant_consistency
BEFORE INSERT ON chat_sessions
BEGIN
  SELECT RAISE(ABORT, 'chat_sessions.tenant_id must match its thread''s tenant_id')
  WHERE NEW.tenant_id <> (SELECT tenant_id FROM threads WHERE thread_id = NEW.thread_id);
END;

CREATE TABLE thread_messages (
  message_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  session_id TEXT NOT NULL REFERENCES chat_sessions (session_id),
  exchange_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  speaker_id TEXT NOT NULL,
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('HUMAN', 'AGENT', 'OPERATOR', 'UNKNOWN')),
  person_id TEXT,
  identity_assurance TEXT NOT NULL CHECK (identity_assurance IN ('VERIFIED', 'PENDING', 'UNRESOLVED')),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  text TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (delivery_state IN ('RECEIVED', 'QUEUED', 'ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none', 'tombstoned')),
  UNIQUE (thread_id, sequence),
  UNIQUE (thread_id, source_event_id)
);

CREATE INDEX idx_thread_messages_exchange ON thread_messages (thread_id, exchange_id, sequence);
CREATE INDEX idx_thread_messages_session ON thread_messages (session_id, sequence);

CREATE TRIGGER trg_thread_messages_tenant_consistency
BEFORE INSERT ON thread_messages
BEGIN
  SELECT RAISE(ABORT, 'thread_messages.tenant_id must match its thread''s tenant_id')
  WHERE NEW.tenant_id <> (SELECT tenant_id FROM threads WHERE thread_id = NEW.thread_id);
END;

CREATE TRIGGER trg_thread_messages_tombstone_only
BEFORE UPDATE ON thread_messages
BEGIN
  SELECT CASE WHEN NOT (
    OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.text = ''
    AND NEW.message_id IS OLD.message_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.thread_id IS OLD.thread_id AND NEW.session_id IS OLD.session_id
    AND NEW.exchange_id IS OLD.exchange_id AND NEW.sequence IS OLD.sequence AND NEW.speaker_id IS OLD.speaker_id
    AND NEW.speaker_kind IS OLD.speaker_kind AND NEW.person_id IS OLD.person_id AND NEW.identity_assurance IS OLD.identity_assurance
    AND NEW.direction IS OLD.direction AND NEW.occurred_at IS OLD.occurred_at AND NEW.received_at IS OLD.received_at
    AND NEW.source_event_id IS OLD.source_event_id AND NEW.reply_to_message_id IS OLD.reply_to_message_id
    AND NEW.delivery_state IS OLD.delivery_state
  ) THEN RAISE(ABORT, 'thread_messages rows are immutable except a none -> tombstoned redaction, which blanks text and nothing else')
  END;
END;

CREATE TRIGGER trg_thread_messages_no_delete
BEFORE DELETE ON thread_messages
BEGIN
  SELECT RAISE(ABORT, 'thread_messages rows may never be deleted');
END;

CREATE TABLE protected_memory_records (
  record_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  session_id TEXT REFERENCES chat_sessions (session_id),
  kind TEXT NOT NULL CHECK (kind IN ('CONSTRAINT', 'INSTRUCTION', 'CORRECTION', 'PREFERENCE')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'SUPERSEDED')),
  asserted_by_speaker_id TEXT NOT NULL,
  subject_person_id TEXT,
  scope_json TEXT NOT NULL,
  body_json TEXT NOT NULL,
  source_message_refs_json TEXT NOT NULL,
  supersedes_record_id TEXT REFERENCES protected_memory_records (record_id),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('CANDIDATE', 'CONFIRMED', 'CONTESTED')),
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none', 'tombstoned')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_protected_memory_thread_status ON protected_memory_records (thread_id, status, kind);
CREATE INDEX idx_protected_memory_subject ON protected_memory_records (subject_person_id, status);

CREATE TRIGGER trg_protected_memory_records_tenant_consistency
BEFORE INSERT ON protected_memory_records
BEGIN
  SELECT RAISE(ABORT, 'protected_memory_records.tenant_id must match its thread''s tenant_id')
  WHERE NEW.tenant_id <> (SELECT tenant_id FROM threads WHERE thread_id = NEW.thread_id);
END;

-- SQLite forbids a subquery inside a CHECK constraint, so every one of
-- these cross-row rules is a BEFORE INSERT trigger instead:
--   - subject_person_id is NULL or equal to asserted_by_speaker_id
--     (record_subject_mismatch otherwise);
--   - a HUMAN-asserted record's subject may never be NULL -- it must always
--     equal the asserter (record_subject_mismatch otherwise). Null-subject
--     records stay reachable for a non-HUMAN asserter (e.g. a future
--     system-generated observation) and remain visible only to their own
--     asserter at read time (msp-core's ThreadMemoryStore#context), never
--     to "every participant".
--   - asserted_by_speaker_id must actually be a participant of thread_id,
--     in the same tenant.
CREATE TRIGGER trg_protected_memory_records_subject_rules
BEFORE INSERT ON protected_memory_records
BEGIN
  SELECT RAISE(ABORT, 'record_subject_mismatch: subject_person_id must be absent or equal to asserted_by_speaker_id')
  WHERE NEW.subject_person_id IS NOT NULL AND NEW.subject_person_id <> NEW.asserted_by_speaker_id;

  SELECT RAISE(ABORT, 'record_subject_mismatch: a HUMAN-asserted record requires subject_person_id equal to asserted_by_speaker_id')
  WHERE NEW.subject_person_id IS NULL AND EXISTS (
    SELECT 1 FROM thread_participants p WHERE p.thread_id = NEW.thread_id AND p.speaker_id = NEW.asserted_by_speaker_id AND p.speaker_kind = 'HUMAN'
  );

  SELECT RAISE(ABORT, 'protected_memory_records: asserted_by_speaker_id must be a participant of thread_id in the same tenant')
  WHERE NOT EXISTS (
    SELECT 1 FROM thread_participants p WHERE p.thread_id = NEW.thread_id AND p.speaker_id = NEW.asserted_by_speaker_id AND p.tenant_id = NEW.tenant_id
  );
END;

-- Two, and only two, UPDATE shapes are permitted: (a) the existing
-- supersession lifecycle transition (ACTIVE -> SUPERSEDED/REVOKED, version
-- incremented, nothing else touched), and (b) a one-way tombstone
-- (redaction_state none -> tombstoned, body_json blanked to '{}', nothing
-- else touched, including status/version).
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
    ) OR (
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.body_json = '{}'
      AND NEW.record_id IS OLD.record_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.thread_id IS OLD.thread_id AND NEW.session_id IS OLD.session_id
      AND NEW.kind IS OLD.kind AND NEW.status IS OLD.status AND NEW.asserted_by_speaker_id IS OLD.asserted_by_speaker_id
      AND NEW.subject_person_id IS OLD.subject_person_id AND NEW.scope_json IS OLD.scope_json
      AND NEW.source_message_refs_json IS OLD.source_message_refs_json AND NEW.supersedes_record_id IS OLD.supersedes_record_id
      AND NEW.verification_state IS OLD.verification_state AND NEW.version IS OLD.version AND NEW.created_at IS OLD.created_at
    )
  ) THEN RAISE(ABORT, 'protected_memory_records rows may only be superseded (ACTIVE -> SUPERSEDED/REVOKED) or tombstoned (body blanked)')
  END;
END;

CREATE TRIGGER trg_protected_memory_records_no_delete
BEFORE DELETE ON protected_memory_records
BEGIN
  SELECT RAISE(ABORT, 'protected_memory_records rows may never be deleted');
END;

-- Operational (not transcript-evidence) compaction lease bookkeeping.
CREATE TABLE session_compaction_jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES chat_sessions (session_id),
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMMITTED', 'RETRYABLE', 'FAILED')),
  source_start_sequence INTEGER NOT NULL,
  source_end_sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  leased_until TEXT,
  lease_token TEXT,
  worker_id TEXT,
  invocation_state TEXT,
  summary_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_compaction_jobs_status ON session_compaction_jobs (status, updated_at);

CREATE TRIGGER trg_session_compaction_jobs_tenant_consistency
BEFORE INSERT ON session_compaction_jobs
BEGIN
  SELECT RAISE(ABORT, 'session_compaction_jobs.tenant_id must match its thread''s tenant_id')
  WHERE NEW.tenant_id <> (SELECT tenant_id FROM threads WHERE thread_id = NEW.thread_id);
END;

CREATE TABLE session_summaries (
  summary_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES chat_sessions (session_id),
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  summary_version INTEGER NOT NULL,
  covered_from_sequence INTEGER NOT NULL,
  covered_through_sequence INTEGER NOT NULL,
  covered_sequences_json TEXT,
  source_digest TEXT NOT NULL,
  previous_summary_id TEXT REFERENCES session_summaries (summary_id),
  summary_json TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  summarizer_version TEXT NOT NULL,
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none', 'tombstoned')),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, summary_version)
);

CREATE INDEX idx_session_summaries_thread ON session_summaries (thread_id, covered_through_sequence);

CREATE TRIGGER trg_session_summaries_tenant_consistency
BEFORE INSERT ON session_summaries
BEGIN
  SELECT RAISE(ABORT, 'session_summaries.tenant_id must match its thread''s tenant_id')
  WHERE NEW.tenant_id <> (SELECT tenant_id FROM threads WHERE thread_id = NEW.thread_id);
END;

CREATE TRIGGER trg_session_summaries_tombstone_only
BEFORE UPDATE ON session_summaries
BEGIN
  SELECT CASE WHEN NOT (
    OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.summary_json = '{}'
    AND NEW.summary_id IS OLD.summary_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.session_id IS OLD.session_id AND NEW.thread_id IS OLD.thread_id
    AND NEW.summary_version IS OLD.summary_version AND NEW.covered_from_sequence IS OLD.covered_from_sequence
    AND NEW.covered_through_sequence IS OLD.covered_through_sequence AND NEW.covered_sequences_json IS OLD.covered_sequences_json
    AND NEW.source_digest IS OLD.source_digest AND NEW.previous_summary_id IS OLD.previous_summary_id
    AND NEW.policy_revision IS OLD.policy_revision AND NEW.summarizer_version IS OLD.summarizer_version
    AND NEW.created_at IS OLD.created_at
  ) THEN RAISE(ABORT, 'session_summaries rows are immutable except a none -> tombstoned redaction, which blanks summary_json and nothing else')
  END;
END;

CREATE TRIGGER trg_session_summaries_no_delete
BEFORE DELETE ON session_summaries
BEGIN
  SELECT RAISE(ABORT, 'session_summaries rows may never be deleted');
END;

CREATE TABLE thread_delivery_receipts (
  receipt_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES thread_messages (message_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  text TEXT NOT NULL,
  provider_ref TEXT,
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none', 'tombstoned')),
  recorded_at TEXT NOT NULL,
  UNIQUE (message_id, receipt_id)
);

CREATE INDEX idx_thread_delivery_message ON thread_delivery_receipts (message_id, recorded_at);

CREATE TRIGGER trg_thread_delivery_receipts_tenant_consistency
BEFORE INSERT ON thread_delivery_receipts
BEGIN
  SELECT RAISE(ABORT, 'thread_delivery_receipts.tenant_id must match its message''s thread tenant_id')
  WHERE NEW.tenant_id <> (SELECT t.tenant_id FROM thread_messages m JOIN threads t ON t.thread_id = m.thread_id WHERE m.message_id = NEW.message_id);
END;

CREATE TRIGGER trg_thread_delivery_receipts_tombstone_only
BEFORE UPDATE ON thread_delivery_receipts
BEGIN
  SELECT CASE WHEN NOT (
    OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.text = ''
    AND NEW.receipt_id IS OLD.receipt_id AND NEW.tenant_id IS OLD.tenant_id AND NEW.message_id IS OLD.message_id AND NEW.outcome IS OLD.outcome
    AND NEW.provider_ref IS OLD.provider_ref AND NEW.recorded_at IS OLD.recorded_at
  ) THEN RAISE(ABORT, 'thread_delivery_receipts rows are immutable except a none -> tombstoned redaction, which blanks text and nothing else')
  END;
END;

CREATE TRIGGER trg_thread_delivery_receipts_no_delete
BEFORE DELETE ON thread_delivery_receipts
BEGIN
  SELECT RAISE(ABORT, 'thread_delivery_receipts rows may never be deleted');
END;

-- Model-invocation receipts. No user-facing text is stored here (packet_hash
-- is an opaque digest, model_ref is a provider/model identifier), so no
-- redaction/tombstone trigger applies; the existing state-machine UPDATE
-- (RESOLVED -> SUBMITTED -> COMPLETED/FAILED/UNKNOWN) is unrestricted.
CREATE TABLE thread_injection_receipts (
  injection_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  exchange_id TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RESOLVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- A delivery receipt that names an inbound message/thread MSP has not seen
-- yet (delivery can race the inbound webhook). Deliberately NOT a foreign
-- key to threads/thread_messages -- that is the whole point of "pending".
-- Transient staging, not transcript evidence, but its text still gets the
-- same tombstone-only UPDATE protection while it is buffered here, and it
-- is never deleted: once its scoped inbound message arrives it is marked
-- `reconcile_state = 'reconciled'` instead (see
-- ThreadMemoryStore#drainDeliveries) -- an operational trail survives even
-- though the receipt itself has been folded into thread_delivery_receipts.
CREATE TABLE thread_pending_deliveries (
  receipt_id TEXT PRIMARY KEY,
  inbound_message_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT,
  channel_account_id TEXT NOT NULL,
  external_room_ref_hmac TEXT NOT NULL,
  outcome TEXT NOT NULL,
  text TEXT NOT NULL,
  provider_ref TEXT,
  reconcile_state TEXT NOT NULL DEFAULT 'pending' CHECK (reconcile_state IN ('pending', 'reconciled')),
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none', 'tombstoned')),
  recorded_at TEXT NOT NULL
);

CREATE TRIGGER trg_thread_pending_deliveries_no_delete
BEFORE DELETE ON thread_pending_deliveries
BEGIN
  SELECT RAISE(ABORT, 'thread_pending_deliveries rows may never be deleted');
END;

-- Two, and only two, UPDATE shapes are permitted: (a) reconcile
-- (pending -> reconciled, nothing else touched), and (b) a one-way
-- tombstone (redaction_state none -> tombstoned, text blanked, nothing else
-- touched, including reconcile_state).
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
    ) OR (
      OLD.redaction_state = 'none' AND NEW.redaction_state = 'tombstoned' AND NEW.text = '' AND NEW.reconcile_state IS OLD.reconcile_state
      AND NEW.receipt_id IS OLD.receipt_id AND NEW.inbound_message_id IS OLD.inbound_message_id AND NEW.source_event_id IS OLD.source_event_id
      AND NEW.tenant_id IS OLD.tenant_id AND NEW.business_id IS OLD.business_id AND NEW.channel_account_id IS OLD.channel_account_id
      AND NEW.external_room_ref_hmac IS OLD.external_room_ref_hmac AND NEW.outcome IS OLD.outcome
      AND NEW.provider_ref IS OLD.provider_ref AND NEW.recorded_at IS OLD.recorded_at
    )
  ) THEN RAISE(ABORT, 'thread_pending_deliveries rows permit only a pending -> reconciled transition or a tombstone redaction')
  END;
END;

CREATE TABLE thread_summary_invalidations (
  summary_id TEXT PRIMARY KEY REFERENCES session_summaries (summary_id),
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

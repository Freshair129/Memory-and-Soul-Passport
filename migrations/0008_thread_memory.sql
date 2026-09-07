-- 0008_thread_memory.sql
--
-- Unified thread, speaker, session and compacted-memory state.  This is the
-- first MSP-owned persistence slice for the LINE -> thread -> memory flow.
-- Raw channel identifiers remain opaque references; identity and permission
-- authority stays in Zuri.

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  thread_kind TEXT NOT NULL CHECK (thread_kind IN ('DIRECT', 'GROUP', 'ROOM')),
  channel_type TEXT NOT NULL,
  channel_account_id TEXT NOT NULL,
  external_room_ref TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT,
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('DIRECT', 'GROUP', 'ROOM')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_account_id, external_room_ref)
);

CREATE INDEX idx_threads_tenant_business ON threads (tenant_id, business_id);
CREATE INDEX idx_threads_status ON threads (status);

CREATE TABLE thread_participants (
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  speaker_id TEXT NOT NULL,
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('HUMAN', 'AGENT', 'OPERATOR', 'UNKNOWN')),
  person_id TEXT,
  identity_assurance TEXT NOT NULL CHECK (identity_assurance IN ('VERIFIED', 'PENDING', 'UNRESOLVED')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  source_ref TEXT,
  PRIMARY KEY (thread_id, speaker_id)
);

CREATE INDEX idx_thread_participants_person ON thread_participants (person_id);

CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY,
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

CREATE TABLE thread_messages (
  message_id TEXT PRIMARY KEY,
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
  source_event_id TEXT,
  reply_to_message_id TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (delivery_state IN ('RECEIVED', 'QUEUED', 'ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  UNIQUE (thread_id, sequence),
  UNIQUE (source_event_id)
);

CREATE INDEX idx_thread_messages_exchange ON thread_messages (thread_id, exchange_id, sequence);
CREATE INDEX idx_thread_messages_session ON thread_messages (session_id, sequence);

CREATE TABLE protected_memory_records (
  record_id TEXT PRIMARY KEY,
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
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_protected_memory_thread_status ON protected_memory_records (thread_id, status, kind);
CREATE INDEX idx_protected_memory_subject ON protected_memory_records (subject_person_id, status);

CREATE TABLE session_compaction_jobs (
  job_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions (session_id),
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMMITTED', 'RETRYABLE', 'FAILED')),
  source_start_sequence INTEGER NOT NULL,
  source_end_sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  leased_until TEXT,
  summary_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_compaction_jobs_status ON session_compaction_jobs (status, updated_at);

CREATE TABLE session_summaries (
  summary_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions (session_id),
  thread_id TEXT NOT NULL REFERENCES threads (thread_id),
  summary_version INTEGER NOT NULL,
  covered_from_sequence INTEGER NOT NULL,
  covered_through_sequence INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  previous_summary_id TEXT REFERENCES session_summaries (summary_id),
  summary_json TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  summarizer_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, summary_version)
);

CREATE INDEX idx_session_summaries_thread ON session_summaries (thread_id, covered_through_sequence);

-- Messages and summaries are provenance records. They are never rewritten or
-- deleted by the runtime; retention/erasure is a separate reviewed policy.
CREATE TRIGGER trg_thread_messages_no_update
BEFORE UPDATE ON thread_messages
BEGIN
  SELECT RAISE(ABORT, 'thread_messages are append-only');
END;

CREATE TRIGGER trg_thread_messages_no_delete
BEFORE DELETE ON thread_messages
BEGIN
  SELECT RAISE(ABORT, 'thread_messages are append-only');
END;

CREATE TRIGGER trg_session_summaries_no_update
BEFORE UPDATE ON session_summaries
BEGIN
  SELECT RAISE(ABORT, 'session_summaries are append-only');
END;

CREATE TRIGGER trg_session_summaries_no_delete
BEFORE DELETE ON session_summaries
BEGIN
  SELECT RAISE(ABORT, 'session_summaries are append-only');
END;

-- Operational receipts are separate from immutable transcript evidence.
ALTER TABLE session_compaction_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE session_compaction_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE session_compaction_jobs ADD COLUMN invocation_state TEXT;
ALTER TABLE session_summaries ADD COLUMN covered_sequences_json TEXT;

CREATE TABLE thread_delivery_receipts (
  receipt_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES thread_messages(message_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('ACCEPTED','DELIVERED','FAILED','UNKNOWN')),
  text TEXT NOT NULL,
  provider_ref TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE(message_id, receipt_id)
);

CREATE TABLE thread_injection_receipts (
  injection_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id),
  exchange_id TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RESOLVED','SUBMITTED','COMPLETED','FAILED','UNKNOWN')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE thread_pending_deliveries (
  receipt_id TEXT PRIMARY KEY,
  inbound_message_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT,
  channel_account_id TEXT NOT NULL,
  external_room_ref TEXT NOT NULL,
  outcome TEXT NOT NULL,
  text TEXT NOT NULL,
  provider_ref TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE thread_summary_invalidations (
  summary_id TEXT PRIMARY KEY REFERENCES session_summaries(summary_id),
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_thread_delivery_message ON thread_delivery_receipts(message_id, recorded_at);

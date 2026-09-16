-- 0014_erasure_receipts_pseudonymize.sql (PH-MEMOS-6, DEC-MEMOS-53,
-- BL-MEMOS-076)
--
-- 0013 is reserved by the parent integration for the pending nonce-schema
-- amendment. This migration therefore keeps the next available number in
-- this worktree; the migration runner assigns the final sequence by merge
-- order, per DEC-MEMOS-07/14.
--
-- Supersedes only the STORAGE half of DEC-MEMOS-28. The permanence half is
-- reasserted by recreating both immutable/no-delete triggers after the table
-- rebuild. No foreign-keys=off directive is needed: no foreign key or
-- trigger body outside this table references erasure_receipts.

-- SQLite's RAISE() is legal only inside a trigger program, not in a
-- top-level SELECT. Use a transient trigger-backed probe so the approved
-- non-empty precondition still aborts inside the migration transaction. On a
-- non-empty table the RAISE rolls back this guard table and trigger together
-- with the rest of the migration; on an empty table both transient objects
-- are removed before the rebuild proceeds.
CREATE TABLE erasure_receipts_migration_guard (probe INTEGER NOT NULL);

CREATE TRIGGER trg_erasure_receipts_migration_guard
BEFORE INSERT ON erasure_receipts_migration_guard
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM erasure_receipts)
    THEN RAISE(ABORT, 'erasure_receipts is not empty; this migration cannot compute principal_hmac for an existing raw row inside pure SQL -- a JS-level backfill using the live MSP_IDENTITY_HMAC_KEY must run and convert every existing row before this migration applies. Contact KIN.')
  END;
END;

INSERT INTO erasure_receipts_migration_guard (probe) VALUES (1);
DROP TRIGGER trg_erasure_receipts_migration_guard;
DROP TABLE erasure_receipts_migration_guard;

CREATE TABLE erasure_receipts_new (
  erasure_receipt_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_hmac TEXT NOT NULL,
  principal_hmac_salt TEXT NOT NULL,
  identity_key_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  requested_by_agent_id TEXT NOT NULL,
  tables_affected_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

INSERT INTO erasure_receipts_new
  (erasure_receipt_id, tenant_id, principal_hmac, principal_hmac_salt,
   identity_key_version, idempotency_key, requested_by_agent_id,
   tables_affected_json, created_at)
SELECT erasure_receipt_id, tenant_id, '', '', '', idempotency_key,
   requested_by_agent_id, tables_affected_json, created_at
FROM erasure_receipts;

DROP TABLE erasure_receipts;
ALTER TABLE erasure_receipts_new RENAME TO erasure_receipts;

-- The old raw-principal index cannot survive because principal_id is gone.
-- Receipt matching is a rare compliance path and scans one tenant only.
CREATE INDEX idx_erasure_receipts_tenant ON erasure_receipts (tenant_id);

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

// Typed domain error classes with a stable `.code`, matching the error
// vocabulary recorded in docs/api/API-009-Persistent-Memory-Contract.md §5
// (this packet does not implement the tool surface that raises these over
// the wire -- that is Phase 2 -- but the domain layer's own error shapes are
// built to that vocabulary now so Phase 2 does not need to re-map them).

export class MspRuntimeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class MemoryNotFoundError extends MspRuntimeError {
  constructor(message = "Memory entity not found.") {
    super(message, "not_found");
  }
}

export class MemoryConflictError extends MspRuntimeError {
  constructor(message = "Concurrent write conflict on this (category, key).") {
    super(message, "conflict");
  }
}

// Raised by db/migrate.mjs's checksum-drift guard and downgrade guard. Both
// are startup-fatal: the process must refuse to start rather than run
// against a schema it cannot trust.
export class SchemaVersionError extends MspRuntimeError {
  constructor(message) {
    super(message, "db_unavailable");
  }
}

// API-011 thread memory (TASK-MEMOS-002): a request failed the domain
// layer's own shape/business-rule validation. Message is prefixed with the
// code so it stays legible over the JSON-RPC wire, whose tool-call error
// envelope carries only `.message` text, never `.code` (see
// apps/msp-server/src/transport/stdio-jsonrpc-server.mjs).
export class ThreadValidationError extends MspRuntimeError {
  constructor(message) {
    super(`validation_failed: ${message}`, "validation_failed");
  }
}

export class ThreadConflictError extends MspRuntimeError {
  constructor(message) {
    super(`conflict: ${message}`, "conflict");
  }
}

export class ThreadNotFoundError extends MspRuntimeError {
  constructor(message) {
    super(`not_found: ${message}`, "not_found");
  }
}

// A tool that must HMAC a raw channel/room reference (msp_thread_resolve,
// the sweep/delivery paths that re-derive the same hash) was invoked with no
// MSP_IDENTITY_HMAC_KEY configured. Fails closed: no thread, participant,
// message or delivery row is ever written under a fabricated or absent key.
export class IdentityHmacUnconfiguredError extends MspRuntimeError {
  constructor(message = "No MSP_IDENTITY_HMAC_KEY is configured; the channel identity cannot be hashed.") {
    super(`identity_hmac_unconfigured: ${message}`, "identity_hmac_unconfigured");
  }
}

// A caller-supplied text/body/scope payload exceeded the deployment's bound.
// Distinct from ThreadValidationError so callers can distinguish "malformed"
// from "too big to process".
export class ThreadPayloadTooLargeError extends MspRuntimeError {
  constructor(message) {
    super(`payload_too_large: ${message}`, "payload_too_large");
  }
}

// RKOI review (post-implementation, item 1): a request named a thread whose
// stored thread_kind does not match the grant's audienceKind claim -- on
// mint (thread_kind/audience_kind/grant.audienceKind must all agree) or on
// any later call against an already-resolved thread. Distinct from
// thread_scope_denied (packages/msp-contracts/src/contracts/errors.mjs)
// because this is a data-consistency mismatch the caller can fix by
// re-resolving, not a permission the grant lacks.
export class ThreadAudienceMismatchError extends MspRuntimeError {
  constructor(message = "thread_kind/audience_kind and the grant's audienceKind must all agree.") {
    super(`thread_audience_mismatch: ${message}`, "thread_audience_mismatch");
  }
}

// RKOI review (post-implementation, item 4): a protected-memory-record
// insert violated the subject rule enforced by
// migrations/0008_thread_memory.sql's trg_protected_memory_records_subject_rules
// trigger (subject_person_id must be absent or equal to
// asserted_by_speaker_id; a HUMAN asserter's subject may never be absent).
// ThreadMemoryStore#recordProtectedMemory pre-checks this in JS AND relies
// on the trigger as the unconditional backstop; either path raises this
// same typed error.
export class RecordSubjectMismatchError extends MspRuntimeError {
  constructor(message = "subject_person_id must be absent or equal to asserted_by_speaker_id.") {
    super(`record_subject_mismatch: ${message}`, "record_subject_mismatch");
  }
}

// RKOI review (post-implementation, item 11): a compaction claim/commit/
// retry named a lease token or source range that does not match the
// currently-leased job, or whose lease has already expired against the
// server's own clock. Distinct from the generic `conflict` code so a
// caller can tell "your lease is gone" from every other conflict shape
// (e.g. "session_id does not belong to thread_id").
export class CompactionLeaseConflictError extends MspRuntimeError {
  constructor(message = "The compaction lease is stale, mismatched or already terminal.") {
    super(`compaction_lease_conflict: ${message}`, "compaction_lease_conflict");
  }
}

// Reserved for a later packet (person-erasure / GDPR-style deletion): not
// raised anywhere in stage 1. Declared now so the error vocabulary and its
// code are stable before that packet needs them.
export class PrincipalErasedError extends MspRuntimeError {
  constructor(message = "The principal's identity has been erased.") {
    super(`principal_erased: ${message}`, "principal_erased");
  }
}

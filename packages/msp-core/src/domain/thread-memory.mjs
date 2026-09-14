// Unified thread, speaker, session and compaction state (API-011,
// TASK-MEMOS-002 stage 1).
//
// Zuri owns channel identity and authorization. MSP owns the durable thread
// lifecycle, speaker references, bounded recent exchanges and the
// provenance of compacted session memory. This module deliberately accepts
// opaque channel/person references; it never resolves a LINE id or decides
// authorization -- that is apps/msp-server's
// transport/handlers/thread-guard.mjs's job, built on
// @freshair129/msp-contracts/thread-access's pure grant verification.
//
// Raw channel identifiers are never stored: every external room reference is
// HMAC-SHA256'd under an injected identity key before it reaches a column
// (`#hmacRoomRef`), and every journal actor is the HMAC of the raw speaker
// id, never the id itself (`#hmacPrincipal`) -- W5. A method that needs to
// hash a value with no key configured throws IdentityHmacUnconfiguredError
// and writes nothing (checked before any DB mutation) -- identical fail-
// closed shape to how contracts/errors.mjs's GksProviderUnconfiguredError
// already works for the GKS bridge.
import { createHash, createHmac, randomUUID } from "node:crypto";

import { mintRef } from "./ids.mjs";
import {
  AgentNotCurrentError,
  CompactionLeaseConflictError,
  GrantReplayedError,
  IdentityHmacUnconfiguredError,
  RecordSubjectMismatchError,
  ThreadConflictError,
  ThreadNotFoundError,
  ThreadPayloadTooLargeError,
  ThreadValidationError,
} from "./errors.mjs";

const SPEAKER_KINDS = new Set(["HUMAN", "AGENT", "OPERATOR", "UNKNOWN"]);
const ASSURANCE = new Set(["VERIFIED", "PENDING", "UNRESOLVED"]);
const DIRECTIONS = new Set(["INBOUND", "OUTBOUND"]);
const DELIVERY_STATES = new Set(["RECEIVED", "QUEUED", "ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN"]);
const MEMORY_KINDS = new Set(["CONSTRAINT", "INSTRUCTION", "CORRECTION", "PREFERENCE"]);
const MEMORY_STATUSES = new Set(["ACTIVE", "REVOKED", "SUPERSEDED"]);
const VERIFICATION_STATES = new Set(["CANDIDATE", "CONFIRMED", "CONTESTED"]);
const THREAD_KINDS = new Set(["DIRECT", "GROUP", "ROOM"]);
const ASSURANCE_RANK = { UNRESOLVED: 0, PENDING: 1, VERIFIED: 2 };
const SUMMARY_FIELDS = ["topics", "decisions", "openQuestions", "pendingActions", "corrections", "outcomes", "participants"];

// Deployment ceilings on caller-supplied payload sizes. Deliberately
// generous (LINE's own text limit is far smaller) -- this bound exists to
// stop a single record from becoming unbounded, not to enforce a specific
// channel's UX limit, which is Zuri's business.
const MAX_TEXT_LENGTH = 20_000;
const MAX_BODY_JSON_LENGTH = 50_000;
const MAX_SCOPE_JSON_LENGTH = 10_000;
const MAX_SOURCE_REFS = 200;

// PH-MEMOS-3 stage 2 (BL-MEMOS-043, RKOI stage-2 review round 2,
// owner-direction ruling): the ONE identical answer for every reason a
// supersedes_record_id might be unsupersedable -- unknown id, another
// agent's AGENT-visibility record, or a record failing the pre-existing
// stage-1 ownership/status check. A third, distinguishable code (the
// round-1 fix's own thread_scope_denied) would itself have been an oracle.
const SUPERSESSION_REFUSAL = "supersedes_record_id does not name a record this caller can supersede";

// PH-MEMOS-3 stage 2 (BL-MEMOS-048, RKOI stage-2 review round 2, defense
// in depth): the sanity bound #consumeNonce enforces on `grantExpiresAt`,
// well outside verifyThreadGrant's own 65-second expiry window -- see
// #consumeNonce's own comment for why this exists at all.
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export class ThreadMemoryValidationError extends ThreadValidationError {}
export class ThreadMemoryConflictError extends ThreadConflictError {}
export class ThreadMemoryNotFoundError extends ThreadNotFoundError {}
export { AgentNotCurrentError, CompactionLeaseConflictError, GrantReplayedError, IdentityHmacUnconfiguredError, RecordSubjectMismatchError, ThreadPayloadTooLargeError };

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ThreadMemoryValidationError(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label);
}

function iso(value, label = "timestamp") {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new ThreadMemoryValidationError(`${label} must be a valid timestamp.`);
  return date.toISOString();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new ThreadMemoryValidationError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new ThreadMemoryValidationError(`${label} must be a non-negative integer.`);
  return value;
}

function enumValue(value, values, label) {
  const normalized = requiredString(value, label).toUpperCase();
  if (!values.has(normalized)) throw new ThreadMemoryValidationError(`${label} is invalid.`);
  return normalized;
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadMemoryValidationError(`${label} must be an object.`);
  }
  return value;
}

function boundedText(value, label, max = MAX_TEXT_LENGTH) {
  const text = requiredString(value, label);
  if (text.length > max) throw new ThreadPayloadTooLargeError(`${label} exceeds ${max} characters.`);
  return text;
}

function boundedJsonString(value, label, max) {
  const serialized = JSON.stringify(value);
  if (serialized.length > max) throw new ThreadPayloadTooLargeError(`${label} exceeds ${max} serialized characters.`);
  return serialized;
}

function stringArray(value, label, { required = true, max = MAX_SOURCE_REFS } = {}) {
  if (value === undefined || value === null) {
    if (!required) return [];
    throw new ThreadMemoryValidationError(`${label} is required.`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ThreadMemoryValidationError(`${label} must be an array of non-empty strings.`);
  }
  if (value.length > max) throw new ThreadPayloadTooLargeError(`${label} exceeds ${max} items.`);
  return value.map((item) => item.trim());
}

function ref(prefix) {
  return mintRef(prefix, randomUUID());
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// HMAC-SHA256, over the exact field order the contract documents (API-011
// §"Identity hashing", design §6.3): "tenant_id|channel_account_id|
// external_room_ref". RKOI review (2nd round), CRITICAL 1: channel_type is
// deliberately NOT part of this hash -- zuri-ai's msp_thread_delivery_record
// grant never carries a channelType claim (verified against zuri-ai
// origin/main's createMspThreadMemoryPort#recordDelivery), so requiring one
// to compute this hash made every delivery receipt unreachable. Exported so
// apps/msp-server's thread-guard.mjs can recompute a grant's own room hash
// and compare it against a resolved thread's stored one (RKOI review,
// WARNING 1) without needing any DB-only field.
export function hmacRoomRef(key, { tenantId, channelAccountId, externalRoomRef }) {
  // RKOI review, WARNING 8: the identity key needs the same >=32-character
  // bar as MSP_THREAD_SERVICE_KEY.
  if (typeof key !== "string" || key.length < 32) throw new IdentityHmacUnconfiguredError();
  return createHmac("sha256", key)
    .update(`${tenantId}|${channelAccountId}|${externalRoomRef}`, "utf8")
    .digest("hex");
}

// A raw SqliteError from one of migrations/0008_thread_memory.sql's
// RAISE(ABORT) triggers, translated into the same typed vocabulary every
// other failure in this module uses (W10) -- a caller never sees a driver
// error string. Any error this does not recognize is rethrown unchanged.
function translateTriggerError(error) {
  if (!(error instanceof Error) || typeof error.message !== "string") throw error;
  if (/one HUMAN participant/.test(error.message)) {
    throw new ThreadMemoryConflictError("a DIRECT thread may only ever have one HUMAN participant for its lifetime.");
  }
  if (/record_subject_mismatch:/.test(error.message)) {
    throw new RecordSubjectMismatchError(error.message.replace(/^.*record_subject_mismatch:\s*/, ""));
  }
  if (
    /tenant_id must match|session_id must belong to|must be a CURRENT participant|exchange_id must belong to thread_id|must name an OUTBOUND message/.test(
      error.message,
    )
  ) {
    throw new ThreadMemoryValidationError(error.message.replace(/^.*?:\s*/, ""));
  }
  // RKOI code review round 2, WARNING 3: these two RAISE(ABORT) triggers
  // (trg_thread_messages_tenant_consistency's exchange_id and
  // reply_to_message_id checks) were not yet recognized here, so they fell
  // through to the generic `throw error` below and leaked a raw
  // SqliteError/trigger-text string to the caller instead of the module's
  // typed vocabulary.
  //
  // exchange_id is, like message_id/receipt_id/injection_id, a caller-
  // supplied identifier that must behave as a single GLOBAL namespace (the
  // trigger's entire purpose is refusing a second thread's claim on an
  // exchange_id already used by a first) -- so a collision here gets
  // mapped to the exact SAME generic conflict message as any other id
  // collision below, never naming the other tenant or thread, for the same
  // no-existence-oracle reason.
  if (/exchange_id was previously used on a different thread/.test(error.message)) {
    throw new ThreadMemoryConflictError("That identifier is already in use.");
  }
  // reply_to_message_id is thread-scoped by construction (the query behind
  // this trigger is `WHERE ... AND thread_id = NEW.thread_id`), so this is
  // always a validation problem with the caller's own request, never
  // information about another tenant.
  if (/reply_to_message_id must name a message of the same thread/.test(error.message)) {
    throw new ThreadMemoryValidationError("reply_to_message_id does not name a message of this thread.");
  }
  // RKOI review, 2nd round, WARNING 3 (W6 leftover): message_id, receipt_id
  // and injection_id are caller-supplied, global primary keys. A collision
  // is mapped to the SAME generic `conflict` regardless of which tenant
  // already holds the colliding row -- the message never names the table,
  // the column, or anything about the existing row, so it cannot be used to
  // probe whether an id exists under another tenant.
  if (/UNIQUE constraint failed/.test(error.message)) {
    throw new ThreadMemoryConflictError("That identifier is already in use.");
  }
  throw error;
}

function hmacPrincipal(key, speakerId) {
  // RKOI review, WARNING 8: same >=32-character bar as hmacRoomRef.
  if (typeof key !== "string" || key.length < 32) throw new IdentityHmacUnconfiguredError();
  return createHmac("sha256", key).update(String(speakerId), "utf8").digest("hex");
}

function rowThread(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    threadKind: row.thread_kind,
    // audience_kind is not a stored column (API-011 stage 1: zuri-ai always
    // sends thread_kind === audience_kind; resolveThread validates that and
    // the response mirrors thread_kind so callers reading
    // thread.audienceKind keep working unchanged).
    audienceKind: row.thread_kind,
    channelType: row.channel_type,
    channelAccountId: row.channel_account_id,
    // Not raw identity -- already a one-way HMAC -- so it is safe to expose
    // to apps/msp-server's thread-guard.mjs for the RKOI review's WARNING 1
    // room check (a grant's OWN room hash must match this thread's).
    externalRoomRefHmac: row.external_room_ref_hmac,
    tenantId: row.tenant_id,
    businessId: row.business_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    status: row.status,
    openedAt: row.opened_at,
    lastHumanAt: row.last_human_at,
    idleDeadline: row.idle_deadline,
    closedAt: row.closed_at,
    latestSequence: row.latest_sequence,
    summaryWatermark: row.summary_watermark,
    policyRevision: row.policy_revision,
    version: row.version,
  };
}

function rowMessage(row) {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    exchangeId: row.exchange_id,
    sequence: row.sequence,
    speakerId: row.speaker_id,
    speakerKind: row.speaker_kind,
    personId: row.person_id,
    identityAssurance: row.identity_assurance,
    direction: row.direction,
    text: row.text,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    sourceEventId: row.source_event_id,
    replyToMessageId: row.reply_to_message_id,
    deliveryState: row.delivery_state,
    redactionState: row.redaction_state,
  };
}

function rowProtected(row) {
  return {
    recordId: row.record_id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    assertedBySpeakerId: row.asserted_by_speaker_id,
    subjectPersonId: row.subject_person_id,
    scope: parseJson(row.scope_json, {}),
    body: parseJson(row.body_json, {}),
    sourceMessageRefs: parseJson(row.source_message_refs_json, []),
    supersedesRecordId: row.supersedes_record_id,
    verificationState: row.verification_state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // PH-MEMOS-3 stage 2 (BL-MEMOS-043, Sec.9.4): agentId is NULL on every
    // legacy stage-1 row; visibility defaults to 'THREAD' at the schema
    // level (migration 0009), so every legacy row reports it too.
    agentId: row.agent_id ?? null,
    visibility: row.visibility ?? "THREAD",
  };
}

function rowSummary(row) {
  return {
    summaryId: row.summary_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    summaryVersion: row.summary_version,
    coveredFromSequence: row.covered_from_sequence,
    coveredThroughSequence: row.covered_through_sequence,
    sourceDigest: row.source_digest,
    coveredSequences: parseJson(row.covered_sequences_json, null),
    previousSummaryId: row.previous_summary_id,
    summary: parseJson(row.summary_json, {}),
    policyRevision: row.policy_revision,
    summarizerVersion: row.summarizer_version,
    createdAt: row.created_at,
  };
}

function rowParticipant(row) {
  return {
    membershipId: row.membership_id,
    threadId: row.thread_id,
    speakerId: row.speaker_id,
    speakerKind: row.speaker_kind,
    personId: row.person_id,
    identityAssurance: row.identity_assurance,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    sourceRef: row.source_ref,
  };
}

/**
 * Read-only, DB-backed lookups the API-011 thread guard needs to make its
 * scope decisions (C-2 fix: this logic used to live inside
 * packages/msp-contracts/src/contracts/thread-access.mjs, coupling the pure
 * contracts layer to storage; it now lives here, in msp-core, alongside
 * ThreadMemoryStore, and apps/msp-server/src/transport/handlers/
 * thread-guard.mjs orchestrates it together with
 * @freshair129/msp-contracts/thread-access's pure assertThreadScope).
 * ThreadRegistry never mutates anything and never authorizes anything
 * itself -- it only answers "what does the database say", leaving every
 * scope decision to the guard.
 */
export class ThreadRegistry {
  #db;

  constructor(db) {
    if (!db || typeof db.prepare !== "function") throw new TypeError("ThreadRegistry requires a database.");
    this.#db = db;
  }

  findThreadById(threadId) {
    if (!threadId) return null;
    return rowThread(this.#db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId));
  }

  findThreadBySession(sessionId) {
    if (!sessionId) return null;
    return rowThread(
      this.#db
        .prepare("SELECT t.* FROM threads t JOIN chat_sessions s ON s.thread_id = t.thread_id WHERE s.session_id = ?")
        .get(sessionId),
    );
  }

  findThreadByJob(jobId) {
    if (!jobId) return null;
    return rowThread(
      this.#db
        .prepare("SELECT t.* FROM threads t JOIN session_compaction_jobs j ON j.thread_id = t.thread_id WHERE j.job_id = ?")
        .get(jobId),
    );
  }

  findThreadByMessage(messageId) {
    if (!messageId) return null;
    return rowThread(
      this.#db
        .prepare("SELECT t.* FROM threads t JOIN thread_messages m ON m.thread_id = t.thread_id WHERE m.message_id = ?")
        .get(messageId),
    );
  }

  // The single OPEN (left_at IS NULL) participant row for this exact
  // speaker_id, of ANY speaker_kind. Used by the guard to decide whether an
  // append is creating/changing state versus continuing unchanged.
  findCurrentParticipant(threadId, speakerId) {
    if (!threadId || !speakerId) return null;
    const row = this.#db
      .prepare("SELECT * FROM thread_participants WHERE thread_id = ? AND speaker_id = ? AND left_at IS NULL")
      .get(threadId, speakerId);
    return row ? rowParticipant(row) : null;
  }

  // BL-MEMOS-058 (design Sec.7 rule 2, PH-MEMOS-4 review round 2, CRITICAL
  // 1): an EXISTENCE check over EVERY row for this thread and speaker --
  // current or departed, no left_at filter at all. Distinct from
  // findCurrentParticipant (left_at IS NULL only): the guard needs to tell
  // "this speaker_id has never had a row on this thread" apart from
  // "a row exists, but none is open" to refuse a claim-free rejoin after
  // `leave`, which findCurrentParticipant alone cannot distinguish from a
  // genuine first-ever join.
  hasEverParticipated(threadId, speakerId) {
    if (!threadId || !speakerId) return false;
    const row = this.#db.prepare("SELECT 1 FROM thread_participants WHERE thread_id = ? AND speaker_id = ? LIMIT 1").get(threadId, speakerId);
    return !!row;
  }

  // The DIRECT thread's sole current HUMAN participant, if any. This is the
  // C-1 private-read predicate's DB-backed half: DIRECT thread_kind, a
  // VERIFIED HUMAN participant who has not left, matching the grant
  // principal -- the guard does the principal comparison itself.
  findCurrentHumanParticipant(threadId) {
    if (!threadId) return null;
    const row = this.#db
      .prepare("SELECT * FROM thread_participants WHERE thread_id = ? AND speaker_kind = 'HUMAN' AND left_at IS NULL")
      .get(threadId);
    return row ? rowParticipant(row) : null;
  }

  // §8.1/§8.2 (PH-MEMOS-3 stage 2): the agent gate's read-only currency
  // check for every thread-bound tool OTHER than msp_thread_resolve
  // (whose mint-race-safe attach/currency logic lives inside
  // ThreadMemoryStore#resolveThread's own transaction instead, since it
  // may need to WRITE a new attachment, not merely read one). Returns a
  // boolean, not a row -- callers only ever need "is this agent current."
  findCurrentAgent(threadId, agentId, workspaceId) {
    if (!threadId || !agentId || !workspaceId) return false;
    const row = this.#db
      .prepare("SELECT 1 FROM thread_agents WHERE thread_id = ? AND agent_id = ? AND workspace_id = ? AND left_at IS NULL")
      .get(threadId, agentId, workspaceId);
    return !!row;
  }

  // §8.2/§12.2 (PH-MEMOS-3 stage 2): msp_thread_delivery_record's PENDING
  // path has no thread_id or inbound message yet to resolve a thread
  // through -- its only handle on "which thread" is the room binding
  // itself, the exact same triple idx_threads_active_binding uniques on.
  // externalRoomRefHmac is the CALLER's job (hmacRoomRef, identity key is
  // apps/msp-server's concern, not msp-core's ThreadRegistry).
  findThreadByRoom({ tenantId, channelAccountId, externalRoomRefHmac } = {}) {
    if (!tenantId || !channelAccountId || !externalRoomRefHmac) return null;
    return rowThread(
      this.#db
        .prepare("SELECT * FROM threads WHERE tenant_id = ? AND channel_account_id = ? AND external_room_ref_hmac = ? AND status = 'ACTIVE'")
        .get(tenantId, channelAccountId, externalRoomRefHmac),
    );
  }
}

export class ThreadMemoryStore {
  #db;
  #journal;
  #identityHmacKey;

  constructor(db, journal, { identityHmacKey = null } = {}) {
    if (!db || typeof db.prepare !== "function") throw new TypeError("ThreadMemoryStore requires a database.");
    this.#db = db;
    this.#journal = journal;
    this.#identityHmacKey = identityHmacKey;
  }

  #hmacRoomRef(fields) {
    return hmacRoomRef(this.#identityHmacKey, fields);
  }

  #hmacPrincipal(speakerId) {
    return hmacPrincipal(this.#identityHmacKey, speakerId);
  }

  // PH-MEMOS-3 stage 2 (BL-MEMOS-048, DEC-MEMOS-20, Sec.6.1.1): consumes a
  // grant's nonce for anti-replay -- called from INSIDE each nonce-required
  // store method's own synchronous db.transaction() body, immediately
  // alongside its own write, so a replayed nonce rolls back the whole
  // mutation with it (never a partial apply). A PRIMARY KEY conflict on
  // (tenant_id, nonce) means this exact grant was already consumed for
  // this tenant -- re-thrown as GrantReplayedError. Pruning is bounded (at
  // most 200 rows), opportunistic (runs immediately before every insert,
  // never a separate scheduled job), and compares against the REAL server
  // wall clock ONLY -- never the synthetic MSP_TEST_CLOCK `now` a caller
  // might supply elsewhere, so a test can never manipulate its own nonces
  // out of existence early.
  //
  // RKOI review (stage-2 revision, WARNING 1): `grantExpiresAt` is
  // grant.expiresAt itself (an epoch-ms number, already bounds-checked by
  // verifyThreadGrant against the REAL server clock -- never derived from
  // this call's own business timestamp, which is only ever real under
  // MSP_TEST_CLOCK=1). Deriving the nonce's own `expires_at` from a
  // caller-suppliable business `now` would let a test-clock-enabled caller
  // stamp a nonce with an arbitrary expiry (RKOI's probe: a far-future
  // business `now` produced a nonce that would never be pruned by the
  // real-clock-only prune above).
  //
  // RKOI review (stage-2 revision, WARNING 2, DEC-MEMOS-20): `nonce` is
  // used EXACTLY as given -- never `requiredString`'s own `.trim()`, so
  // `" padnonce "` and `"padnonce"` are two distinct nonces, not the same
  // one collapsed by trimming. Type/length (1-128 characters) are
  // re-validated here as defense in depth; the guard is the primary
  // enforcement point and already refuses anything this check would catch
  // before ever reaching this method.
  #consumeNonce(tenantId, nonce, grantExpiresAt) {
    if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 128) {
      throw new ThreadMemoryValidationError("nonce must be a string of 1 to 128 characters.");
    }
    // RKOI review (stage-2 revision round 2, defense in depth): a bare
    // `Number.isFinite` check let `grantExpiresAt` reach `new
    // Date(grantExpiresAt).toISOString()` below with any finite number at
    // all -- including something like `1e20`, which is OUTSIDE the native
    // `Date` object's own representable range and makes `toISOString()`
    // throw a raw, untyped `RangeError: Invalid time value` instead of
    // this module's own typed vocabulary. Refused here instead, before
    // that call ever runs: `grantExpiresAt` must be a finite INTEGER
    // (epoch milliseconds, matching how `verifyThreadGrant` itself
    // produces `grant.expiresAt`) within TEN_YEARS_MS of the real server
    // clock -- comfortably wider than `verifyThreadGrant`'s own 65-second
    // expiry window, so this is a sanity bound against a malformed or
    // hostile caller, not a second copy of that check. A negative value,
    // or any value astronomically far from "now" in either direction, is
    // always outside this window and refused by the same single check.
    if (!Number.isInteger(grantExpiresAt) || Math.abs(grantExpiresAt - Date.now()) > TEN_YEARS_MS) {
      throw new ThreadMemoryValidationError("grantExpiresAt must be a finite integer (epoch milliseconds) within 10 years of the server clock.");
    }
    this.#db.prepare("DELETE FROM grant_nonces WHERE rowid IN (SELECT rowid FROM grant_nonces WHERE expires_at < ? LIMIT 200)").run(new Date().toISOString());
    const expiresAt = new Date(grantExpiresAt).toISOString();
    try {
      this.#db.prepare("INSERT INTO grant_nonces (tenant_id, nonce, expires_at) VALUES (?, ?, ?)").run(tenantId, nonce, expiresAt);
    } catch (error) {
      if (!String(error?.message).includes("UNIQUE")) throw error;
      throw new GrantReplayedError();
    }
  }

  #journalAppend(entry) {
    // W5: never journal a raw speaker/person id. `actor` is always the HMAC
    // of the raw speaker id (or a fixed, non-identity system label for
    // worker-driven entries, e.g. "msp:session-router"), and no payload
    // field below carries a raw external_room_ref or person id.
    this.#journal?.append(entry);
  }

  resolveThread({
    threadKind,
    channelType,
    channelAccountId,
    externalRoomRef,
    tenantId,
    businessId = null,
    audienceKind,
    agentId,
    workspaceId,
    assertAgents = false,
    mayMint = true,
    nonce,
    grantExpiresAt,
    now,
  } = {}) {
    const kind = enumValue(threadKind, THREAD_KINDS, "thread_kind");
    if (audienceKind !== undefined && audienceKind !== null && audienceKind !== "") {
      const audience = enumValue(audienceKind, THREAD_KINDS, "audience_kind");
      if (audience !== kind) {
        throw new ThreadMemoryValidationError("audience_kind must equal thread_kind.");
      }
    }
    const channel = requiredString(channelType, "channel_type");
    const account = requiredString(channelAccountId, "channel_account_id");
    const room = requiredString(externalRoomRef, "external_room_ref");
    const tenant = requiredString(tenantId, "tenant_id");
    const business = optionalString(businessId, "business_id");
    // PH-MEMOS-3 stage 2 (BL-MEMOS-041, DEC-MEMOS-21): agentId/workspaceId
    // are validated here too, not only by the guard's own
    // verifyThreadGrant check -- the domain layer never trusts a caller's
    // claim about its own required fields, matching every other required
    // field in this method.
    const agent = requiredString(agentId, "agentId");
    const workspace = requiredString(workspaceId, "workspaceId");
    const timestamp = iso(now);
    // Fail closed BEFORE any lookup or write: no thread is ever created, and
    // no existing binding is ever compared, under a fabricated or absent key.
    const roomHmac = this.#hmacRoomRef({ tenantId: tenant, channelAccountId: account, externalRoomRef: room });

    // RKOI review, item 3 (relink): the uniqueness constraint, and this
    // lookup, only ever consider the ACTIVE thread for this binding. A
    // CLOSED or REVOKED thread under the same binding does not block a
    // fresh mint -- that is exactly how a relink (closing the old thread,
    // then re-resolving) hands the binding to a new principal without the
    // new principal ever inheriting the old thread's history. Closing a
    // thread is a later lifecycle-tool packet; this method only ever reads
    // the current ACTIVE row.
    const existing = this.#db
      .prepare("SELECT * FROM threads WHERE tenant_id = ? AND channel_account_id = ? AND external_room_ref_hmac = ? AND status = 'ACTIVE'")
      .get(tenant, account, roomHmac);
    if (existing) {
      // RKOI code review round 2, WARNING 1 (DEC-MEMOS-16, adopted default
      // pending owner confirmation): the room-hash binding
      // (tenant_id, channel_account_id, external_room_ref_hmac) does not
      // encode channel_type (see hmacRoomRef's header comment -- deliberate,
      // since zuri-ai's delivery grant never sends one). That means a
      // resolve naming a DIFFERENT channel_type than the thread that
      // already owns this binding can never be treated as "the same
      // thread" -- it must be refused as a typed conflict, exactly like a
      // business_id or thread_kind mismatch, never silently returning the
      // other channel's thread under the caller's own requested kind.
      if (existing.business_id !== business || existing.thread_kind !== kind || existing.channel_type !== channel) {
        throw new ThreadMemoryConflictError("The channel binding already belongs to a different thread scope.");
      }
      // §8.1: this call did not just mint the thread, so it goes through
      // the ordinary current-or-assertAgents gate, exactly like a mint-race
      // loser below. BL-MEMOS-048: the nonce is consumed in the SAME
      // transaction as any attach, on every outcome (no-op, self-assert
      // attach) -- a replay rolls back the attach with it. RKOI review
      // (stage-2 revision, WARNING 7a): the gate runs BEFORE the
      // `updated_at` bump below, so a refused resolve (agent_not_current)
      // never touches the thread row at all.
      const agentAttached = this.#resolveAgentCurrencyAndNonce(existing.thread_id, tenant, agent, workspace, assertAgents, nonce, timestamp, grantExpiresAt);
      this.#db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(timestamp, existing.thread_id);
      const thread = rowThread({ ...existing, updated_at: timestamp });
      return { thread, created: false, agentAttached };
    }

    // §8.1/§8.3, DEC-MEMOS-18: a worker-only grant (operator, with no
    // reader/writer flags) never mints a thread -- the guard computes
    // mayMint from the grant's own capability flags and passes it down
    // here; a room with no ACTIVE thread yet is refused not_found for such
    // a grant, never created:true.
    if (!mayMint) {
      throw new ThreadMemoryNotFoundError("No ACTIVE thread exists for this room, and this grant may not mint one.");
    }

    const threadId = ref("thread");
    try {
      // Mint-race rule (RKOI stage-2 review round 1, defense in depth):
      // auto-attach happens only after THIS call's own INSERT INTO threads
      // actually wins -- the thread insert and the minting agent's
      // thread_agents row are written in the same transaction, so a crash
      // or a losing race between the two INSERTs can never leave a minted
      // thread with no agent attached, or an attached agent with no thread.
      this.#db.transaction(() => {
        this.#db
          .prepare(`
            INSERT INTO threads
              (thread_id, thread_kind, channel_type, channel_account_id, external_room_ref_hmac,
               tenant_id, business_id, status, created_at, updated_at)
            VALUES (@thread_id, @thread_kind, @channel_type, @channel_account_id, @external_room_ref_hmac,
               @tenant_id, @business_id, 'ACTIVE', @created_at, @updated_at)
          `)
          .run({
            thread_id: threadId,
            thread_kind: kind,
            channel_type: channel,
            channel_account_id: account,
            external_room_ref_hmac: roomHmac,
            tenant_id: tenant,
            business_id: business,
            created_at: timestamp,
            updated_at: timestamp,
          });
        this.#db
          .prepare(`
            INSERT INTO thread_agents (agent_attachment_id, tenant_id, thread_id, agent_id, workspace_id, joined_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(ref("agent-attachment"), tenant, threadId, agent, workspace, timestamp);
        // BL-MEMOS-048: consumed in the SAME transaction as the mint --
        // a replayed nonce rolls back the whole mint, not merely the
        // attach.
        this.#consumeNonce(tenant, nonce, grantExpiresAt);
      })();
    } catch (error) {
      if (!String(error?.message).includes("UNIQUE")) throw error;
      const raced = this.#db
        .prepare("SELECT * FROM threads WHERE tenant_id = ? AND channel_account_id = ? AND external_room_ref_hmac = ? AND status = 'ACTIVE'")
        .get(tenant, account, roomHmac);
      if (!raced) throw error;
      // Same DEC-MEMOS-16 check as the initial lookup above, applied to the
      // UNIQUE-constraint race-retry read.
      if (raced.business_id !== business || raced.thread_kind !== kind || raced.channel_type !== channel) {
        throw new ThreadMemoryConflictError("The channel binding already belongs to a different thread scope.");
      }
      const thread = rowThread(raced);
      // §8.1 mint-race rule: this call LOST the race -- it is not the
      // minting agent, and does not auto-attach merely because its own
      // lookup ran before the winner's INSERT committed. It goes through
      // the ordinary existing-thread gate like any other caller resolving
      // a thread it did not create.
      const agentAttached = this.#resolveAgentCurrencyAndNonce(thread.threadId, tenant, agent, workspace, assertAgents, nonce, timestamp, grantExpiresAt);
      return { thread, created: false, agentAttached };
    }

    const created = rowThread(this.#db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId));
    // RKOI review (stage-2 revision, WARNING 6, §8.4): a mint's actor is
    // the minting agent's own id (grant.agentId), in plain text -- not the
    // fixed "msp:thread-resolver" system label, which predates agentId
    // existing as a grant claim at all. workspace_id is grant.workspaceId
    // (the agent's real workspace), not `tenant` -- the tenant_id
    // placeholder this field carried before workspaceId existed.
    this.#journalAppend({
      actor: agent,
      toolName: "msp_thread_resolve",
      ref: threadId,
      workspaceId: workspace,
      payload: { thread_id: threadId, created: true, channel_type: channel },
      policyDecision: "allow",
    });
    return { thread: created, created: true, agentAttached: true };
  }

  // §8.1: an agent is "current" on a thread exactly when a thread_agents
  // row for (thread_id, agent_id, workspace_id) exists with left_at IS
  // NULL. Used by resolveThread's existing-thread gate (including a
  // mint-race loser, which reaches this exact same path): an already-
  // current agent is a no-op (agentAttached: false); a non-current agent
  // needs assertAgents to attach (agentAttached: true) and is otherwise
  // refused agent_not_current. Returns whether THIS call caused a new
  // attachment. BL-MEMOS-048: the nonce is consumed in the SAME
  // transaction, on every outcome (no-op or attach) -- a replay rolls
  // back the whole call, never merely because the outcome happened to be
  // a no-op.
  #resolveAgentCurrencyAndNonce(threadId, tenantId, agentId, workspaceId, assertAgents, nonce, joinedAt, grantExpiresAt) {
    return this.#db.transaction(() => {
      const current = this.#db
        .prepare("SELECT 1 FROM thread_agents WHERE thread_id = ? AND agent_id = ? AND workspace_id = ? AND left_at IS NULL")
        .get(threadId, agentId, workspaceId);
      let attached = false;
      if (!current) {
        if (!assertAgents) {
          throw new AgentNotCurrentError();
        }
        try {
          this.#db
            .prepare(`
              INSERT INTO thread_agents (agent_attachment_id, tenant_id, thread_id, agent_id, workspace_id, joined_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            .run(ref("agent-attachment"), tenantId, threadId, agentId, workspaceId, joinedAt);
          attached = true;
        } catch (error) {
          // A concurrent self-assert race for the identical (thread_id,
          // agent_id, workspace_id) triple: the partial UNIQUE index
          // (left_at IS NULL) allows only one open row, so the loser here
          // is already current the instant the winner's INSERT commits --
          // this is success, not a failure.
          if (!String(error?.message).includes("UNIQUE")) throw error;
        }
      }
      // RKOI review (stage-2 revision, WARNING 1): grantExpiresAt, NEVER
      // joinedAt (the business timestamp, W1-gated and caller-suppliable
      // under MSP_TEST_CLOCK=1) -- see #consumeNonce's own header comment.
      this.#consumeNonce(tenantId, nonce, grantExpiresAt);
      return attached;
    })();
  }

  appendMessage({
    threadId,
    sessionId = null,
    exchangeId = null,
    messageId = null,
    sourceEventId,
    speakerId,
    speakerKind,
    personId = null,
    identityAssurance,
    direction,
    text,
    occurredAt,
    receivedAt,
    replyToMessageId = null,
    deliveryState,
    idleTimeoutMinutes = 30,
    policyRevision = "default",
    reconcileDelivery = false,
    agentId = null,
    workspaceId = null,
    now,
  } = {}) {
    const thread = this.#requireThread(threadId);
    const speaker = requiredString(speakerId, "speaker_id");
    const speakerType = enumValue(speakerKind, SPEAKER_KINDS, "speaker_kind");
    const assurance = enumValue(identityAssurance, ASSURANCE, "identity_assurance");
    const messageDirection = enumValue(direction, DIRECTIONS, "direction");
    const content = boundedText(text, "text");
    const state = deliveryState ? enumValue(deliveryState, DELIVERY_STATES, "delivery_state") : messageDirection === "INBOUND" ? "RECEIVED" : "QUEUED";
    const timestamp = iso(now);
    const occurred = iso(occurredAt ?? timestamp, "occurred_at");
    const received = iso(receivedAt ?? timestamp, "received_at");
    const timeout = positiveInteger(idleTimeoutMinutes, "idle_timeout_minutes");
    const person = optionalString(personId, "person_id");
    // W7: source_event_id is required -- zuri-ai always sends one, and a
    // replayed identical append must be answered with `deduplicated: true`
    // and the original ids rather than accepted twice or rejected.
    const source = requiredString(sourceEventId, "source_event_id");
    // W6: the duplicate check is scoped to THIS thread (matching the
    // tenant-scoped UNIQUE (thread_id, source_event_id) constraint) -- it
    // never queries, or reveals the existence of, a row in another thread.
    const existing = this.#db.prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND source_event_id = ?").get(thread.threadId, source);
    if (existing) {
      // RKOI review, item 8: a replay of the SAME source_event_id with
      // DIFFERENT content is a conflict, never a silent dedupe -- only an
      // identical replay is idempotent.
      if (
        existing.speaker_id !== speaker ||
        existing.speaker_kind !== speakerType ||
        (existing.person_id ?? null) !== person ||
        existing.identity_assurance !== assurance ||
        existing.direction !== messageDirection ||
        existing.text !== content
      ) {
        throw new ThreadMemoryConflictError("source_event_id was already recorded with different content.");
      }
      // #drainDeliveries never throws (RKOI code review round 3) -- an
      // identical replay must reconcile whatever it can and still return
      // deduplicated:true, never fail permanently because an earlier
      // attempt left an unreconcilable pending row behind.
      if (existing.direction === "INBOUND") this.#drainDeliveries(existing.message_id);
      return { message: rowMessage(existing), session: rowSession(this.#getSession(existing.session_id)), deduplicated: true };
    }

    // W5: the journal actor is the speaker's HMAC, never the raw id. Fails
    // closed BEFORE any write below if no identity key is configured.
    const principalHmac = this.#hmacPrincipal(speaker);
    // PH-MEMOS-3 stage 2 (§8.4): an AGENT-attributable entry's actor
    // becomes the calling agent's own id, in plain text -- not a W5
    // regression (agentId is a Tier-1-owned workspace/process identifier,
    // not personal data, unlike a HUMAN speaker's raw id). A HUMAN-
    // attributable entry's actor is unchanged (principalHmac). Falls back
    // to principalHmac when no agentId was supplied at all (the unguarded
    // handler map's own business-logic tests never pass one).
    const actor = speakerType === "HUMAN" || !agentId ? principalHmac : agentId;

    let result;
    try {
    result = this.#db.transaction(() => {
      const referencedExchange = messageDirection === 'OUTBOUND' && exchangeId ? this.#db.prepare("SELECT * FROM thread_messages WHERE thread_id=? AND exchange_id=? AND direction='INBOUND' ORDER BY sequence LIMIT 1").get(thread.threadId, exchangeId) : null;
      if (messageDirection === 'OUTBOUND' && (!referencedExchange || replyToMessageId !== referencedExchange.message_id)) {
        throw new ThreadMemoryValidationError('Outbound requires its explicit exchange_id and reply_to_message_id.');
      }
      const active = referencedExchange ? this.#getSession(referencedExchange.session_id) : sessionId ? this.#getSession(sessionId) : this.#getOpenSession(thread.threadId);
      if (active && active.thread_id !== thread.threadId) throw new ThreadMemoryConflictError("session_id does not belong to thread_id.");
      if (sessionId && referencedExchange && sessionId !== referencedExchange.session_id) throw new ThreadMemoryConflictError('Exchange belongs to a different session.');
      if (referencedExchange && active?.status === 'CLOSED' && !reconcileDelivery) throw new ThreadMemoryConflictError('Cannot append to a sealed session.');
      // RKOI code review round 2, WARNING 5: a caller that names an
      // explicit, no-longer-open session_id with no exchange reference
      // (the OUTBOUND-via-exchange case is already covered by the
      // "Exchange belongs to a different session" check above) would
      // otherwise fall through to the auto-rotation branch below, which
      // silently creates a brand-new OPEN session, ignoring the one the
      // caller actually named. If a DIFFERENT session for this thread is
      // already OPEN by the time that runs, the new session's INSERT
      // collides with idx_chat_sessions_one_open and used to surface as a
      // raw UNIQUE-constraint conflict ("That identifier is already in
      // use."), which says nothing about the real problem. Answer with a
      // typed, specific error instead, before that fallback ever runs.
      if (!referencedExchange && sessionId && active && active.status !== 'OPEN') {
        throw new ThreadMemoryConflictError('session_id names a session that is not open.');
      }
      let session = active;
      if (messageDirection === 'INBOUND' && exchangeId) {
        const previous = this.#db.prepare('SELECT session_id FROM thread_messages WHERE thread_id=? AND exchange_id=? LIMIT 1').get(thread.threadId, exchangeId);
        if (previous && (previous.session_id !== active?.session_id || active?.status !== 'OPEN' || Date.parse(active.idle_deadline) <= Date.parse(timestamp))) {
          throw new ThreadMemoryConflictError('Inbound cannot reopen an expired exchange.');
        }
      }
      if (!referencedExchange && (!session || session.status !== "OPEN" || Date.parse(session.idle_deadline) <= Date.parse(timestamp))) {
        if (session && session.status === "OPEN") this.#closeIdleSession(session, timestamp);
        session = this.#createSession(thread.threadId, thread.tenantId, timestamp, timeout, policyRevision);
      }

      const exchange = exchangeId ? requiredString(exchangeId, "exchange_id") : ref("exchange");
      const sequenceRow = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM thread_messages WHERE thread_id = ?").get(thread.threadId);
      const sequence = Number(sequenceRow.sequence) + 1;
      const id = messageId ? requiredString(messageId, "message_id") : ref("message");

      this.#db
        .prepare(`
          INSERT INTO thread_messages
            (message_id, tenant_id, thread_id, session_id, exchange_id, sequence, speaker_id, speaker_kind,
             person_id, identity_assurance, direction, text, occurred_at, received_at,
             source_event_id, reply_to_message_id, delivery_state)
          VALUES (@message_id, @tenant_id, @thread_id, @session_id, @exchange_id, @sequence, @speaker_id, @speaker_kind,
             @person_id, @identity_assurance, @direction, @text, @occurred_at, @received_at,
             @source_event_id, @reply_to_message_id, @delivery_state)
        `)
        .run({
          message_id: id,
          tenant_id: thread.tenantId,
          thread_id: thread.threadId,
          session_id: session.session_id,
          exchange_id: exchange,
          sequence,
          speaker_id: speaker,
          speaker_kind: speakerType,
          person_id: person,
          identity_assurance: assurance,
          direction: messageDirection,
          text: content,
          occurred_at: occurred,
          received_at: received,
          source_event_id: source,
          reply_to_message_id: optionalString(replyToMessageId, "reply_to_message_id"),
          delivery_state: state,
        });

      // C-1: only a HUMAN speaker is ever recorded as a thread participant.
      // AGENT/OPERATOR/UNKNOWN speakers live only in thread_messages rows --
      // they are never inserted here, so they can never satisfy the
      // private-read predicate (msp-server's thread-guard.mjs) no matter
      // what speaker_kind a caller claims. WHETHER this append is allowed
      // to CREATE or CHANGE a HUMAN participant's row is the guard's job
      // (assertParticipants), enforced before this handler ever runs; this
      // method performs the write the guard already authorized, and the
      // trg_thread_participants_direct_single_human trigger is the
      // unconditional last line of defense regardless of what the guard
      // decided.
      if (speakerType === "HUMAN") {
        this.#applyHumanParticipant(thread.threadId, speaker, person, assurance, timestamp, source);
      }
      const lastHuman = messageDirection === "INBOUND" && speakerType === "HUMAN" ? timestamp : session.last_human_at;
      const deadline = lastHuman ? new Date(Date.parse(lastHuman) + timeout * 60_000).toISOString() : session.idle_deadline;
      this.#db
        .prepare("UPDATE chat_sessions SET latest_sequence = ?, last_human_at = ?, idle_deadline = ?, version = version + 1 WHERE session_id = ?")
        .run(sequence, lastHuman, deadline, session.session_id);
      this.#db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(timestamp, thread.threadId);
      if (session.status === 'CLOSING') {
        const job = this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE session_id=? AND status IN ('PENDING','RETRYABLE','RUNNING')").get(session.session_id);
        if (job?.status === 'RUNNING' && !reconcileDelivery) throw new ThreadMemoryConflictError('Summary source is leased; reply must be reconciled before retry.');
        if (job) this.#db.prepare('UPDATE session_compaction_jobs SET source_end_sequence=?, updated_at=? WHERE job_id=?').run(sequence, timestamp, job.job_id);
      }

      return { message: rowMessage(this.#db.prepare("SELECT * FROM thread_messages WHERE message_id = ?").get(id)), session: rowSession(this.#getSession(session.session_id)), deduplicated: false };
    })();
    } catch (error) {
      translateTriggerError(error);
    }

    // RKOI code review round 3: this runs AFTER the transaction above has
    // already committed the message -- deliberately kept out of that
    // transaction (the simpler of the two options RKOI offered) rather
    // than moved inside it, because #drainDeliveries can call back into
    // recordDelivery, which opens its OWN nested db.transaction(); folding
    // that into this method's transaction would mean a reconcile failure
    // either has to be swallowed mid-transaction (fragile: better-sqlite3
    // transactions roll back their ENTIRE effect on any uncaught throw,
    // including the message INSERT this method is trying to protect) or
    // requires threading a "some errors are fine here" exception ladder
    // through both methods. #drainDeliveries now never throws instead
    // (see its own comment), so the append's result is unconditionally
    // safe to return either way, with none of that complexity.
    if (messageDirection === 'INBOUND') this.#drainDeliveries(result.message.messageId);

    // RKOI review (stage-2 revision, WARNING 6, §8.4): workspace_id is
    // grant.workspaceId -- the calling agent's real workspace -- not the
    // stage-1 tenant_id placeholder this field carried before workspaceId
    // existed. Falls back to the tenant_id placeholder only when no
    // workspaceId was supplied at all (the unguarded handler map's own
    // business-logic tests never pass one).
    this.#journalAppend({
      actor,
      toolName: "msp_thread_message_append",
      ref: result.message.messageId,
      workspaceId: workspaceId || thread.tenantId,
      payload: { thread_id: thread.threadId, session_id: result.session.sessionId, sequence: result.message.sequence, direction: messageDirection },
      policyDecision: "allow",
    });
    return result;
  }

  recordProtectedMemory({
    threadId,
    sessionId = null,
    kind,
    assertedBySpeakerId,
    subjectPersonId = null,
    scope = {},
    body,
    sourceMessageRefs,
    supersedesRecordId = null,
    status = "ACTIVE",
    verificationState = "CANDIDATE",
    agentId = null,
    workspaceId = null,
    visibility = "THREAD",
    nonce,
    grantExpiresAt,
    now,
  } = {}) {
    const thread = this.#requireThread(threadId);
    const memoryKind = enumValue(kind, MEMORY_KINDS, "kind");
    const memoryStatus = enumValue(status, MEMORY_STATUSES, "status");
    const verification = enumValue(verificationState, VERIFICATION_STATES, "verification_state");
    const speaker = requiredString(assertedBySpeakerId, "asserted_by_speaker_id");
    const person = optionalString(subjectPersonId, "subject_person_id");
    // PH-MEMOS-3 stage 2 (BL-MEMOS-043, DEC-MEMOS-19): visibility defaults
    // to THREAD (shared among the thread's current agents), matching the
    // migration's own column default and every legacy row's backfill --
    // an AGENT-visibility record requires a non-null agent_id, backstopped
    // unconditionally by the migration's own
    // trg_protected_memory_records_agent_rules trigger regardless of what
    // this JS check does.
    const recordVisibility = enumValue(visibility, new Set(["AGENT", "THREAD"]), "visibility");
    const recordAgentId = optionalString(agentId, "agentId");
    if (recordVisibility === "AGENT" && !recordAgentId) {
      throw new ThreadMemoryValidationError("visibility=AGENT requires a non-null agentId.");
    }
    const payload = objectValue(body, "body");
    boundedJsonString(payload, "body", MAX_BODY_JSON_LENGTH);
    const scopeValue = objectValue(scope, "scope");
    boundedJsonString(scopeValue, "scope", MAX_SCOPE_JSON_LENGTH);
    const sourceRefs = stringArray(sourceMessageRefs, "source_message_refs");
    const timestamp = iso(now);
    const principalHmac = this.#hmacPrincipal(speaker);
    const participant = this.#db.prepare("SELECT speaker_id, speaker_kind FROM thread_participants WHERE thread_id = ? AND speaker_id = ? AND left_at IS NULL").get(thread.threadId, speaker);
    if (!participant) throw new ThreadMemoryValidationError("asserted_by_speaker_id must be the thread's current participant.");
    // C-1 / RKOI review item 4: a protected record with a subject is only
    // ever visible to its own asserter -- so it may only ever NAME its own
    // asserter as subject, or no subject at all. A HUMAN asserter's record
    // may never have a null subject: it must always name itself, so a
    // null-subject record can only ever come from a non-HUMAN asserter (a
    // future system-generated observation). This is the same rule the
    // guard enforces from the grant side (asserted_by_speaker_id ===
    // grant.principalId); this domain-level check, and
    // migrations/0008_thread_memory.sql's
    // trg_protected_memory_records_subject_rules trigger, are the two
    // layers that hold for every caller, guarded or not.
    if (person !== null && person !== speaker) {
      throw new RecordSubjectMismatchError("subject_person_id must be absent or equal to asserted_by_speaker_id.");
    }
    if (person === null && participant.speaker_kind === "HUMAN") {
      throw new RecordSubjectMismatchError("a HUMAN-asserted record requires subject_person_id equal to asserted_by_speaker_id.");
    }
    if (sessionId) {
      const session = this.#getSession(sessionId);
      if (!session || session.thread_id !== thread.threadId) throw new ThreadMemoryConflictError("session_id does not belong to thread_id.");
    }
    const placeholders = sourceRefs.map(() => "?").join(", ");
    const sourceRows = sourceRefs.length
      ? this.#db.prepare(`SELECT message_id, speaker_id FROM thread_messages WHERE thread_id = ? AND message_id IN (${placeholders})`).all(thread.threadId, ...sourceRefs)
      : [];
    if (sourceRows.length !== sourceRefs.length) throw new ThreadMemoryValidationError("Every source_message_ref must belong to thread_id.");
    if (sourceRows.some((row) => row.speaker_id !== speaker)) throw new ThreadMemoryValidationError('Source author must match asserted_by_speaker_id.');
    // PH-MEMOS-3 stage 2 (BL-MEMOS-043, CRITICAL 2): agent_id/visibility
    // join the hash's input list -- two different agents recording
    // identical content now get two distinct records (one per agent)
    // unless they also agree on visibility/agent_id, which two DIFFERENT
    // agents structurally cannot (each supplies its own agentId). Without
    // this, agent B's identical assertion would collide on agent A's
    // existing record_id and hand B back A's AGENT-visibility row.
    const recordId = `memory-record_${sha256(JSON.stringify([thread.threadId, sessionId, memoryKind, speaker, person, scopeValue, payload, [...sourceRefs].sort(), supersedesRecordId, verification, memoryStatus, recordAgentId, recordVisibility]))}`;
    const existingRecord = this.#db.prepare('SELECT * FROM protected_memory_records WHERE record_id=?').get(recordId);
    if (existingRecord) {
      // BL-MEMOS-048: the dedup short-circuit is not itself a write, but
      // this is still a nonce-required tool -- a replayed grant is refused
      // even when the call would otherwise have been a no-op.
      this.#consumeNonce(thread.tenantId, nonce, grantExpiresAt);
      return rowProtected(existingRecord);
    }
    // PH-MEMOS-3 stage 2 (BL-MEMOS-043, RKOI stage-2 review round 2,
    // owner-direction ruling): one identical validation_failed answer,
    // same fixed message, for an unknown id, another agent's
    // AGENT-visibility record, AND a record failing the pre-existing
    // stage-1 ownership/status check (previously a distinguishable
    // `conflict`) -- three distinguishable outcomes would themselves be an
    // oracle. Existence and other-agent AGENT-visibility are checked
    // FIRST; only if both pass does the stage-1 ownership/status check
    // run, and it too now returns this identical answer. The cross-agent
    // refusal applies to AGENT-visibility records only -- a THREAD-
    // visibility or legacy (agent_id IS NULL) record stays supersedable by
    // any agent under the stage-1 rules alone.
    if (supersedesRecordId) {
      const old = this.#db.prepare("SELECT * FROM protected_memory_records WHERE record_id = ? AND thread_id = ?").get(supersedesRecordId, thread.threadId);
      if (!old) throw new ThreadMemoryValidationError(SUPERSESSION_REFUSAL);
      if (old.visibility === "AGENT" && old.agent_id !== recordAgentId) throw new ThreadMemoryValidationError(SUPERSESSION_REFUSAL);
      if (old.asserted_by_speaker_id !== speaker || old.subject_person_id !== person || old.status !== 'ACTIVE') throw new ThreadMemoryValidationError(SUPERSESSION_REFUSAL);
    }
    try {
      this.#db.transaction(() => {
      // BL-MEMOS-048: consumed first, inside the same transaction as the
      // INSERT (and any supersession UPDATE) below -- a replay rolls back
      // the whole write.
      this.#consumeNonce(thread.tenantId, nonce, grantExpiresAt);
      this.#db
        .prepare(`
          INSERT INTO protected_memory_records
            (record_id, tenant_id, thread_id, session_id, kind, status, asserted_by_speaker_id,
             subject_person_id, scope_json, body_json, source_message_refs_json,
             supersedes_record_id, verification_state, version, created_at, updated_at,
             agent_id, visibility)
          VALUES (@record_id, @tenant_id, @thread_id, @session_id, @kind, @status, @asserted_by_speaker_id,
             @subject_person_id, @scope_json, @body_json, @source_message_refs_json,
             @supersedes_record_id, @verification_state, 1, @created_at, @updated_at,
             @agent_id, @visibility)
        `)
        .run({
          record_id: recordId,
          tenant_id: thread.tenantId,
          thread_id: thread.threadId,
          session_id: sessionId,
          kind: memoryKind,
          status: memoryStatus,
          asserted_by_speaker_id: speaker,
          subject_person_id: person,
          scope_json: JSON.stringify(scopeValue),
          body_json: JSON.stringify(payload),
          source_message_refs_json: JSON.stringify(sourceRefs),
          supersedes_record_id: supersedesRecordId,
          verification_state: verification,
          created_at: timestamp,
          updated_at: timestamp,
          agent_id: recordAgentId,
          visibility: recordVisibility,
        });
      if (supersedesRecordId) {
        const changed = this.#db.prepare("UPDATE protected_memory_records SET status = 'SUPERSEDED', updated_at = ?, version = version + 1 WHERE record_id = ? AND status='ACTIVE' AND asserted_by_speaker_id=?").run(timestamp, supersedesRecordId, speaker);
        // PH-MEMOS-3 stage 2: the race-time variant of the same unified
        // refusal (BL-MEMOS-043) -- this was ThreadMemoryConflictError
        // ('conflict') in stage 1; folded into the identical
        // validation_failed answer as every other unsupersedable case.
        if (!changed.changes) throw new ThreadMemoryValidationError(SUPERSESSION_REFUSAL);
      }
      })();
    } catch (error) {
      // Defense in depth: trg_protected_memory_records_subject_rules is the
      // unconditional backstop for the same rule checked in JS above. Any
      // caller that reaches the trigger anyway (a defect in the JS checks,
      // or a future direct caller that bypasses them) still gets the typed
      // error, not a raw SqliteError.
      translateTriggerError(error);
    }
    const record = rowProtected(this.#db.prepare("SELECT * FROM protected_memory_records WHERE record_id = ?").get(recordId));
    // RKOI review (stage-2 revision, WARNING 6, §8.4): workspace_id is
    // grant.workspaceId, not the tenant_id placeholder -- see
    // appendMessage's identical fix for the full reasoning.
    this.#journalAppend({
      actor: principalHmac,
      toolName: "msp_thread_memory_record",
      ref: recordId,
      workspaceId: workspaceId || thread.tenantId,
      payload: { thread_id: thread.threadId, kind: memoryKind, source_count: sourceRefs.length },
      policyDecision: "allow",
    });
    return record;
  }

  // requesterSpeakerId is the private-read caller's own speaker id (the
  // guard sets it to grant.principalId only after confirming that principal
  // is the thread's current VERIFIED HUMAN participant). context() itself
  // enforces nothing about WHO may call it -- that authorization lives
  // entirely in the guard -- but it always filters protectedRecords to the
  // requester's own assertions once a requesterSpeakerId is given, so a
  // record with a null subject is visible only to its own asserter, never
  // to "every participant" (C-1).
  context({ threadId, recentExchangeCount = 6, currentExchangeId, requesterSpeakerId, requesterAgentId, now } = {}) {
    const thread = this.#requireThread(threadId);
    const count = positiveInteger(recentExchangeCount, "recent_exchange_count");
    const exchangeIds = this.#db.prepare(`SELECT exchange_id FROM thread_messages WHERE thread_id=? GROUP BY exchange_id
      HAVING MAX(direction='INBOUND')=1 AND MAX(direction='OUTBOUND' AND COALESCE((SELECT r.outcome FROM thread_delivery_receipts r WHERE r.message_id=thread_messages.message_id ORDER BY (r.outcome IN ('ACCEPTED','DELIVERED')) DESC, r.recorded_at DESC, r.rowid DESC LIMIT 1),delivery_state) IN ('ACCEPTED','DELIVERED'))=1
      ORDER BY MAX(sequence) DESC LIMIT ?`).all(thread.threadId, count).map((row) => row.exchange_id);
    const pending = currentExchangeId ?? this.#db.prepare(`SELECT i.exchange_id FROM thread_messages i WHERE i.thread_id=? AND i.direction='INBOUND'
      AND NOT EXISTS (SELECT 1 FROM thread_messages o WHERE o.thread_id=i.thread_id AND o.exchange_id=i.exchange_id AND o.direction='OUTBOUND')
      ORDER BY i.sequence DESC LIMIT 1`).get(thread.threadId)?.exchange_id;
    if (pending && !exchangeIds.includes(pending)) exchangeIds.unshift(pending);
    const selected = exchangeIds.length ? this.#db.prepare(`SELECT * FROM thread_messages WHERE thread_id=? AND exchange_id IN (${exchangeIds.map(() => '?').join(',')}) ORDER BY sequence`).all(thread.threadId, ...exchangeIds) : [];
    for (const row of selected) {
      const receipt = this.#db.prepare("SELECT * FROM thread_delivery_receipts WHERE message_id=? ORDER BY (outcome IN ('ACCEPTED','DELIVERED')) DESC, recorded_at DESC, rowid DESC LIMIT 1").get(row.message_id);
      if (receipt) { row.delivery_state = receipt.outcome; row.text = receipt.text; }
    }
    const exchanges = exchangeIds
      .reverse()
      .map((exchangeId) => ({ exchangeId, messages: selected.filter((row) => row.exchange_id === exchangeId).map(rowMessage) }));
    const summaries = this.#db.prepare("SELECT * FROM session_summaries s WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM thread_summary_invalidations i WHERE i.summary_id=s.summary_id) ORDER BY covered_through_sequence DESC").all(thread.threadId).map(rowSummary);
    // PH-MEMOS-3 stage 2 (BL-MEMOS-043, Sec.9.4): the agent-visibility
    // filter is ANDed onto the existing HUMAN private-read filter, not a
    // replacement for it -- a record must pass both. Corrected (RKOI
    // stage-2 review round 1, warning 5): an ABSENT requesterAgentId must
    // see THREAD records only, never fall through to showing every AGENT
    // record -- the earlier draft's `OR (no requesterAgentId)` clause made
    // the whole filter vacuously true whenever requesterAgentId happened
    // to be absent. Every stage-1 row is a legacy agent_id IS NULL,
    // visibility='THREAD' row by construction, so it always passes this
    // filter regardless -- stage-1 behaviour is unchanged.
    const protectedRecords = this.#db.prepare("SELECT * FROM protected_memory_records WHERE thread_id = ? AND status = 'ACTIVE' ORDER BY created_at ASC").all(thread.threadId).map(rowProtected)
      .filter((record) => !requesterSpeakerId || record.assertedBySpeakerId === requesterSpeakerId)
      .filter((record) => record.visibility === "THREAD" || (record.visibility === "AGENT" && !!requesterAgentId && record.agentId === requesterAgentId));
    const participants = this.#db.prepare("SELECT * FROM thread_participants WHERE thread_id = ? AND left_at IS NULL ORDER BY joined_at ASC").all(thread.threadId).map(rowParticipant);
    const session = this.#getOpenSession(thread.threadId);
    const firstRecentSequence = selected.length ? Math.min(...selected.map((row) => row.sequence)) : null;
    const ranges = [...summaries.flatMap((summary) => summary.coveredSequences?.map((sequence) => [sequence, sequence]) ?? [[summary.coveredFromSequence, summary.coveredThroughSequence]]), ...selected.map((row) => [row.sequence, row.sequence])].sort((a, b) => a[0] - b[0]);
    const missing = [];
    let coveredThrough = 0;
    for (const [from, through] of ranges) {
      if (from > coveredThrough + 1) missing.push({ fromSequence: coveredThrough + 1, throughSequence: from - 1 });
      coveredThrough = Math.max(coveredThrough, through);
    }
    const lastSequence = this.#db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM thread_messages WHERE thread_id=?').get(thread.threadId).n;
    if (lastSequence > coveredThrough) missing.push({ fromSequence: coveredThrough + 1, throughSequence: lastSequence });
    return {
      thread: rowThread(this.#db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(thread.threadId)),
      session: rowSession(session),
      recentExchangeCount: exchanges.length,
      recentExchanges: exchanges,
      participants,
      threadSummaries: summaries.map((summary) => ({
        ...summary,
        overlapsRecent: firstRecentSequence !== null && summary.coveredThroughSequence >= firstRecentSequence,
      })),
      protectedRecords,
      coverageGap: missing.length ? { ...missing[0], ranges: missing, reason: 'no_committed_source_coverage' } : null,
      asOf: iso(now),
    };
  }

  // RKOI review, CRITICAL 1: the room hash no longer depends on
  // channel_type (see hmacRoomRef's header comment), so it can be computed
  // ONCE from the caller's own filter fields and bound directly into the
  // SQL, rather than re-derived per candidate row.
  sweepIdleSessions({ now, limit = 100, tenantId, businessId, channelAccountId, externalRoomRef, nonce, grantExpiresAt, workspaceId = null } = {}) {
    const timestamp = iso(now);
    const tenant = requiredString(tenantId, "tenant_id");
    const max = positiveInteger(limit, "limit");
    const roomHmac = externalRoomRef ? this.#hmacRoomRef({ tenantId, channelAccountId, externalRoomRef }) : null;
    const due = this.#db.prepare(`SELECT s.* FROM chat_sessions s JOIN threads t ON s.thread_id=t.thread_id
      WHERE s.status='OPEN' AND s.idle_deadline<=? AND (? IS NULL OR t.tenant_id=?)
      AND (?=0 OR t.business_id IS ?) AND (? IS NULL OR t.channel_account_id=?)
      AND (? IS NULL OR t.external_room_ref_hmac=?)
      ORDER BY s.idle_deadline ASC LIMIT ?`)
      .all(timestamp, tenantId ?? null, tenantId ?? null, businessId === undefined ? 0 : 1, businessId ?? null,
        channelAccountId ?? null, channelAccountId ?? null, roomHmac, roomHmac, max);
    // RKOI review (stage-2 revision, WARNING 7b): the nonce is consumed
    // inside THIS SAME transaction, immediately before the mutation it
    // guards -- not in an earlier, separate transaction before validation
    // (tenant_id/limit) and the `due` query even ran, which would have
    // wasted the nonce on a call that later failed for an unrelated
    // reason, or committed it with nothing tying it to this specific
    // mutation.
    const jobs = this.#db.transaction(() => {
      this.#consumeNonce(tenant, nonce, grantExpiresAt);
      return due.map((session) => this.#closeIdleSession(session, timestamp)).filter(Boolean);
    })();
    // RKOI review (stage-2 revision, WARNING 6, §8.4): workspace_id is the
    // sweeping operator/worker's own grant.workspaceId, not job.tenant_id
    // -- sweep's actor stays the fixed "msp:session-router" system label
    // (it spans many threads/agents at once, per DEC-MEMOS-18), but
    // workspace_id is real operational information once workspaceId is a
    // required grant claim.
    for (const job of jobs) {
      this.#journalAppend({ actor: "msp:session-router", toolName: "msp_session_sweep", ref: job.job_id, workspaceId: workspaceId || job.tenant_id, payload: { session_id: job.session_id, source_end_sequence: job.source_end_sequence }, policyDecision: "allow" });
    }
    // PH-MEMOS-3 stage 2 (BL-MEMOS-042, RKOI stage-2 review round 2, finding
    // 6): thread_kind/channel_type join the job's own columns here (not
    // added to #jobResult itself, which claim/commit/retry also use and
    // whose response shapes this design does not change) -- both are
    // non-sensitive, room-scoped, and let the worker construct its own
    // subsequent msp_thread_resolve call for this job's room, which
    // requires both fields.
    const ready = this.#db.prepare(`SELECT j.*, t.thread_kind AS thread_kind, t.channel_type AS channel_type FROM session_compaction_jobs j JOIN threads t ON j.thread_id=t.thread_id
      WHERE (j.status IN ('PENDING','RETRYABLE') OR (j.status='RUNNING' AND j.leased_until<=?))
      AND (? IS NULL OR t.tenant_id=?) AND (?=0 OR t.business_id IS ?)
      AND (? IS NULL OR t.channel_account_id=?)
      AND (? IS NULL OR t.external_room_ref_hmac=?)
      ORDER BY j.created_at LIMIT ?`).all(timestamp, tenantId ?? null, tenantId ?? null,
        businessId === undefined ? 0 : 1, businessId ?? null, channelAccountId ?? null, channelAccountId ?? null,
        roomHmac, roomHmac, max);
    return { closed: jobs.length, jobs: ready.map((job) => ({ ...this.#jobResult(job), threadKind: job.thread_kind, channelType: job.channel_type })) };
  }

  commitCompaction({
    sessionId,
    jobId = null,
    sourceStartSequence,
    sourceEndSequence,
    summary,
    sourceDigest = null,
    policyRevision,
    summarizerVersion,
    invocationState,
    leaseToken,
    agentId = null,
    workspaceId = null,
    nonce,
    grantExpiresAt,
    now,
  } = {}) {
    const sessionRef = requiredString(sessionId, "session_id");
    requiredString(jobId, 'job_id');
    requiredString(leaseToken, 'lease_token');
    requiredString(sourceDigest, 'source_digest');
    const start = nonNegativeInteger(sourceStartSequence, "source_start_sequence");
    const end = positiveInteger(sourceEndSequence, "source_end_sequence");
    if (end < start) throw new ThreadMemoryValidationError("source_end_sequence must be >= source_start_sequence.");
    if (requiredString(invocationState, "invocation_state").toUpperCase() !== "TERMINAL") throw new ThreadMemoryConflictError("Compaction requires a terminal model invocation.");
    const policy = requiredString(policyRevision, "policy_revision");
    const summarizer = requiredString(summarizerVersion, "summarizer_version");
    const timestamp = iso(now);
    const session = this.#getSession(sessionRef);
    if (!session) throw new ThreadMemoryValidationError("Unknown session_id.");
    const thread = this.#requireThread(session.thread_id);
    if (jobId) {
      const done = this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE job_id=? AND session_id=? AND status='COMMITTED'").get(jobId, sessionRef);
      if (done) {
        if (this.#db.prepare('SELECT 1 FROM thread_summary_invalidations WHERE summary_id=?').get(done.summary_id)) throw new ThreadMemoryConflictError('Committed summary was invalidated by later evidence.');
        const stored = rowSummary(this.#db.prepare('SELECT * FROM session_summaries WHERE summary_id=?').get(done.summary_id));
        const sources = this.#sourceRows(sessionRef, start, end);
        if (stored.sourceDigest !== sourceDigest || stored.coveredFromSequence !== start || stored.coveredThroughSequence !== end ||
            stored.policyRevision !== policy || stored.summarizerVersion !== summarizer ||
            JSON.stringify(stored.summary) !== JSON.stringify(this.#validateSummary(summary, sources))) throw new ThreadMemoryConflictError('Committed job retry differs.');
        // BL-MEMOS-048: the already-committed retry short-circuit is not
        // itself a write, but commit is still nonce-required.
        this.#db.transaction(() => this.#consumeNonce(thread.tenantId, nonce, grantExpiresAt))();
        return { summary: stored, jobId: done.job_id };
      }
    }
    if (session.status !== "CLOSING") throw new ThreadMemoryConflictError("Only a CLOSING session can be compacted.");
    const job = jobId
      ? this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE job_id = ? AND session_id = ?").get(jobId, sessionRef)
      : this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE session_id = ? AND status IN ('PENDING', 'RUNNING', 'RETRYABLE') ORDER BY created_at DESC LIMIT 1").get(sessionRef);
    if (!job) throw new ThreadMemoryConflictError("No pending compaction job exists for session_id.");
    if (job.status !== 'RUNNING' || job.lease_token !== leaseToken || Date.parse(job.leased_until) <= Date.parse(timestamp)) throw new CompactionLeaseConflictError('Compaction lease is stale.');
    if (job.source_start_sequence !== start || job.source_end_sequence !== end) throw new ThreadMemoryConflictError("Compaction source range does not match the leased job.");
    if (session.latest_sequence < end) throw new ThreadMemoryConflictError("Compaction cannot cover messages that have not been durably appended.");
    const sourceRows = this.#sourceRows(sessionRef, start, end);
    if (!sourceRows.length) throw new ThreadMemoryValidationError("Compaction source range contains no messages.");
    const digest = sha256(JSON.stringify(sourceRows));
    if (sourceDigest && sourceDigest.toLowerCase() !== digest) throw new ThreadMemoryValidationError('source_digest does not match the durable source.');
    const summaryPayload = this.#validateSummary(summary, sourceRows);

    const result = this.#db.transaction(() => {
      // BL-MEMOS-048: consumed first, inside the same transaction as the
      // summary INSERT and job/session UPDATEs below.
      this.#consumeNonce(thread.tenantId, nonce, grantExpiresAt);
      const current = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(job.job_id);
      if (current.status !== 'RUNNING' || current.lease_token !== leaseToken || Date.parse(current.leased_until) <= Date.parse(timestamp) ||
          current.source_start_sequence !== start || current.source_end_sequence !== end) throw new CompactionLeaseConflictError('Compaction lease changed.');
      if (sha256(JSON.stringify(this.#sourceRows(sessionRef, start, end))) !== digest) throw new ThreadMemoryConflictError('Compaction source changed.');
      const previous = this.#db.prepare("SELECT * FROM session_summaries WHERE thread_id = ? ORDER BY covered_through_sequence DESC LIMIT 1").get(session.thread_id);
      const versionRow = this.#db.prepare("SELECT COALESCE(MAX(summary_version), 0) AS version FROM session_summaries WHERE session_id = ?").get(sessionRef);
      const summaryId = ref("summary");
      this.#db.prepare(`
        INSERT INTO session_summaries
          (summary_id, tenant_id, session_id, thread_id, summary_version, covered_from_sequence,
           covered_through_sequence, source_digest, previous_summary_id, summary_json,
           policy_revision, summarizer_version, created_at, covered_sequences_json)
        VALUES (@summary_id, @tenant_id, @session_id, @thread_id, @summary_version, @covered_from_sequence,
           @covered_through_sequence, @source_digest, @previous_summary_id, @summary_json,
           @policy_revision, @summarizer_version, @created_at, @covered_sequences_json)
      `).run({
        summary_id: summaryId,
        tenant_id: thread.tenantId,
        session_id: sessionRef,
        thread_id: session.thread_id,
        summary_version: Number(versionRow.version) + 1,
        covered_from_sequence: start,
        covered_through_sequence: end,
        source_digest: digest,
        previous_summary_id: previous?.summary_id ?? null,
        summary_json: JSON.stringify(summaryPayload),
        policy_revision: policy,
        summarizer_version: summarizer,
        created_at: timestamp,
        covered_sequences_json: JSON.stringify(sourceRows.map((row) => row.sequence)),
      });
      this.#db.prepare("UPDATE session_compaction_jobs SET status = 'COMMITTED', summary_id = ?, updated_at = ?, last_error = NULL WHERE job_id = ?").run(summaryId, timestamp, job.job_id);
      this.#db.prepare("UPDATE chat_sessions SET status = 'CLOSED', closed_at = ?, summary_watermark = ?, version = version + 1 WHERE session_id = ?").run(timestamp, end, sessionRef);
      // A new session may have opened while this job was being summarized.
      // Advance its prefix watermark too, so the next job does not compact
      // the same messages a second time.
      this.#db.prepare("UPDATE chat_sessions SET summary_watermark = MAX(summary_watermark, ?), version = version + 1 WHERE thread_id = ? AND status = 'OPEN'").run(end, session.thread_id);
      return { summaryId, summaryVersion: Number(versionRow.version) + 1 };
    })();
    // PH-MEMOS-3 stage 2 (§8.3/§8.4): the worker's own agentId replaces the
    // "msp:compaction-worker" fixed label -- the claiming/committing worker
    // is now a real, current, attributable agent of the job's thread, not
    // an anonymous system process. Falls back to the old fixed label when
    // no agentId was supplied (unguarded business-logic tests). RKOI review
    // (stage-2 revision, WARNING 6): workspace_id is likewise the worker's
    // own grant.workspaceId, not the tenant_id placeholder.
    this.#journalAppend({ actor: agentId || "msp:compaction-worker", toolName: "msp_session_compaction_commit", ref: result.summaryId, workspaceId: workspaceId || thread.tenantId, payload: { session_id: sessionRef, job_id: job.job_id, through_sequence: end }, policyDecision: "allow" });
    return { summary: rowSummary(this.#db.prepare("SELECT * FROM session_summaries WHERE summary_id = ?").get(result.summaryId)), jobId: job.job_id };
  }

  claimCompaction({ jobId, workerId, leaseSeconds = 120, nonce, grantExpiresAt, now } = {}) {
    const timestamp = iso(now);
    const worker = requiredString(workerId, 'worker_id');
    const seconds = positiveInteger(leaseSeconds, 'lease_seconds');
    if (seconds > 300) throw new ThreadMemoryValidationError('lease_seconds exceeds 300.');
    return this.#db.transaction(() => {
      const job = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(requiredString(jobId, 'job_id'));
      if (!job || ['COMMITTED', 'FAILED'].includes(job.status)) throw new CompactionLeaseConflictError('Job is missing or terminal.');
      // BL-MEMOS-048: consumed inside the same transaction as the lease
      // UPDATE below, once the job is known to exist -- an unknown job_id
      // is refused before ever touching a real tenant's nonce ledger.
      this.#consumeNonce(job.tenant_id, nonce, grantExpiresAt);
      if (job.status === 'RUNNING' && Date.parse(job.leased_until) > Date.parse(timestamp)) throw new CompactionLeaseConflictError('Job already leased.');
      // Model requests expire explicitly after two minutes; a live request must
      // finish before the summarizer can acquire the transcript.
      const invocations = this.#db.prepare("SELECT r.* FROM thread_injection_receipts r WHERE r.state IN ('RESOLVED','SUBMITTED') AND EXISTS (SELECT 1 FROM thread_messages m WHERE m.session_id=? AND m.exchange_id=r.exchange_id AND m.thread_id=r.thread_id)").all(job.session_id);
      if (invocations.some((r) => Date.parse(r.updated_at) + 120_000 > Date.parse(timestamp))) throw new ThreadMemoryConflictError('Reply invocation is still active.');
      for (const r of invocations) this.#db.prepare("UPDATE thread_injection_receipts SET state='UNKNOWN',version=version+1,updated_at=? WHERE injection_id=?").run(timestamp, r.injection_id);
      const pending = this.#sourceRows(job.session_id, job.source_start_sequence, job.source_end_sequence);
      const last = this.#db.prepare('SELECT MAX(received_at) AS at FROM thread_messages WHERE session_id=?').get(job.session_id).at;
      const awaitingReply = pending.some((r) => r.direction === 'INBOUND' && !pending.some((o) => o.direction === 'OUTBOUND' && o.exchange_id === r.exchange_id)) || pending.some((r) => r.direction === 'OUTBOUND' && r.delivery_state === 'QUEUED');
      if (awaitingReply && Date.parse(last) + 120_000 > Date.parse(timestamp)) throw new ThreadMemoryConflictError('Reply receipt deadline has not elapsed.');
      const token = ref('lease');
      const until = new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
      this.#db.prepare("UPDATE session_compaction_jobs SET status='RUNNING', lease_token=?, worker_id=?, leased_until=?, attempts=attempts+1, invocation_state='RUNNING', updated_at=? WHERE job_id=?")
        .run(token, worker, until, timestamp, job.job_id);
      const sources = this.#sourceRows(job.session_id, job.source_start_sequence, job.source_end_sequence);
      // RKOI review, item 11: the claim response never includes protected
      // records -- a summarizer worker has no business reading them
      // (msp_thread_context, the private-read-gated tool, is the only
      // reader), and this lease is the one artifact a claim response
      // hands to an arbitrary worker process.
      return { ...this.#jobResult(job), status: 'RUNNING', leaseToken: token, leasedUntil: until, sources,
        sourceDigest: sha256(JSON.stringify(sources)) };
    })();
  }

  recordDelivery({ inboundMessageId, sourceEventId, receiptId, outcome, text, providerRef, scope, nonce, grantExpiresAt, now } = {}) {
    const inboundId = requiredString(inboundMessageId, 'inbound_message_id');
    if (sourceEventId !== `${inboundId}:assistant`) throw new ThreadMemoryValidationError('Delivery source must name its inbound message.');
    const state = enumValue(outcome, new Set(['ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN']), 'outcome');
    const id = requiredString(receiptId, 'receipt_id');
    const body = boundedText(text, 'text');
    const timestamp = iso(now);
    const inbound = this.#db.prepare("SELECT * FROM thread_messages WHERE message_id=? AND direction='INBOUND'").get(inboundId);
    if (!inbound) {
      if (!scope?.tenantId || !scope.channelAccountId || !scope.externalRoomRef) throw new ThreadMemoryValidationError('Delivery scope is required.');
      const roomHmac = this.#hmacRoomRef({ tenantId: scope.tenantId, channelAccountId: scope.channelAccountId, externalRoomRef: scope.externalRoomRef });
      const old = this.#db.prepare('SELECT * FROM thread_pending_deliveries WHERE receipt_id=?').get(id);
      if (old) {
        // RKOI code review round 2, WARNING 4: a receipt_id colliding with
        // a DIFFERENT tenant's pending delivery answers with the exact same
        // generic conflict text every other caller-supplied global id
        // collision uses (message_id/exchange_id/injection_id) -- never a
        // scenario-specific message a caller could use to tell "this id
        // belongs to someone else" apart from "this id is my own but with
        // different content". This is cheap to fix and does not change the
        // outcome (still a conflict either way), only the message text.
        // It does NOT hide the residual existence-oracle inherent to any
        // globally unique caller-supplied id: a truly UNUSED receipt_id
        // still succeeds outright as PENDING_INBOUND below, so a caller can
        // still tell "taken" from "free" by outcome alone. receipt_id has
        // no stage-1 keyring binding it to a tenant before this call, so
        // that residual gap is recorded, not fixed. RKOI ruled (code review
        // round 3) that this leftover outcome-level oracle across the five
        // caller-supplied global ids (receipt_id, exchange_id, message_id,
        // injection_id, inbound_message_id) is accepted as low severity for
        // stage 1 -- see RSK-MEMOS-09 in docs/IMPLEMENTATION-PLAN-MEMORY-OS.md.
        if (old.tenant_id !== scope.tenantId) {
          throw new ThreadMemoryConflictError('That identifier is already in use.');
        }
        if (old.inbound_message_id !== inboundId || old.business_id !== (scope.businessId ?? null) ||
          old.channel_account_id !== scope.channelAccountId || old.external_room_ref_hmac !== roomHmac || old.text !== body || old.outcome !== state) {
          throw new ThreadMemoryConflictError('Pending receipt retry differs.');
        }
      }
      // RKOI review (docs round 4), item 2: ON CONFLICT(receipt_id), not OR
      // IGNORE, so this only ever suppresses the intended idempotent-retry
      // collision on receipt_id -- never a NOT NULL violation on tenant_id.
      // PH-MEMOS-3 stage 2 (BL-MEMOS-112): agent_id/workspace_id are
      // stamped onto the pending row here -- nullable at the schema level
      // (a pre-stage-2 legacy row has neither), but the guard's own
      // currency check (thread-guard.mjs) already guarantees a real
      // caller reaching this line always has both. BL-MEMOS-048: the
      // pending insert is now wrapped in its own transaction so it commits
      // or rolls back together with its nonce consumption -- nonce is
      // only ever consumed for a LIVE (guarded) call; there is no grant,
      // and nothing to replay-check, for #drainDeliveries' own internal
      // call (which never sets one).
      this.#db.transaction(() => {
        if (nonce) this.#consumeNonce(scope.tenantId, nonce, grantExpiresAt);
        this.#db.prepare('INSERT INTO thread_pending_deliveries(receipt_id,inbound_message_id,source_event_id,tenant_id,business_id,channel_account_id,external_room_ref_hmac,outcome,text,provider_ref,recorded_at,agent_id,workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(receipt_id) DO NOTHING')
          .run(id, inboundId, sourceEventId, scope.tenantId, scope.businessId ?? null, scope.channelAccountId, roomHmac, state, body, providerRef ?? null, timestamp, scope.agentId ?? null, scope.workspaceId ?? null);
      })();
      return { receiptId: id, status: 'PENDING_INBOUND' };
    }
    const thread = this.#requireThread(inbound.thread_id);
    if (scope) {
      const roomHmac = scope.__precomputedHmac ?? this.#hmacRoomRef({ tenantId: scope.tenantId, channelAccountId: scope.channelAccountId, externalRoomRef: scope.externalRoomRef });
      if (thread.tenantId !== scope.tenantId || thread.businessId !== (scope.businessId ?? null) || thread.channelAccountId !== scope.channelAccountId || thread.externalRoomRefHmac !== roomHmac) {
        throw new ThreadMemoryConflictError('Delivery scope differs.');
      }
    }
    // PH-MEMOS-3 stage 2 (BL-MEMOS-112, CRITICAL 1): re-verified here for
    // BOTH callers of this RESOLVED path -- the live guarded call (already
    // checked once by thread-guard.mjs's general currency gate, so this is
    // harmless defense in depth) and #drainDeliveries' internal call
    // (which has no guard at all, so this is the ONLY enforcement point).
    // scope.agentId is grant.agentId on a live call, or the STORED pending
    // row's own agent_id on a drain re-check (#drainDeliveries threads it
    // through as such) -- a missing agentId (a legacy NULL-agent pending
    // row) fails this identically to a departed one: neither ever
    // satisfies "is this agent current," by construction, not a special
    // case.
    const deliveryAgentCurrent =
      scope?.agentId &&
      this.#db.prepare("SELECT 1 FROM thread_agents WHERE thread_id = ? AND agent_id = ? AND workspace_id = ? AND left_at IS NULL").get(thread.threadId, scope.agentId, scope.workspaceId);
    if (!deliveryAgentCurrent) {
      throw new AgentNotCurrentError();
    }
    try {
    return this.#db.transaction(() => {
    // BL-MEMOS-048: consumed first, inside the transaction -- only for a
    // LIVE (guarded) call; #drainDeliveries' internal call has no grant
    // and never sets one.
    if (nonce) this.#consumeNonce(thread.tenantId, nonce, grantExpiresAt);
    let message = this.#db.prepare("SELECT * FROM thread_messages WHERE thread_id=? AND source_event_id=? AND direction='OUTBOUND'").get(thread.threadId, sourceEventId);
    if (!message) {
      // PH-MEMOS-3 stage 2 (§8.2, finding 3): never a fixed label -- the
      // resolved (live) path speaks as the calling agent (grant.agentId,
      // threaded in here as scope.agentId); a drained pending row speaks
      // as whichever agent queued it (the STORED agent_id, also threaded
      // in as scope.agentId by #drainDeliveries -- there is no live caller
      // at drain time to ask for a fresh one). RKOI review (stage-2
      // revision round 2, W6 leftover): workspace_id on this append's own
      // journal entry is likewise scope.workspaceId -- the calling agent's
      // real workspace on a live call, or the STORED pending row's own
      // workspace_id on a drain -- never appendMessage's own tenant_id
      // fallback (which only applies when no workspaceId is given at
      // all).
      const appended = this.appendMessage({ threadId: inbound.thread_id, sessionId: inbound.session_id, exchangeId: inbound.exchange_id,
        replyToMessageId: inboundId, sourceEventId, speakerId: scope.agentId, speakerKind: 'AGENT', identityAssurance: 'VERIFIED',
        direction: 'OUTBOUND', text: body, deliveryState: state, reconcileDelivery: true, agentId: scope.agentId, workspaceId: scope.workspaceId, now });
      message = this.#db.prepare('SELECT * FROM thread_messages WHERE message_id=?').get(appended.message.messageId);
    }
    const existing = this.#db.prepare('SELECT * FROM thread_delivery_receipts WHERE receipt_id=?').get(id);
    if (existing) {
      if (existing.message_id !== message.message_id || existing.text !== body || existing.outcome !== state || existing.provider_ref !== (providerRef ?? null)) throw new ThreadMemoryConflictError('Delivery receipt retry differs.');
      return { receiptId: id, messageId: message.message_id, outcome: state, deduplicated: true };
    }
    this.#db.prepare('INSERT INTO thread_delivery_receipts(receipt_id,tenant_id,message_id,outcome,text,provider_ref,recorded_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, thread.tenantId, message.message_id, state, body, providerRef ?? null, iso(now));
    this.#refreshSummaryAfterDelivery(message.session_id, iso(now));
    // RKOI review, item 6: a pending delivery is never deleted, even once
    // reconciled -- it transitions reconcile_state 'pending' -> 'reconciled'
    // (migrations/0008_thread_memory.sql's
    // trg_thread_pending_deliveries_update_guard permits only that
    // transition, or a tombstone redaction), leaving an operational trail
    // even though the receipt itself has been folded into
    // thread_delivery_receipts above.
    this.#db.prepare("UPDATE thread_pending_deliveries SET reconcile_state='reconciled' WHERE receipt_id=? AND reconcile_state='pending'").run(id);
    return { receiptId: id, messageId: message.message_id, outcome: state, deduplicated: false };
    })();
    } catch (error) {
      translateTriggerError(error);
    }
  }

  #drainDeliveries(inboundId) {
    for (const row of this.#db.prepare(`SELECT p.* FROM thread_pending_deliveries p
      JOIN thread_messages m ON m.message_id=p.inbound_message_id JOIN threads t ON t.thread_id=m.thread_id
      WHERE p.inbound_message_id=? AND p.reconcile_state='pending' AND p.tenant_id=t.tenant_id AND p.business_id IS t.business_id
      AND p.channel_account_id=t.channel_account_id AND p.external_room_ref_hmac=t.external_room_ref_hmac`).all(inboundId)) {
      try {
        // PH-MEMOS-3 stage 2 (§8.2 CRITICAL 1, RKOI stage-2 review round 2,
        // finding 4): the STORED (agent_id, workspace_id) pair -- never a
        // freshly re-derived one -- is threaded through as scope.agentId/
        // workspaceId, so recordDelivery's own currency re-check runs
        // against the INBOUND MESSAGE's own thread (thread.threadId,
        // resolved from inboundId inside recordDelivery itself) using the
        // agent that queued this row, not whichever agent (if any) happens
        // to be current right now. A NULL stored agent_id (a legacy,
        // pre-stage-2 pending row) flows through unchanged and fails the
        // same currency check identically to a departed agent.
        this.recordDelivery({ inboundMessageId: inboundId, sourceEventId: row.source_event_id, receiptId: row.receipt_id, outcome: row.outcome,
          text: row.text, providerRef: row.provider_ref, now: row.recorded_at,
          scope: { tenantId: row.tenant_id, businessId: row.business_id, channelAccountId: row.channel_account_id, externalRoomRef: null, __precomputedHmac: row.external_room_ref_hmac, agentId: row.agent_id, workspaceId: row.workspace_id } });
      } catch (error) {
        // RKOI code review round 3: reconciliation is best-effort from the
        // append's point of view. RKOI's r3/q1.mjs showed a pending
        // receipt_id that collides with an UNRELATED tenant's already
        // -delivered receipt (thread_delivery_receipts.receipt_id is a
        // global namespace, same as message_id/exchange_id/injection_id --
        // see RSK-MEMOS-09 in docs/IMPLEMENTATION-PLAN-MEMORY-OS.md) can
        // make recordDelivery throw here, AFTER this append's own INSERT
        // has already committed. That must never fail, or retroactively
        // unwind, the append that already succeeded -- #drainDeliveries
        // runs once per pending row, after the append's own transaction,
        // specifically so a reconcile failure on one row can never touch
        // the message it is trying to attach a receipt to. The
        // unreconcilable row is left exactly as it was (recordDelivery's
        // own transaction rolled back before ever reaching the
        // reconcile_state='reconciled' UPDATE) for a later drain attempt --
        // this append's caller still sees its own successful result.
        //
        // RKOI's confirmation pass: absorbing every error here means an
        // operator reading this journal entry could not tell a receipt_id
        // collision apart from a real storage fault -- record a STABLE
        // code, never the free-text message (which can vary run to run and
        // is not part of any typed vocabulary). Our own typed errors
        // (ThreadConflictError et al, thrown by recordDelivery/
        // translateTriggerError) always set `.code` to one of the fixed
        // reason strings in errors.mjs (e.g. "conflict"); a raw driver
        // error (e.g. better-sqlite3's SqliteError) sets `.code` to its own
        // fixed string too (e.g. "SQLITE_BUSY"). Anything without a
        // string `.code` at all falls back to the fixed "internal" label.
        const errorCode = typeof error?.code === "string" && error.code ? error.code : "internal";
        // RKOI review (stage-2 revision round 2, W6 leftover): workspace_id
        // is the STORED pending row's own workspace_id -- the agent that
        // queued it, whether or not the reconcile itself succeeded --
        // falling back to row.tenant_id only for a legacy row that
        // predates workspace_id existing on this table at all (NULL).
        this.#journalAppend({
          actor: "msp:delivery-drain",
          toolName: "msp_thread_message_append.reconcile_skipped",
          ref: inboundId,
          workspaceId: row.workspace_id || row.tenant_id,
          payload: { receipt_id: row.receipt_id, reconciled: false, error_code: errorCode },
          policyDecision: "allow",
        });
      }
    }
  }

  #refreshSummaryAfterDelivery(sessionId, timestamp) {
    const session = this.#getSession(sessionId);
    if (session.status === 'OPEN') return;
    // RKOI review (docs round 4), item 2: `INSERT OR IGNORE` also swallows a
    // NOT NULL violation, not just the intended PRIMARY KEY (summary_id)
    // idempotent-retry collision (probe V1' showed a dropped row with
    // changes=0 and no error). `ON CONFLICT(summary_id) DO NOTHING` keeps
    // the retry idempotent while still raising on any other constraint
    // failure.
    this.#db
      .prepare(
        "INSERT INTO thread_summary_invalidations(summary_id,tenant_id,reason,recorded_at) SELECT summary_id,tenant_id,'DELIVERY_RECONCILED',? FROM session_summaries WHERE session_id=? ON CONFLICT(summary_id) DO NOTHING",
      )
      .run(timestamp, sessionId);
    const active = this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE session_id=? AND status IN ('PENDING','RETRYABLE','RUNNING')").get(sessionId);
    if (active) {
      this.#db.prepare("UPDATE session_compaction_jobs SET status='RETRYABLE',lease_token=NULL,leased_until=NULL,source_end_sequence=?,updated_at=? WHERE job_id=?").run(session.latest_sequence, timestamp, active.job_id);
    } else {
      const start = this.#db.prepare('SELECT MIN(sequence) AS n FROM thread_messages WHERE session_id=?').get(sessionId).n;
      this.#db.prepare("INSERT INTO session_compaction_jobs(job_id,tenant_id,session_id,thread_id,status,source_start_sequence,source_end_sequence,idempotency_key,attempts,created_at,updated_at) VALUES(?,?,?,?,'PENDING',?,?,?,0,?,?)")
        .run(ref('compaction-job'), session.tenant_id, sessionId, session.thread_id, start, session.latest_sequence, ref('delivery-amendment'), timestamp, timestamp);
    }
    this.#db.prepare("UPDATE chat_sessions SET status='CLOSING',closed_at=NULL,summary_watermark=0,version=version+1 WHERE session_id=?").run(sessionId);
  }

  recordInjection({ threadId, exchangeId, injectionId, packetHash, policyRevision, modelRef, state, nonce, grantExpiresAt, now } = {}) {
    const thread = this.#requireThread(threadId);
    const id = requiredString(injectionId, 'injection_id');
    const hash = requiredString(packetHash, 'packet_hash');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ThreadMemoryValidationError('packet_hash must be SHA-256.');
    const status = enumValue(state, new Set(['RESOLVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN']), 'state');
    const exchange = this.#db.prepare('SELECT 1 FROM thread_messages WHERE thread_id=? AND exchange_id=?').get(threadId, exchangeId);
    if (!exchange) throw new ThreadMemoryValidationError('Unknown exchange_id for thread.');
    const timestamp = iso(now);
    try {
    return this.#db.transaction(() => {
      // BL-MEMOS-048: consumed first, inside the transaction, on every
      // outcome including the same-state no-op just below -- a replay is
      // refused even when the call would otherwise be idempotent.
      this.#consumeNonce(thread.tenantId, nonce, grantExpiresAt);
      const old = this.#db.prepare('SELECT * FROM thread_injection_receipts WHERE injection_id=?').get(id);
      if (!old && status === 'RESOLVED') {
        const session = this.#db.prepare('SELECT s.* FROM chat_sessions s JOIN thread_messages m ON m.session_id=s.session_id WHERE m.thread_id=? AND m.exchange_id=? LIMIT 1').get(threadId, exchangeId);
        if (session.status === 'CLOSED' || this.#db.prepare("SELECT 1 FROM session_compaction_jobs WHERE session_id=? AND status='RUNNING'").get(session.session_id)) throw new ThreadMemoryConflictError('Session is sealed or leased for summary.');
      }
      if (old && (old.thread_id !== threadId || old.exchange_id !== exchangeId || old.packet_hash !== hash || old.policy_revision !== policyRevision || old.model_ref !== modelRef)) throw new ThreadMemoryConflictError('Injection identity differs.');
      if (old?.state === status) return { injectionId: id, state: status, version: old.version };
      const allowed = { RESOLVED: ['SUBMITTED', 'FAILED'], SUBMITTED: ['COMPLETED', 'FAILED', 'UNKNOWN'] };
      if ((!old && status !== 'RESOLVED') || (old && !allowed[old.state]?.includes(status))) throw new ThreadMemoryConflictError('Invalid injection receipt transition.');
      if (!old) this.#db.prepare('INSERT INTO thread_injection_receipts(injection_id,tenant_id,thread_id,exchange_id,packet_hash,policy_revision,model_ref,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, thread.tenantId, threadId, exchangeId, hash, requiredString(policyRevision, 'policy_revision'), requiredString(modelRef, 'model_ref'), status, iso(now));
      else this.#db.prepare('UPDATE thread_injection_receipts SET state=?,updated_at=?,version=version+1 WHERE injection_id=?').run(status, iso(now), id);
      return { injectionId: id, state: status, version: (old?.version ?? 0) + 1 };
    })();
    } catch (error) {
      translateTriggerError(error);
    }
  }

  retryCompaction({ jobId, error, leaseToken, nonce, grantExpiresAt, now } = {}) {
    const id = requiredString(jobId, "job_id");
    const message = requiredString(error, "error").slice(0, 1000);
    const timestamp = iso(now);
    // RKOI review, item 11: retry always requires the lease token, checked
    // separately from -- not folded silently into -- the expiry check
    // against the server's own clock (`timestamp`, W1-gated).
    if (!leaseToken) throw new ThreadMemoryValidationError('lease_token is required to retry a compaction job.');
    const job = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(id);
    if (!job) throw new CompactionLeaseConflictError('Compaction lease is stale.');
    // BL-MEMOS-048: retryCompaction gained its own transaction here so the
    // lease UPDATE and its nonce consumption commit or roll back together
    // -- previously two bare, unwrapped statements.
    //
    // RKOI review (stage-2 revision, WARNING 3, test gap #1): the nonce is
    // consumed FIRST, inside the transaction, BEFORE the lease/status
    // staleness re-check below -- not before the transaction, against a
    // snapshot of `job` read before it even opened. A single successful
    // retry moves the job's own status from RUNNING to RETRYABLE, which
    // means a literal REPLAY (the identical signed request, same nonce)
    // would otherwise hit a "lease is stale" error from the CHANGED job
    // state before ever reaching the nonce check -- masking the replay as
    // an ordinary lease conflict instead of the dedicated grant_replayed
    // this tool is required to answer. Consuming the nonce first, and
    // re-reading the job's CURRENT state only after that succeeds, means a
    // true replay is always caught by the PRIMARY KEY conflict first,
    // regardless of what the job's own state has done since the original
    // call; a genuinely stale lease (a different nonce) still rolls the
    // nonce insert back along with everything else in this same
    // transaction, so it is never wasted.
    return this.#db.transaction(() => {
      this.#consumeNonce(job.tenant_id, nonce, grantExpiresAt);
      const current = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(id);
      if (current.status !== 'RUNNING' || current.lease_token !== leaseToken || Date.parse(current.leased_until) <= Date.parse(timestamp)) {
        throw new CompactionLeaseConflictError('Compaction lease is stale.');
      }
      const result = this.#db.prepare("UPDATE session_compaction_jobs SET status = 'RETRYABLE', invocation_state='FAILED', last_error = ?, updated_at = ? WHERE job_id = ? AND status='RUNNING' AND lease_token=? AND leased_until>?").run(message, timestamp, id, leaseToken, timestamp);
      if (!result.changes) throw new CompactionLeaseConflictError("Compaction job is missing or already terminal.");
      return this.#jobResult(this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE job_id = ?").get(id));
    })();
  }

  #sourceRows(sessionId, start, end) {
    const rows = this.#db.prepare('SELECT message_id, sequence, exchange_id, speaker_id, direction, delivery_state, text FROM thread_messages WHERE session_id=? AND sequence BETWEEN ? AND ? ORDER BY sequence').all(sessionId, start, end);
    for (const row of rows) {
      const receipt = this.#db.prepare("SELECT * FROM thread_delivery_receipts WHERE message_id=? ORDER BY (outcome IN ('ACCEPTED','DELIVERED')) DESC, recorded_at DESC, rowid DESC LIMIT 1").get(row.message_id);
      if (receipt) { row.delivery_state = receipt.outcome; row.text = receipt.text; }
    }
    return rows;
  }

  #validateSummary(summary, sourceRows = []) {
    const value = objectValue(summary, "summary");
    const output = {};
    for (const field of SUMMARY_FIELDS) {
      if (!Array.isArray(value[field])) {
        throw new ThreadMemoryValidationError(`summary.${field} must be an array.`);
      }
      output[field] = value[field].map((item) => {
        if (!item || typeof item.text !== 'string' || !item.text.trim()) throw new ThreadMemoryValidationError('Summary item requires text.');
        requiredString(item.speakerId, 'summary.speakerId');
        const refs = stringArray(item.sourceMessageRefs, 'summary.sourceMessageRefs');
        if (refs.some((id) => !sourceRows.some((row) => row.message_id === id && (!item.speakerId || row.speaker_id === item.speakerId)))) throw new ThreadMemoryValidationError('Summary source/author is outside the authorized range.');
        return { text: item.text.trim(), sourceMessageRefs: refs, ...(item.speakerId ? { speakerId: item.speakerId } : {}), verificationState: 'CANDIDATE' };
      });
    }
    return output;
  }

  #requireThread(threadId) {
    const id = requiredString(threadId, "thread_id");
    const row = this.#db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(id);
    if (!row) throw new ThreadMemoryNotFoundError(`Unknown thread_id "${id}".`);
    if (row.status === "REVOKED") throw new ThreadMemoryConflictError("The thread is revoked.");
    return rowThread(row);
  }

  #getSession(sessionId) {
    return this.#db.prepare("SELECT * FROM chat_sessions WHERE session_id = ?").get(sessionId);
  }

  #getOpenSession(threadId) {
    return this.#db.prepare("SELECT * FROM chat_sessions WHERE thread_id = ? AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1").get(threadId);
  }

  #createSession(threadId, tenantId, timestamp, idleTimeoutMinutes, policyRevision) {
    const last = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM thread_messages WHERE thread_id = ?").get(threadId);
    const watermark = this.#db.prepare("SELECT COALESCE(MAX(covered_through_sequence), 0) AS sequence FROM session_summaries WHERE thread_id = ?").get(threadId);
    const sessionId = ref("session");
    const deadline = new Date(Date.parse(timestamp) + idleTimeoutMinutes * 60_000).toISOString();
    this.#db.prepare(`
      INSERT INTO chat_sessions
        (session_id, tenant_id, thread_id, status, opened_at, last_human_at, idle_deadline,
         closed_at, latest_sequence, summary_watermark, policy_revision, version)
      VALUES (@session_id, @tenant_id, @thread_id, 'OPEN', @opened_at, NULL, @idle_deadline,
         NULL, @latest_sequence, @summary_watermark, @policy_revision, 1)
    `).run({ session_id: sessionId, tenant_id: tenantId, thread_id: threadId, opened_at: timestamp, idle_deadline: deadline, latest_sequence: Number(last.sequence), summary_watermark: Number(watermark.sequence), policy_revision: requiredString(policyRevision, "policy_revision") });
    return this.#getSession(sessionId);
  }

  #closeIdleSession(session, timestamp) {
    if (session.status !== "OPEN") return null;
    const start = Number(this.#db.prepare('SELECT MIN(sequence) AS sequence FROM thread_messages WHERE session_id=?').get(session.session_id).sequence ?? Number(session.latest_sequence) + 1);
    const end = Number(session.latest_sequence);
    if (end < start) {
      this.#db.prepare("UPDATE chat_sessions SET status = 'CLOSED', closed_at = ?, version = version + 1 WHERE session_id = ?").run(timestamp, session.session_id);
      return null;
    }
    this.#db.prepare("UPDATE chat_sessions SET status = 'CLOSING', version = version + 1 WHERE session_id = ?").run(session.session_id);
    const jobId = ref("compaction-job");
    const key = `${session.session_id}:${start}:${end}`;
    // RKOI review (docs round 4), item 2: ON CONFLICT(idempotency_key), not
    // OR IGNORE, so this only ever suppresses the intended idempotent-retry
    // collision -- never a NOT NULL violation on tenant_id.
    this.#db.prepare(`
      INSERT INTO session_compaction_jobs
        (job_id, tenant_id, session_id, thread_id, status, source_start_sequence, source_end_sequence,
         idempotency_key, attempts, leased_until, summary_id, last_error, created_at, updated_at)
      VALUES (@job_id, @tenant_id, @session_id, @thread_id, 'PENDING', @source_start_sequence, @source_end_sequence,
         @idempotency_key, 0, NULL, NULL, NULL, @created_at, @updated_at)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run({ job_id: jobId, tenant_id: session.tenant_id, session_id: session.session_id, thread_id: session.thread_id, source_start_sequence: start, source_end_sequence: end, idempotency_key: key, created_at: timestamp, updated_at: timestamp });
    return this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE idempotency_key = ?").get(key);
  }

  // C-1: only ever called for speakerKind === 'HUMAN' (see appendMessage).
  // Inserts a NEW append-only row exactly when something about this
  // speaker's state actually changes (first join, a person_id link, or an
  // identity_assurance upgrade); a no-op append (same speaker, same state)
  // never touches the table at all. The
  // trg_thread_participants_direct_single_human trigger is the
  // unconditional backstop against a second distinct HUMAN ever joining a
  // DIRECT thread, independent of whatever authorized this call.
  #applyHumanParticipant(threadId, speakerId, personId, assurance, joinedAt, sourceRef) {
    const existing = this.#db.prepare("SELECT * FROM thread_participants WHERE thread_id = ? AND speaker_id = ? AND left_at IS NULL").get(threadId, speakerId);
    if (!existing) {
      this.#db.prepare(
        `INSERT INTO thread_participants (membership_id, tenant_id, thread_id, speaker_id, speaker_kind, person_id, identity_assurance, joined_at, left_at, source_ref)
         VALUES (?, (SELECT tenant_id FROM threads WHERE thread_id = ?), ?, ?, 'HUMAN', ?, ?, ?, NULL, ?)`,
      ).run(ref("membership"), threadId, threadId, speakerId, personId, assurance, joinedAt, sourceRef);
      return;
    }
    const nextPerson = personId || existing.person_id;
    const changed = nextPerson !== existing.person_id || ASSURANCE_RANK[assurance] > ASSURANCE_RANK[existing.identity_assurance];
    if (!changed) return;
    this.#db.transaction(() => {
      this.#db.prepare("UPDATE thread_participants SET left_at = ? WHERE membership_id = ?").run(joinedAt, existing.membership_id);
      this.#db.prepare(
        `INSERT INTO thread_participants (membership_id, tenant_id, thread_id, speaker_id, speaker_kind, person_id, identity_assurance, joined_at, left_at, source_ref)
         VALUES (?, (SELECT tenant_id FROM threads WHERE thread_id = ?), ?, ?, 'HUMAN', ?, ?, ?, NULL, ?)`,
      ).run(ref("membership"), threadId, threadId, speakerId, nextPerson, ASSURANCE_RANK[assurance] > ASSURANCE_RANK[existing.identity_assurance] ? assurance : existing.identity_assurance, joinedAt, sourceRef ?? existing.source_ref);
    })();
  }

  #jobResult(row) {
    return {
      jobId: row.job_id,
      sessionId: row.session_id,
      threadId: row.thread_id,
      status: row.status,
      sourceStartSequence: row.source_start_sequence,
      sourceEndSequence: row.source_end_sequence,
      idempotencyKey: row.idempotency_key,
      attempts: row.attempts,
      summaryId: row.summary_id,
      lastError: row.last_error,
    };
  }
}

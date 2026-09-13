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
  CompactionLeaseConflictError,
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

export class ThreadMemoryValidationError extends ThreadValidationError {}
export class ThreadMemoryConflictError extends ThreadConflictError {}
export class ThreadMemoryNotFoundError extends ThreadNotFoundError {}
export { CompactionLeaseConflictError, IdentityHmacUnconfiguredError, RecordSubjectMismatchError, ThreadPayloadTooLargeError };

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
      this.#db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(timestamp, existing.thread_id);
      return { thread: rowThread({ ...existing, updated_at: timestamp }), created: false };
    }

    const threadId = ref("thread");
    try {
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
      return { thread: rowThread(raced), created: false };
    }

    const created = rowThread(this.#db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId));
    this.#journalAppend({
      actor: "msp:thread-resolver",
      toolName: "msp_thread_resolve",
      ref: threadId,
      workspaceId: tenant,
      payload: { thread_id: threadId, created: true, channel_type: channel },
      policyDecision: "allow",
    });
    return { thread: created, created: true };
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
      if (existing.direction === "INBOUND") this.#drainDeliveries(existing.message_id);
      return { message: rowMessage(existing), session: rowSession(this.#getSession(existing.session_id)), deduplicated: true };
    }

    // W5: the journal actor is the speaker's HMAC, never the raw id. Fails
    // closed BEFORE any write below if no identity key is configured.
    const principalHmac = this.#hmacPrincipal(speaker);

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

    if (messageDirection === 'INBOUND') this.#drainDeliveries(result.message.messageId);

    this.#journalAppend({
      actor: principalHmac,
      toolName: "msp_thread_message_append",
      ref: result.message.messageId,
      workspaceId: thread.tenantId,
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
    now,
  } = {}) {
    const thread = this.#requireThread(threadId);
    const memoryKind = enumValue(kind, MEMORY_KINDS, "kind");
    const memoryStatus = enumValue(status, MEMORY_STATUSES, "status");
    const verification = enumValue(verificationState, VERIFICATION_STATES, "verification_state");
    const speaker = requiredString(assertedBySpeakerId, "asserted_by_speaker_id");
    const person = optionalString(subjectPersonId, "subject_person_id");
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
    const recordId = `memory-record_${sha256(JSON.stringify([thread.threadId, sessionId, memoryKind, speaker, person, scopeValue, payload, [...sourceRefs].sort(), supersedesRecordId, verification, memoryStatus]))}`;
    const existingRecord = this.#db.prepare('SELECT * FROM protected_memory_records WHERE record_id=?').get(recordId);
    if (existingRecord) return rowProtected(existingRecord);
    if (supersedesRecordId) {
      const old = this.#db.prepare("SELECT * FROM protected_memory_records WHERE record_id = ? AND thread_id = ?").get(supersedesRecordId, thread.threadId);
      if (!old) throw new ThreadMemoryValidationError("supersedes_record_id must reference a record in the same thread.");
      if (old.asserted_by_speaker_id !== speaker || old.subject_person_id !== person || old.status !== 'ACTIVE') throw new ThreadMemoryConflictError('Supersession requires the same speaker and subject and an active record.');
    }
    try {
      this.#db.transaction(() => {
      this.#db
        .prepare(`
          INSERT INTO protected_memory_records
            (record_id, tenant_id, thread_id, session_id, kind, status, asserted_by_speaker_id,
             subject_person_id, scope_json, body_json, source_message_refs_json,
             supersedes_record_id, verification_state, version, created_at, updated_at)
          VALUES (@record_id, @tenant_id, @thread_id, @session_id, @kind, @status, @asserted_by_speaker_id,
             @subject_person_id, @scope_json, @body_json, @source_message_refs_json,
             @supersedes_record_id, @verification_state, 1, @created_at, @updated_at)
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
        });
      if (supersedesRecordId) {
        const changed = this.#db.prepare("UPDATE protected_memory_records SET status = 'SUPERSEDED', updated_at = ?, version = version + 1 WHERE record_id = ? AND status='ACTIVE' AND asserted_by_speaker_id=?").run(timestamp, supersedesRecordId, speaker);
        if (!changed.changes) throw new ThreadMemoryConflictError('Protected record changed during supersession.');
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
    this.#journalAppend({
      actor: principalHmac,
      toolName: "msp_thread_memory_record",
      ref: recordId,
      workspaceId: thread.tenantId,
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
  context({ threadId, recentExchangeCount = 6, currentExchangeId, requesterSpeakerId, now } = {}) {
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
    const protectedRecords = this.#db.prepare("SELECT * FROM protected_memory_records WHERE thread_id = ? AND status = 'ACTIVE' ORDER BY created_at ASC").all(thread.threadId).map(rowProtected)
      .filter((record) => !requesterSpeakerId || record.assertedBySpeakerId === requesterSpeakerId);
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
  sweepIdleSessions({ now, limit = 100, tenantId, businessId, channelAccountId, externalRoomRef } = {}) {
    const timestamp = iso(now);
    const max = positiveInteger(limit, "limit");
    const roomHmac = externalRoomRef ? this.#hmacRoomRef({ tenantId, channelAccountId, externalRoomRef }) : null;
    const due = this.#db.prepare(`SELECT s.* FROM chat_sessions s JOIN threads t ON s.thread_id=t.thread_id
      WHERE s.status='OPEN' AND s.idle_deadline<=? AND (? IS NULL OR t.tenant_id=?)
      AND (?=0 OR t.business_id IS ?) AND (? IS NULL OR t.channel_account_id=?)
      AND (? IS NULL OR t.external_room_ref_hmac=?)
      ORDER BY s.idle_deadline ASC LIMIT ?`)
      .all(timestamp, tenantId ?? null, tenantId ?? null, businessId === undefined ? 0 : 1, businessId ?? null,
        channelAccountId ?? null, channelAccountId ?? null, roomHmac, roomHmac, max);
    const jobs = this.#db.transaction(() => due.map((session) => this.#closeIdleSession(session, timestamp)).filter(Boolean))();
    for (const job of jobs) {
      this.#journalAppend({ actor: "msp:session-router", toolName: "msp_session_sweep", ref: job.job_id, workspaceId: job.tenant_id, payload: { session_id: job.session_id, source_end_sequence: job.source_end_sequence }, policyDecision: "allow" });
    }
    const ready = this.#db.prepare(`SELECT j.* FROM session_compaction_jobs j JOIN threads t ON j.thread_id=t.thread_id
      WHERE (j.status IN ('PENDING','RETRYABLE') OR (j.status='RUNNING' AND j.leased_until<=?))
      AND (? IS NULL OR t.tenant_id=?) AND (?=0 OR t.business_id IS ?)
      AND (? IS NULL OR t.channel_account_id=?)
      AND (? IS NULL OR t.external_room_ref_hmac=?)
      ORDER BY j.created_at LIMIT ?`).all(timestamp, tenantId ?? null, tenantId ?? null,
        businessId === undefined ? 0 : 1, businessId ?? null, channelAccountId ?? null, channelAccountId ?? null,
        roomHmac, roomHmac, max);
    return { closed: jobs.length, jobs: ready.map((job) => this.#jobResult(job)) };
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
    this.#journalAppend({ actor: "msp:compaction-worker", toolName: "msp_session_compaction_commit", ref: result.summaryId, workspaceId: thread.tenantId, payload: { session_id: sessionRef, job_id: job.job_id, through_sequence: end }, policyDecision: "allow" });
    return { summary: rowSummary(this.#db.prepare("SELECT * FROM session_summaries WHERE summary_id = ?").get(result.summaryId)), jobId: job.job_id };
  }

  claimCompaction({ jobId, workerId, leaseSeconds = 120, now } = {}) {
    const timestamp = iso(now);
    const worker = requiredString(workerId, 'worker_id');
    const seconds = positiveInteger(leaseSeconds, 'lease_seconds');
    if (seconds > 300) throw new ThreadMemoryValidationError('lease_seconds exceeds 300.');
    return this.#db.transaction(() => {
      const job = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(requiredString(jobId, 'job_id'));
      if (!job || ['COMMITTED', 'FAILED'].includes(job.status)) throw new CompactionLeaseConflictError('Job is missing or terminal.');
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

  recordDelivery({ inboundMessageId, sourceEventId, receiptId, outcome, text, providerRef, scope, now } = {}) {
    const inboundId = requiredString(inboundMessageId, 'inbound_message_id');
    if (sourceEventId !== `${inboundId}:assistant`) throw new ThreadMemoryValidationError('Delivery source must name its inbound message.');
    const state = enumValue(outcome, new Set(['ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN']), 'outcome');
    const id = requiredString(receiptId, 'receipt_id');
    const body = boundedText(text, 'text');
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
      this.#db.prepare('INSERT INTO thread_pending_deliveries(receipt_id,inbound_message_id,source_event_id,tenant_id,business_id,channel_account_id,external_room_ref_hmac,outcome,text,provider_ref,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(receipt_id) DO NOTHING')
        .run(id, inboundId, sourceEventId, scope.tenantId, scope.businessId ?? null, scope.channelAccountId, roomHmac, state, body, providerRef ?? null, iso(now));
      return { receiptId: id, status: 'PENDING_INBOUND' };
    }
    const thread = this.#requireThread(inbound.thread_id);
    if (scope) {
      const roomHmac = scope.__precomputedHmac ?? this.#hmacRoomRef({ tenantId: scope.tenantId, channelAccountId: scope.channelAccountId, externalRoomRef: scope.externalRoomRef });
      if (thread.tenantId !== scope.tenantId || thread.businessId !== (scope.businessId ?? null) || thread.channelAccountId !== scope.channelAccountId || thread.externalRoomRefHmac !== roomHmac) {
        throw new ThreadMemoryConflictError('Delivery scope differs.');
      }
    }
    try {
    return this.#db.transaction(() => {
    let message = this.#db.prepare("SELECT * FROM thread_messages WHERE thread_id=? AND source_event_id=? AND direction='OUTBOUND'").get(thread.threadId, sourceEventId);
    if (!message) {
      const appended = this.appendMessage({ threadId: inbound.thread_id, sessionId: inbound.session_id, exchangeId: inbound.exchange_id,
        replyToMessageId: inboundId, sourceEventId, speakerId: 'zuri-line-agent', speakerKind: 'AGENT', identityAssurance: 'VERIFIED',
        direction: 'OUTBOUND', text: body, deliveryState: state, reconcileDelivery: true, now });
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
      this.recordDelivery({ inboundMessageId: inboundId, sourceEventId: row.source_event_id, receiptId: row.receipt_id, outcome: row.outcome,
        text: row.text, providerRef: row.provider_ref, now: row.recorded_at,
        scope: { tenantId: row.tenant_id, businessId: row.business_id, channelAccountId: row.channel_account_id, externalRoomRef: null, __precomputedHmac: row.external_room_ref_hmac } });
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

  recordInjection({ threadId, exchangeId, injectionId, packetHash, policyRevision, modelRef, state, now } = {}) {
    const thread = this.#requireThread(threadId);
    const id = requiredString(injectionId, 'injection_id');
    const hash = requiredString(packetHash, 'packet_hash');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ThreadMemoryValidationError('packet_hash must be SHA-256.');
    const status = enumValue(state, new Set(['RESOLVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN']), 'state');
    const exchange = this.#db.prepare('SELECT 1 FROM thread_messages WHERE thread_id=? AND exchange_id=?').get(threadId, exchangeId);
    if (!exchange) throw new ThreadMemoryValidationError('Unknown exchange_id for thread.');
    try {
    return this.#db.transaction(() => {
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

  retryCompaction({ jobId, error, leaseToken, now } = {}) {
    const id = requiredString(jobId, "job_id");
    const message = requiredString(error, "error").slice(0, 1000);
    const timestamp = iso(now);
    const job = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(id);
    // RKOI review, item 11: retry always requires the lease token, checked
    // separately from -- not folded silently into -- the expiry check
    // against the server's own clock (`timestamp`, W1-gated).
    if (!leaseToken) throw new ThreadMemoryValidationError('lease_token is required to retry a compaction job.');
    if (!job || job.status !== 'RUNNING' || job.lease_token !== leaseToken || Date.parse(job.leased_until) <= Date.parse(timestamp)) throw new CompactionLeaseConflictError('Compaction lease is stale.');
    const result = this.#db.prepare("UPDATE session_compaction_jobs SET status = 'RETRYABLE', invocation_state='FAILED', last_error = ?, updated_at = ? WHERE job_id = ? AND status='RUNNING' AND lease_token=? AND leased_until>?").run(message, timestamp, id, leaseToken, timestamp);
    if (!result.changes) throw new CompactionLeaseConflictError("Compaction job is missing or already terminal.");
    return this.#jobResult(this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE job_id = ?").get(id));
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

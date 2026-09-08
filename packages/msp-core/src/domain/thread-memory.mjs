// Unified thread, speaker, session and compaction state (ADR-044).
//
// Zuri owns channel identity and authorization. MSP owns the durable thread
// lifecycle, speaker references, bounded recent exchanges and the provenance
// of compacted session memory. This module deliberately accepts opaque
// channel/person references; it never resolves a LINE id or grants access.
import { createHash, randomUUID } from "node:crypto";

import { mintRef } from "./ids.mjs";
import { MspRuntimeError } from "./errors.mjs";

const SPEAKER_KINDS = new Set(["HUMAN", "AGENT", "OPERATOR", "UNKNOWN"]);
const ASSURANCE = new Set(["VERIFIED", "PENDING", "UNRESOLVED"]);
const DIRECTIONS = new Set(["INBOUND", "OUTBOUND"]);
const DELIVERY_STATES = new Set(["RECEIVED", "QUEUED", "ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN"]);
const MEMORY_KINDS = new Set(["CONSTRAINT", "INSTRUCTION", "CORRECTION", "PREFERENCE"]);
const MEMORY_STATUSES = new Set(["ACTIVE", "REVOKED", "SUPERSEDED"]);
const VERIFICATION_STATES = new Set(["CANDIDATE", "CONFIRMED", "CONTESTED"]);
const SUMMARY_FIELDS = ["topics", "decisions", "openQuestions", "pendingActions", "corrections", "outcomes", "participants"];

export class ThreadMemoryValidationError extends MspRuntimeError {
  constructor(message) {
    super(message, "invalid_request");
  }
}

export class ThreadMemoryConflictError extends MspRuntimeError {
  constructor(message) {
    super(message, "conflict");
  }
}

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

function stringArray(value, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return [];
    throw new ThreadMemoryValidationError(`${label} is required.`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ThreadMemoryValidationError(`${label} must be an array of non-empty strings.`);
  }
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

function rowThread(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    threadKind: row.thread_kind,
    channelType: row.channel_type,
    channelAccountId: row.channel_account_id,
    externalRoomRef: row.external_room_ref,
    tenantId: row.tenant_id,
    businessId: row.business_id,
    audienceKind: row.audience_kind,
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

export class ThreadMemoryStore {
  #db;
  #journal;

  constructor(db, journal) {
    if (!db || typeof db.prepare !== "function") throw new TypeError("ThreadMemoryStore requires a database.");
    this.#db = db;
    this.#journal = journal;
  }

  resolveThread({
    threadKind,
    channelType,
    channelAccountId,
    externalRoomRef,
    tenantId,
    businessId = null,
    audienceKind = threadKind,
    now,
  } = {}) {
    const kind = enumValue(threadKind, new Set(["DIRECT", "GROUP", "ROOM"]), "thread_kind");
    const audience = enumValue(audienceKind, new Set(["DIRECT", "GROUP", "ROOM"]), "audience_kind");
    const channel = requiredString(channelType, "channel_type");
    const account = requiredString(channelAccountId, "channel_account_id");
    const room = requiredString(externalRoomRef, "external_room_ref");
    const tenant = requiredString(tenantId, "tenant_id");
    const business = optionalString(businessId, "business_id");
    const timestamp = iso(now);

    const existing = this.#db
      .prepare("SELECT * FROM threads WHERE channel_account_id = ? AND external_room_ref = ?")
      .get(account, room);
    if (existing) {
      if (existing.tenant_id !== tenant || existing.business_id !== business || existing.thread_kind !== kind || existing.audience_kind !== audience) {
        throw new ThreadMemoryConflictError("The channel binding already belongs to a different thread scope.");
      }
      if (existing.status === "REVOKED") throw new ThreadMemoryConflictError("The thread binding is revoked.");
      this.#db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(timestamp, existing.thread_id);
      return { thread: rowThread({ ...existing, updated_at: timestamp }), created: false };
    }

    const threadId = ref("thread");
    try {
      this.#db
        .prepare(`
          INSERT INTO threads
            (thread_id, thread_kind, channel_type, channel_account_id, external_room_ref,
             tenant_id, business_id, audience_kind, status, created_at, updated_at)
          VALUES (@thread_id, @thread_kind, @channel_type, @channel_account_id, @external_room_ref,
             @tenant_id, @business_id, @audience_kind, 'ACTIVE', @created_at, @updated_at)
        `)
        .run({
          thread_id: threadId,
          thread_kind: kind,
          channel_type: channel,
          channel_account_id: account,
          external_room_ref: room,
          tenant_id: tenant,
          business_id: business,
          audience_kind: audience,
          created_at: timestamp,
          updated_at: timestamp,
        });
    } catch (error) {
      if (!String(error?.message).includes("UNIQUE")) throw error;
      const raced = this.#db
        .prepare("SELECT * FROM threads WHERE channel_account_id = ? AND external_room_ref = ?")
        .get(account, room);
      if (!raced) throw error;
      if (raced.tenant_id !== tenant || raced.business_id !== business || raced.thread_kind !== kind || raced.audience_kind !== audience) {
        throw new ThreadMemoryConflictError("The channel binding already belongs to a different thread scope.");
      }
      if (raced.status === "REVOKED") throw new ThreadMemoryConflictError("The thread binding is revoked.");
      return { thread: rowThread(raced), created: false };
    }

    return {
      thread: rowThread(this.#db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId)),
      created: true,
    };
  }

  appendMessage({
    threadId,
    sessionId = null,
    exchangeId = null,
    messageId = null,
    sourceEventId = null,
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
    const content = requiredString(text, "text");
    const state = deliveryState ? enumValue(deliveryState, DELIVERY_STATES, "delivery_state") : messageDirection === "INBOUND" ? "RECEIVED" : "QUEUED";
    const timestamp = iso(now);
    const occurred = iso(occurredAt ?? timestamp, "occurred_at");
    const received = iso(receivedAt ?? timestamp, "received_at");
    const timeout = positiveInteger(idleTimeoutMinutes, "idle_timeout_minutes");
    const person = optionalString(personId, "person_id");
    const source = optionalString(sourceEventId, "source_event_id");

    if (source) {
      const existing = this.#db.prepare("SELECT * FROM thread_messages WHERE source_event_id = ?").get(source);
      if (existing) {
        if (existing.thread_id !== thread.threadId) {
          throw new ThreadMemoryConflictError("source_event_id already belongs to a different thread.");
        }
        if (existing.direction === 'INBOUND') this.#drainDeliveries(existing.message_id);
        return { message: rowMessage(existing), session: rowSession(this.#getSession(existing.session_id)), deduplicated: true };
      }
    }

    const result = this.#db.transaction(() => {
      const referencedExchange = messageDirection === 'OUTBOUND' && exchangeId ? this.#db.prepare("SELECT * FROM thread_messages WHERE thread_id=? AND exchange_id=? AND direction='INBOUND' ORDER BY sequence LIMIT 1").get(thread.threadId, exchangeId) : null;
      if (messageDirection === 'OUTBOUND' && (!referencedExchange || replyToMessageId !== referencedExchange.message_id)) {
        throw new ThreadMemoryValidationError('Outbound requires its explicit exchange_id and reply_to_message_id.');
      }
      const active = referencedExchange ? this.#getSession(referencedExchange.session_id) : sessionId ? this.#getSession(sessionId) : this.#getOpenSession(thread.threadId);
      if (active && active.thread_id !== thread.threadId) throw new ThreadMemoryConflictError("session_id does not belong to thread_id.");
      if (sessionId && referencedExchange && sessionId !== referencedExchange.session_id) throw new ThreadMemoryConflictError('Exchange belongs to a different session.');
      if (referencedExchange && active?.status === 'CLOSED' && !reconcileDelivery) throw new ThreadMemoryConflictError('Cannot append to a sealed session.');
      let session = active;
      if (messageDirection === 'INBOUND' && exchangeId) {
        const previous = this.#db.prepare('SELECT session_id FROM thread_messages WHERE thread_id=? AND exchange_id=? LIMIT 1').get(thread.threadId, exchangeId);
        if (previous && (previous.session_id !== active?.session_id || active?.status !== 'OPEN' || Date.parse(active.idle_deadline) <= Date.parse(timestamp))) {
          throw new ThreadMemoryConflictError('Inbound cannot reopen an expired exchange.');
        }
      }
      if (!referencedExchange && (!session || session.status !== "OPEN" || Date.parse(session.idle_deadline) <= Date.parse(timestamp))) {
        if (session && session.status === "OPEN") this.#closeIdleSession(session, timestamp);
        session = this.#createSession(thread.threadId, timestamp, timeout, policyRevision);
      }

      const exchange = exchangeId ? requiredString(exchangeId, "exchange_id") : ref("exchange");
      const sequenceRow = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM thread_messages WHERE thread_id = ?").get(thread.threadId);
      const sequence = Number(sequenceRow.sequence) + 1;
      const id = messageId ? requiredString(messageId, "message_id") : ref("message");

      this.#db
        .prepare(`
          INSERT INTO thread_messages
            (message_id, thread_id, session_id, exchange_id, sequence, speaker_id, speaker_kind,
             person_id, identity_assurance, direction, text, occurred_at, received_at,
             source_event_id, reply_to_message_id, delivery_state)
          VALUES (@message_id, @thread_id, @session_id, @exchange_id, @sequence, @speaker_id, @speaker_kind,
             @person_id, @identity_assurance, @direction, @text, @occurred_at, @received_at,
             @source_event_id, @reply_to_message_id, @delivery_state)
        `)
        .run({
          message_id: id,
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

      this.#upsertParticipant(thread.threadId, speaker, speakerType, person, assurance, timestamp, source);
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

    if (messageDirection === 'INBOUND') this.#drainDeliveries(result.message.messageId);

    this.#journal?.append({
      actor: speaker,
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
    const sourceRefs = stringArray(sourceMessageRefs, "source_message_refs");
    const timestamp = iso(now);
    const participant = this.#db.prepare("SELECT speaker_id FROM thread_participants WHERE thread_id = ? AND speaker_id = ?").get(thread.threadId, speaker);
    if (!participant) throw new ThreadMemoryValidationError("asserted_by_speaker_id must be a participant in thread_id.");
    if (sessionId) {
      const session = this.#getSession(sessionId);
      if (!session || session.thread_id !== thread.threadId) throw new ThreadMemoryConflictError("session_id does not belong to thread_id.");
    }
    const placeholders = sourceRefs.map(() => "?").join(", ");
    const sourceRows = this.#db.prepare(`SELECT message_id, speaker_id FROM thread_messages WHERE thread_id = ? AND message_id IN (${placeholders})`).all(thread.threadId, ...sourceRefs);
    if (sourceRows.length !== sourceRefs.length) throw new ThreadMemoryValidationError("Every source_message_ref must belong to thread_id.");
    if (sourceRows.some((row) => row.speaker_id !== speaker)) throw new ThreadMemoryValidationError('Source author must match asserted_by_speaker_id.');
    const recordId = `memory-record_${sha256(JSON.stringify([thread.threadId, sessionId, memoryKind, speaker, person, scope, payload, [...sourceRefs].sort(), supersedesRecordId, verification, memoryStatus]))}`;
    const existingRecord = this.#db.prepare('SELECT * FROM protected_memory_records WHERE record_id=?').get(recordId);
    if (existingRecord) return rowProtected(existingRecord);
    if (supersedesRecordId) {
      const old = this.#db.prepare("SELECT * FROM protected_memory_records WHERE record_id = ? AND thread_id = ?").get(supersedesRecordId, thread.threadId);
      if (!old) throw new ThreadMemoryValidationError("supersedes_record_id must reference a record in the same thread.");
      if (old.asserted_by_speaker_id !== speaker || old.subject_person_id !== person || old.status !== 'ACTIVE') throw new ThreadMemoryConflictError('Supersession requires the same speaker and subject and an active record.');
    }
    this.#db.transaction(() => {
    this.#db
      .prepare(`
        INSERT INTO protected_memory_records
          (record_id, thread_id, session_id, kind, status, asserted_by_speaker_id,
           subject_person_id, scope_json, body_json, source_message_refs_json,
           supersedes_record_id, verification_state, version, created_at, updated_at)
        VALUES (@record_id, @thread_id, @session_id, @kind, @status, @asserted_by_speaker_id,
           @subject_person_id, @scope_json, @body_json, @source_message_refs_json,
           @supersedes_record_id, @verification_state, 1, @created_at, @updated_at)
      `)
      .run({
        record_id: recordId,
        thread_id: thread.threadId,
        session_id: sessionId,
        kind: memoryKind,
        status: memoryStatus,
        asserted_by_speaker_id: speaker,
        subject_person_id: person,
        scope_json: JSON.stringify(objectValue(scope, "scope")),
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
    const record = rowProtected(this.#db.prepare("SELECT * FROM protected_memory_records WHERE record_id = ?").get(recordId));
    this.#journal?.append({
      actor: speaker,
      toolName: "msp_thread_memory_record",
      ref: recordId,
      workspaceId: thread.tenantId,
      payload: { thread_id: thread.threadId, kind: memoryKind, source_count: sourceRefs.length },
      policyDecision: "allow",
    });
    return record;
  }

  context({ threadId, recentExchangeCount = 6, currentExchangeId, requesterPersonId, now } = {}) {
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
      .filter((record) => !requesterPersonId || ((!record.subjectPersonId || record.subjectPersonId === requesterPersonId) &&
        (!(record.scope?.businessId ?? record.scope?.business_id) || (record.scope.businessId ?? record.scope.business_id) === thread.businessId) &&
        (!(record.scope?.personId ?? record.scope?.person_id) || (record.scope.personId ?? record.scope.person_id) === requesterPersonId)));
    const participants = this.#db.prepare("SELECT * FROM thread_participants WHERE thread_id = ? ORDER BY joined_at ASC").all(thread.threadId).map((row) => ({
      threadId: row.thread_id,
      speakerId: row.speaker_id,
      speakerKind: row.speaker_kind,
      personId: row.person_id,
      identityAssurance: row.identity_assurance,
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      sourceRef: row.source_ref,
    }));
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

  sweepIdleSessions({ now, limit = 100, tenantId, businessId, channelAccountId, externalRoomRef } = {}) {
    const timestamp = iso(now);
    const max = positiveInteger(limit, "limit");
    const due = this.#db.prepare(`SELECT s.* FROM chat_sessions s JOIN threads t ON s.thread_id=t.thread_id
      WHERE s.status='OPEN' AND s.idle_deadline<=? AND (? IS NULL OR t.tenant_id=?)
      AND (?=0 OR t.business_id IS ?) AND (? IS NULL OR t.channel_account_id=?)
      AND (? IS NULL OR t.external_room_ref=?) ORDER BY s.idle_deadline ASC LIMIT ?`)
      .all(timestamp, tenantId ?? null, tenantId ?? null, businessId === undefined ? 0 : 1, businessId ?? null,
        channelAccountId ?? null, channelAccountId ?? null, externalRoomRef ?? null, externalRoomRef ?? null, max);
    const jobs = this.#db.transaction(() => due.map((session) => this.#closeIdleSession(session, timestamp)).filter(Boolean))();
    for (const job of jobs) {
      this.#journal?.append({ actor: "msp:session-router", toolName: "msp_session_sweep", ref: job.job_id, workspaceId: null, payload: { session_id: job.session_id, source_end_sequence: job.source_end_sequence }, policyDecision: "allow" });
    }
    const ready = this.#db.prepare(`SELECT j.* FROM session_compaction_jobs j JOIN threads t ON j.thread_id=t.thread_id
      WHERE (j.status IN ('PENDING','RETRYABLE') OR (j.status='RUNNING' AND j.leased_until<=?))
      AND (? IS NULL OR t.tenant_id=?) AND (?=0 OR t.business_id IS ?)
      AND (? IS NULL OR t.channel_account_id=?) AND (? IS NULL OR t.external_room_ref=?)
      ORDER BY j.created_at LIMIT ?`).all(timestamp, tenantId ?? null, tenantId ?? null,
        businessId === undefined ? 0 : 1, businessId ?? null, channelAccountId ?? null, channelAccountId ?? null,
        externalRoomRef ?? null, externalRoomRef ?? null, max);
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
    if (job.status !== 'RUNNING' || job.lease_token !== leaseToken || Date.parse(job.leased_until) <= Date.parse(timestamp)) throw new ThreadMemoryConflictError('Compaction lease is stale.');
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
          current.source_start_sequence !== start || current.source_end_sequence !== end) throw new ThreadMemoryConflictError('Compaction lease changed.');
      if (sha256(JSON.stringify(this.#sourceRows(sessionRef, start, end))) !== digest) throw new ThreadMemoryConflictError('Compaction source changed.');
      const previous = this.#db.prepare("SELECT * FROM session_summaries WHERE thread_id = ? ORDER BY covered_through_sequence DESC LIMIT 1").get(session.thread_id);
      const versionRow = this.#db.prepare("SELECT COALESCE(MAX(summary_version), 0) AS version FROM session_summaries WHERE session_id = ?").get(sessionRef);
      const summaryId = ref("summary");
      this.#db.prepare(`
        INSERT INTO session_summaries
          (summary_id, session_id, thread_id, summary_version, covered_from_sequence,
           covered_through_sequence, source_digest, previous_summary_id, summary_json,
           policy_revision, summarizer_version, created_at, covered_sequences_json)
        VALUES (@summary_id, @session_id, @thread_id, @summary_version, @covered_from_sequence,
           @covered_through_sequence, @source_digest, @previous_summary_id, @summary_json,
           @policy_revision, @summarizer_version, @created_at, @covered_sequences_json)
      `).run({
        summary_id: summaryId,
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
    this.#journal?.append({ actor: "msp:compaction-worker", toolName: "msp_session_compaction_commit", ref: result.summaryId, workspaceId: null, payload: { session_id: sessionRef, job_id: job.job_id, through_sequence: end }, policyDecision: "allow" });
    return { summary: rowSummary(this.#db.prepare("SELECT * FROM session_summaries WHERE summary_id = ?").get(result.summaryId)), jobId: job.job_id };
  }

  claimCompaction({ jobId, workerId, leaseSeconds = 120, now } = {}) {
    const timestamp = iso(now);
    const worker = requiredString(workerId, 'worker_id');
    const seconds = positiveInteger(leaseSeconds, 'lease_seconds');
    if (seconds > 300) throw new ThreadMemoryValidationError('lease_seconds exceeds 300.');
    return this.#db.transaction(() => {
      const job = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(requiredString(jobId, 'job_id'));
      if (!job || ['COMMITTED', 'FAILED'].includes(job.status)) throw new ThreadMemoryConflictError('Job is missing or terminal.');
      if (job.status === 'RUNNING' && Date.parse(job.leased_until) > Date.parse(timestamp)) throw new ThreadMemoryConflictError('Job already leased.');
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
      const protectedRecords = this.#db.prepare("SELECT * FROM protected_memory_records WHERE thread_id=? AND status='ACTIVE'").all(job.thread_id).map(rowProtected);
      return { ...this.#jobResult(job), status: 'RUNNING', leaseToken: token, leasedUntil: until, sources,
        sourceDigest: sha256(JSON.stringify(sources)), protectedRecords };
    })();
  }

  recordDelivery({ inboundMessageId, sourceEventId, receiptId, outcome, text, providerRef, scope, now } = {}) {
    const inboundId = requiredString(inboundMessageId, 'inbound_message_id');
    if (sourceEventId !== `${inboundId}:assistant`) throw new ThreadMemoryValidationError('Delivery source must name its inbound message.');
    const state = enumValue(outcome, new Set(['ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN']), 'outcome');
    const id = requiredString(receiptId, 'receipt_id');
    const body = requiredString(text, 'text');
    const inbound = this.#db.prepare("SELECT * FROM thread_messages WHERE message_id=? AND direction='INBOUND'").get(inboundId);
    if (!inbound) {
      if (!scope?.tenantId || !scope.channelAccountId || !scope.externalRoomRef) throw new ThreadMemoryValidationError('Delivery scope is required.');
      const old = this.#db.prepare('SELECT * FROM thread_pending_deliveries WHERE receipt_id=?').get(id);
      if (old && (old.inbound_message_id !== inboundId || old.tenant_id !== scope.tenantId || old.business_id !== (scope.businessId ?? null) ||
        old.channel_account_id !== scope.channelAccountId || old.external_room_ref !== scope.externalRoomRef || old.text !== body || old.outcome !== state)) throw new ThreadMemoryConflictError('Pending receipt retry differs.');
      this.#db.prepare('INSERT OR IGNORE INTO thread_pending_deliveries(receipt_id,inbound_message_id,source_event_id,tenant_id,business_id,channel_account_id,external_room_ref,outcome,text,provider_ref,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, inboundId, sourceEventId, scope.tenantId, scope.businessId ?? null, scope.channelAccountId, scope.externalRoomRef, state, body, providerRef ?? null, iso(now));
      return { receiptId: id, status: 'PENDING_INBOUND' };
    }
    const thread = this.#requireThread(inbound.thread_id);
    if (scope && (thread.tenantId !== scope.tenantId || thread.businessId !== (scope.businessId ?? null) || thread.channelAccountId !== scope.channelAccountId || thread.externalRoomRef !== scope.externalRoomRef)) throw new ThreadMemoryConflictError('Delivery scope differs.');
    return this.#db.transaction(() => {
    let message = this.#db.prepare("SELECT * FROM thread_messages WHERE source_event_id=? AND direction='OUTBOUND'").get(sourceEventId);
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
    this.#db.prepare('INSERT INTO thread_delivery_receipts(receipt_id,message_id,outcome,text,provider_ref,recorded_at) VALUES(?,?,?,?,?,?)')
      .run(id, message.message_id, state, body, providerRef ?? null, iso(now));
    this.#refreshSummaryAfterDelivery(message.session_id, iso(now));
    this.#db.prepare('DELETE FROM thread_pending_deliveries WHERE receipt_id=?').run(id);
    return { receiptId: id, messageId: message.message_id, outcome: state, deduplicated: false };
    })();
  }

  #drainDeliveries(inboundId) {
    for (const row of this.#db.prepare(`SELECT p.* FROM thread_pending_deliveries p
      JOIN thread_messages m ON m.message_id=p.inbound_message_id JOIN threads t ON t.thread_id=m.thread_id
      WHERE p.inbound_message_id=? AND p.tenant_id=t.tenant_id AND p.business_id IS t.business_id
      AND p.channel_account_id=t.channel_account_id AND p.external_room_ref=t.external_room_ref`).all(inboundId)) {
      this.recordDelivery({ inboundMessageId: inboundId, sourceEventId: row.source_event_id, receiptId: row.receipt_id, outcome: row.outcome,
        text: row.text, providerRef: row.provider_ref, now: row.recorded_at,
        scope: { tenantId: row.tenant_id, businessId: row.business_id, channelAccountId: row.channel_account_id, externalRoomRef: row.external_room_ref } });
    }
  }

  #refreshSummaryAfterDelivery(sessionId, timestamp) {
    const session = this.#getSession(sessionId);
    if (session.status === 'OPEN') return;
    this.#db.prepare("INSERT OR IGNORE INTO thread_summary_invalidations(summary_id,reason,recorded_at) SELECT summary_id,'DELIVERY_RECONCILED',? FROM session_summaries WHERE session_id=?").run(timestamp, sessionId);
    const active = this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE session_id=? AND status IN ('PENDING','RETRYABLE','RUNNING')").get(sessionId);
    if (active) {
      this.#db.prepare("UPDATE session_compaction_jobs SET status='RETRYABLE',lease_token=NULL,leased_until=NULL,source_end_sequence=?,updated_at=? WHERE job_id=?").run(session.latest_sequence, timestamp, active.job_id);
    } else {
      const start = this.#db.prepare('SELECT MIN(sequence) AS n FROM thread_messages WHERE session_id=?').get(sessionId).n;
      this.#db.prepare("INSERT INTO session_compaction_jobs(job_id,session_id,thread_id,status,source_start_sequence,source_end_sequence,idempotency_key,attempts,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?,?,0,?,?)")
        .run(ref('compaction-job'), sessionId, session.thread_id, start, session.latest_sequence, ref('delivery-amendment'), timestamp, timestamp);
    }
    this.#db.prepare("UPDATE chat_sessions SET status='CLOSING',closed_at=NULL,summary_watermark=0,version=version+1 WHERE session_id=?").run(sessionId);
  }

  recordInjection({ threadId, exchangeId, injectionId, packetHash, policyRevision, modelRef, state, now } = {}) {
    this.#requireThread(threadId);
    const id = requiredString(injectionId, 'injection_id');
    const hash = requiredString(packetHash, 'packet_hash');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ThreadMemoryValidationError('packet_hash must be SHA-256.');
    const status = enumValue(state, new Set(['RESOLVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN']), 'state');
    const exchange = this.#db.prepare('SELECT 1 FROM thread_messages WHERE thread_id=? AND exchange_id=?').get(threadId, exchangeId);
    if (!exchange) throw new ThreadMemoryValidationError('Unknown exchange_id for thread.');
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
      if (!old) this.#db.prepare('INSERT INTO thread_injection_receipts(injection_id,thread_id,exchange_id,packet_hash,policy_revision,model_ref,state,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, threadId, exchangeId, hash, requiredString(policyRevision, 'policy_revision'), requiredString(modelRef, 'model_ref'), status, iso(now));
      else this.#db.prepare('UPDATE thread_injection_receipts SET state=?,updated_at=?,version=version+1 WHERE injection_id=?').run(status, iso(now), id);
      return { injectionId: id, state: status, version: (old?.version ?? 0) + 1 };
    })();
  }

  retryCompaction({ jobId, error, leaseToken, now } = {}) {
    const id = requiredString(jobId, "job_id");
    const message = requiredString(error, "error").slice(0, 1000);
    const timestamp = iso(now);
    const job = this.#db.prepare('SELECT * FROM session_compaction_jobs WHERE job_id=?').get(id);
    if (!job || !leaseToken || job.status !== 'RUNNING' || job.lease_token !== leaseToken || Date.parse(job.leased_until) <= Date.parse(timestamp)) throw new ThreadMemoryConflictError('Compaction lease is stale.');
    const result = this.#db.prepare("UPDATE session_compaction_jobs SET status = 'RETRYABLE', invocation_state='FAILED', last_error = ?, updated_at = ? WHERE job_id = ? AND status='RUNNING' AND lease_token=? AND leased_until>?").run(message, timestamp, id, leaseToken, timestamp);
    if (!result.changes) throw new ThreadMemoryConflictError("Compaction job is missing or already terminal.");
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
    if (!row) throw new ThreadMemoryValidationError(`Unknown thread_id "${id}".`);
    if (row.status === "REVOKED") throw new ThreadMemoryConflictError("The thread is revoked.");
    return rowThread(row);
  }

  #getSession(sessionId) {
    return this.#db.prepare("SELECT * FROM chat_sessions WHERE session_id = ?").get(sessionId);
  }

  #getOpenSession(threadId) {
    return this.#db.prepare("SELECT * FROM chat_sessions WHERE thread_id = ? AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1").get(threadId);
  }

  #createSession(threadId, timestamp, idleTimeoutMinutes, policyRevision) {
    const last = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM thread_messages WHERE thread_id = ?").get(threadId);
    const watermark = this.#db.prepare("SELECT COALESCE(MAX(covered_through_sequence), 0) AS sequence FROM session_summaries WHERE thread_id = ?").get(threadId);
    const sessionId = ref("session");
    const deadline = new Date(Date.parse(timestamp) + idleTimeoutMinutes * 60_000).toISOString();
    this.#db.prepare(`
      INSERT INTO chat_sessions
        (session_id, thread_id, status, opened_at, last_human_at, idle_deadline,
         closed_at, latest_sequence, summary_watermark, policy_revision, version)
      VALUES (@session_id, @thread_id, 'OPEN', @opened_at, NULL, @idle_deadline,
         NULL, @latest_sequence, @summary_watermark, @policy_revision, 1)
    `).run({ session_id: sessionId, thread_id: threadId, opened_at: timestamp, idle_deadline: deadline, latest_sequence: Number(last.sequence), summary_watermark: Number(watermark.sequence), policy_revision: requiredString(policyRevision, "policy_revision") });
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
    this.#db.prepare(`
      INSERT OR IGNORE INTO session_compaction_jobs
        (job_id, session_id, thread_id, status, source_start_sequence, source_end_sequence,
         idempotency_key, attempts, leased_until, summary_id, last_error, created_at, updated_at)
      VALUES (@job_id, @session_id, @thread_id, 'PENDING', @source_start_sequence, @source_end_sequence,
         @idempotency_key, 0, NULL, NULL, NULL, @created_at, @updated_at)
    `).run({ job_id: jobId, session_id: session.session_id, thread_id: session.thread_id, source_start_sequence: start, source_end_sequence: end, idempotency_key: key, created_at: timestamp, updated_at: timestamp });
    return this.#db.prepare("SELECT * FROM session_compaction_jobs WHERE idempotency_key = ?").get(key);
  }

  #upsertParticipant(threadId, speakerId, speakerKind, personId, assurance, joinedAt, sourceRef) {
    const existing = this.#db.prepare("SELECT * FROM thread_participants WHERE thread_id = ? AND speaker_id = ?").get(threadId, speakerId);
    if (!existing) {
      this.#db.prepare(`INSERT INTO thread_participants (thread_id, speaker_id, speaker_kind, person_id, identity_assurance, joined_at, left_at, source_ref) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).run(threadId, speakerId, speakerKind, personId, assurance, joinedAt, sourceRef);
      return;
    }
    const rank = { UNRESOLVED: 0, PENDING: 1, VERIFIED: 2 };
    const nextPerson = personId || existing.person_id;
    const nextAssurance = rank[assurance] > rank[existing.identity_assurance] ? assurance : existing.identity_assurance;
    this.#db.prepare("UPDATE thread_participants SET person_id = ?, identity_assurance = ?, source_ref = COALESCE(?, source_ref) WHERE thread_id = ? AND speaker_id = ?").run(nextPerson, nextAssurance, sourceRef, threadId, speakerId);
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

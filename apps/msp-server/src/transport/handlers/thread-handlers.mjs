// Transport wrappers for the unified thread/speaker/session memory contract.
// Zuri supplies opaque channel and Person references; this handler never
// resolves a provider id or decides authorization.
import { ThreadMemoryStore } from "@freshair129/msp-core/thread-memory";

function actor(args, fallback = "system") {
  return typeof args.actor === "string" && args.actor.trim() ? args.actor.trim() : fallback;
}

export function createThreadHandlers({ db, journal, idleTimeoutMinutes = 30, recentExchangeCount = 6 }) {
  const store = new ThreadMemoryStore(db, journal);
  const bounded = (value, ceiling, label) => {
    if (value === undefined || value === null) return ceiling;
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`${label} exceeds the MSP deployment policy ceiling.`);
    }
    return value;
  };

  return {
    async msp_thread_resolve(args = {}) {
      const result = store.resolveThread({
        threadKind: args.thread_kind,
        channelType: args.channel_type,
        channelAccountId: args.channel_account_id,
        externalRoomRef: args.external_room_ref,
        tenantId: args.tenant_id,
        businessId: args.business_id,
        audienceKind: args.audience_kind,
        now: args.now,
      });
      journal?.append({
        actor: actor(args),
        toolName: "msp_thread_resolve",
        ref: result.thread.threadId,
        workspaceId: result.thread.tenantId,
        payload: { thread_id: result.thread.threadId, created: result.created, channel_type: result.thread.channelType },
        policyDecision: "allow",
      });
      return result;
    },

    async msp_thread_message_append(args = {}) {
      return store.appendMessage({
        threadId: args.thread_id,
        sessionId: args.session_id,
        exchangeId: args.exchange_id,
        messageId: args.message_id,
        sourceEventId: args.source_event_id,
        speakerId: args.speaker_id,
        speakerKind: args.speaker_kind,
        personId: args.person_id,
        identityAssurance: args.identity_assurance,
        direction: args.direction,
        text: args.text,
        occurredAt: args.occurred_at,
        receivedAt: args.received_at,
        replyToMessageId: args.reply_to_message_id,
        deliveryState: args.delivery_state,
        idleTimeoutMinutes: bounded(args.idle_timeout_minutes, idleTimeoutMinutes, "idle_timeout_minutes"),
        policyRevision: args.policy_revision,
        now: args.now,
      });
    },

    async msp_thread_memory_record(args = {}) {
      return store.recordProtectedMemory({
        threadId: args.thread_id,
        sessionId: args.session_id,
        kind: args.kind,
        assertedBySpeakerId: args.asserted_by_speaker_id,
        subjectPersonId: args.subject_person_id,
        scope: args.scope,
        body: args.body,
        sourceMessageRefs: args.source_message_refs,
        supersedesRecordId: args.supersedes_record_id,
        status: args.status,
        verificationState: args.verification_state,
        now: args.now,
      });
    },

    async msp_thread_context(args = {}) {
      return store.context({
        threadId: args.thread_id,
        recentExchangeCount: bounded(args.recent_exchange_count, recentExchangeCount, "recent_exchange_count"),
        now: args.now,
      });
    },

    async msp_session_sweep(args = {}) {
      return store.sweepIdleSessions({ now: args.now, limit: args.limit ?? 100 });
    },

    async msp_session_compaction_commit(args = {}) {
      return store.commitCompaction({
        sessionId: args.session_id,
        jobId: args.job_id,
        sourceStartSequence: args.source_start_sequence,
        sourceEndSequence: args.source_end_sequence,
        summary: args.summary,
        sourceDigest: args.source_digest,
        policyRevision: args.policy_revision,
        summarizerVersion: args.summarizer_version,
        invocationState: args.invocation_state,
        now: args.now,
      });
    },

    async msp_session_compaction_retry(args = {}) {
      return store.retryCompaction({ jobId: args.job_id, error: args.error, now: args.now });
    },
  };
}

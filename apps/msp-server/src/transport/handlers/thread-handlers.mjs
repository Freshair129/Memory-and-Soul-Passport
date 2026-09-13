// Transport wrappers for the unified thread/speaker/session memory contract
// (API-011, TASK-MEMOS-002). Zuri supplies opaque channel and Person
// references; this handler never resolves a provider id or decides
// authorization -- that is thread-guard.mjs's job, wrapped around every one
// of these handlers before it is registered on the tool registry
// (see server.mjs). Journaling is entirely ThreadMemoryStore's
// responsibility (msp-core): it already HMACs every actor before writing an
// entry, so this file never calls journal.append itself.
import { ThreadMemoryStore } from "@freshair129/msp-core/thread-memory";

/**
 * @param {object} options
 * @param {boolean} [options.allowTestClock] W1: whether `args.now` may ever
 *   reach the domain layer. Read ONCE at the composition root
 *   (server.mjs, from `env.MSP_TEST_CLOCK === "1"`) and passed in here --
 *   this file never reads process.env itself, so there is exactly one place
 *   in the whole runtime that decides whether a caller may steal or extend
 *   a lease by lying about the time.
 */
export function createThreadHandlers({ db, journal, identityHmacKey = null, idleTimeoutMinutes = 30, recentExchangeCount = 6, allowTestClock = false }) {
  const store = new ThreadMemoryStore(db, journal, { identityHmacKey });
  const now = (args) => (allowTestClock ? args.now : undefined);
  const bounded = (value, ceiling, label) => {
    if (value === undefined || value === null) return ceiling;
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`${label} exceeds the MSP deployment policy ceiling.`);
    }
    return value;
  };

  return {
    async msp_thread_resolve(args = {}) {
      return store.resolveThread({
        threadKind: args.thread_kind,
        channelType: args.channel_type,
        channelAccountId: args.channel_account_id,
        externalRoomRef: args.external_room_ref,
        tenantId: args.tenant_id,
        businessId: args.business_id,
        audienceKind: args.audience_kind,
        now: now(args),
      });
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
        now: now(args),
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
        now: now(args),
      });
    },

    async msp_thread_context(args = {}) {
      return store.context({
        threadId: args.thread_id,
        recentExchangeCount: bounded(args.recent_exchange_count, recentExchangeCount, "recent_exchange_count"),
        currentExchangeId: args.current_exchange_id,
        // Injected by thread-guard.mjs from the verified grant principal --
        // never trusted from the request body itself.
        requesterSpeakerId: args.requester_speaker_id,
        now: now(args),
      });
    },

    async msp_session_sweep(args = {}) {
      return store.sweepIdleSessions({
        now: now(args),
        limit: args.limit ?? 100,
        tenantId: args.tenant_id,
        businessId: args.business_id,
        channelAccountId: args.channel_account_id,
        externalRoomRef: args.external_room_ref,
      });
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
        leaseToken: args.lease_token,
        now: now(args),
      });
    },

    async msp_session_compaction_retry(args = {}) {
      return store.retryCompaction({ jobId: args.job_id, error: args.error, leaseToken: args.lease_token, now: now(args) });
    },
    async msp_session_compaction_claim(args = {}) {
      return store.claimCompaction({ jobId: args.job_id, workerId: args.worker_id, leaseSeconds: args.lease_seconds, now: now(args) });
    },
    async msp_thread_delivery_record(args = {}) {
      return store.recordDelivery({
        inboundMessageId: args.inbound_message_id,
        sourceEventId: args.source_event_id,
        receiptId: args.receipt_id,
        outcome: args.outcome,
        text: args.text,
        providerRef: args.provider_ref,
        scope: args.delivery_scope,
        now: now(args),
      });
    },
    async msp_thread_injection_record(args = {}) {
      return store.recordInjection({
        threadId: args.thread_id,
        exchangeId: args.exchange_id,
        injectionId: args.injection_id,
        packetHash: args.packet_hash,
        policyRevision: args.policy_revision,
        modelRef: args.model_ref,
        state: args.state,
        now: now(args),
      });
    },
  };
}

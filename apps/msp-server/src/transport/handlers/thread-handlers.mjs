// Transport wrappers for the unified thread/speaker/session memory contract
// (API-011, TASK-MEMOS-002). Zuri supplies opaque channel and Person
// references; this handler never resolves a provider id or decides
// authorization -- that is thread-guard.mjs's job, wrapped around every one
// of these handlers before it is registered on the tool registry
// (see server.mjs). Journaling is entirely ThreadMemoryStore's
// responsibility (msp-core): it already HMACs every actor before writing an
// entry, so this file never calls journal.append itself.
import { ThreadMemoryStore } from "@freshair129/msp-core/thread-memory";
import { ThreadValidationError } from "@freshair129/msp-core/errors";

/**
 * @param {object} options
 * @param {boolean} [options.allowTestClock] W1: whether `args.now` may ever
 *   reach the domain layer. Read ONCE at the composition root
 *   (server.mjs, from `env.MSP_TEST_CLOCK === "1"`) and passed in here --
 *   this file never reads process.env itself, so there is exactly one place
 *   in the whole runtime that decides whether a caller may steal or extend
 *   a lease by lying about the time.
 */
export function createThreadHandlers({ db, journal, identityHmacKey = null, idleTimeoutMinutes = 30, recentExchangeCount = 6, allowTestClock = false, retentionDays = 0 }) {
  const store = new ThreadMemoryStore(db, journal, { identityHmacKey });
  const now = (args) => (allowTestClock ? args.now : undefined);
  const bounded = (value, ceiling, label) => {
    if (value === undefined || value === null) return ceiling;
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      // RKOI review (2nd round), WARNING 5: a typed error, not a raw Error.
      throw new ThreadValidationError(`${label} exceeds the MSP deployment policy ceiling.`);
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
        // PH-MEMOS-3 stage 2 (BL-MEMOS-041): thread-guard.mjs verifies and
        // injects these from the grant -- this handler never reads a raw
        // agentId/workspaceId/assertAgents claim off the wire directly.
        agentId: args.grant_agent_id,
        workspaceId: args.grant_workspace_id,
        assertAgents: args.grant_assert_agents,
        mayMint: args.grant_may_mint,
        // PH-MEMOS-3 stage 2 (BL-MEMOS-048): guard-verified nonce claim,
        // consumed inside resolveThread's own transaction on every outcome.
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
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
        // PH-MEMOS-3 stage 2 (§8.4): the journal actor for an
        // AGENT-attributable entry becomes this id directly, in plain text.
        agentId: args.grant_agent_id,
        // RKOI review (stage-2 revision, WARNING 6): journal workspace_id.
        workspaceId: args.grant_workspace_id,
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
        // PH-MEMOS-3 stage 2 (BL-MEMOS-043): agentId is guard-verified
        // (grant.agentId), never trusted from the wire; visibility is a
        // new, optional, additive request field (default THREAD).
        agentId: args.grant_agent_id,
        // RKOI review (stage-2 revision, WARNING 6): journal workspace_id.
        workspaceId: args.grant_workspace_id,
        visibility: args.visibility,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
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
        requesterAgentId: args.requester_agent_id,
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
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        // RKOI review (stage-2 revision, WARNING 6): journal workspace_id.
        workspaceId: args.grant_workspace_id,
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
        // PH-MEMOS-3 stage 2 (§8.3/§8.4): the worker's own agentId becomes
        // the journal actor, replacing the fixed "msp:compaction-worker"
        // label -- it is now a real, current, attributable agent.
        agentId: args.grant_agent_id,
        // RKOI review (stage-2 revision, WARNING 6): journal workspace_id.
        workspaceId: args.grant_workspace_id,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },

    async msp_session_compaction_retry(args = {}) {
      return store.retryCompaction({ jobId: args.job_id, error: args.error, leaseToken: args.lease_token, nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at, now: now(args) });
    },
    async msp_session_compaction_claim(args = {}) {
      return store.claimCompaction({ jobId: args.job_id, workerId: args.worker_id, leaseSeconds: args.lease_seconds, nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at, now: now(args) });
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
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
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
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },

    // PH-MEMOS-4 (BL-MEMOS-050, Sec.7.1): thread-guard.mjs verifies and
    // injects grant_agent_id/grant_workspace_id/grant_nonce -- this handler
    // never reads a raw claim off the wire directly, matching every other
    // handler in this file.
    async msp_thread_participant_lifecycle(args = {}) {
      return store.participantLifecycle({
        threadId: args.thread_id,
        action: args.action,
        speakerId: args.speaker_id,
        agentId: args.grant_agent_id,
        workspaceId: args.grant_workspace_id,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },

    // PH-MEMOS-4 (BL-MEMOS-051, Sec.8.6): self-only, no agent_id request
    // field at all -- the row closed is always (thread_id, grant.agentId,
    // grant.workspaceId).
    async msp_thread_agent_detach(args = {}) {
      return store.detachAgent({
        threadId: args.thread_id,
        agentId: args.grant_agent_id,
        workspaceId: args.grant_workspace_id,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },

    // PH-MEMOS-4 (BL-MEMOS-053, Sec.11.2): tenant_id/principal_id are
    // guard-resolved (defaulted to the grant's own principal, or the
    // named principal once dataSubjectAdmin is verified) -- never trusted
    // from the raw request body past the guard.
    async msp_thread_principal_erase(args = {}) {
      return store.erasePrincipal({
        principalId: args.principal_id,
        tenantId: args.tenant_id,
        idempotencyKey: args.idempotency_key,
        agentId: args.grant_agent_id,
        workspaceId: args.grant_workspace_id,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },

    // PH-MEMOS-4 (BL-MEMOS-054, Sec.11.2): retentionDays is a deployment
    // ceiling (MSP_THREAD_RETENTION_DAYS), read once at the composition
    // root (server.mjs) and threaded down here -- this handler never reads
    // process.env itself, the same W1-style convention idleTimeoutMinutes/
    // recentExchangeCount already use.
    async msp_thread_retention_tick(args = {}) {
      return store.retentionTick({
        tenantId: args.tenant_id,
        dryRun: args.dry_run === true,
        retentionDays,
        agentId: args.grant_agent_id,
        workspaceId: args.grant_workspace_id,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },

    // PH-MEMOS-4 (BL-MEMOS-055, Sec.11.2): a read, not a mutation -- no
    // nonce consumption inside the domain method's own write path, but the
    // guard still requires a nonce claim for replay-bounded-call
    // discipline (Sec.11.2's own reasoning), consumed alongside the
    // journal write.
    async msp_thread_principal_export(args = {}) {
      return store.exportPrincipal({
        principalId: args.principal_id,
        tenantId: args.tenant_id,
        agentId: args.grant_agent_id,
        workspaceId: args.grant_workspace_id,
        nonce: args.grant_nonce,
        grantExpiresAt: args.grant_expires_at,
        now: now(args),
      });
    },
  };
}

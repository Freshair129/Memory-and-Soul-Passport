// API-011 thread memory (TASK-MEMOS-002), C-2 fix: the DB-backed half of
// thread-tool authorization lives HERE, in apps/msp-server (which is
// allowed to import both msp-core and msp-contracts freely), not inside
// packages/msp-contracts/src/contracts/thread-access.mjs. That file keeps
// only pure grant verification (verifyThreadGrant) and the fail-closed
// assertThreadScope(condition, message) throw helper; this module supplies
// every `condition` it evaluates, using msp-core's ThreadRegistry for the
// DB reads.
//
// This is the external service boundary for the whole API-011 tool
// surface: every registered tool is wrapped here before dispatch, mirroring
// how contracts/vault-scope-guard.mjs's assertVaultScope is orchestrated by
// a transport/handlers/*.mjs module for the vault surface.
import { hmacRoomRef, ThreadRegistry } from "@freshair129/msp-core/thread-memory";
import { AgentNotCurrentError, GrantNonceRequiredError, ThreadAudienceMismatchError, ThreadNotFoundError, ThreadValidationError } from "@freshair129/msp-core/errors";
import { assertThreadScope, verifyThreadGrant } from "@freshair129/msp-contracts/thread-access";
import { validateThreadContract } from "@freshair129/msp-contracts/thread-schema";

const ASSURANCE_RANK = { UNRESOLVED: 0, PENDING: 1, VERIFIED: 2 };

// PH-MEMOS-3 stage 2 (BL-MEMOS-048, Sec.6.1.1): every mutating tool except
// msp_thread_message_append (source_event_id already gives it replay
// protection -- a second layer would be redundant) and msp_thread_context
// (read-only, nothing to replay). PH-MEMOS-4 (Sec.7.1/Sec.8.6/Sec.11.2)
// adds all five new tools EXCEPT msp_thread_retention_tick, whose nonce
// requirement is conditional on dry_run (DEC-MEMOS-35, checked separately
// below, not a blanket membership in this set).
const NONCE_REQUIRED_TOOLS = new Set([
  "msp_thread_resolve",
  "msp_thread_memory_record",
  "msp_thread_injection_record",
  "msp_thread_delivery_record",
  "msp_session_sweep",
  "msp_session_compaction_claim",
  "msp_session_compaction_commit",
  "msp_session_compaction_retry",
  "msp_thread_participant_lifecycle",
  "msp_thread_agent_detach",
  "msp_thread_principal_erase",
  "msp_thread_principal_export",
]);

// PH-MEMOS-4 (Sec.11.2): the three new tools that are NOT thread-bound --
// tenant/principal-scoped (erase/export) or tenant-scoped (retention),
// never routed through threadLookupFor. Named explicitly here, the same
// way NONCE_REQUIRED_TOOLS is already named as one guard edit site, so the
// deny-all fall-through below excludes them by name instead of refusing
// them unconditionally the instant they are registered.
const NON_THREAD_BOUND_TOOLS = new Set(["msp_session_sweep", "msp_thread_delivery_record", "msp_thread_principal_erase", "msp_thread_retention_tick", "msp_thread_principal_export"]);

// RKOI review (2nd round), WARNING 3: the SAME message for "no thread
// resolves at all" and "a thread resolves, but not to this grant's scope" --
// a caller must never be able to tell "that id does not exist" apart from
// "that id belongs to someone else" from the error text alone.
const SCOPE_MESSAGE = "thread_scope_denied: the request does not resolve to a thread this grant can access.";

function threadLookupFor(registry, name, input) {
  if (input.thread_id) return registry.findThreadById(input.thread_id);
  if (input.session_id) return registry.findThreadBySession(input.session_id);
  if (input.job_id) return registry.findThreadByJob(input.job_id);
  if (name === "msp_thread_delivery_record") return registry.findThreadByMessage(input.inbound_message_id);
  return null;
}

/**
 * @param {object} options
 * @param {import("better-sqlite3").Database} options.db
 * @param {string|((tenantId: string|undefined) => string|undefined)} options.key
 *   MSP_THREAD_SERVICE_KEY, or (RKOI review, item 9) a per-tenant resolver
 *   function -- passed straight through to
 *   @freshair129/msp-contracts/thread-access's verifyThreadGrant. Stage 1
 *   always resolves to the single MSP_THREAD_SERVICE_KEY; stage 2 can add a
 *   real keyring here without changing this guard.
 * @param {string} options.identityHmacKey MSP_IDENTITY_HMAC_KEY -- used ONLY
 *   to recompute a grant's own room hash for the WARNING 1 room check below;
 *   every OTHER identity hash (room ref at write time, journal actor) stays
 *   msp-core's job.
 * @param {() => number} [options.clock]
 */
export function createThreadGuard({ db, key, identityHmacKey, clock = Date.now }) {
  const registry = new ThreadRegistry(db);

  return function guardThreadHandler({ name, handler }) {
    return async (args = {}) => {
      const { access, ...input } = args;
      const now = clock();
      const grant = verifyThreadGrant(name, input, access, key, now);
      validateThreadContract(name, args);

      // PH-MEMOS-3 stage 2 (§8.4): agentId/workspaceId are required on
      // every one of the ten tools (verifyThreadGrant, BL-MEMOS-040) and
      // several domain-layer methods need the calling agent's own id for
      // reasons beyond currency (the journal actor on an agent-attributable
      // entry, the speaker id on a resolved-path delivery, the agent_id
      // stamped onto a protected-memory record) -- injected once here,
      // universally, the same guard-verified-pass-through convention as
      // input.requester_speaker_id/input.delivery_scope below, rather than
      // duplicated per tool.
      input.grant_agent_id = grant.agentId;
      input.grant_workspace_id = grant.workspaceId;

      // PH-MEMOS-3 stage 2 (BL-MEMOS-048, Sec.6.1.1): a nonce-required
      // tool called with no nonce claim at all is refused before anything
      // else -- a guard-level PRESENCE check, distinct from the
      // domain-level replay-CONSUMPTION logic (GrantReplayedError) each
      // relevant store method performs inside its own transaction.
      //
      // RKOI review (stage-2 revision, WARNING 2, DEC-MEMOS-20): presence
      // (undefined/null -- "no nonce claim at all") is grant_nonce_required;
      // anything else that is not a plain string of 1-128 characters is a
      // MALFORMED claim, refused as a typed validation_failed naming the
      // type problem, never silently coerced. The value is used EXACTLY as
      // given -- never trimmed -- so `" padnonce "` and `"padnonce"` are
      // two distinct nonces, not the same one collapsed by trimming.
      // PH-MEMOS-4 (Sec.11.2, DEC-MEMOS-35): msp_thread_retention_tick's
      // nonce is required only when dry_run is NOT true -- a dry_run:true
      // call is fully read-only with respect to mutation and replay, the
      // same exemption msp_thread_context already has for being genuinely
      // read-only, so it is checked here as an addition to the set rather
      // than a blanket member of it.
      const nonceRequired = NONCE_REQUIRED_TOOLS.has(name) || (name === "msp_thread_retention_tick" && input.dry_run !== true);
      if (nonceRequired) {
        if (grant.nonce === undefined || grant.nonce === null) throw new GrantNonceRequiredError();
        if (typeof grant.nonce !== "string") {
          throw new ThreadValidationError(`nonce must be a string, got ${typeof grant.nonce}.`);
        }
        if (grant.nonce.length < 1 || grant.nonce.length > 128) {
          throw new ThreadValidationError(`nonce must be between 1 and 128 characters, got ${grant.nonce.length}.`);
        }
        input.grant_nonce = grant.nonce;
        // Sec.12.2: the nonce's own expiry is derived from the grant's OWN
        // expiresAt claim (already bounds-checked by verifyThreadGrant
        // against the real server clock above), never from any
        // domain-layer business timestamp a caller can influence under
        // MSP_TEST_CLOCK=1.
        input.grant_expires_at = grant.expiresAt;
      }

      // RKOI review, item 11: these presence checks run BEFORE the thread
      // lookup below, so a request missing its lease entirely is refused
      // the same way whether or not job_id happens to resolve to a real
      // job -- the lease requirement is not contingent on the job existing.
      if (name === "msp_session_compaction_commit") {
        assertThreadScope(!!input.lease_token && !!input.source_digest, "thread_scope_denied: compaction commit requires its lease.");
      }
      if (name === "msp_session_compaction_retry") {
        assertThreadScope(!!input.lease_token, "thread_scope_denied: compaction retry requires its lease token.");
      }

      const thread = threadLookupFor(registry, name, input);

      if (name === "msp_thread_resolve") {
        assertThreadScope(
          input.tenant_id === grant.tenantId &&
            (input.business_id ?? null) === (grant.businessId ?? null) &&
            input.channel_account_id === grant.channelAccountId &&
            input.external_room_ref === grant.externalRoomRef,
          SCOPE_MESSAGE,
        );
        // RKOI review, item 1: on mint, thread_kind, audience_kind (when
        // sent) and the grant's own audienceKind claim must all agree.
        // zuri-ai's resolve grant always carries audienceKind (its port's
        // resolveThread signs `audienceKind: audience` unconditionally), so
        // this check is unconditional here, unlike the existing-thread
        // check below.
        if (
          input.thread_kind !== grant.audienceKind ||
          (input.audience_kind !== undefined && input.audience_kind !== null && input.audience_kind !== input.thread_kind)
        ) {
          throw new ThreadAudienceMismatchError(
            "thread_kind, audience_kind and the grant's audienceKind must all agree on msp_thread_resolve.",
          );
        }
        // PH-MEMOS-3 stage 2 (BL-MEMOS-041, §8.1/§8.3): the guard decides
        // whether this grant may ever MINT a thread -- a worker-only grant
        // (operator, with none of the reader/writer capability flags) may
        // never bring a room's first thread into existence (DEC-MEMOS-18).
        // The mint-race-safe attach/currency decision itself is the
        // domain layer's job (ThreadMemoryStore#resolveThread's own
        // transaction); this guard only ever passes down verified grant
        // claims and this one derived capability flag, exactly like
        // input.delivery_scope below.
        const workerOnlyGrant =
          grant.operator === true &&
          grant.readPrivate !== true &&
          grant.writePrivate !== true &&
          grant.confirmMemory !== true &&
          grant.deliveryWriter !== true;
        input.grant_assert_agents = grant.assertAgents === true;
        input.grant_may_mint = !workerOnlyGrant;
      } else if (thread) {
        assertThreadScope(
          thread.status === "ACTIVE" &&
            thread.tenantId === grant.tenantId &&
            thread.businessId === (grant.businessId ?? null) &&
            thread.channelAccountId === grant.channelAccountId,
          SCOPE_MESSAGE,
        );
        // RKOI review (2nd round), WARNING 1 / CRITICAL (round 2): channel_
        // account_id equality alone is not enough -- many threads can share
        // one channel_account_id (many rooms under one LINE OA). The
        // grant's OWN room (tenantId|channelAccountId|externalRoomRef) must
        // hash to the SAME value as this specific thread's stored hash, for
        // EVERY thread-bound tool, including compaction claim/commit/retry
        // via the job's thread. Without this, a grant scoped to room
        // "dm-b" (or an operator's own distinct room) could act on, or
        // read, a DIFFERENT room's thread as long as the channel account
        // matched.
        //
        // RKOI code review round 2, CRITICAL: this check used to run only
        // `if (grant.externalRoomRef)`, so a validly-SIGNED grant that
        // simply OMITTED externalRoomRef skipped the room check entirely --
        // fail OPEN, not fail closed. RKOI's r2/p2.mjs probe demonstrated
        // this claiming another room's compaction job, reading/appending to
        // a DIRECT thread that was not the grant's own, and planting a
        // membership into a GROUP thread with no room claim at all. Every
        // real zuri-ai grant for every thread-bound tool always carries
        // both externalRoomRef and channelAccountId (verified against
        // zuri-ai origin/main's createMspThreadMemoryPort); a grant missing
        // either is refused outright, never treated as "no room to check".
        assertThreadScope(!!grant.externalRoomRef && !!grant.channelAccountId, SCOPE_MESSAGE);
        const grantRoomHmac = hmacRoomRef(identityHmacKey, {
          tenantId: grant.tenantId,
          channelAccountId: grant.channelAccountId,
          externalRoomRef: grant.externalRoomRef,
        });
        assertThreadScope(grantRoomHmac === thread.externalRoomRefHmac, SCOPE_MESSAGE);
        // RKOI review (docs round 4), replacing the "skip when absent" rule
        // from the earlier round: audienceKind is REQUIRED on every later
        // call against an existing thread EXCEPT msp_thread_delivery_record
        // -- zuri-ai's own port sends it on the other five tools
        // (resolveThread, appendMessage, context, recordProtectedMemory,
        // recordInjection's claimsFor route). msp_thread_delivery_record's
        // grant never carries one (verified against zuri-ai origin/main's
        // createMspThreadMemoryPort#recordDelivery) -- its scope comes from
        // the inbound message's own thread plus the room-hash check above,
        // so the audience check is skipped ONLY when the claim is genuinely
        // absent; a delivery grant that DOES carry audienceKind is still
        // checked. ROOM behaves exactly like GROUP here -- neither is
        // DIRECT, so neither ever reaches a private read below.
        if (name === "msp_thread_delivery_record" && grant.audienceKind === undefined) {
          // no audience claim to check for this one tool.
        } else if (grant.audienceKind === undefined || grant.audienceKind !== thread.audienceKind) {
          throw new ThreadAudienceMismatchError(
            `the grant's audienceKind ("${grant.audienceKind}") does not match this thread's own kind ("${thread.audienceKind}").`,
          );
        }
        // PH-MEMOS-3 stage 2 (BL-MEMOS-042, §8.2): every thread-bound tool
        // OTHER than msp_thread_resolve (whose own attach-or-currency logic
        // lives inside ThreadMemoryStore#resolveThread's own transaction,
        // §8.1) requires the calling agent be CURRENT (an open thread_agents
        // row) on this exact thread. Reached uniformly here for append,
        // context, memory_record, injection_record,
        // msp_thread_delivery_record's RESOLVED path (thread resolved via
        // inbound_message_id), and claim/commit/retry (thread resolved via
        // the job's own thread) -- no per-tool special-casing needed. This
        // is a DEDICATED code (agent_not_current), not thread_scope_denied
        // -- a caller must be able to tell "you're not authorized for this
        // thread at all" apart from "you're not this thread's current
        // agent," since the fix differs (attach via assertAgents on
        // msp_thread_resolve, vs. a scope problem entirely). Delivery's
        // PENDING path (no thread resolvable at all yet) gets its own
        // separate room-based check, BL-MEMOS-112.
        if (!registry.findCurrentAgent(thread.threadId, grant.agentId, grant.workspaceId)) {
          throw new AgentNotCurrentError();
        }
      } else if (!NON_THREAD_BOUND_TOOLS.has(name)) {
        assertThreadScope(false, SCOPE_MESSAGE);
      }

      // PH-MEMOS-4 (BL-MEMOS-050, Sec.7.1): msp_thread_participant_lifecycle
      // is thread-bound in the guard's ordinary sense (input.thread_id), so
      // it already received the full generic `else if (thread)` check above
      // -- both actions only add their own extra checks on top of it, the
      // same shape msp_thread_memory_record's writePrivate+DIRECT check
      // already has.
      if (name === "msp_thread_participant_lifecycle") {
        // DEC-MEMOS-22: `leave` always requires assertParticipants,
        // unconditionally, self or third-party -- no self-service
        // exception. DEC-MEMOS-23: `close_for_relink` requires the SAME
        // claim, plus assertRelink below -- neither substitutes for the
        // other, and grant.operator never substitutes for either.
        assertThreadScope(
          grant.assertParticipants === true,
          "thread_scope_denied: participant lifecycle changes require assertParticipants.",
        );
        if (input.action === "close_for_relink") {
          // DEC-MEMOS-23: GROUP/ROOM threads have no single-Person binding
          // to relink.
          assertThreadScope(thread.audienceKind === "DIRECT", "thread_scope_denied: close_for_relink is DIRECT-only.");
          assertThreadScope(
            grant.assertRelink === true,
            "thread_scope_denied: close_for_relink requires assertRelink in addition to assertParticipants.",
          );
        }
      }

      // PH-MEMOS-4 (BL-MEMOS-053/054/055, Sec.11.2): the three tenant/
      // principal-scoped tools -- not thread-bound, so `thread` is always
      // null here; every check below is a NEW guard branch, name-matched
      // rather than the generic `else if (thread)` path.
      if (name === "msp_thread_principal_erase" || name === "msp_thread_principal_export") {
        // DEC-MEMOS-25: self (principal_id absent or === grant.principalId)
        // requires dataSubjectAccess; naming a DIFFERENT principal_id
        // additionally requires dataSubjectAdmin -- both claims together,
        // dataSubjectAdmin alone is not sufficient. Neither claim is
        // operator (DEC-MEMOS-26) -- this is not a worker/compaction
        // concern.
        assertThreadScope(
          grant.dataSubjectAccess === true,
          "thread_scope_denied: this operation requires dataSubjectAccess.",
        );
        const requestedPrincipalId = input.principal_id;
        if (requestedPrincipalId !== undefined && requestedPrincipalId !== null && requestedPrincipalId !== grant.principalId) {
          assertThreadScope(
            grant.dataSubjectAdmin === true,
            "thread_scope_denied: acting on a different principal's data requires dataSubjectAdmin.",
          );
        }
        // Defaults to the grant's own principal -- the self-erasure/export
        // case (Sec.11.2). Overwritten unconditionally, exactly like
        // msp_session_sweep already overwrites its own scope fields from
        // the grant, never trusted from the request body past this point.
        input.principal_id = requestedPrincipalId ?? grant.principalId;
        input.tenant_id = grant.tenantId;
      }

      if (name === "msp_thread_retention_tick") {
        // DEC-MEMOS-26: retention reuses `operator` via an EXPLICIT name
        // check, not the `msp_session_` prefix match below -- this tool's
        // name does not share that prefix.
        assertThreadScope(grant.operator === true, "thread_scope_denied: this operation requires an operator grant.");
        // Deliberately whole-tenant, never room-scoped -- every row this
        // tool touches is WHERE tenant_id = grant.tenantId, with no room/
        // channel-account filter at all (Sec.11.2, a stated ruling).
        input.tenant_id = grant.tenantId;
      }

      if (name === "msp_thread_context") {
        assertThreadScope(
          grant.readPrivate === true && thread.audienceKind === "DIRECT",
          "thread_scope_denied: private context requires readPrivate on a DIRECT thread.",
        );
        // C-1 private-read predicate: DIRECT thread, grant principal IS the
        // current (left_at IS NULL) VERIFIED HUMAN participant. GROUP/ROOM
        // threads never reach here (excluded just above).
        const member = registry.findCurrentHumanParticipant(thread.threadId);
        assertThreadScope(
          !!member && member.speakerId === grant.principalId && member.identityAssurance === "VERIFIED",
          "thread_scope_denied: the grant principal is not this DIRECT thread's current verified human participant.",
        );
        input.requester_speaker_id = grant.principalId;
        // PH-MEMOS-3 stage 2 (BL-MEMOS-043, Sec.9.4): threaded down the
        // same way, for the AGENT/THREAD record-visibility filter.
        input.requester_agent_id = grant.agentId;
      }

      if (name === "msp_thread_message_append" && input.speaker_kind === "HUMAN") {
        // RKOI review (2nd round), WARNING 2: person_id may never name
        // anyone but the grant's own principal, whether creating a
        // membership or changing one -- probe A9c minted person_id=bob
        // under principal erin, which this closes unconditionally.
        const requestedPerson = input.person_id ?? undefined;
        assertThreadScope(
          requestedPerson === undefined || requestedPerson === null || requestedPerson === grant.principalId,
          "thread_scope_denied: person_id must be absent or equal to the grant principal.",
        );

        // BL-MEMOS-058 (design Sec.7 rule 2, PH-MEMOS-4 review round 2,
        // CRITICAL 1): a THREE-WAY branch, not a modified two-branch
        // condition -- "no CURRENT row" and "no row at all" are different
        // questions, and conflating them let a departed principal's very
        // next plain HUMAN append silently re-create membership through
        // the claim-free first-membership path below.
        const everParticipated = registry.hasEverParticipated(thread.threadId, input.speaker_id);
        const current = registry.findCurrentParticipant(thread.threadId, input.speaker_id);
        if (!everParticipated) {
          // Case 1: a genuine first-ever join -- unchanged fast path.
          // Never reads `current` (also null here, but incidentally --
          // the branch's condition is `everParticipated`, not `current`
          // truthiness). zuri-ai's frozen flow (resolve, then a HUMAN
          // append, no separate "join" tool) depends on this succeeding
          // with no extra claim.
          assertThreadScope(
            input.speaker_id === grant.principalId,
            "thread_scope_denied: the first HUMAN membership on a thread must be created by the grant principal.",
          );
        } else if (current === null) {
          // Case 2: a REJOIN -- a row existed before (current or
          // departed), but none is open now. Unconditional
          // assertParticipants, no DEC-MEMOS-15 self-upgrade exception,
          // and `current.personId` (or any other field of `current`) is
          // NEVER read -- `current` is null by this branch's own
          // definition, there is no stored row to compare against. Case
          // 2b (intended, design Sec.7 rule 2 round 3): this condition is
          // keyed on speakerId alone, not `speakerId ===
          // grant.principalId`, so a Tier-1 caller with assertParticipants
          // can also re-attach a DIFFERENT departed third party to a
          // GROUP/ROOM thread -- refused unconditionally on DIRECT by the
          // existing single-HUMAN schema trigger (Sec.6.3).
          assertThreadScope(
            grant.assertParticipants === true,
            "thread_scope_denied: rejoining a thread after leaving requires assertParticipants.",
          );
        } else if (input.speaker_id !== grant.principalId) {
          // Case 3a: a current row exists, third-party change. Never
          // self -- ANY touch to someone else's participant row, changed
          // or not, requires an explicit assertion.
          assertThreadScope(
            grant.assertParticipants === true,
            "thread_scope_denied: creating, upgrading or reassigning a HUMAN participant requires assertParticipants.",
          );
        } else {
          // Case 3b: a current row exists, self (input.speaker_id ===
          // grant.principalId, and the REQUESTED person_id is already
          // constrained above to {null, grant.principalId}). RKOI review
          // (docs round 4), item 3 (tightening DEC-MEMOS-15): the STORED
          // row's person_id must be checked too, not just the value this
          // request sends -- a self upgrade is free only when the
          // participant record was not already linked to some OTHER
          // person (however that happened). If it was, this still needs
          // an explicit assertion even though speaker_id and the
          // REQUESTED person_id both look self-referential. Safe to read
          // `current.personId` here: `current` is non-null by this
          // branch's own construction. A downgrade (VERIFIED -> PENDING)
          // reaches this same branch and is likewise never gated on its
          // own -- ThreadMemoryStore#applyHumanParticipant already treats
          // a downgrade as no change at all, so it is accepted here and
          // silently ignored there, never refused and never stored.
          const storedPerson = current.personId ?? null;
          if (storedPerson !== null && storedPerson !== grant.principalId) {
            assertThreadScope(
              grant.assertParticipants === true,
              "thread_scope_denied: this participant's stored person_id already names someone else; upgrading requires assertParticipants.",
            );
          }
        }
      }

      // PH-MEMOS-3 stage 2 (BL-MEMOS-042, §8.2): for an AGENT-kind message,
      // speaker_id must equal grant.agentId -- the direct analogue of the
      // HUMAN rule above requiring speaker_id === grant.principalId on the
      // first membership. An agent can never author a message as a
      // different agent's speaker_id.
      if (name === "msp_thread_message_append" && input.speaker_kind === "AGENT") {
        assertThreadScope(
          input.speaker_id === grant.agentId,
          "thread_scope_denied: an AGENT-kind message's speaker_id must equal the grant's agentId.",
        );
      }

      if (name === "msp_thread_memory_record") {
        assertThreadScope(
          grant.writePrivate === true && thread.audienceKind === "DIRECT",
          "thread_scope_denied: recording protected memory requires writePrivate on a DIRECT thread.",
        );
        assertThreadScope(
          input.asserted_by_speaker_id === grant.principalId,
          "thread_scope_denied: asserted_by_speaker_id must equal the grant principal.",
        );
        if (input.verification_state === "CONFIRMED") {
          assertThreadScope(grant.confirmMemory === true, "thread_scope_denied: CONFIRMED requires confirmMemory.");
        }
      }

      if (name === "msp_thread_injection_record") {
        assertThreadScope(
          grant.readPrivate === true && thread.audienceKind === "DIRECT",
          "thread_scope_denied: injection receipts require readPrivate on a DIRECT thread.",
        );
      }

      if (name.startsWith("msp_session_")) {
        assertThreadScope(grant.operator === true, "thread_scope_denied: this operation requires an operator grant.");
      }

      if (name === "msp_thread_delivery_record") {
        assertThreadScope(grant.deliveryWriter === true, "thread_scope_denied: delivery receipts require a deliveryWriter grant.");
        // RKOI review (2nd round), CRITICAL 1: zuri-ai's own delivery grant
        // (createMspThreadMemoryPort#recordDelivery) never carries a
        // channelType claim -- requiring one made every delivery
        // unreachable. The room hash no longer needs channel_type at all
        // (see hmacRoomRef's header comment in msp-core/thread-memory.mjs),
        // so channelType is no longer required, or even read, here.
        assertThreadScope(
          !!grant.channelAccountId && !!grant.externalRoomRef,
          "thread_scope_denied: the delivery grant is missing its channel scope.",
        );
        // PH-MEMOS-3 stage 2 (BL-MEMOS-112, §8.2 CRITICAL 1): the PENDING
        // path (no thread resolved above -- inbound_message_id does not
        // name an existing message yet) has no thread_id to check agent
        // currency against. Resolve the room's own ACTIVE thread directly
        // (the exact triple idx_threads_active_binding uniques on) and
        // require the calling agent be current on THAT thread before the
        // pending row is ever written. The RESOLVED path (thread truthy)
        // already got its currency check from the general "else if
        // (thread)" branch above -- this is deliberately the one place
        // that branch could not reach.
        if (!thread) {
          const pendingRoomHmac = hmacRoomRef(identityHmacKey, {
            tenantId: grant.tenantId,
            channelAccountId: grant.channelAccountId,
            externalRoomRef: grant.externalRoomRef,
          });
          const pendingThread = registry.findThreadByRoom({
            tenantId: grant.tenantId,
            channelAccountId: grant.channelAccountId,
            externalRoomRefHmac: pendingRoomHmac,
          });
          if (!pendingThread) {
            // Reusing ThreadNotFoundError/not_found's existing definition
            // ("no matching thread") -- never a new thread_not_found
            // string. It is never possible to queue a pending delivery for
            // a room MSP has never seen an ACTIVE thread for.
            throw new ThreadNotFoundError("No ACTIVE thread exists for this room yet.");
          }
          if (!registry.findCurrentAgent(pendingThread.threadId, grant.agentId, grant.workspaceId)) {
            throw new AgentNotCurrentError();
          }
        }
        input.delivery_scope = {
          tenantId: grant.tenantId,
          businessId: grant.businessId ?? null,
          channelAccountId: grant.channelAccountId,
          externalRoomRef: grant.externalRoomRef,
          // PH-MEMOS-3 stage 2 (§8.2): stamped onto the pending row
          // (required going forward) and used by the RESOLVED path's own
          // internal append as speakerId -- never the removed hard-coded
          // 'zuri-line-agent' label.
          agentId: grant.agentId,
          workspaceId: grant.workspaceId,
        };
      }

      if (name === "msp_session_compaction_commit") {
        for (const value of Object.values(input.summary ?? {})) {
          assertThreadScope(
            Array.isArray(value) && value.every((item) => item && typeof item === "object"),
            "thread_scope_denied: malformed summary payload.",
          );
        }
      }

      // Sweep must never turn a tenant-bound operator into an all-tenant
      // worker: every filter field is OVERWRITTEN from the grant, never
      // trusted from the request body.
      if (name === "msp_session_sweep") {
        input.tenant_id = grant.tenantId;
        input.business_id = grant.businessId ?? null;
        input.channel_account_id = grant.channelAccountId;
        input.external_room_ref = grant.externalRoomRef;
        assertThreadScope(!!input.channel_account_id && !!input.external_room_ref, "thread_scope_denied: sweep grant is missing its channel scope.");
      }

      // W1: a caller-supplied `now` is never honored unless the composition
      // root explicitly opted into a test clock (server.mjs reads
      // MSP_TEST_CLOCK once, at startup, and threads that decision down to
      // thread-handlers.mjs) -- otherwise a caller could steal or extend a
      // lease by lying about the time. This guard never itself decides that;
      // it only ever forwards `input` to the handler, which is where that
      // decision is actually enforced (createThreadHandlers).
      //
      // RKOI review (2nd round), WARNING 5: output validation against
      // API-011.tools.json used to run here, AFTER `handler(input)` had
      // already committed the domain's own DB transaction -- a mismatch
      // could only ever be reported once the write had already happened,
      // which is not a fail-closed check, only a late diagnostic. It is
      // deliberately REMOVED rather than moved: the domain layer's
      // responses are built exclusively by this module's own typed
      // row-mappers (rowThread/rowMessage/etc in thread-memory.mjs), never
      // by echoing untrusted input, so a mismatch here would mean a defect
      // in that mapping code that already shipped -- an output check
      // running after commit cannot prevent that, only report it after the
      // fact, and input validation (still run above, before ANY write)
      // remains the fail-closed half of contract enforcement.
      return await handler(input);
    };
  };
}

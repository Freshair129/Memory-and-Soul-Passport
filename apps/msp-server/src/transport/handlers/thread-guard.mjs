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
import { ThreadRegistry } from "@freshair129/msp-core/thread-memory";
import { ThreadAudienceMismatchError } from "@freshair129/msp-core/errors";
import { assertThreadScope, verifyThreadGrant } from "@freshair129/msp-contracts/thread-access";
import { validateThreadContract } from "@freshair129/msp-contracts/thread-schema";

const ASSURANCE_RANK = { UNRESOLVED: 0, PENDING: 1, VERIFIED: 2 };

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
 * @param {() => number} [options.clock]
 */
export function createThreadGuard({ db, key, clock = Date.now }) {
  const registry = new ThreadRegistry(db);

  return function guardThreadHandler({ name, handler }) {
    return async (args = {}) => {
      const { access, ...input } = args;
      const now = clock();
      const grant = verifyThreadGrant(name, input, access, key, now);
      validateThreadContract(name, args);

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
          "thread_scope_denied: the resolve request does not match the grant's channel scope.",
        );
        // RKOI review, item 1: on mint, thread_kind, audience_kind (when
        // sent) and the grant's own audienceKind claim must all agree.
        if (
          input.thread_kind !== grant.audienceKind ||
          (input.audience_kind !== undefined && input.audience_kind !== null && input.audience_kind !== input.thread_kind)
        ) {
          throw new ThreadAudienceMismatchError(
            "thread_kind, audience_kind and the grant's audienceKind must all agree on msp_thread_resolve.",
          );
        }
      } else if (thread) {
        assertThreadScope(
          thread.status === "ACTIVE" &&
            thread.tenantId === grant.tenantId &&
            thread.businessId === (grant.businessId ?? null) &&
            thread.channelAccountId === grant.channelAccountId,
          "thread_scope_denied: the thread does not match the grant's channel scope.",
        );
        // RKOI review, item 1: on every later call against an existing
        // thread, the grant's audienceKind must match the thread's own
        // (immutable) thread_kind. ROOT behaves exactly like GROUP here --
        // neither is DIRECT, so neither ever reaches a private read below.
        if (grant.audienceKind !== thread.audienceKind) {
          throw new ThreadAudienceMismatchError(
            `the grant's audienceKind ("${grant.audienceKind}") does not match this thread's own kind ("${thread.audienceKind}").`,
          );
        }
      } else if (!["msp_session_sweep", "msp_thread_delivery_record"].includes(name)) {
        assertThreadScope(false, "thread_scope_denied: unknown thread reference.");
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
      }

      if (name === "msp_thread_message_append") {
        // A HUMAN append must always speak as the grant principal, UNLESS
        // the grant carries an explicit assertParticipants claim asserting
        // a change on someone else's behalf (RKOI review, item 2).
        if (input.speaker_kind === "HUMAN") {
          const current = registry.findCurrentParticipant(thread.threadId, input.speaker_id);
          if (!current) {
            // The FIRST-EVER membership for this speaker_id is always
            // bound to the grant principal -- never caller-asserted, even
            // under assertParticipants. zuri-ai's frozen flow (resolve,
            // then a HUMAN append, no separate "join" tool) depends on
            // this succeeding with no extra claim.
            assertThreadScope(
              input.speaker_id === grant.principalId,
              "thread_scope_denied: the first HUMAN membership on a thread must be created by the grant principal.",
            );
          } else {
            // Omitting person_id on a routine follow-up append is "no
            // change requested", never "unlink" -- only an EXPLICIT,
            // different person_id counts as a change (matches
            // ThreadMemoryStore#applyHumanParticipant's own
            // `personId || existing.person_id` "keep unless explicitly
            // replaced" semantics in msp-core).
            const requestedPerson = input.person_id ?? undefined;
            const requestedAssurance = input.identity_assurance;
            const isChange =
              (requestedPerson !== undefined && requestedPerson !== (current.personId ?? null)) ||
              (ASSURANCE_RANK[requestedAssurance] ?? -1) > (ASSURANCE_RANK[current.identityAssurance] ?? -1);
            if (isChange || input.speaker_id !== grant.principalId) {
              // Continuing as an already-current, UNCHANGED participant
              // needs no extra claim as long as the caller IS that
              // principal. Anything else -- a state change, or speaking as
              // a speaker_id that is not the grant's own principal at all
              // -- requires an explicit assertParticipants claim.
              assertThreadScope(
                grant.assertParticipants === true,
                "thread_scope_denied: creating, upgrading or reassigning a HUMAN participant requires assertParticipants.",
              );
            }
          }
        }
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
        assertThreadScope(
          !!grant.channelAccountId && !!grant.externalRoomRef && !!grant.channelType,
          "thread_scope_denied: the delivery grant is missing its channel scope.",
        );
        input.delivery_scope = {
          tenantId: grant.tenantId,
          businessId: grant.businessId ?? null,
          channelAccountId: grant.channelAccountId,
          externalRoomRef: grant.externalRoomRef,
          channelType: grant.channelType,
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
      const result = await handler(input);
      validateThreadContract(name, result, "output");
      return result;
    };
  };
}

// API-011 thread memory (TASK-MEMOS-002): business-logic coverage of
// ThreadMemoryStore, exercised through `server.threadHandlers` -- the
// UNGUARDED handler map server.mjs also exposes for exactly this purpose
// (see apps/msp-server/src/server.mjs). Authorization itself (the guard,
// grants, C-1/C-2 and the RKOI-review items) is covered separately by
// tests/security/thread-memory-scoping.security.mjs against the REAL
// guarded stdio process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../apps/msp-server/src/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [];
const servers = [];

function timestamp(minutes) {
  return new Date(Date.parse("2026-09-08T00:00:00.000Z") + minutes * 60_000).toISOString();
}

function summary() {
  return {
    topics: ["onboarding"],
    decisions: ["use the registered workspace"],
    openQuestions: ["confirm the next owner"],
    pendingActions: ["send the setup link"],
    corrections: ["keep the speaker attached to each fact"],
    outcomes: ["thread memory is scoped"],
    participants: ["person:alice", "person:bob"],
  };
}

function makeServer() {
  const root = mkdtempSync(path.join(tmpdir(), "msp-thread-memory-test-"));
  roots.push(root);
  // W1: server.threadHandlers still routes through createThreadHandlers'
  // `now(args)` gate -- MSP_TEST_CLOCK=1 is required for the synthetic
  // `now:` values below to reach the domain layer at all.
  const server = createServer({
    dbPath: path.join(root, "msp.sqlite3"),
    env: { ...process.env, MSP_TEST_CLOCK: "1", MSP_IDENTITY_HMAC_KEY: "a".repeat(40) },
  });
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length) servers.pop().close();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("unified thread, speaker and session memory", () => {
  it("keeps a stable thread, records speakers, retains six exchanges and queues compaction", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const resolved = await tools.msp_thread_resolve({
      actor: "zuri-integration",
      thread_kind: "GROUP",
      audience_kind: "GROUP",
      channel_type: "LINE_GROUP",
      channel_account_id: "oa-zuri",
      external_room_ref: "line-group-hash",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
      now: timestamp(0),
    });
    expect(resolved.created).toBe(true);
    expect(resolved.thread.audienceKind).toBe("GROUP");
    const again = await tools.msp_thread_resolve({
      actor: "zuri-integration",
      thread_kind: "GROUP",
      audience_kind: "GROUP",
      channel_type: "LINE_GROUP",
      channel_account_id: "oa-zuri",
      external_room_ref: "line-group-hash",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
      now: timestamp(1),
    });
    expect(again.created).toBe(false);
    expect(again.thread.threadId).toBe(resolved.thread.threadId);

    let sessionId;
    let firstInbound;
    for (let index = 0; index < 7; index += 1) {
      const exchangeId = `exchange-${index + 1}`;
      const inbound = await tools.msp_thread_message_append({
        thread_id: resolved.thread.threadId,
        session_id: sessionId,
        exchange_id: exchangeId,
        source_event_id: `event-in-${index + 1}`,
        speaker_id: index % 2 === 0 ? "line-speaker-alice" : "line-speaker-bob",
        speaker_kind: "HUMAN",
        person_id: index % 2 === 0 ? "person:alice" : "person:bob",
        identity_assurance: "VERIFIED",
        direction: "INBOUND",
        text: `คำถามรอบที่ ${index + 1}`,
        now: timestamp(index),
        occurred_at: timestamp(index),
        idle_timeout_minutes: 30,
        policy_revision: "line-memory-v1",
      });
      sessionId = inbound.session.sessionId;
      firstInbound ??= inbound.message;
      const outbound = await tools.msp_thread_message_append({
        thread_id: resolved.thread.threadId,
        session_id: sessionId,
        exchange_id: exchangeId,
        source_event_id: `event-out-${index + 1}`,
        reply_to_message_id: inbound.message.messageId,
        speaker_id: "zuri-agent",
        speaker_kind: "AGENT",
        identity_assurance: "VERIFIED",
        direction: "OUTBOUND",
        text: `คำตอบรอบที่ ${index + 1}`,
        now: timestamp(index),
        delivery_state: "DELIVERED",
      });
      expect(outbound.message.exchangeId).toBe(exchangeId);
    }

    const memory = await tools.msp_thread_memory_record({
      thread_id: resolved.thread.threadId,
      session_id: sessionId,
      kind: "CONSTRAINT",
      asserted_by_speaker_id: "line-speaker-alice",
      subject_person_id: "line-speaker-alice",
      scope: { audience: "GROUP", business_id: "business-smartgift" },
      body: { text: "ตอบเป็นหลาย bubble" },
      source_message_refs: [firstInbound.messageId],
      verification_state: "CONFIRMED",
      now: timestamp(7),
    });
    expect(memory.kind).toBe("CONSTRAINT");

    const beforeClose = await tools.msp_thread_context({ thread_id: resolved.thread.threadId, recent_exchange_count: 6, now: timestamp(7) });
    expect(beforeClose.recentExchangeCount).toBe(6);
    await expect(tools.msp_thread_context({ thread_id: resolved.thread.threadId, recent_exchange_count: 7, now: timestamp(7) })).rejects.toThrow(/policy ceiling/i);
    // AGENT never becomes a participant (C-1): only the two HUMAN speakers show up.
    expect(beforeClose.participants.map((entry) => entry.speakerId).sort()).toEqual(["line-speaker-alice", "line-speaker-bob"].sort());
    expect(beforeClose.recentExchanges[0].messages[0].speakerId).toBe("line-speaker-bob");

    const sweep = await tools.msp_session_sweep({ now: timestamp(40) });
    expect(sweep.closed).toBe(1);
    expect(sweep.jobs[0].sourceStartSequence).toBe(1);
    expect(sweep.jobs[0].sourceEndSequence).toBe(14);

    const duplicate = await tools.msp_thread_message_append({
      thread_id: resolved.thread.threadId,
      source_event_id: "event-in-7",
      speaker_id: "line-speaker-alice",
      speaker_kind: "HUMAN",
      person_id: "person:alice",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: `คำถามรอบที่ 7`,
      now: timestamp(40),
    });
    expect(duplicate.deduplicated).toBe(true);

    // RKOI review, item 8: an identical replay is still idempotent, but a
    // replay of the SAME source_event_id with DIFFERENT content conflicts.
    await expect(
      tools.msp_thread_message_append({
        thread_id: resolved.thread.threadId,
        source_event_id: "event-in-7",
        speaker_id: "line-speaker-alice",
        speaker_kind: "HUMAN",
        identity_assurance: "VERIFIED",
        direction: "INBOUND",
        text: "ข้อความที่ไม่ตรงกัน",
        now: timestamp(40),
      }),
    ).rejects.toThrow(/conflict/i);

    const nextWhileCompacting = await tools.msp_thread_message_append({
      thread_id: resolved.thread.threadId,
      exchange_id: "exchange-8",
      source_event_id: "event-in-8",
      speaker_id: "line-speaker-alice",
      speaker_kind: "HUMAN",
      person_id: "person:alice",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: "ข้อความใน session ใหม่ระหว่างสรุป",
      now: timestamp(40),
      idle_timeout_minutes: 30,
      policy_revision: "line-memory-v1",
    });
    expect(nextWhileCompacting.session.sessionId).not.toBe(sessionId);
    expect(nextWhileCompacting.session.summaryWatermark).toBe(0);

    const claim = await tools.msp_session_compaction_claim({ job_id: sweep.jobs[0].jobId, worker_id: "test-worker", now: timestamp(41) });
    // RKOI review, item 11: the claim response never includes protected records.
    expect(claim.protectedRecords).toBeUndefined();
    const compactInput = {
      session_id: sessionId,
      job_id: sweep.jobs[0].jobId,
      source_start_sequence: 1,
      source_end_sequence: 14,
      summary: Object.fromEntries(Object.entries(summary()).map(([field, items]) => [field, items.map((text) => ({ text, speakerId: firstInbound.speakerId, sourceMessageRefs: [firstInbound.messageId] }))])),
      lease_token: claim.leaseToken,
      source_digest: claim.sourceDigest,
      policy_revision: "line-memory-v1",
      summarizer_version: "zuri-summary-v1",
      now: timestamp(41),
    };
    await expect(tools.msp_session_compaction_commit({ ...compactInput, invocation_state: "RUNNING" })).rejects.toThrow(/terminal model invocation/i);
    const committed = await tools.msp_session_compaction_commit({ ...compactInput, invocation_state: "TERMINAL" });
    expect(committed.summary.coveredThroughSequence).toBe(14);

    const afterClose = await tools.msp_thread_context({ thread_id: resolved.thread.threadId, recent_exchange_count: 6, now: timestamp(42) });
    expect(afterClose.threadSummaries).toHaveLength(1);
    expect(afterClose.threadSummaries[0].overlapsRecent).toBe(true);
    expect(afterClose.coverageGap).toBeNull();

    const next = await tools.msp_thread_message_append({
      thread_id: resolved.thread.threadId,
      session_id: nextWhileCompacting.session.sessionId,
      exchange_id: "exchange-8",
      source_event_id: "event-in-9",
      speaker_id: "line-speaker-alice",
      speaker_kind: "HUMAN",
      person_id: "person:alice",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: "ข้อความต่อเนื่องใน session ใหม่",
      now: timestamp(42),
      idle_timeout_minutes: 30,
      policy_revision: "line-memory-v1",
    });
    expect(next.session.sessionId).toBe(nextWhileCompacting.session.sessionId);
    expect(next.session.summaryWatermark).toBe(14);
  });

  it("does not let a different business reuse an existing channel binding", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const input = {
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE_DM",
      channel_account_id: "oa-zuri",
      external_room_ref: "user-hash",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
    };
    await tools.msp_thread_resolve(input);
    await expect(tools.msp_thread_resolve({ ...input, business_id: "business-emc" })).rejects.toThrow(/different thread scope/i);
  });

  // W6 / RKOI review item 5: tenant-scoped uniqueness means a source_event_id
  // (or any denormalized child row) in tenant A can never collide with, or
  // be confused for, tenant B's row -- including across two DIFFERENT
  // threads that happen to reuse the same source_event_id string, which is
  // no longer treated as a cross-thread conflict at all (that global check
  // was itself the leak W6 closed).
  it("allows the same source_event_id to be reused across two different threads without conflict or cross-thread leakage", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const base = {
      actor: "zuri-integration",
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE_DM",
      channel_account_id: "oa-zuri",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
    };
    const first = await tools.msp_thread_resolve({ ...base, external_room_ref: "dm-one" });
    const second = await tools.msp_thread_resolve({ ...base, external_room_ref: "dm-two" });
    const firstAppend = await tools.msp_thread_message_append({
      thread_id: first.thread.threadId,
      source_event_id: "source-shared",
      speaker_id: "line-speaker-one",
      speaker_kind: "HUMAN",
      identity_assurance: "PENDING",
      direction: "INBOUND",
      text: "ครั้งแรก",
    });
    const secondAppend = await tools.msp_thread_message_append({
      thread_id: second.thread.threadId,
      source_event_id: "source-shared",
      speaker_id: "line-speaker-two",
      speaker_kind: "HUMAN",
      identity_assurance: "PENDING",
      direction: "INBOUND",
      text: "ข้อความคนละ thread",
    });
    expect(secondAppend.deduplicated).toBe(false);
    expect(secondAppend.message.messageId).not.toBe(firstAppend.message.messageId);
    expect(secondAppend.message.threadId).toBe(second.thread.threadId);
  });

  // RKOI code review round 2, WARNING 3: unlike source_event_id,
  // exchange_id IS a single global namespace by design (the trigger's whole
  // purpose is refusing a second thread's claim on an exchange_id already
  // used by a first) -- going through the real domain call (not a raw SQL
  // INSERT) proves translateTriggerError now maps that RAISE(ABORT) to the
  // module's typed vocabulary, with the exact same generic conflict text as
  // any other caller-supplied global id collision, instead of leaking the
  // raw SqliteError/trigger message.
  it("refuses an inbound append naming an exchange_id already used on a different thread, as a typed conflict with the generic id-collision text", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const base = { thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE_DM", channel_account_id: "oa-zuri", tenant_id: "tenant-01" };
    const first = await tools.msp_thread_resolve({ ...base, external_room_ref: "dm-exchange-one" });
    const second = await tools.msp_thread_resolve({ ...base, external_room_ref: "dm-exchange-two" });
    const firstAppend = await tools.msp_thread_message_append({
      thread_id: first.thread.threadId, source_event_id: "ex-first", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    await expect(
      tools.msp_thread_message_append({
        thread_id: second.thread.threadId,
        source_event_id: "ex-second",
        exchange_id: firstAppend.message.exchangeId,
        speaker_id: "bob",
        speaker_kind: "HUMAN",
        identity_assurance: "VERIFIED",
        direction: "INBOUND",
        text: "stealing the exchange",
      }),
    ).rejects.toThrow(/^conflict: That identifier is already in use\.$/);
  });

  it("requires source_event_id on every append", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const resolved = await tools.msp_thread_resolve({
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE_DM",
      channel_account_id: "oa-zuri",
      external_room_ref: "user-hash-required",
      tenant_id: "tenant-01",
    });
    await expect(
      tools.msp_thread_message_append({
        thread_id: resolved.thread.threadId,
        speaker_id: "line-speaker",
        speaker_kind: "HUMAN",
        identity_assurance: "VERIFIED",
        direction: "INBOUND",
        text: "no source event id",
      }),
    ).rejects.toThrow(/source_event_id/i);
  });

  it("resolves to the current thread when the caller has no identity key configured -- fails closed with identity_hmac_unconfigured", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "msp-thread-memory-no-key-test-"));
    roots.push(root);
    const server = createServer({ dbPath: path.join(root, "msp.sqlite3"), env: { ...process.env, MSP_TEST_CLOCK: "1", MSP_IDENTITY_HMAC_KEY: undefined } });
    servers.push(server);
    await expect(
      server.threadHandlers.msp_thread_resolve({
        thread_kind: "DIRECT",
        audience_kind: "DIRECT",
        channel_type: "LINE_DM",
        channel_account_id: "oa-zuri",
        external_room_ref: "user-hash-no-key",
        tenant_id: "tenant-01",
      }),
    ).rejects.toThrow(/identity_hmac_unconfigured/i);
  });

  // RKOI code review round 2, WARNING 1 (DEC-MEMOS-16, adopted default
  // pending owner confirmation): the room-hash binding does not encode
  // channel_type at all (deliberate -- see hmacRoomRef's header comment), so
  // a resolve naming a DIFFERENT channel_type than the thread that already
  // owns this exact (tenant, channel_account, external_room_ref) binding
  // must be refused as a typed conflict, never silently handed the other
  // channel's thread under the caller's own requested kind.
  it("refuses a resolve whose channel_type differs from the existing ACTIVE thread's binding, never returning the other channel's thread (DEC-MEMOS-16)", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const base = {
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_account_id: "oa-cross-channel",
      external_room_ref: "same-room-ref",
      tenant_id: "tenant-01",
    };
    const line = await tools.msp_thread_resolve({ ...base, channel_type: "LINE" });
    await expect(tools.msp_thread_resolve({ ...base, channel_type: "FACEBOOK" })).rejects.toThrow(/different thread scope/i);
    // Confirm the LINE thread itself is completely unaffected -- a refused
    // cross-channel resolve must not have created, mutated, or handed out
    // any thread under the FACEBOOK identity.
    const relookup = await tools.msp_thread_resolve({ ...base, channel_type: "LINE" });
    expect(relookup.thread.threadId).toBe(line.thread.threadId);
    expect(relookup.created).toBe(false);
  });

  // RKOI code review round 2, WARNING 5: an inbound append naming an
  // explicit, no-longer-open session_id (with no exchange reference) used
  // to fall through to the auto-rotation branch, which silently created a
  // brand-new session -- and if a DIFFERENT session was already OPEN by
  // then, that INSERT collided with idx_chat_sessions_one_open and
  // surfaced as a raw, misleading "That identifier is already in use."
  // conflict. It must instead say the named session is not open.
  it("gives a typed, specific error for an inbound append naming a stale (non-open) session_id while a different session is already OPEN", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const { thread } = await tools.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-stale", external_room_ref: "room-stale", tenant_id: "tenant-01",
    });
    const first = await tools.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "stale-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "first",
      idle_timeout_minutes: 1, now: timestamp(0),
    });
    const staleSessionId = first.session.sessionId;
    // Idle the first session out and rotate into a new OPEN one.
    await tools.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "stale-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "second",
      now: timestamp(5),
    });
    await expect(
      tools.msp_thread_message_append({
        thread_id: thread.threadId,
        session_id: staleSessionId,
        source_event_id: "stale-3",
        speaker_id: "alice",
        speaker_kind: "HUMAN",
        identity_assurance: "VERIFIED",
        direction: "INBOUND",
        text: "naming the stale session",
        now: timestamp(6),
      }),
    ).rejects.toThrow(/session_id names a session that is not open/i);
  });

  // RKOI code review round 2, WARNING 4: a receipt_id colliding with a
  // DIFFERENT tenant's pending delivery answers with the exact same generic
  // conflict text as any other caller-supplied global id collision
  // (message_id/exchange_id/injection_id), chosen because it was cheap to
  // do -- it does not, and cannot, remove the residual existence-oracle
  // inherent to any globally unique caller-supplied id (a truly UNUSED
  // receipt_id still succeeds as PENDING_INBOUND), which is recorded as a
  // named stage-1 gap rather than fixed.
  it("a pending delivery receipt_id colliding with a different tenant's pending delivery gets the same generic conflict text as any other id collision", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    await tools.msp_thread_delivery_record({
      inbound_message_id: "nope-ten1",
      source_event_id: "nope-ten1:assistant",
      receipt_id: "shared-receipt",
      outcome: "ACCEPTED",
      text: "t",
      delivery_scope: { tenantId: "tenant-01", businessId: null, channelAccountId: "oa-r4", externalRoomRef: "room-r4" },
    });
    await expect(
      tools.msp_thread_delivery_record({
        inbound_message_id: "nope-ten2",
        source_event_id: "nope-ten2:assistant",
        receipt_id: "shared-receipt",
        outcome: "ACCEPTED",
        text: "t",
        delivery_scope: { tenantId: "tenant-02", businessId: null, channelAccountId: "oa-r4", externalRoomRef: "room-r4" },
      }),
    ).rejects.toThrow(/That identifier is already in use\./);
    // A genuinely UNUSED receipt_id still succeeds -- the residual
    // existence-oracle this leaves in place is the named stage-1 gap.
    await expect(
      tools.msp_thread_delivery_record({
        inbound_message_id: "nope-ten3",
        source_event_id: "nope-ten3:assistant",
        receipt_id: "totally-unused-receipt",
        outcome: "ACCEPTED",
        text: "t",
        delivery_scope: { tenantId: "tenant-03", businessId: null, channelAccountId: "oa-r4", externalRoomRef: "room-r4" },
      }),
    ).resolves.toMatchObject({ status: "PENDING_INBOUND" });
  });

  // RKOI code review round 3: RKOI's r3/q1.mjs "drain failure after inbound
  // commit (receipt collision)" sequence -- an inbound append must never
  // fail, or become permanently unrepeatable, just because #drainDeliveries
  // (which runs AFTER the append's own transaction has already committed)
  // hits an unreconcilable pending receipt.
  it("an inbound append succeeds, and replays cleanly, even when reconciling its pending delivery collides with an unrelated tenant's already-delivered receipt_id", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const { thread: threadOne } = await tools.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-drain", external_room_ref: "dm-alice-drain", tenant_id: "tenant-drain-1",
    });
    await tools.msp_thread_message_append({
      thread_id: threadOne.threadId, speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice",
      direction: "INBOUND", text: "hi", source_event_id: "alice-e1", message_id: "alice-m1",
    });
    const { thread: threadTwo } = await tools.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-drain", external_room_ref: "dm-zed-drain", tenant_id: "tenant-drain-2",
    });

    // Tenant 1's inbound is fully delivered under receipt_id
    // "crm-delivered-alice" -- a real row in thread_delivery_receipts.
    await tools.msp_thread_delivery_record({
      inbound_message_id: "alice-m1", source_event_id: "alice-m1:assistant", receipt_id: "crm-delivered-alice", outcome: "ACCEPTED", text: "yo",
      delivery_scope: { tenantId: "tenant-drain-1", businessId: null, channelAccountId: "oa-drain", externalRoomRef: "dm-alice-drain" },
    });
    // Tenant 2, entirely independently, records a PENDING delivery for its
    // OWN future inbound message, using the exact SAME receipt_id (a
    // caller-supplied global id -- see RSK-MEMOS-09).
    const pending = await tools.msp_thread_delivery_record({
      inbound_message_id: "zed-future", source_event_id: "zed-future:assistant", receipt_id: "crm-delivered-alice", outcome: "ACCEPTED", text: "t",
      delivery_scope: { tenantId: "tenant-drain-2", businessId: null, channelAccountId: "oa-drain", externalRoomRef: "dm-zed-drain" },
    });
    expect(pending.status).toBe("PENDING_INBOUND");

    // Tenant 2's inbound now arrives -- #drainDeliveries tries to reconcile
    // the pending row above, which hits tenant 1's already-delivered
    // receipt_id and must NOT fail this append.
    const arrive = tools.msp_thread_message_append({
      thread_id: threadTwo.threadId, speaker_id: "zed", speaker_kind: "HUMAN", identity_assurance: "VERIFIED",
      direction: "INBOUND", text: "q", source_event_id: "zf", message_id: "zed-future",
    });
    await expect(arrive).resolves.toMatchObject({ message: { messageId: "zed-future" }, deduplicated: false });

    // An identical replay must also succeed, not fail the same way forever.
    const replay = tools.msp_thread_message_append({
      thread_id: threadTwo.threadId, speaker_id: "zed", speaker_kind: "HUMAN", identity_assurance: "VERIFIED",
      direction: "INBOUND", text: "q", source_event_id: "zf", message_id: "zed-future",
    });
    await expect(replay).resolves.toMatchObject({ message: { messageId: "zed-future" }, deduplicated: true });

    // The pending row is left exactly as it was, for a later drain --
    // never silently marked reconciled, never deleted.
    const pendingRow = server.db.prepare("SELECT tenant_id, reconcile_state FROM thread_pending_deliveries WHERE receipt_id=?").get("crm-delivered-alice");
    expect(pendingRow).toMatchObject({ tenant_id: "tenant-drain-2", reconcile_state: "pending" });

    // Tenant 1's already-delivered receipt is completely untouched.
    const deliveredRow = server.db.prepare("SELECT tenant_id, message_id FROM thread_delivery_receipts WHERE receipt_id=?").get("crm-delivered-alice");
    expect(deliveredRow.tenant_id).toBe("tenant-drain-1");

    // The skipped reconcile is journaled, scoped to tenant 2, with no raw
    // ids beyond the usual application refs -- once for the original
    // append and once more for the replay, since each independently
    // retries (and again fails) the same reconcile. RKOI's confirmation
    // pass: the payload also carries a STABLE error_code (never the
    // free-text message), so an operator can tell a receipt_id collision
    // (ThreadConflictError's own "conflict" code) apart from a real
    // storage fault.
    const skipped = server.db.prepare("SELECT ref, workspace_id, payload_json FROM journal WHERE tool_name = 'msp_thread_message_append.reconcile_skipped'").all();
    expect(skipped).toHaveLength(2);
    for (const entry of skipped) {
      expect(entry).toMatchObject({ ref: "zed-future", workspace_id: "tenant-drain-2" });
      expect(JSON.parse(entry.payload_json)).toMatchObject({ receipt_id: "crm-delivered-alice", reconciled: false, error_code: "conflict" });
    }
  });
});

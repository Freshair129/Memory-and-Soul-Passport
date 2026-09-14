// API-011 thread memory (TASK-MEMOS-002): migrations/0008_thread_memory.sql's
// own triggers, and W5's journal-actor requirement, exercised directly
// against the database/domain layer (same process) -- these are schema and
// journaling invariants, not grant-authorization decisions, so they belong
// beside tests/integration/migrate.test.mjs's real-graph coverage rather
// than tests/security/thread-memory-scoping.security.mjs's real-process
// attack reproductions.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../apps/msp-server/src/server.mjs";

const roots = [];
const servers = [];

// PH-MEMOS-3 stage 2 (BL-MEMOS-041/048): agentId/workspaceId/nonce are now
// required, domain-layer fields on most of the ten tools (§6.1.1) -- this
// file exercises schema/journal invariants through the UNGUARDED handler
// map, which reads them off grant_agent_id/grant_workspace_id/grant_nonce
// (the exact keys thread-guard.mjs injects from a verified grant). A
// stable, shared agent/workspace pair, and a FRESH random nonce per call,
// are supplied by default so no individual call site below needs to
// change.
function withDefaultGrantFields(server) {
  const freshNonce = () => randomBytes(16).toString("hex");
  const handlers = server.threadHandlers;
  const withNonce = (name) => {
    const original = handlers[name];
    handlers[name] = (args = {}) => original({ grant_nonce: freshNonce(), ...args });
  };
  const original = handlers.msp_thread_resolve;
  handlers.msp_thread_resolve = (args = {}) =>
    original({ grant_agent_id: "agent-test", grant_workspace_id: "workspace-test", grant_may_mint: true, grant_nonce: freshNonce(), ...args });
  withNonce("msp_thread_memory_record");
  withNonce("msp_thread_injection_record");
  withNonce("msp_session_sweep");
  withNonce("msp_session_compaction_claim");
  withNonce("msp_session_compaction_commit");
  withNonce("msp_session_compaction_retry");
  return server;
}

function makeServer() {
  const root = mkdtempSync(path.join(tmpdir(), "msp-thread-schema-invariants-"));
  roots.push(root);
  const server = withDefaultGrantFields(
    createServer({
      dbPath: path.join(root, "msp.sqlite3"),
      env: { ...process.env, MSP_TEST_CLOCK: "1", MSP_IDENTITY_HMAC_KEY: "c".repeat(40) },
    }),
  );
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length) servers.pop().close();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("migrations/0008_thread_memory.sql trigger invariants", () => {
  it("refuses any UPDATE to threads.thread_kind/tenant_id/channel_account_id/external_room_ref_hmac/business_id -- only status/updated_at may change, and only ACTIVE -> CLOSED (RKOI review, 2nd round, WARNING 4)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-a", tenant_id: "tenant-a",
    });
    expect(() => server.db.prepare("UPDATE threads SET thread_kind='GROUP' WHERE thread_id=?").run(thread.threadId)).toThrow(/immutable/);
    expect(() => server.db.prepare("UPDATE threads SET tenant_id='tenant-b' WHERE thread_id=?").run(thread.threadId)).toThrow(/immutable/);
    expect(() => server.db.prepare("UPDATE threads SET business_id='other-business' WHERE thread_id=?").run(thread.threadId)).toThrow(/immutable/);
    // The one permitted status transition still updates cleanly.
    expect(() => server.db.prepare("UPDATE threads SET status='CLOSED' WHERE thread_id=?").run(thread.threadId)).not.toThrow();
    // Once CLOSED, status never bounces back to ACTIVE (or anywhere else).
    expect(() => server.db.prepare("UPDATE threads SET status='ACTIVE' WHERE thread_id=?").run(thread.threadId)).toThrow(/may only transition ACTIVE -> CLOSED/);
    expect(() => server.db.prepare("UPDATE threads SET status='REVOKED' WHERE thread_id=?").run(thread.threadId)).toThrow(/may only transition ACTIVE -> CLOSED/);
  });

  it("refuses a second, distinct HUMAN participant on a DIRECT thread even after the first has left (RKOI item 2/C-1 backstop)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-b", tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    // Close alice's membership out from under the invariant to prove even a
    // FORMER participant's departure never reopens the slot for someone else.
    server.db.prepare("UPDATE thread_participants SET left_at=? WHERE thread_id=? AND speaker_id='alice'").run(new Date().toISOString(), thread.threadId);
    await expect(
      server.threadHandlers.msp_thread_message_append({
        thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
      }),
    ).rejects.toThrow(/one HUMAN participant/);
  });

  it("thread_participants rows are append-only: no DELETE, and UPDATE permits only left_at NULL -> NOT NULL", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "GROUP", audience_kind: "GROUP", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-c", tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    expect(() => server.db.prepare("DELETE FROM thread_participants WHERE thread_id=?").run(thread.threadId)).toThrow(/never be deleted/);
    expect(() => server.db.prepare("UPDATE thread_participants SET person_id='someone-else' WHERE thread_id=?").run(thread.threadId)).toThrow(/append-only/);
  });

  it("tenant-consistency triggers refuse a denormalized child row naming a foreign tenant (RKOI item 5)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-d", tenant_id: "tenant-a",
    });
    expect(() =>
      server.db
        .prepare(
          "INSERT INTO chat_sessions (session_id, tenant_id, thread_id, status, opened_at, idle_deadline, latest_sequence, summary_watermark, policy_revision, version) VALUES ('sess-x','tenant-b',?,'OPEN',?,?,0,0,'v1',1)",
        )
        .run(thread.threadId, new Date().toISOString(), new Date().toISOString()),
    ).toThrow(/tenant_id must match/);
  });

  it("protected_memory_records refuses a HUMAN-asserted record with a null subject, and a subject naming someone other than the asserter (RKOI item 4)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-e", tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    await expect(
      server.threadHandlers.msp_thread_memory_record({
        thread_id: thread.threadId, kind: "CONSTRAINT", asserted_by_speaker_id: "alice", subject_person_id: "bob",
        body: { text: "about bob" }, source_message_refs: [],
      }),
    ).rejects.toThrow(/record_subject_mismatch/);
    await expect(
      server.threadHandlers.msp_thread_memory_record({
        thread_id: thread.threadId, kind: "CONSTRAINT", asserted_by_speaker_id: "alice", subject_person_id: null,
        body: { text: "no subject at all" }, source_message_refs: [],
      }),
    ).rejects.toThrow(/record_subject_mismatch/);
  });

  it("a null-subject record from a non-HUMAN asserter is visible only to its own asserter at read time, never to a different requester", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-f", tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    // Seed a non-HUMAN participant directly (OPERATOR speakers are never
    // created by the domain's own append path -- see thread-memory.mjs --
    // so this constructs the one theoretical shape the subject rule allows
    // a null subject for).
    server.db
      .prepare(
        "INSERT INTO thread_participants (membership_id, tenant_id, thread_id, speaker_id, speaker_kind, identity_assurance, joined_at, left_at) VALUES ('m-op','tenant-a',?, 'system-observer', 'OPERATOR', 'VERIFIED', ?, NULL)",
      )
      .run(thread.threadId, new Date().toISOString());
    const record = await server.threadHandlers.msp_thread_memory_record({
      thread_id: thread.threadId, kind: "INSTRUCTION", asserted_by_speaker_id: "system-observer", subject_person_id: null,
      body: { text: "an operational note with no subject" }, source_message_refs: [],
    });
    expect(record.subjectPersonId).toBeNull();
    const asAsserter = await server.threadHandlers.msp_thread_context({ thread_id: thread.threadId, requester_speaker_id: "system-observer" });
    expect(asAsserter.protectedRecords.map((r) => r.recordId)).toContain(record.recordId);
    const asAlice = await server.threadHandlers.msp_thread_context({ thread_id: thread.threadId, requester_speaker_id: "alice" });
    expect(asAlice.protectedRecords.map((r) => r.recordId)).not.toContain(record.recordId);
  });

  it("thread_messages/session_summaries/protected_memory_records/thread_delivery_receipts permit only their one-way tombstone UPDATE, and never a DELETE", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-g", tenant_id: "tenant-a",
    });
    const { message } = await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "sensitive text",
    });
    expect(() => server.db.prepare("DELETE FROM thread_messages WHERE message_id=?").run(message.messageId)).toThrow(/never be deleted/);
    expect(() => server.db.prepare("UPDATE thread_messages SET text='rewritten' WHERE message_id=?").run(message.messageId)).toThrow(/immutable/);
    expect(() =>
      server.db.prepare("UPDATE thread_messages SET redaction_state='tombstoned', text='' WHERE message_id=?").run(message.messageId),
    ).not.toThrow();
    expect(server.db.prepare("SELECT text, redaction_state FROM thread_messages WHERE message_id=?").get(message.messageId)).toEqual({
      text: "", redaction_state: "tombstoned",
    });
  });

  it("thread_pending_deliveries permits only a pending -> reconciled transition, or a tombstone, and never a DELETE", async () => {
    const server = makeServer();
    server.db
      .prepare(
        "INSERT INTO thread_pending_deliveries (receipt_id, inbound_message_id, source_event_id, tenant_id, channel_account_id, external_room_ref_hmac, outcome, text, recorded_at) VALUES ('r-1','msg-x','msg-x:assistant','tenant-a','oa','hash', 'ACCEPTED', 'buffered text', ?)",
      )
      .run(new Date().toISOString());
    expect(() => server.db.prepare("DELETE FROM thread_pending_deliveries WHERE receipt_id='r-1'").run()).toThrow(/never be deleted/);
    expect(() => server.db.prepare("UPDATE thread_pending_deliveries SET outcome='FAILED' WHERE receipt_id='r-1'").run()).toThrow(/permit only/);
    expect(() => server.db.prepare("UPDATE thread_pending_deliveries SET reconcile_state='reconciled' WHERE receipt_id='r-1'").run()).not.toThrow();
    expect(server.db.prepare("SELECT reconcile_state FROM thread_pending_deliveries WHERE receipt_id='r-1'").get().reconcile_state).toBe("reconciled");
  });

  it("thread_pending_deliveries.outcome is CHECKed, and an INSERT cannot arrive pre-tombstoned with its text still intact (RKOI review, 2nd round, WARNING 4)", async () => {
    const server = makeServer();
    expect(() =>
      server.db
        .prepare(
          "INSERT INTO thread_pending_deliveries (receipt_id, inbound_message_id, source_event_id, tenant_id, channel_account_id, external_room_ref_hmac, outcome, text, recorded_at) VALUES ('r-bad-outcome','msg-x','msg-x:assistant','tenant-a','oa','hash', 'NOT_A_REAL_OUTCOME', 'x', ?)",
        )
        .run(new Date().toISOString()),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      server.db
        .prepare(
          "INSERT INTO thread_pending_deliveries (receipt_id, inbound_message_id, source_event_id, tenant_id, channel_account_id, external_room_ref_hmac, outcome, text, redaction_state, recorded_at) VALUES ('r-pretombstoned','msg-x','msg-x:assistant','tenant-a','oa','hash', 'ACCEPTED', 'still here', 'tombstoned', ?)",
        )
        .run(new Date().toISOString()),
    ).toThrow(/CHECK constraint failed/);
  });

  it("thread_messages refuses a session of another thread, an exchange_id reused across threads, and a reply_to_message_id naming another thread's message (RKOI review, 3rd round probes M2-M4)", async () => {
    const server = makeServer();
    const { thread: threadA } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-m-a", tenant_id: "tenant-a",
    });
    const { thread: threadB } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-m-b", tenant_id: "tenant-a",
    });
    const { message: messageA } = await server.threadHandlers.msp_thread_message_append({
      thread_id: threadA.threadId, source_event_id: "a-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from A",
    });
    const sessionA = server.db.prepare("SELECT session_id FROM chat_sessions WHERE thread_id=?").get(threadA.threadId).session_id;
    const { message: messageB } = await server.threadHandlers.msp_thread_message_append({
      thread_id: threadB.threadId, source_event_id: "b-1", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from B",
    });
    const sessionB = server.db.prepare("SELECT session_id FROM chat_sessions WHERE thread_id=?").get(threadB.threadId).session_id;

    expect(() =>
      server.db
        .prepare(
          "INSERT INTO thread_messages(message_id,tenant_id,thread_id,session_id,exchange_id,sequence,speaker_id,speaker_kind,identity_assurance,direction,text,occurred_at,received_at,source_event_id) VALUES('m-cross-session','tenant-a',?,?,'ex-cross',9,'bob','HUMAN','VERIFIED','INBOUND','x','t','t','ev-cross-session')",
        )
        .run(threadB.threadId, sessionA),
    ).toThrow(/session_id must belong to thread_id/);

    expect(() =>
      server.db
        .prepare(
          "INSERT INTO thread_messages(message_id,tenant_id,thread_id,session_id,exchange_id,sequence,speaker_id,speaker_kind,identity_assurance,direction,text,occurred_at,received_at,source_event_id) VALUES('m-cross-exchange','tenant-a',?,?,?,9,'bob','HUMAN','VERIFIED','INBOUND','x','t','t','ev-cross-exchange')",
        )
        .run(threadB.threadId, sessionB, messageA.exchangeId),
    ).toThrow(/exchange_id was previously used on a different thread/);

    expect(() =>
      server.db
        .prepare(
          "INSERT INTO thread_messages(message_id,tenant_id,thread_id,session_id,exchange_id,sequence,speaker_id,speaker_kind,identity_assurance,direction,text,occurred_at,received_at,source_event_id,reply_to_message_id) VALUES('m-cross-reply','tenant-a',?,?,'ex-b-own',9,'bob','HUMAN','VERIFIED','INBOUND','x','t','t','ev-cross-reply',?)",
        )
        .run(threadB.threadId, sessionB, messageA.messageId),
    ).toThrow(/reply_to_message_id must name a message of the same thread/);
    expect(messageB.threadId).toBe(threadB.threadId);
  });

  it("chat_sessions permits at most one OPEN session per thread, but deliberately allows more than one CLOSING (RKOI review, docs round 4, item 4)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-one-open", tenant_id: "tenant-a",
    });
    const sessionId = server.db.prepare(
      "INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sess-real','tenant-a',?,'CLOSING','t','t','p') RETURNING session_id",
    ).get(thread.threadId).session_id;
    expect(sessionId).toBe("sess-real");
    expect(() =>
      server.db
        .prepare("INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sess-open-2','tenant-a',?,'OPEN','t','t','p')")
        .run(thread.threadId),
    ).not.toThrow();
    expect(() =>
      server.db
        .prepare("INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sess-open-3','tenant-a',?,'OPEN','t','t','p')")
        .run(thread.threadId),
    ).toThrow(/UNIQUE constraint failed/);
    // Deliberately NOT constrained: probe S2 (late-delivery reconciliation
    // reopening an already-CLOSED session to CLOSING) can legitimately
    // coexist with a newer, independently-idled CLOSING session for the
    // SAME thread -- see tests/integration/thread-summary-worker.test.mjs's
    // "records a late fallback..." case for the real flow that produces
    // exactly this. A schema-level "one CLOSING" index was tried and
    // dropped for this reason; the invariant stays application-enforced.
    expect(() =>
      server.db
        .prepare("INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sess-closing-2','tenant-a',?,'CLOSING','t','t','p')")
        .run(thread.threadId),
    ).not.toThrow();
  });

  it("session_compaction_jobs refuses a session of another thread or tenant, and pins tenant_id/thread_id/session_id on UPDATE (RKOI review, 3rd round probes J1-J3)", async () => {
    const server = makeServer();
    const { thread: threadA } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-j-a", tenant_id: "tenant-a",
    });
    const { thread: threadA2 } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-j-a2", tenant_id: "tenant-a",
    });
    const { thread: threadB } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-j-b", tenant_id: "tenant-b",
    });
    const sA = server.db.prepare("INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sA','tenant-a',?,'CLOSING','t','t','p') RETURNING session_id").get(threadA.threadId).session_id;
    server.db.prepare("INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sA2','tenant-a',?,'CLOSING','t','t','p')").run(threadA2.threadId);
    server.db.prepare("INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sB','tenant-b',?,'CLOSING','t','t','p')").run(threadB.threadId);

    const job = (id, tenantId, sessionId, threadId) =>
      server.db
        .prepare(
          "INSERT INTO session_compaction_jobs(job_id,tenant_id,session_id,thread_id,status,source_start_sequence,source_end_sequence,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'PENDING',1,2,?,'t','t')",
        )
        .run(id, tenantId, sessionId, threadId, id);

    expect(() => job("j1", "tenant-a", "sA2", threadA.threadId)).toThrow(/session_id must belong to thread_id/);
    expect(() => job("j2", "tenant-a", "sB", threadA.threadId)).toThrow(/session_id must belong to thread_id/);
    expect(() => job("j3", "tenant-a", sA, threadA.threadId)).not.toThrow();
    expect(() =>
      server.db.prepare("UPDATE session_compaction_jobs SET tenant_id='tenant-b', thread_id=?, session_id='sB' WHERE job_id='j3'").run(threadB.threadId),
    ).toThrow(/immutable/);
  });

  it("thread_injection_receipts requires a RESOLVED-first insert, enforces its forward-only state machine, and pins injection_id (RKOI review, 3rd round probes I1-I5)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-i", tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    await server.threadHandlers.msp_thread_injection_record({
      thread_id: thread.threadId, exchange_id: (await server.threadHandlers.msp_thread_context({ thread_id: thread.threadId })).recentExchanges[0].exchangeId,
      injection_id: "inj1", packet_hash: "a".repeat(64), policy_revision: "p", model_ref: "m", state: "RESOLVED",
    });
    expect(() => server.db.prepare("UPDATE thread_injection_receipts SET state='COMPLETED', version=version+1 WHERE injection_id='inj1'").run()).toThrow(/invalid, out of order/);
    expect(() =>
      server.db.prepare("UPDATE thread_injection_receipts SET injection_id='inj-stolen' WHERE injection_id='inj1'").run(),
    ).toThrow(/invalid, out of order/);
    expect(() => server.db.prepare("UPDATE thread_injection_receipts SET state='SUBMITTED', version=version+1 WHERE injection_id='inj1'").run()).not.toThrow();
    expect(() => server.db.prepare("UPDATE thread_injection_receipts SET state='FAILED', version=version+1 WHERE injection_id='inj1'").run()).not.toThrow();
    expect(() => server.db.prepare("UPDATE thread_injection_receipts SET state='COMPLETED', version=version+1 WHERE injection_id='inj1'").run()).toThrow(/invalid, out of order/);
    expect(() => server.db.prepare("DELETE FROM thread_injection_receipts WHERE injection_id='inj1'").run()).toThrow(/never be deleted/);
  });

  it("protected_memory_records refuses an asserter whose membership has already left (left_at IS NOT NULL)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-left", tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    server.db.prepare("UPDATE thread_participants SET left_at=? WHERE thread_id=? AND speaker_id='alice'").run(new Date().toISOString(), thread.threadId);
    await expect(
      server.threadHandlers.msp_thread_memory_record({
        thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { text: "x" }, source_message_refs: [],
      }),
    ).rejects.toThrow(/must be the thread's current participant/);
  });

  it("thread_summary_invalidations pins tenant_id/summary_id on UPDATE, refuses a foreign tenant, and never DELETEs (RKOI review, 3rd round addendum item 1)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-v", tenant_id: "tenant-a",
    });
    server.db.prepare(
      "INSERT INTO chat_sessions(session_id,tenant_id,thread_id,status,opened_at,idle_deadline,policy_revision) VALUES('sess-v','tenant-a',?,'CLOSED','t','t','p')",
    ).run(thread.threadId);
    server.db.prepare(
      "INSERT INTO session_summaries(summary_id,tenant_id,session_id,thread_id,summary_version,covered_from_sequence,covered_through_sequence,source_digest,summary_json,policy_revision,summarizer_version,created_at) VALUES('sum-v','tenant-a','sess-v',?,1,1,1,'d','{}','p','v','t')",
    ).run(thread.threadId);
    expect(() =>
      server.db.prepare("INSERT INTO thread_summary_invalidations(summary_id,tenant_id,reason,recorded_at) VALUES('sum-v','tenant-b','r','t')").run(),
    ).toThrow(/tenant_id must match/);
    server.db.prepare("INSERT INTO thread_summary_invalidations(summary_id,tenant_id,reason,recorded_at) VALUES('sum-v','tenant-a','r','t')").run();
    expect(() => server.db.prepare("UPDATE thread_summary_invalidations SET tenant_id='tenant-b'").run()).toThrow(/immutable/);
    expect(() => server.db.prepare("DELETE FROM thread_summary_invalidations").run()).toThrow(/never be deleted/);
    // RKOI code review round 2, WARNING 7: the WHOLE row is immutable, not
    // just tenant_id/summary_id -- reason and recorded_at are facts
    // observed at write time and must never be edited after the fact.
    expect(() => server.db.prepare("UPDATE thread_summary_invalidations SET reason='different-reason' WHERE summary_id='sum-v'").run()).toThrow(/immutable/);
    expect(() => server.db.prepare("UPDATE thread_summary_invalidations SET recorded_at='later' WHERE summary_id='sum-v'").run()).toThrow(/immutable/);
  });

  // RKOI code review round 2, WARNING 7: `threads` had every no-delete
  // trigger EXCEPT its own -- every other durable table in this file
  // refuses a DELETE, but a thread row itself did not.
  it("refuses to ever DELETE a threads row", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-no-delete", tenant_id: "tenant-a",
    });
    expect(() => server.db.prepare("DELETE FROM threads WHERE thread_id=?").run(thread.threadId)).toThrow(/never be deleted/);
  });

  // RKOI code review round 2, WARNING 7: an injection receipt's exchange_id
  // must belong to ITS OWN thread_id -- the domain layer already checks
  // this before ever inserting (ThreadMemoryStore#recordInjection), so this
  // proves the schema-level backstop independently, the same way every
  // other cross-reference integrity rule in this file is proven directly
  // against the table.
  it("thread_injection_receipts refuses an exchange_id that belongs to a different thread", async () => {
    const server = makeServer();
    const { thread: threadA } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-inj-a", tenant_id: "tenant-a",
    });
    const { thread: threadB } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-inj-b", tenant_id: "tenant-a",
    });
    const { message: messageA } = await server.threadHandlers.msp_thread_message_append({
      thread_id: threadA.threadId, source_event_id: "inj-a-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from A",
    });
    expect(() =>
      server.db
        .prepare(
          "INSERT INTO thread_injection_receipts(injection_id,tenant_id,thread_id,exchange_id,packet_hash,policy_revision,model_ref,state,updated_at) VALUES('inj-cross','tenant-a',?,?,?,'p','m','RESOLVED','t')",
        )
        .run(threadB.threadId, messageA.exchangeId, "a".repeat(64)),
    ).toThrow(/exchange_id must belong to thread_id/);
  });

  // RKOI code review round 2, WARNING 7: a delivery receipt's target
  // message is, by definition, the reply that was delivered -- it can only
  // ever be an OUTBOUND message. The domain layer only ever looks up an
  // OUTBOUND message before inserting a receipt, so this proves the
  // schema-level backstop independently.
  it("thread_delivery_receipts refuses a message_id that names an INBOUND message", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-recv-only", tenant_id: "tenant-a",
    });
    const { message } = await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "recv-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi",
    });
    expect(() =>
      server.db
        .prepare("INSERT INTO thread_delivery_receipts(receipt_id,tenant_id,message_id,outcome,text,recorded_at) VALUES('recv-only-receipt','tenant-a',?,'ACCEPTED','x','t')")
        .run(message.messageId),
    ).toThrow(/must name an OUTBOUND message/);
  });

  // RKOI code review round 2, WARNING 3: idx_thread_messages_exchange_lookup
  // (exchange_id, thread_id) exists specifically so the cross-thread
  // exchange_id check in trg_thread_messages_tenant_consistency is a single
  // index seek, not a full table scan of thread_messages.
  it("uses an index, not a full table scan, for the exchange_id-across-threads lookup the tenant-consistency trigger runs", async () => {
    const server = makeServer();
    const plan = server.db
      .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM thread_messages m WHERE m.exchange_id = ? AND m.thread_id <> ?")
      .all("some-exchange", "some-thread")
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_thread_messages_exchange_lookup/);
    expect(plan).not.toMatch(/SCAN thread_messages/);
  });

  // PH-MEMOS-3 stage 2 (migration 0009, BL-MEMOS-041): thread_agents is the
  // structural analogue of thread_participants -- same append-only,
  // no-DELETE, tenant-consistency shape, proven the same way.
  it("thread_agents rows are append-only: no DELETE, and UPDATE permits only left_at NULL -> NOT NULL", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-agents-append-only", tenant_id: "tenant-a",
      grant_agent_id: "agent-invariant", grant_workspace_id: "workspace-invariant",
    });
    expect(() => server.db.prepare("DELETE FROM thread_agents WHERE thread_id=?").run(thread.threadId)).toThrow(/never be deleted/);
    expect(() => server.db.prepare("UPDATE thread_agents SET agent_id='someone-else' WHERE thread_id=?").run(thread.threadId)).toThrow(/append-only/);
    // The one permitted transition still updates cleanly.
    expect(() => server.db.prepare("UPDATE thread_agents SET left_at=? WHERE thread_id=?").run(new Date().toISOString(), thread.threadId)).not.toThrow();
  });

  it("thread_agents refuses a row naming a foreign tenant (tenant-consistency trigger)", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-agents-tenant", tenant_id: "tenant-a",
      grant_agent_id: "agent-invariant", grant_workspace_id: "workspace-invariant",
    });
    expect(() =>
      server.db
        .prepare("INSERT INTO thread_agents (agent_attachment_id, tenant_id, thread_id, agent_id, workspace_id, joined_at) VALUES ('att-x','tenant-b',?,'agent-foreign','workspace-foreign',?)")
        .run(thread.threadId, new Date().toISOString()),
    ).toThrow(/tenant_id must match/);
  });

  // PH-MEMOS-3 stage 2 (migration 0009, BL-MEMOS-043): a record with
  // visibility=AGENT requires a non-null agent_id, and any agent_id must
  // have attached to the record's own thread_id at some point -- both
  // enforced unconditionally by trg_protected_memory_records_agent_rules,
  // independent of whatever the handler already checked.
  it("protected_memory_records refuses visibility=AGENT with a null agent_id, and any agent_id that never attached to thread_id", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-record-agent-rules", tenant_id: "tenant-a",
      grant_agent_id: "agent-attached", grant_workspace_id: "workspace-attached",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi",
    });
    const insertRecord = (recordId, agentId, visibility) =>
      server.db
        .prepare(
          `INSERT INTO protected_memory_records
             (record_id, tenant_id, thread_id, session_id, kind, status, asserted_by_speaker_id, subject_person_id,
              scope_json, body_json, source_message_refs_json, supersedes_record_id, verification_state, version,
              created_at, updated_at, agent_id, visibility)
           VALUES (?, ?, ?, NULL, 'PREFERENCE', 'ACTIVE', 'alice', 'alice', '{}', '{}', '[]', NULL, 'CANDIDATE', 1, ?, ?, ?, ?)`,
        )
        .run(recordId, thread.tenantId, thread.threadId, new Date().toISOString(), new Date().toISOString(), agentId, visibility);
    expect(() => insertRecord("memory-record_null-agent-visible", null, "AGENT")).toThrow(/requires a non-NULL agent_id/);
    expect(() => insertRecord("memory-record_never-attached", "agent-stranger", "THREAD")).toThrow(/must have attached to thread_id/);
    expect(() => insertRecord("memory-record_ok", "agent-attached", "AGENT")).not.toThrow();
  });

  // PH-MEMOS-3 stage 2 (migration 0009, BL-MEMOS-112): the recreated
  // trg_thread_pending_deliveries_update_guard now also pins agent_id/
  // workspace_id on both permitted transitions -- without this, a
  // reconcile UPDATE could rewrite the very agent id the drain-time
  // currency re-check depends on.
  it("thread_pending_deliveries' reconcile UPDATE cannot rewrite agent_id/workspace_id", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-pending-agent-pin", tenant_id: "tenant-a",
      grant_agent_id: "agent-pending", grant_workspace_id: "workspace-pending",
    });
    await server.threadHandlers.msp_thread_delivery_record({
      inbound_message_id: "not-arrived", source_event_id: "not-arrived:assistant", receipt_id: "receipt-pending-agent-pin", outcome: "ACCEPTED", text: "t",
      delivery_scope: { tenantId: thread.tenantId, businessId: null, channelAccountId: "oa", externalRoomRef: "room-pending-agent-pin", agentId: "agent-pending", workspaceId: "workspace-pending" },
    });
    expect(() =>
      server.db.prepare("UPDATE thread_pending_deliveries SET agent_id='agent-rewritten' WHERE receipt_id=?").run("receipt-pending-agent-pin"),
    ).toThrow(/permit only a pending/i);
  });
});

// W5: every journal entry's `actor` is the HMAC of the raw speaker id --
// never the raw id, never a raw external_room_ref, anywhere in the journal.
describe("W5: the journal never carries a raw speaker/person id or external_room_ref", () => {
  it("scans every journal row written by a full resolve/append/record/sweep flow", async () => {
    const server = makeServer();
    const rawSpeakerId = "line-user-U_super_secret_raw_id";
    const rawExternalRoomRef = "line-room-raw-ref-should-never-appear";
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: rawExternalRoomRef, tenant_id: "tenant-a",
    });
    await server.threadHandlers.msp_thread_message_append({
      thread_id: thread.threadId, source_event_id: "in-1", speaker_id: rawSpeakerId, speaker_kind: "HUMAN",
      person_id: rawSpeakerId, identity_assurance: "VERIFIED", direction: "INBOUND", text: "hello",
    });
    await server.threadHandlers.msp_thread_memory_record({
      thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: rawSpeakerId, subject_person_id: rawSpeakerId,
      body: { text: "prefers email" }, source_message_refs: [],
    });
    await server.threadHandlers.msp_session_sweep({ tenant_id: "tenant-a" });

    const rows = server.db.prepare("SELECT actor, payload_json FROM journal").all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actor).not.toContain(rawSpeakerId);
      expect(row.actor).not.toBe(rawSpeakerId);
      expect(row.payload_json).not.toContain(rawSpeakerId);
      expect(row.payload_json).not.toContain(rawExternalRoomRef);
    }
    // At least the append and the record entries carry a real HMAC actor
    // (64 lowercase hex chars, sha256), not an empty or trivial string.
    expect(rows.some((r) => /^[a-f0-9]{64}$/.test(r.actor))).toBe(true);
  });
});

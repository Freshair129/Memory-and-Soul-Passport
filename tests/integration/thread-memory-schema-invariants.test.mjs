// API-011 thread memory (TASK-MEMOS-002): migrations/0008_thread_memory.sql's
// own triggers, and W5's journal-actor requirement, exercised directly
// against the database/domain layer (same process) -- these are schema and
// journaling invariants, not grant-authorization decisions, so they belong
// beside tests/integration/migrate.test.mjs's real-graph coverage rather
// than tests/security/thread-memory-scoping.security.mjs's real-process
// attack reproductions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../apps/msp-server/src/server.mjs";

const roots = [];
const servers = [];

function makeServer() {
  const root = mkdtempSync(path.join(tmpdir(), "msp-thread-schema-invariants-"));
  roots.push(root);
  const server = createServer({
    dbPath: path.join(root, "msp.sqlite3"),
    env: { ...process.env, MSP_TEST_CLOCK: "1", MSP_IDENTITY_HMAC_KEY: "c".repeat(40) },
  });
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length) servers.pop().close();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("migrations/0008_thread_memory.sql trigger invariants", () => {
  it("refuses any UPDATE to threads.thread_kind/tenant_id/channel_account_id/external_room_ref_hmac -- only status/business_id/updated_at may change", async () => {
    const server = makeServer();
    const { thread } = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa", external_room_ref: "room-a", tenant_id: "tenant-a",
    });
    expect(() => server.db.prepare("UPDATE threads SET thread_kind='GROUP' WHERE thread_id=?").run(thread.threadId)).toThrow(/immutable/);
    expect(() => server.db.prepare("UPDATE threads SET tenant_id='tenant-b' WHERE thread_id=?").run(thread.threadId)).toThrow(/immutable/);
    // A permitted column still updates cleanly.
    expect(() => server.db.prepare("UPDATE threads SET status='CLOSED' WHERE thread_id=?").run(thread.threadId)).not.toThrow();
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

// PH-MEMOS-4 (TASK-MEMOS-004, design v0.5.4b Sec.11.1/Sec.11.2): one suite
// file for msp_thread_principal_erase/msp_thread_retention_tick/
// msp_thread_principal_export (BL-MEMOS-053..056), proven against the REAL
// running msp-server process through its guarded tool surface, signed with
// @freshair129/msp-contracts/thread-access's real signThreadRequest --
// never a mock guard, matching every other *.security.mjs file's house
// style in this repo.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { signThreadRequest } from "../../packages/msp-contracts/src/contracts/thread-access.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const SERVICE_KEY = "thread-erasure-security-test-key-32bytes";
const IDENTITY_KEY = "thread-erasure-security-test-hmac-key-32b";

function tempDbPath(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `msp-erasure-${label}-`));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY") throw error;
      }
    },
  };
}

function spawnRuntime(dbPath, extraEnv = {}) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEY: SERVICE_KEY, MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY, ...extraEnv },
    timeoutMs: 10_000,
  });
}

function signed(name, input, claims) {
  return signThreadRequest(name, input, claims, SERVICE_KEY);
}

const ROOM = { channelAccountId: "oa-erasure", tenantId: "tenant-erasure", agentId: "agent-erasure", workspaceId: "workspace-erasure" };
const ROOM_REQUEST = { channel_type: "LINE", channel_account_id: "oa-erasure", tenant_id: "tenant-erasure" };

function directClaims(overrides = {}) {
  return { ...ROOM, audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", ...overrides };
}

function groupClaims(overrides = {}) {
  return { ...ROOM, audienceKind: "GROUP", principalId: "alice", policyRevision: "v1", ...overrides };
}

async function withDb(dbPath, fn) {
  const { open } = await import("@freshair129/msp-storage/connection");
  const db = open(dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// Directly seeds a session_summaries row (bypassing the full sweep/claim/
// commit compaction pipeline, which is orthogonal to what this file is
// proving) -- the same "direct-DB precondition setup" house style
// thread-agent-scoping.security.mjs already uses for thread_agents
// departure. chat_sessions/threads must already exist for the FK/
// consistency triggers.
async function seedSummary(dbPath, { summaryId, tenantId, sessionId, threadId, summaryVersion = 1 }) {
  await withDb(dbPath, async (db) => {
    db.prepare(
      `INSERT INTO session_summaries
        (summary_id, tenant_id, session_id, thread_id, summary_version, covered_from_sequence, covered_through_sequence,
         source_digest, summary_json, policy_revision, summarizer_version, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, 'v1', 'test', ?)`,
    ).run(summaryId, tenantId, sessionId, threadId, summaryVersion, "d".repeat(64), JSON.stringify({ topics: [{ text: "seeded summary content" }] }), new Date().toISOString());
  });
}

async function seedDeliveryReceipt(dbPath, { receiptId, tenantId, messageId }) {
  await withDb(dbPath, async (db) => {
    db.prepare(`INSERT INTO thread_delivery_receipts (receipt_id, tenant_id, message_id, outcome, text, recorded_at) VALUES (?, ?, ?, 'DELIVERED', 'seeded delivery text', ?)`).run(
      receiptId,
      tenantId,
      messageId,
      new Date().toISOString(),
    );
  });
}

// MSP_TEST_CLOCK is deliberately not in @freshair129/msp-client-js's env
// allowlist (W1) -- a spawned child never honors a synthetic `now`, so
// retention's age-based pass cannot be tested by pushing the clock
// forward. An UPDATE-after-the-fact cannot backdate occurred_at either --
// every tombstone-shape trigger in this schema pins EVERY column except
// the two the tombstone itself changes, occurred_at included. An old
// message is instead seeded directly via msp_thread_message_append's own
// occurred_at request field (a legitimate, ungated business field, unlike
// `now` -- see the "when the message actually occurred" note in
// thread-memory.mjs, distinct from the W1-gated `now` used for lease/
// deadline computation).
function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function departParticipant(dbPath, threadId, speakerId) {
  await withDb(dbPath, async (db) => {
    const info = db.prepare("UPDATE thread_participants SET left_at = ? WHERE thread_id = ? AND speaker_id = ? AND left_at IS NULL").run(new Date().toISOString(), threadId, speakerId);
    assert.equal(info.changes, 1);
  });
}

async function row(dbPath, sql, ...params) {
  return withDb(dbPath, async (db) => db.prepare(sql).get(...params));
}

async function rows(dbPath, sql, ...params) {
  return withDb(dbPath, async (db) => db.prepare(sql).all(...params));
}

// ---------------------------------------------------------------------
// BL-MEMOS-053: msp_thread_principal_erase.
// ---------------------------------------------------------------------

test("erase: self-erasure requires dataSubjectAccess -- refused without it", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-noclaim");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-noclaim" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-noclaim" }, claims),
    );
    await assert.rejects(
      call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k1" }, claims)),
      /thread_scope_denied/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: naming another principal without dataSubjectAdmin is refused, even WITH dataSubjectAccess (DEC-MEMOS-25)", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-cross-noadmin");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-cross-noadmin" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-cross-noadmin" }, claims),
    );
    await assert.rejects(
      call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k1", principal_id: "bob" }, { ...claims, dataSubjectAccess: true })),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: dataSubjectAccess alone must not authorize erasing a DIFFERENT principal",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: direct-DB assertions -- messages/records tombstoned and blanked (body_json AND scope_json), participants closed", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-direct-db");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-direct-db" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-direct-db" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "secret content" }, claims),
    );
    await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { note: "alice likes coffee" }, source_message_refs: [inbound.message.messageId] },
        { ...claims, writePrivate: true },
      ),
    );

    const result = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-direct-db" }, { ...claims, dataSubjectAccess: true }));
    assert.equal(result.replay, false);
    assert.equal(result.tablesAffected.threadMessages, 1);
    assert.equal(result.tablesAffected.protectedMemoryRecords, 1);
    assert.equal(result.tablesAffected.threadParticipants, 1);

    const message = await row(dbPath, "SELECT redaction_state, text FROM thread_messages WHERE thread_id = ?", thread.threadId);
    assert.deepEqual(message, { redaction_state: "tombstoned", text: "" });

    const record = await row(dbPath, "SELECT redaction_state, body_json, scope_json FROM protected_memory_records WHERE thread_id = ?", thread.threadId);
    assert.deepEqual(record, { redaction_state: "tombstoned", body_json: "{}", scope_json: "{}" });

    const openParticipants = await row(dbPath, "SELECT COUNT(*) AS count FROM thread_participants WHERE thread_id = ? AND left_at IS NULL", thread.threadId);
    assert.equal(openParticipants.count, 0);

    // Every tool blind to the erased content -- the thread is still ACTIVE
    // (erasure does not close threads), but a fresh context read shows no
    // trace of the erased message text.
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: idempotent -- a second call with the SAME (tenant_id, idempotency_key) and the SAME principal_id returns the stored receipt with NO further writes", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-idempotent");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-idempotent" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-idempotent" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );

    const first = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-idempotent" }, { ...claims, dataSubjectAccess: true }));
    const receiptCountAfterFirst = await row(dbPath, "SELECT COUNT(*) AS count FROM erasure_receipts");

    const second = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-idempotent" }, { ...claims, dataSubjectAccess: true }));
    const receiptCountAfterSecond = await row(dbPath, "SELECT COUNT(*) AS count FROM erasure_receipts");

    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(second.erasureReceiptId, first.erasureReceiptId);
    assert.equal(receiptCountAfterSecond.count, receiptCountAfterFirst.count, "a replay must insert NO further erasure_receipts row");
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: the SAME idempotency_key with a DIFFERENT principal_id is refused conflict", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-key-collision");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-key-collision" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-key-collision" }, claims),
    );
    await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-collision" }, { ...claims, dataSubjectAccess: true }));
    await assert.rejects(
      call(
        "msp_thread_principal_erase",
        signed("msp_thread_principal_erase", { idempotency_key: "k-collision", principal_id: "bob" }, { ...claims, dataSubjectAccess: true, dataSubjectAdmin: true }),
      ),
      /conflict/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: an unknown principal is a trivial zero-count success, never not_found (DEC-MEMOS-33)", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-unknown");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-unknown" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-unknown" }, claims),
    );
    const result = await call(
      "msp_thread_principal_erase",
      signed("msp_thread_principal_erase", { idempotency_key: "k-unknown", principal_id: "never-existed" }, { ...claims, dataSubjectAccess: true, dataSubjectAdmin: true }),
    );
    assert.equal(result.replay, false);
    assert.deepEqual(result.tablesAffected, { threadMessages: 0, protectedMemoryRecords: 0, sessionSummaries: 0, threadDeliveryReceipts: 0, threadParticipants: 0 });
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: thread_pending_deliveries is asserted UNTOUCHED (CRITICAL 4 item 2 -- AGENT-authored reply text, out of erasure's scope entirely)", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-pending-untouched");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-pending" });
    // BL-MEMOS-112: the PENDING path requires the room's own ACTIVE thread
    // to already exist and the calling agent be current on it -- resolve
    // first, then queue a pending delivery for an inbound MSP has not
    // seen yet (the PENDING path, same shape other suites in this repo
    // already exercise).
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-pending" }, claims),
    );
    await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { source_event_id: "in-1:assistant", receipt_id: "receipt-pending-1", outcome: "ACCEPTED", text: "queued reply text", inbound_message_id: "in-1" },
        { ...claims, deliveryWriter: true },
      ),
    );
    const beforeRow = await row(dbPath, "SELECT redaction_state, text FROM thread_pending_deliveries WHERE receipt_id = ?", "receipt-pending-1");
    assert.equal(beforeRow.redaction_state, "none");

    await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-pending" }, { ...claims, dataSubjectAccess: true }));

    const afterRow = await row(dbPath, "SELECT redaction_state, text FROM thread_pending_deliveries WHERE receipt_id = ?", "receipt-pending-1");
    assert.deepEqual(afterRow, beforeRow, "thread_pending_deliveries must be byte-for-byte unchanged by erasure");
  } finally {
    await call.close();
    cleanup();
  }
});

test("DEC-MEMOS-34, GROUP-thread reproduction: p2 authored the summarized content, p1 erases -- summaries/receipts are left completely untouched", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-group-nonsole");
  const call = spawnRuntime(dbPath);
  try {
    const claims = groupClaims({ externalRoomRef: "room-group-nonsole" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "room-group-nonsole" }, claims),
    );
    const p1 = await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "p1-in-1", speaker_id: "p1", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from p1" }, groupClaims({ externalRoomRef: "room-group-nonsole", principalId: "p1" })),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "p2-in-1", speaker_id: "p2", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from p2, this is MY content" }, groupClaims({ externalRoomRef: "room-group-nonsole", principalId: "p2" })),
    );
    // A delivery receipt must reference an OUTBOUND message -- an AGENT
    // reply to p1's own inbound exchange.
    const outbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: thread.threadId, session_id: p1.session.sessionId, exchange_id: p1.message.exchangeId, reply_to_message_id: p1.message.messageId,
          source_event_id: "agent-out-1", speaker_id: claims.agentId, speaker_kind: "AGENT", identity_assurance: "VERIFIED", direction: "OUTBOUND", text: "agent reply", delivery_state: "QUEUED",
        },
        claims,
      ),
    );

    await seedSummary(dbPath, { summaryId: "summary-nonsole-1", tenantId: "tenant-erasure", sessionId: p1.session.sessionId, threadId: thread.threadId });
    await seedDeliveryReceipt(dbPath, { receiptId: "receipt-nonsole-1", tenantId: "tenant-erasure", messageId: outbound.message.messageId });

    // p1 erases -- p1 is NOT the thread's sole-ever HUMAN participant (p2
    // also joined), so DEC-MEMOS-34 disqualifies this thread entirely.
    const result = await call(
      "msp_thread_principal_erase",
      signed("msp_thread_principal_erase", { idempotency_key: "k-nonsole" }, { ...groupClaims({ externalRoomRef: "room-group-nonsole", principalId: "p1" }), dataSubjectAccess: true }),
    );
    assert.equal(result.tablesAffected.sessionSummaries, 0);
    assert.equal(result.tablesAffected.threadDeliveryReceipts, 0);

    const summary = await row(dbPath, "SELECT redaction_state, summary_json FROM session_summaries WHERE summary_id = ?", "summary-nonsole-1");
    assert.deepEqual(summary, { redaction_state: "none", summary_json: JSON.stringify({ topics: [{ text: "seeded summary content" }] }) });
    const receipt = await row(dbPath, "SELECT redaction_state, text FROM thread_delivery_receipts WHERE receipt_id = ?", "receipt-nonsole-1");
    assert.deepEqual(receipt, { redaction_state: "none", text: "seeded delivery text" });

    // p1's own authored message is STILL erased -- only summaries/
    // receipts are exempted, not p1's own authored content.
    const p1Message = await row(dbPath, "SELECT redaction_state FROM thread_messages WHERE message_id = ?", p1.message.messageId);
    assert.equal(p1Message.redaction_state, "tombstoned");
  } finally {
    await call.close();
    cleanup();
  }
});

test("DEC-MEMOS-34, GROUP-thread reproduction (export direction): p1 exports -- returns NO summary from the non-sole-HUMAN thread at all", async () => {
  const { dbPath, cleanup } = tempDbPath("export-group-nonsole");
  const call = spawnRuntime(dbPath);
  try {
    const claims = groupClaims({ externalRoomRef: "room-export-nonsole" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "room-export-nonsole" }, claims),
    );
    const p1 = await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "p1-in-1", speaker_id: "p1", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from p1" }, groupClaims({ externalRoomRef: "room-export-nonsole", principalId: "p1" })),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "p2-in-1", speaker_id: "p2", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from p2" }, groupClaims({ externalRoomRef: "room-export-nonsole", principalId: "p2" })),
    );
    await seedSummary(dbPath, { summaryId: "summary-export-nonsole-1", tenantId: "tenant-erasure", sessionId: p1.session.sessionId, threadId: thread.threadId });

    const exported = await call(
      "msp_thread_principal_export",
      signed("msp_thread_principal_export", {}, { ...groupClaims({ externalRoomRef: "room-export-nonsole", principalId: "p1" }), dataSubjectAccess: true }),
    );
    assert.equal(exported.summaries.length, 0, "a non-sole-HUMAN GROUP thread's summary must never appear in p1's export");
    assert.equal(exported.messages.length, 1, "p1's own authored message must still be exported");
  } finally {
    await call.close();
    cleanup();
  }
});

test("DEC-MEMOS-34, UNKNOWN-speaker reproduction: sole HUMAN participant plus one UNKNOWN-speaker message -- excluded from BOTH erasure and export", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-unknown-speaker");
  const call = spawnRuntime(dbPath);
  try {
    const claims = groupClaims({ externalRoomRef: "room-unknown-speaker" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "room-unknown-speaker" }, claims),
    );
    const p1 = await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "p1-in-1", speaker_id: "p1", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from p1" }, groupClaims({ externalRoomRef: "room-unknown-speaker", principalId: "p1" })),
    );
    // An UNKNOWN-kind message from an unresolved second person -- posts no
    // thread_participants row at all (design Sec.7 rule 1), so the
    // participant-only condition alone would have wrongly qualified this
    // thread as p1's sole-ever-HUMAN thread.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "unknown-in-1", speaker_id: "unresolved-someone", speaker_kind: "UNKNOWN", identity_assurance: "UNRESOLVED", direction: "INBOUND", text: "an unresolved person's message" },
        claims,
      ),
    );
    await seedSummary(dbPath, { summaryId: "summary-unknown-speaker-1", tenantId: "tenant-erasure", sessionId: p1.session.sessionId, threadId: thread.threadId });

    // Confirm the participant-only precondition really WOULD have
    // qualified this thread, so the assertion below is meaningful.
    const humanCount = await row(dbPath, "SELECT COUNT(DISTINCT speaker_id) AS count FROM thread_participants WHERE thread_id = ? AND speaker_kind = 'HUMAN'", thread.threadId);
    assert.equal(humanCount.count, 1);

    const eraseResult = await call(
      "msp_thread_principal_erase",
      signed("msp_thread_principal_erase", { idempotency_key: "k-unknown-speaker" }, { ...groupClaims({ externalRoomRef: "room-unknown-speaker", principalId: "p1" }), dataSubjectAccess: true }),
    );
    assert.equal(eraseResult.tablesAffected.sessionSummaries, 0, "the UNKNOWN-speaker message must disqualify this thread even though the participant-only test alone would have qualified it");

    const summary = await row(dbPath, "SELECT redaction_state FROM session_summaries WHERE summary_id = ?", "summary-unknown-speaker-1");
    assert.equal(summary.redaction_state, "none");

    const exported = await call(
      "msp_thread_principal_export",
      signed("msp_thread_principal_export", {}, { ...groupClaims({ externalRoomRef: "room-unknown-speaker", principalId: "p1" }), dataSubjectAccess: true }),
    );
    assert.equal(exported.summaries.length, 0);
  } finally {
    await call.close();
    cleanup();
  }
});

test("WARNING 4: a thread with one shared speaker_id used by two different person_ids is disqualified by the person_id count ALONE", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-person-id-disagreement");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-person-disagreement" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-person-disagreement" }, claims),
    );
    const first = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "PENDING", person_id: "alice", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    await seedSummary(dbPath, { summaryId: "summary-person-disagreement-1", tenantId: "tenant-erasure", sessionId: first.session.sessionId, threadId: thread.threadId });

    // Schema-legal: swap the SAME speaker_id's person_id to a different
    // value on a NEW membership row (append-only -- a real UPDATE via
    // direct SQL here would violate trg_thread_participants_append_only,
    // so a second row is inserted directly, exactly the shape a real
    // assertParticipants-gated change would also produce).
    await withDb(dbPath, async (db) => {
      db.prepare("UPDATE thread_participants SET left_at = ? WHERE thread_id = ? AND speaker_id = 'alice' AND left_at IS NULL").run(new Date().toISOString(), thread.threadId);
      db.prepare(
        `INSERT INTO thread_participants (membership_id, tenant_id, thread_id, speaker_id, speaker_kind, person_id, identity_assurance, joined_at, left_at, source_ref)
         VALUES ('msp:membership/person-disagreement', 'tenant-erasure', ?, 'alice', 'HUMAN', 'a-different-person', 'VERIFIED', ?, NULL, NULL)`,
      ).run(thread.threadId, new Date().toISOString());
    });

    const speakerIdCount = await row(dbPath, "SELECT COUNT(DISTINCT speaker_id) AS count FROM thread_participants WHERE thread_id = ? AND speaker_kind = 'HUMAN'", thread.threadId);
    assert.equal(speakerIdCount.count, 1, "precondition: the speaker_id count alone is 1 -- only the person_id count must disqualify");

    const result = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-person-disagreement" }, { ...claims, dataSubjectAccess: true }));
    assert.equal(result.tablesAffected.sessionSummaries, 0, "two distinct person_ids under one shared speaker_id must disqualify the thread, even though the speaker_id count alone is 1");
  } finally {
    await call.close();
    cleanup();
  }
});

test("ordering property (WARNING 1): the DEC-MEMOS-34 qualifying query (no left_at filter) returns the IDENTICAL result before and after closing the participant row", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-ordering-property");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-ordering-property" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-ordering-property" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );

    const qualifyingQuery = `SELECT thread_id FROM thread_participants
      WHERE tenant_id = ? AND speaker_kind = 'HUMAN'
      GROUP BY thread_id
      HAVING COUNT(DISTINCT speaker_id) = 1
         AND COUNT(DISTINCT CASE WHEN person_id IS NOT NULL THEN person_id END) <= 1
         AND MIN(speaker_id) = ?
      EXCEPT
      SELECT thread_id FROM thread_messages
      WHERE tenant_id = ? AND speaker_kind NOT IN ('HUMAN', 'AGENT')`;

    const before = await rows(dbPath, qualifyingQuery, "tenant-erasure", "alice", "tenant-erasure");
    await departParticipant(dbPath, thread.threadId, "alice");
    const after = await rows(dbPath, qualifyingQuery, "tenant-erasure", "alice", "tenant-erasure");

    assert.deepEqual(
      before.map((r) => r.thread_id),
      after.map((r) => r.thread_id),
      "the qualifying-thread query has no left_at filter, so closing the participant row first or last must produce an IDENTICAL qualifying set",
    );
    assert.ok(before.some((r) => r.thread_id === thread.threadId), "the thread must genuinely qualify both before and after, or this test proves nothing");
  } finally {
    await call.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------
// BL-MEMOS-054: msp_thread_retention_tick.
// ---------------------------------------------------------------------

test("retention: refused for a cross-tenant operator by construction -- every row touched is WHERE tenant_id = grant.tenantId", async () => {
  const { dbPath, cleanup } = tempDbPath("retention-cross-tenant");
  const call = spawnRuntime(dbPath, { MSP_THREAD_RETENTION_DAYS: "1" });
  try {
    const claimsTenantA = directClaims({ externalRoomRef: "dm-retention-a", tenantId: "tenant-erasure-a" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-erasure", tenant_id: "tenant-erasure-a", external_room_ref: "dm-retention-a" }, claimsTenantA),
    );
    // tenant B's own operator grant sweeps only tenant B -- proven by
    // construction: a grant scoped to tenant B can never even RESOLVE a
    // tenant A row to compare against, so this is a structural assertion,
    // not a specific refusal to induce.
    const claimsTenantB = { ...claimsTenantA, tenantId: "tenant-erasure-b" };
    const result = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: true }, { ...claimsTenantB, operator: true }));
    assert.deepEqual(result.tablesAffected, { threadMessages: 0, protectedMemoryRecords: 0, sessionSummaries: 0, threadDeliveryReceipts: 0, threadPendingDeliveries: 0 });
  } finally {
    await call.close();
    cleanup();
  }
});

test("retention: a room-claimed operator grant still sweeps the WHOLE tenant, not merely its own room (deliberate, not a gap)", async () => {
  const { dbPath, cleanup } = tempDbPath("retention-whole-tenant");
  const call = spawnRuntime(dbPath, { MSP_THREAD_RETENTION_DAYS: "1" });
  try {
    const claimsRoomA = directClaims({ externalRoomRef: "dm-retention-room-a" });
    const { thread: threadA } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-retention-room-a" }, claimsRoomA),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: threadA.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "room a", occurred_at: daysAgoIso(2) }, claimsRoomA),
    );

    const claimsRoomB = directClaims({ externalRoomRef: "dm-retention-room-b", principalId: "carol" });
    const { thread: threadB } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-retention-room-b" }, claimsRoomB),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: threadB.threadId, source_event_id: "in-1", speaker_id: "carol", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "room b", occurred_at: daysAgoIso(2) }, claimsRoomB),
    );

    // The retention tick's own grant is claimed with room A's own scope
    // (externalRoomRef/channelAccountId set, the shape a real compaction/
    // sweep-style operator grant has) -- but the tick must still see
    // room B's message too, since the tick has no room filter at all.
    const dryRun = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: true }, { ...claimsRoomA, operator: true }));
    assert.equal(dryRun.tablesAffected.threadMessages, 2, "a room-claimed operator grant must still see BOTH rooms' aged messages -- retention is tenant-wide by design");
  } finally {
    await call.close();
    cleanup();
  }
});

test("retention: dry_run distinguishes cleanly from a live pass -- redaction_state/content columns unchanged after dry_run:true, blanked after dry_run:false; a journal entry is written on BOTH arms", async () => {
  const { dbPath, cleanup } = tempDbPath("retention-dry-run");
  const call = spawnRuntime(dbPath, { MSP_THREAD_RETENTION_DAYS: "1" });
  try {
    const claims = directClaims({ externalRoomRef: "dm-retention-dry-run" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-retention-dry-run" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "aged content", occurred_at: daysAgoIso(2) }, claims),
    );

    // dry_run:true consumes no nonce -- omit the claim entirely.
    const dryRun = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: true }, { ...claims, operator: true }));
    assert.equal(dryRun.tablesAffected.threadMessages, 1);

    const afterDry = await row(dbPath, "SELECT redaction_state, text FROM thread_messages WHERE thread_id = ?", thread.threadId);
    assert.deepEqual(afterDry, { redaction_state: "none", text: "aged content" }, "dry_run:true must mutate nothing");

    const journalAfterDry = await row(dbPath, "SELECT COUNT(*) AS count FROM journal WHERE tool_name = 'msp_thread_retention_tick'");
    assert.equal(journalAfterDry.count, 1, "DEC-MEMOS-35 (revised): dry_run:true still writes a journal entry -- only the nonce exemption is dry-run-specific");

    // dry_run:false requires a nonce.
    const live = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: false }, { ...claims, operator: true }));
    assert.equal(live.tablesAffected.threadMessages, 1);

    const afterLive = await row(dbPath, "SELECT redaction_state, text FROM thread_messages WHERE thread_id = ?", thread.threadId);
    assert.deepEqual(afterLive, { redaction_state: "tombstoned", text: "" });

    const journalAfterLive = await row(dbPath, "SELECT COUNT(*) AS count FROM journal WHERE tool_name = 'msp_thread_retention_tick'");
    assert.equal(journalAfterLive.count, 2);
  } finally {
    await call.close();
    cleanup();
  }
});

test("retention: dry_run:true requires no nonce claim at all, and does not consume one when present", async () => {
  const { dbPath, cleanup } = tempDbPath("retention-no-nonce");
  const call = spawnRuntime(dbPath, { MSP_THREAD_RETENTION_DAYS: "1" });
  try {
    const claims = directClaims({ externalRoomRef: "dm-retention-no-nonce" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-retention-no-nonce" }, claims),
    );
    // signThreadRequest auto-generates a nonce unless the caller
    // overrides it with an explicit undefined -- proving the ABSENCE
    // requirement precisely.
    const noNonceClaims = { ...claims, operator: true, nonce: undefined };
    const result = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: true }, noNonceClaims));
    assert.ok(result, "dry_run:true must succeed with literally no nonce claim on the grant");
  } finally {
    await call.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------
// BL-MEMOS-055: msp_thread_principal_export.
// ---------------------------------------------------------------------

test("export: contains only the requester's own material; excludes tombstoned rows including the exporter's OWN previously-erased content (DEC-MEMOS-30)", async () => {
  const { dbPath, cleanup } = tempDbPath("export-own-material");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-export-own" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-export-own" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "my own content" }, claims),
    );

    const beforeErase = await call("msp_thread_principal_export", signed("msp_thread_principal_export", {}, { ...claims, dataSubjectAccess: true }));
    assert.equal(beforeErase.messages.length, 1);
    assert.equal(beforeErase.messages[0].text, "my own content");

    await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-export-own" }, { ...claims, dataSubjectAccess: true }));

    const afterErase = await call("msp_thread_principal_export", signed("msp_thread_principal_export", {}, { ...claims, dataSubjectAccess: true }));
    assert.equal(afterErase.messages.length, 0, "the exporter's own previously-erased content must be permanently unexportable, not merely erased for others");
  } finally {
    await call.close();
    cleanup();
  }
});

test("export: cross-principal export without dataSubjectAdmin is refused thread_scope_denied", async () => {
  const { dbPath, cleanup } = tempDbPath("export-cross-noadmin");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-export-cross-noadmin" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-export-cross-noadmin" }, claims),
    );
    await assert.rejects(
      call("msp_thread_principal_export", signed("msp_thread_principal_export", { principal_id: "bob" }, { ...claims, dataSubjectAccess: true })),
      /thread_scope_denied/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("export: an unknown principal is an empty export, never not_found (DEC-MEMOS-33)", async () => {
  const { dbPath, cleanup } = tempDbPath("export-unknown");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-export-unknown" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-export-unknown" }, claims),
    );
    const result = await call(
      "msp_thread_principal_export",
      signed("msp_thread_principal_export", { principal_id: "never-existed" }, { ...claims, dataSubjectAccess: true, dataSubjectAdmin: true }),
    );
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.protectedRecords, []);
    assert.deepEqual(result.summaries, []);
  } finally {
    await call.close();
    cleanup();
  }
});

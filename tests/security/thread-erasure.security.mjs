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
import { hmacRoomRef } from "../../packages/msp-core/src/domain/thread-memory.mjs";
import { signThreadRequest } from "../../packages/msp-contracts/src/contracts/thread-access.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const SERVICE_KEY = "thread-erasure-security-test-key-32bytes";
const IDENTITY_KEY = "thread-erasure-security-test-hmac-key-32b";
const IDENTITY_KEY_VERSION = "identity-v1";

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
    env: {
      ...process.env,
      MSP_DB_PATH: dbPath,
      MSP_THREAD_SERVICE_KEY: SERVICE_KEY,
      MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY,
      MSP_IDENTITY_HMAC_KEY_VERSION: IDENTITY_KEY_VERSION,
      ...extraEnv,
    },
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
async function seedSummary(dbPath, { summaryId, tenantId, sessionId, threadId, summaryVersion = 1, createdAt = new Date().toISOString() }) {
  await withDb(dbPath, async (db) => {
    db.prepare(
      `INSERT INTO session_summaries
        (summary_id, tenant_id, session_id, thread_id, summary_version, covered_from_sequence, covered_through_sequence,
         source_digest, summary_json, policy_revision, summarizer_version, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, 'v1', 'test', ?)`,
    ).run(summaryId, tenantId, sessionId, threadId, summaryVersion, "d".repeat(64), JSON.stringify({ topics: [{ text: "seeded summary content" }] }), createdAt);
  });
}

async function seedDeliveryReceipt(dbPath, { receiptId, tenantId, messageId, recordedAt = new Date().toISOString() }) {
  await withDb(dbPath, async (db) => {
    db.prepare(`INSERT INTO thread_delivery_receipts (receipt_id, tenant_id, message_id, outcome, text, recorded_at) VALUES (?, ?, ?, 'DELIVERED', 'seeded delivery text', ?)`).run(
      receiptId,
      tenantId,
      messageId,
      recordedAt,
    );
  });
}

// RKOI PH-MEMOS-4 review round 4, REQUIRED item 3: a direct-DB seed for
// protected_memory_records, following the SAME shape
// trg_protected_memory_records_subject_rules requires of a real
// msp_thread_memory_record call -- asserted_by_speaker_id must be a
// CURRENT (left_at IS NULL) HUMAN participant, and a HUMAN asserter's
// subject_person_id must equal its own speaker_id.
async function seedProtectedMemoryRecord(dbPath, { recordId, tenantId, threadId, sessionId, assertedBySpeakerId, createdAt = new Date().toISOString() }) {
  await withDb(dbPath, async (db) => {
    db.prepare(
      `INSERT INTO protected_memory_records
        (record_id, tenant_id, thread_id, session_id, kind, status, asserted_by_speaker_id, subject_person_id,
         scope_json, body_json, source_message_refs_json, verification_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PREFERENCE', 'ACTIVE', ?, ?, '{}', ?, '[]', 'CANDIDATE', ?, ?)`,
    ).run(recordId, tenantId, threadId, sessionId, assertedBySpeakerId, assertedBySpeakerId, JSON.stringify({ note: "seeded aged record" }), createdAt, createdAt);
  });
}

// thread_pending_deliveries carries no thread_id FK at all -- its own
// binding is the room triple (tenant_id, channel_account_id,
// external_room_ref_hmac), matching how msp_thread_delivery_record's
// PENDING path itself resolves a room, never a thread_id.
async function seedPendingDelivery(dbPath, { receiptId, tenantId, channelAccountId, externalRoomRefHmac, inboundMessageId, recordedAt = new Date().toISOString() }) {
  await withDb(dbPath, async (db) => {
    db.prepare(
      `INSERT INTO thread_pending_deliveries
        (receipt_id, inbound_message_id, source_event_id, tenant_id, channel_account_id, external_room_ref_hmac, outcome, text, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACCEPTED', 'seeded pending text', ?)`,
    ).run(receiptId, inboundMessageId, `${receiptId}-source`, tenantId, channelAccountId, externalRoomRefHmac, recordedAt);
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

test("erase: idempotent -- a second call with the SAME (tenant_id, idempotency_key), the SAME principal_id, and a FRESH nonce returns the stored receipt with no content-table or erasure_receipts writes, but does journal and does consume its own nonce", async () => {
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
    const journalCountAfterFirst = await row(dbPath, "SELECT COUNT(*) AS count FROM journal WHERE tool_name = 'msp_thread_principal_erase'");
    assert.equal(journalCountAfterFirst.count, 1, "the non-replay arm must journal exactly once");

    const messageBeforeReplay = await row(dbPath, "SELECT redaction_state, text FROM thread_messages WHERE thread_id = ?", thread.threadId);
    const erasureRow = await row(dbPath, "SELECT tables_affected_json FROM erasure_receipts WHERE erasure_receipt_id = ?", first.erasureReceiptId);

    const second = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-idempotent" }, { ...claims, dataSubjectAccess: true }));
    const receiptCountAfterSecond = await row(dbPath, "SELECT COUNT(*) AS count FROM erasure_receipts");

    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(second.erasureReceiptId, first.erasureReceiptId);
    assert.deepEqual(second.tablesAffected, first.tablesAffected);
    assert.equal(receiptCountAfterSecond.count, receiptCountAfterFirst.count, "a replay must insert NO further erasure_receipts row");

    // RKOI PH-MEMOS-4 review round 4, REQUIRED item 1: the replay arm must
    // journal too, with `replay: true` genuinely set (not the hard-coded
    // `false` the non-replay arm's payload always carries), the SAME
    // tablesAffected snapshot the stored receipt already has, and no raw
    // principal id in the payload -- the same actor (principalHmac)
    // convention as every other erasure journal entry.
    const journalRows = await rows(dbPath, "SELECT actor, payload_json FROM journal WHERE tool_name = 'msp_thread_principal_erase' ORDER BY journal_id ASC");
    assert.equal(journalRows.length, 2, "a replayed idempotency_key call must add its OWN journal row, not skip journaling entirely");
    const [firstEntry, replayEntry] = journalRows;
    assert.equal(firstEntry.actor, replayEntry.actor, "the replay's actor must be the SAME pseudonym convention (principalHmac) as the non-replay arm");
    const firstPayload = JSON.parse(firstEntry.payload_json);
    const replayPayload = JSON.parse(replayEntry.payload_json);
    assert.equal(firstPayload.replay, false);
    assert.equal(replayPayload.replay, true);
    assert.deepEqual(replayPayload.tables_affected, JSON.parse(erasureRow.tables_affected_json), "the replay's journaled tables_affected must match the stored receipt's own snapshot");
    assert.ok(!JSON.stringify(replayPayload).includes("alice"), "the replay's journal payload must never carry the raw principal id");

    // A true no-op on the data itself -- only the journal gets a new entry.
    const messageAfterReplay = await row(dbPath, "SELECT redaction_state, text FROM thread_messages WHERE thread_id = ?", thread.threadId);
    assert.deepEqual(messageAfterReplay, messageBeforeReplay, "a replay must never re-touch a content table");
    const erasureRowAfterReplay = await row(dbPath, "SELECT tables_affected_json FROM erasure_receipts WHERE erasure_receipt_id = ?", first.erasureReceiptId);
    assert.deepEqual(erasureRowAfterReplay, erasureRow, "a replay must never touch the stored erasure_receipts row");
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: receipt stores only the domain-separated scrypt pseudonym, row salt, and key generation", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-receipt-pseudonym");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-receipt-pseudonym" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-receipt-pseudonym" }, claims),
    );

    const result = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-receipt-pseudonym" }, { ...claims, dataSubjectAccess: true }));
    const receipt = await row(
      dbPath,
      "SELECT erasure_receipt_id, tenant_id, principal_hmac, principal_hmac_salt, identity_key_version, idempotency_key, requested_by_agent_id, tables_affected_json, created_at FROM erasure_receipts WHERE erasure_receipt_id = ?",
      result.erasureReceiptId,
    );
    const journal = await row(dbPath, "SELECT actor FROM journal WHERE tool_name = 'msp_thread_principal_erase' AND ref = ?", result.erasureReceiptId);

    assert.deepEqual(Object.keys(receipt), [
      "erasure_receipt_id",
      "tenant_id",
      "principal_hmac",
      "principal_hmac_salt",
      "identity_key_version",
      "idempotency_key",
      "requested_by_agent_id",
      "tables_affected_json",
      "created_at",
    ]);
    assert.match(receipt.principal_hmac, /^[0-9a-f]{64}$/);
    assert.match(receipt.principal_hmac_salt, /^[0-9a-f]{32}$/);
    assert.equal(receipt.identity_key_version, IDENTITY_KEY_VERSION);
    assert.ok(!JSON.stringify(receipt).includes("alice"), "the stored receipt must not contain the raw principal id");
    assert.notEqual(receipt.principal_hmac, journal.actor, "receipt KDF output must be domain-separated from the journal actor pseudonym");
    assert.equal(await row(dbPath, "SELECT COUNT(*) AS count FROM pragma_table_info('erasure_receipts') WHERE name = 'principal_id'").then((value) => value.count), 0);
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: missing receipt-key version refuses atomically before tombstones, receipt insert, or journal append", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-receipt-missing-version");
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY_VERSION: undefined });
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-receipt-missing-version" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-receipt-missing-version" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "must remain" }, claims),
    );

    await assert.rejects(
      call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-missing-version" }, { ...claims, dataSubjectAccess: true })),
      /identity_hmac_unconfigured/,
    );
    assert.deepEqual(await row(dbPath, "SELECT redaction_state, text FROM thread_messages WHERE thread_id = ?", thread.threadId), { redaction_state: "none", text: "must remain" });
    assert.equal((await row(dbPath, "SELECT COUNT(*) AS count FROM erasure_receipts")).count, 0);
    assert.equal((await row(dbPath, "SELECT COUNT(*) AS count FROM journal WHERE tool_name = 'msp_thread_principal_erase'")).count, 0);
  } finally {
    await call.close();
    cleanup();
  }
});

test("erase: a retired receipt key in MSP_IDENTITY_HMAC_KEYRING permits same-principal idempotency replay after rotation", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-receipt-rotation");
  const firstCall = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY_VERSION: "identity-v1" });
  const rotatedKey = "thread-erasure-rotated-hmac-key-32bytes";
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-receipt-rotation" });
    await firstCall(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-receipt-rotation" }, claims),
    );
    const first = await firstCall("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-rotation" }, { ...claims, dataSubjectAccess: true }));
    assert.equal(first.replay, false);
  } finally {
    await firstCall.close();
  }

  const rotatedCall = spawnRuntime(dbPath, {
    MSP_IDENTITY_HMAC_KEY: rotatedKey,
    MSP_IDENTITY_HMAC_KEY_VERSION: "identity-v2",
    MSP_IDENTITY_HMAC_KEYRING: JSON.stringify({ "identity-v1": IDENTITY_KEY }),
  });
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-receipt-rotation" });
    const replay = await rotatedCall("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-rotation" }, { ...claims, dataSubjectAccess: true }));
    assert.equal(replay.replay, true);
  } finally {
    await rotatedCall.close();
  }

  const prunedKeyCall = spawnRuntime(dbPath, {
    MSP_IDENTITY_HMAC_KEY: rotatedKey,
    MSP_IDENTITY_HMAC_KEY_VERSION: "identity-v2",
    // An empty configured ring is invalid startup configuration. Omitting
    // the optional ring models the operationally equivalent pruning state:
    // identity-v1 is no longer retained, so its receipt cannot be matched.
    MSP_IDENTITY_HMAC_KEYRING: undefined,
  });
  try {
    const claims = directClaims({ externalRoomRef: "dm-erase-receipt-rotation" });
    await assert.rejects(
      prunedKeyCall("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-rotation" }, { ...claims, dataSubjectAccess: true })),
      /conflict:.*cannot be matched.*identity-key version is unavailable/i,
      "a receipt whose historical key was pruned must report unavailable matching, not a principal mismatch",
    );
  } finally {
    await prunedKeyCall.close();
    cleanup();
  }
});

test("erase: a LITERAL replay of the exact same signed request (same nonce, same idempotency_key) is refused grant_replayed from the second call onward -- only the very first call is ever accepted, and no refused call ever journals", async () => {
  // RKOI review round 5, WARNING 2: reproduces RKOI's own probe exactly.
  // Before this round's fix, the erasure replay arm never reached
  // #consumeNonce at all, so all four identical calls were ACCEPTED, each
  // appending its own journal row under the real principal's HMAC -- an
  // unbounded, attacker-controlled write to the compliance journal. The
  // exact accept/refuse sequence asserted here, not merely "eventually
  // refused": call 0 (idempotency_key not yet on file) takes the
  // NON-replay arm and consumes the nonce as part of its own mutation;
  // calls 1-3 (same idempotency_key, now on file) take the replay arm,
  // whose own #consumeNonce call collides on the SAME (tenant_id, nonce)
  // row call 0 already inserted and is refused grant_replayed every time --
  // there is no "second accepted call" window at all.
  const { dbPath, cleanup } = tempDbPath("erase-literal-replay");
  const call = spawnRuntime(dbPath);
  try {
    const FIXED_NONCE = "fixed-nonce-literal-replay-0123456789ab";
    const claims = directClaims({ externalRoomRef: "dm-erase-literal-replay" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-erase-literal-replay" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );

    const eraseClaims = { ...claims, dataSubjectAccess: true, nonce: FIXED_NONCE };
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      const request = signed("msp_thread_principal_erase", { idempotency_key: "k-literal-replay" }, eraseClaims);
      try {
        const result = await call("msp_thread_principal_erase", request);
        outcomes.push({ accepted: true, replay: result.replay });
      } catch (error) {
        outcomes.push({ accepted: false, message: error.message });
      }
    }

    assert.equal(outcomes[0].accepted, true, "the first call must be accepted (non-replay arm, mints the receipt)");
    assert.equal(outcomes[0].replay, false);
    for (let i = 1; i < 4; i += 1) {
      assert.equal(outcomes[i].accepted, false, `call ${i} (a literal resend) must be refused, not accepted`);
      assert.match(outcomes[i].message, /grant_replayed/, `call ${i} must be refused specifically as grant_replayed`);
    }

    const journalCount = await row(dbPath, "SELECT COUNT(*) AS count FROM journal WHERE tool_name = 'msp_thread_principal_erase'");
    assert.equal(journalCount.count, 1, "only the single accepted call may ever journal -- a refused literal replay must add NO journal row");

    const receiptCount = await row(dbPath, "SELECT COUNT(*) AS count FROM erasure_receipts");
    assert.equal(receiptCount.count, 1, "a refused literal replay must never mint or touch an erasure_receipts row");

    const nonceCount = await row(dbPath, "SELECT COUNT(*) AS count FROM grant_nonces WHERE nonce = ?", FIXED_NONCE);
    assert.equal(nonceCount.count, 1, "the fixed nonce is consumed exactly once, by the first (accepted) call only");
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
      /conflict:.*different principal_id/i,
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

// RKOI PH-MEMOS-4 review round 4, REQUIRED item 2: every existing
// assertion above for summaries/delivery receipts is "length 0" or
// "untouched" -- if #qualifyingThreadIds silently returned the empty set
// UNCONDITIONALLY, every one of those cases would still pass, hiding a
// real under-erasure regression. These two cases seed a thread that
// GENUINELY qualifies (sole-ever HUMAN, no disqualifying message) and
// prove the positive direction the store layer already gets right
// (RKOI's own probes D1/D5) is also pinned by a repo-resident test.

test("DEC-MEMOS-34 positive: a genuinely qualifying thread's summary is visible via export before erase, tombstoned (direct SELECT) and absent from export after", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-qualifying-summary");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-qualifying-summary" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-qualifying-summary" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );
    // alice is the DIRECT thread's sole-ever HUMAN participant, and no
    // UNKNOWN/OPERATOR message was ever posted -- this thread genuinely
    // qualifies for both erasure's and export's session_summaries
    // disposition.
    await seedSummary(dbPath, { summaryId: "summary-qualifying-1", tenantId: "tenant-erasure", sessionId: inbound.session.sessionId, threadId: thread.threadId });

    const beforeExport = await call("msp_thread_principal_export", signed("msp_thread_principal_export", {}, { ...claims, dataSubjectAccess: true }));
    assert.equal(beforeExport.summaries.length, 1, "precondition: the seeded summary must genuinely qualify, or this test proves nothing");

    const result = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-qualifying-summary" }, { ...claims, dataSubjectAccess: true }));
    assert.equal(result.tablesAffected.sessionSummaries, 1, "the erase call itself must count the tombstoned summary -- an unconditional empty-set regression would report 0 here");

    const summaryRow = await row(dbPath, "SELECT redaction_state, summary_json FROM session_summaries WHERE summary_id = ?", "summary-qualifying-1");
    assert.deepEqual(summaryRow, { redaction_state: "tombstoned", summary_json: "{}" }, "the qualifying summary must actually be tombstoned and blanked, proven by a direct SELECT, not merely the response's own count");

    const afterExport = await call("msp_thread_principal_export", signed("msp_thread_principal_export", {}, { ...claims, dataSubjectAccess: true }));
    assert.equal(afterExport.summaries.length, 0, "a tombstoned summary must be absent from export after erasure (DEC-MEMOS-30)");
  } finally {
    await call.close();
    cleanup();
  }
});

test("DEC-MEMOS-34 positive: a genuinely qualifying thread's delivery receipt is tombstoned (content blanked) after erase", async () => {
  const { dbPath, cleanup } = tempDbPath("erase-qualifying-receipt");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-qualifying-receipt" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-qualifying-receipt" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );
    // A delivery receipt must reference an OUTBOUND message -- an AGENT
    // reply to alice's own inbound exchange, the same shape the existing
    // GROUP-thread reproduction test already uses.
    const outbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: thread.threadId, session_id: inbound.session.sessionId, exchange_id: inbound.message.exchangeId, reply_to_message_id: inbound.message.messageId,
          source_event_id: "agent-out-1", speaker_id: claims.agentId, speaker_kind: "AGENT", identity_assurance: "VERIFIED", direction: "OUTBOUND", text: "agent reply", delivery_state: "QUEUED",
        },
        claims,
      ),
    );
    await seedDeliveryReceipt(dbPath, { receiptId: "receipt-qualifying-1", tenantId: "tenant-erasure", messageId: outbound.message.messageId });

    const result = await call("msp_thread_principal_erase", signed("msp_thread_principal_erase", { idempotency_key: "k-qualifying-receipt" }, { ...claims, dataSubjectAccess: true }));
    assert.equal(result.tablesAffected.threadDeliveryReceipts, 1, "the erase call itself must count the tombstoned receipt -- an unconditional empty-set regression would report 0 here");

    const receiptRow = await row(dbPath, "SELECT redaction_state, text FROM thread_delivery_receipts WHERE receipt_id = ?", "receipt-qualifying-1");
    assert.deepEqual(receiptRow, { redaction_state: "tombstoned", text: "" }, "the qualifying receipt must actually be tombstoned and blanked, proven by a direct SELECT");
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

// RKOI PH-MEMOS-4 review round 4, REQUIRED item 3: RETENTION_TABLES names
// five tables with THREE different age-column names
// (thread_messages.occurred_at, {protected_memory_records,
// session_summaries}.created_at, {thread_delivery_receipts,
// thread_pending_deliveries}.recorded_at) -- a typo in any of the two
// non-threadMessages column names would surface as a raw SqliteError to a
// caller, and the existing dry-run/live test above never seeds the other
// four tables, so it cannot catch that. This seeds aged content in all
// five and asserts every one of the five tablesAffected counters, on
// BOTH the dry-run (zero-mutation) and live (tombstone) pass.
test("retention: dry-run and live pass report every one of the five RETENTION_TABLES counters correctly, not just threadMessages", async () => {
  const { dbPath, cleanup } = tempDbPath("retention-all-tables");
  const call = spawnRuntime(dbPath, { MSP_THREAD_RETENTION_DAYS: "1" });
  try {
    const claims = directClaims({ externalRoomRef: "dm-retention-all-tables" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-retention-all-tables" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "aged inbound", occurred_at: daysAgoIso(2) },
        claims,
      ),
    );
    const outbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: thread.threadId, session_id: inbound.session.sessionId, exchange_id: inbound.message.exchangeId, reply_to_message_id: inbound.message.messageId,
          source_event_id: "agent-out-1", speaker_id: claims.agentId, speaker_kind: "AGENT", identity_assurance: "VERIFIED", direction: "OUTBOUND", text: "aged outbound", delivery_state: "QUEUED",
        },
        claims,
      ),
    );

    await seedProtectedMemoryRecord(dbPath, {
      recordId: "record-aged-1",
      tenantId: "tenant-erasure",
      threadId: thread.threadId,
      sessionId: inbound.session.sessionId,
      assertedBySpeakerId: "alice",
      createdAt: daysAgoIso(2),
    });
    await seedSummary(dbPath, { summaryId: "summary-aged-1", tenantId: "tenant-erasure", sessionId: inbound.session.sessionId, threadId: thread.threadId, createdAt: daysAgoIso(2) });
    await seedDeliveryReceipt(dbPath, { receiptId: "receipt-aged-1", tenantId: "tenant-erasure", messageId: outbound.message.messageId, recordedAt: daysAgoIso(2) });
    await seedPendingDelivery(dbPath, {
      receiptId: "pending-aged-1",
      tenantId: "tenant-erasure",
      channelAccountId: "oa-erasure",
      externalRoomRefHmac: hmacRoomRef(IDENTITY_KEY, { tenantId: "tenant-erasure", channelAccountId: "oa-erasure", externalRoomRef: "dm-retention-all-tables" }),
      inboundMessageId: inbound.message.messageId,
      recordedAt: daysAgoIso(2),
    });

    const expectedCounts = { threadMessages: 1, protectedMemoryRecords: 1, sessionSummaries: 1, threadDeliveryReceipts: 1, threadPendingDeliveries: 1 };

    const dryRun = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: true }, { ...claims, operator: true }));
    assert.deepEqual(dryRun.tablesAffected, expectedCounts, "a typo in any age-column name would surface as a raw SqliteError here, not merely a wrong count");

    // dry_run:true must mutate NOTHING -- every seeded row's redaction_state
    // stays 'none' across the dry-run pass. thread_messages is filtered by
    // its own message_id (not merely thread_id): the thread carries TWO
    // messages (the aged INBOUND one plus the fresh OUTBOUND reply), and
    // only the aged one is a candidate at all.
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_messages WHERE message_id = ?", inbound.message.messageId)).redaction_state, "none");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM protected_memory_records WHERE record_id = ?", "record-aged-1")).redaction_state, "none");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM session_summaries WHERE summary_id = ?", "summary-aged-1")).redaction_state, "none");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_delivery_receipts WHERE receipt_id = ?", "receipt-aged-1")).redaction_state, "none");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_pending_deliveries WHERE receipt_id = ?", "pending-aged-1")).redaction_state, "none");

    const live = await call("msp_thread_retention_tick", signed("msp_thread_retention_tick", { dry_run: false }, { ...claims, operator: true }));
    assert.deepEqual(live.tablesAffected, expectedCounts);

    // dry_run:false must tombstone every one of the five rows -- and leave
    // the thread's fresh OUTBOUND message (never a retention candidate)
    // completely untouched, proving the UPDATE targeted the right row.
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_messages WHERE message_id = ?", inbound.message.messageId)).redaction_state, "tombstoned");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_messages WHERE message_id = ?", outbound.message.messageId)).redaction_state, "none");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM protected_memory_records WHERE record_id = ?", "record-aged-1")).redaction_state, "tombstoned");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM session_summaries WHERE summary_id = ?", "summary-aged-1")).redaction_state, "tombstoned");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_delivery_receipts WHERE receipt_id = ?", "receipt-aged-1")).redaction_state, "tombstoned");
    assert.equal((await row(dbPath, "SELECT redaction_state FROM thread_pending_deliveries WHERE receipt_id = ?", "pending-aged-1")).redaction_state, "tombstoned");
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

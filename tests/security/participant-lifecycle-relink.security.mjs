// PH-MEMOS-4 (TASK-MEMOS-003, design v0.5.4b Sec.7/Sec.7.1/Sec.8.6): one
// suite file for every participant-lifecycle, relink and agent-detach case
// GATE-MEMOS-4 names, proven against the REAL running msp-server process
// through its guarded tool surface, signed with
// @freshair129/msp-contracts/thread-access's real signThreadRequest --
// never a mock guard, matching thread-memory-scoping.security.mjs's and
// thread-agent-scoping.security.mjs's own house style. Covers BL-MEMOS-058
// (the rejoin guard fix, a correction to already-shipped `main` code) and
// BL-MEMOS-050/051/052 (msp_thread_participant_lifecycle,
// msp_thread_agent_detach). The unit-level SQLITE_BUSY_SNAPSHOT catch-
// predicate proof lives in
// tests/contract/thread-memory-busy-snapshot-catch.test.mjs instead (design
// v0.5.4b, plan 0.1.16b: a unit-level check, not a real lock-timeout
// induction, which would be slow and flaky) -- this file's own race case
// proves the OTHER half: a genuine two-process race where the store's own
// transaction-internal re-check (not merely the guard's earlier read)
// refuses the losing side, and no raw driver error ever reaches a caller.
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
const SERVICE_KEY = "participant-lifecycle-relink-security-test-key-32b";
const IDENTITY_KEY = "participant-lifecycle-relink-security-test-hmac-key";

function tempDbPath(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `msp-lifecycle-relink-${label}-`));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      } catch (error) {
        // Best-effort teardown only, same rationale as
        // thread-agent-scoping.security.mjs's own tempDbPath: a residual
        // Windows file-lock race on the temp directory must never
        // retroactively mask an assertion that already passed or thrown.
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

const ROOM = { channelAccountId: "oa-lifecycle", tenantId: "tenant-lifecycle", agentId: "agent-lifecycle", workspaceId: "workspace-lifecycle" };
const ROOM_REQUEST = { channel_type: "LINE", channel_account_id: "oa-lifecycle", tenant_id: "tenant-lifecycle" };

function directClaims(overrides = {}) {
  return { ...ROOM, audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", ...overrides };
}

function groupClaims(overrides = {}) {
  return { ...ROOM, audienceKind: "GROUP", principalId: "alice", policyRevision: "v1", ...overrides };
}

async function departParticipant(dbPath, threadId, speakerId) {
  const { open } = await import("@freshair129/msp-storage/connection");
  const db = open(dbPath);
  try {
    const info = db
      .prepare("UPDATE thread_participants SET left_at = ? WHERE thread_id = ? AND speaker_id = ? AND left_at IS NULL")
      .run(new Date().toISOString(), threadId, speakerId);
    assert.equal(info.changes, 1, "expected exactly one open thread_participants row to depart");
  } finally {
    db.close();
  }
}

async function humanParticipantCount(dbPath, threadId) {
  const { open } = await import("@freshair129/msp-storage/connection");
  const db = open(dbPath);
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM thread_participants WHERE thread_id = ? AND speaker_kind = 'HUMAN' AND left_at IS NULL").get(threadId).count;
  } finally {
    db.close();
  }
}

// Case 1 (regression): never-joined append succeeds with no claim.
test("BL-MEMOS-058 case 1: a never-joined speaker's first HUMAN append succeeds with no assertParticipants claim", async () => {
  const { dbPath, cleanup } = tempDbPath("case1");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-case1" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-case1" }, claims),
    );
    const result = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    assert.ok(result.message.messageId);
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1);
  } finally {
    await call.close();
    cleanup();
  }
});

// Case 2, the bug this correction closes: a departed principal's very next
// plain HUMAN append is refused, never a silent rejoin through the
// claim-free first-membership path.
test("BL-MEMOS-058 case 2 (CRITICAL 1, the bug): a departed principal's next HUMAN append with no claim is refused thread_scope_denied, not a silent rejoin", async () => {
  const { dbPath, cleanup } = tempDbPath("case2-refused");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-case2-refused" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-case2-refused" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1);

    // No leave tool exists yet at this commit (BL-MEMOS-050, unstarted) --
    // departure is simulated the same way thread-agent-scoping.security.mjs
    // already does for thread_agents, exactly the shape
    // trg_thread_participants_append_only permits (left_at NULL -> NOT
    // NULL, nothing else changed).
    await departParticipant(dbPath, thread.threadId, "alice");
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 0, "the departed participant's open row must be closed before the repro append");

    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "still here?" },
          claims,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a departed principal's next plain HUMAN append must never silently re-create membership",
    );

    // Direct-SELECT proof (design Sec.15): the HUMAN participant count for
    // this thread stays 0 across the refused append -- no row was created.
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 0);
  } finally {
    await call.close();
    cleanup();
  }
});

// Case 2, the legitimate path: the same rejoin succeeds once the caller
// carries assertParticipants, creating a NEW row.
test("BL-MEMOS-058 case 2, legitimate path: a departed principal's rejoin WITH assertParticipants succeeds and creates a new row", async () => {
  const { dbPath, cleanup } = tempDbPath("case2-accepted");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-case2-accepted" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-case2-accepted" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    await departParticipant(dbPath, thread.threadId, "alice");
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 0);

    const rejoinClaims = { ...claims, assertParticipants: true };
    const result = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "back" },
        rejoinClaims,
      ),
    );
    assert.ok(result.message.messageId, "the rejoin append itself must succeed once assertParticipants is carried");
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1, "the rejoin must create a new open row");
  } finally {
    await call.close();
    cleanup();
  }
});

// Case 3b, regression-proofing DEC-MEMOS-15 against this same fix: a
// current row's self-upgrade with no claim still succeeds -- a naive
// two-branch reading of the fix could have broken this by falling through
// to a wrong branch or by requiring assertParticipants unconditionally.
test("BL-MEMOS-058 case 3b (regression): DEC-MEMOS-15's self-upgrade with no claim still succeeds for a CURRENT participant", async () => {
  const { dbPath, cleanup } = tempDbPath("case3b");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-case3b" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-case3b" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "PENDING", person_id: "alice", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    // PENDING -> VERIFIED self-upgrade, no assertParticipants, matching
    // DEC-MEMOS-15's own conditions exactly (same speaker_id, person_id in
    // {null, principal}, stored person_id in {null, principal}).
    const result = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "verified now" },
        claims,
      ),
    );
    assert.ok(result.message.messageId, "FAIL-CLOSED REGRESSION: DEC-MEMOS-15's self-upgrade must still succeed with no claim after the BL-MEMOS-058 fix");
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1);
  } finally {
    await call.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------
// BL-MEMOS-050/052: msp_thread_participant_lifecycle -- `leave`.
// ---------------------------------------------------------------------

test("leave: refused thread_scope_denied without assertParticipants, self case (DEC-MEMOS-22)", async () => {
  const { dbPath, cleanup } = tempDbPath("leave-self-noclaim");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-leave-self-noclaim" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-leave-self-noclaim" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );
    await assert.rejects(
      call("msp_thread_participant_lifecycle", signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "leave", speaker_id: "alice" }, claims)),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: leave (self) without assertParticipants must be refused",
    );
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1, "the open row must survive the refused leave");
  } finally {
    await call.close();
    cleanup();
  }
});

test("leave: refused thread_scope_denied without assertParticipants, third-party case (DEC-MEMOS-22, no self-service exception)", async () => {
  const { dbPath, cleanup } = tempDbPath("leave-third-noclaim");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-leave-third-noclaim" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-leave-third-noclaim" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );
    // A different grant principal (bob), still claiming assertParticipants
    // is absent, naming alice as the departing speaker_id.
    const bobClaims = directClaims({ externalRoomRef: "dm-leave-third-noclaim", principalId: "bob" });
    await assert.rejects(
      call("msp_thread_participant_lifecycle", signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "leave", speaker_id: "alice" }, bobClaims)),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: leave (third-party) without assertParticipants must be refused",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("leave: WITH assertParticipants succeeds, sets left_at, and never flips threads.status", async () => {
  const { dbPath, cleanup } = tempDbPath("leave-accepted");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-leave-accepted" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-leave-accepted" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );
    const result = await call(
      "msp_thread_participant_lifecycle",
      signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "leave", speaker_id: "alice" }, { ...claims, assertParticipants: true }),
    );
    assert.equal(result.threadId, thread.threadId);
    assert.equal(result.speakerId, "alice");
    assert.ok(result.leftAt);
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 0);

    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const row = db.prepare("SELECT status FROM threads WHERE thread_id = ?").get(thread.threadId);
      assert.equal(row.status, "ACTIVE", "DEC-MEMOS-22: leave must never transition threads.status");
    } finally {
      db.close();
    }
  } finally {
    await call.close();
    cleanup();
  }
});

test("leave: naming a speaker_id with no open row is not_found", async () => {
  const { dbPath, cleanup } = tempDbPath("leave-notfound");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-leave-notfound" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-leave-notfound" }, claims),
    );
    await assert.rejects(
      call(
        "msp_thread_participant_lifecycle",
        signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "leave", speaker_id: "never-joined" }, { ...claims, assertParticipants: true }),
      ),
      /not_found/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------
// BL-MEMOS-050/052: msp_thread_participant_lifecycle -- `close_for_relink`.
// ---------------------------------------------------------------------

test("close_for_relink: assertParticipants ALONE (no assertRelink) is refused thread_scope_denied (DEC-MEMOS-23)", async () => {
  const { dbPath, cleanup } = tempDbPath("relink-no-assertrelink");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-relink-no-assertrelink" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-relink-no-assertrelink" }, claims),
    );
    await assert.rejects(
      call("msp_thread_participant_lifecycle", signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "close_for_relink" }, { ...claims, assertParticipants: true })),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: close_for_relink must require assertRelink IN ADDITION TO assertParticipants",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("close_for_relink: refused thread_scope_denied on a GROUP thread (DEC-MEMOS-23, DIRECT-only)", async () => {
  const { dbPath, cleanup } = tempDbPath("relink-group-refused");
  const call = spawnRuntime(dbPath);
  try {
    const claims = groupClaims({ externalRoomRef: "room-relink-group" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "room-relink-group" }, claims),
    );
    await assert.rejects(
      call(
        "msp_thread_participant_lifecycle",
        signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "close_for_relink" }, { ...claims, assertParticipants: true, assertRelink: true }),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: close_for_relink must be refused on a non-DIRECT thread even with both claims",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("close_for_relink: happy path closes the old DIRECT thread, and the next resolve mints a thread with NONE of the old one's history", async () => {
  const { dbPath, cleanup } = tempDbPath("relink-happy");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-relink-happy" });
    const { thread: oldThread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-relink-happy" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: oldThread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "old secret content" },
        claims,
      ),
    );

    const closed = await call(
      "msp_thread_participant_lifecycle",
      signed("msp_thread_participant_lifecycle", { thread_id: oldThread.threadId, action: "close_for_relink" }, { ...claims, assertParticipants: true, assertRelink: true }),
    );
    assert.equal(closed.status, "CLOSED");

    // The old thread's every tool is refused now -- closed threads refuse
    // everything (design Sec.11, unchanged stage-1 behavior).
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: oldThread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "after close" },
          claims,
        ),
      ),
      /thread_scope_denied/,
    );

    // The SAME binding's next resolve mints a NEW thread_id -- DEC-MEMOS-11
    // unchanged, ACTIVE-scoped uniqueness only.
    const { thread: newThread, created } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-relink-happy" }, claims),
    );
    assert.equal(created, true, "the same binding must mint a genuinely NEW thread, not reattach to the closed one");
    assert.notEqual(newThread.threadId, oldThread.threadId);

    // The new thread carries none of the old one's history -- a fresh
    // HUMAN append is once again the claim-free first-membership path.
    const appended = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: newThread.threadId, source_event_id: "in-new-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "new content" },
        claims,
      ),
    );
    assert.equal(appended.message.sequence, 1, "the new thread's own sequence must start fresh, proving no inherited history");

    const context = await call("msp_thread_context", signed("msp_thread_context", { thread_id: newThread.threadId }, { ...claims, readPrivate: true }));
    const texts = context.recentExchanges.flatMap((exchange) => [exchange.inbound?.text, exchange.outbound?.text]).filter(Boolean);
    assert.ok(!texts.some((text) => text.includes("old secret content")), "the new thread's context must never surface the old thread's content");
  } finally {
    await call.close();
    cleanup();
  }
});

test("case 2b: a Tier-1 caller with assertParticipants can re-attach a DIFFERENT departed third party on a GROUP thread", async () => {
  const { dbPath, cleanup } = tempDbPath("case2b-group");
  const call = spawnRuntime(dbPath);
  try {
    const claims = groupClaims({ externalRoomRef: "room-case2b" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "room-case2b" }, claims),
    );
    // bob joins as a HUMAN participant (his own grant, own claim-free
    // first-ever join).
    const bobClaims = groupClaims({ externalRoomRef: "room-case2b", principalId: "bob" });
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "bob-in-1", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from bob" }, bobClaims),
    );
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1);

    // bob departs (no leave tool call needed for this repro -- direct
    // departure, same shape leave itself produces).
    await departParticipant(dbPath, thread.threadId, "bob");
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 0);

    // alice's own grant, carrying assertParticipants, re-attaches BOB --
    // a DIFFERENT, departed third party, not alice's own former
    // membership. Case 2's condition is keyed on speakerId alone.
    const result = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "bob-in-2", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "bob is back" },
        { ...claims, assertParticipants: true },
      ),
    );
    assert.ok(result.message.messageId, "case 2b: re-attaching a different departed third party on GROUP must succeed with assertParticipants");
    assert.equal(await humanParticipantCount(dbPath, thread.threadId), 1);
  } finally {
    await call.close();
    cleanup();
  }
});

test("case 2b: the same third-party rejoin is refused unconditionally on a DIRECT thread by the single-HUMAN schema trigger", async () => {
  const { dbPath, cleanup } = tempDbPath("case2b-direct-refused");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-case2b-direct" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-case2b-direct" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );
    await departParticipant(dbPath, thread.threadId, "alice");

    // A DIFFERENT principal's grant, carrying assertParticipants, tries to
    // attach a SECOND distinct HUMAN (bob) to the DIRECT thread alice
    // already occupied for life -- refused by the schema trigger
    // regardless of the claim.
    const bobClaims = directClaims({ externalRoomRef: "dm-case2b-direct", principalId: "bob" });
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "bob-in-1", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "can I join?" },
          { ...bobClaims, assertParticipants: true },
        ),
      ),
      /one HUMAN participant|conflict/i,
      "FAIL-CLOSED VIOLATION: a DIRECT thread must never gain a second distinct HUMAN participant, even a departed-and-reattached one",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------
// BL-MEMOS-050/052: close_for_relink's status race.
// ---------------------------------------------------------------------

test("close_for_relink status race: a concurrent close_for_relink racing an in-flight append never leaks a raw driver error -- only a typed conflict or an ordinary success", async () => {
  const { dbPath, cleanup } = tempDbPath("relink-race");
  // Two REAL, separate server processes against the SAME database file --
  // the only way this specific race (the store's own transaction-internal
  // re-check, Sec.7.1 WARNING 2) is genuinely reachable: within a single
  // process, every domain-layer DB call is synchronous (better-sqlite3),
  // so one call's guard-through-store pipeline always completes before
  // another's guard even starts (no interleaving is possible at all).
  const callA = spawnRuntime(dbPath);
  const callB = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-relink-race" });
    const { thread } = await callA(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-relink-race" }, claims),
    );
    await callA(
      "msp_thread_message_append",
      signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" }, claims),
    );

    const relink = callA(
      "msp_thread_participant_lifecycle",
      signed("msp_thread_participant_lifecycle", { thread_id: thread.threadId, action: "close_for_relink" }, { ...claims, assertParticipants: true, assertRelink: true }),
    );
    const append = callB(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-race", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "racing" },
        claims,
      ),
    );

    const [relinkOutcome, appendOutcome] = await Promise.allSettled([relink, append]);

    // The relink itself, issued once with valid claims against an ACTIVE
    // thread, must always succeed -- it is never the losing side of this
    // race in this repro shape.
    assert.equal(relinkOutcome.status, "fulfilled", "close_for_relink itself must succeed");
    assert.equal(relinkOutcome.value.status, "CLOSED");

    // The racing append either lands cleanly (it won the race, landing
    // before the close committed) or is refused -- and if refused, it is
    // asserted to be EXACTLY the typed conflict this design specifies,
    // never a raw SqliteError/driver string (SQLITE_BUSY, "database is
    // locked", etc.) leaking to the caller.
    if (appendOutcome.status === "rejected") {
      const message = appendOutcome.reason?.message ?? String(appendOutcome.reason);
      assert.ok(
        /conflict|thread_scope_denied/i.test(message),
        `FAIL-CLOSED VIOLATION: a raw driver error must never reach the caller for this race, got: ${message}`,
      );
      assert.ok(!/SQLITE_BUSY|database is locked/i.test(message), `a raw SQLite error string leaked to the caller: ${message}`);
    }
  } finally {
    await callA.close();
    await callB.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------
// BL-MEMOS-051/052: msp_thread_agent_detach.
// ---------------------------------------------------------------------

test("detach: a detached agent is denied agent_not_current on every thread-bound tool on its very next call, and can re-attach via its own assertAgents", async () => {
  const { dbPath, cleanup } = tempDbPath("detach");
  const call = spawnRuntime(dbPath);
  try {
    const claims = directClaims({ externalRoomRef: "dm-detach" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-detach" }, claims),
    );

    const detachResult = await call("msp_thread_agent_detach", signed("msp_thread_agent_detach", { thread_id: thread.threadId }, claims));
    assert.equal(detachResult.threadId, thread.threadId);
    assert.equal(detachResult.agentId, claims.agentId);
    assert.ok(detachResult.leftAt);

    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
          claims,
        ),
      ),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: a detached agent's very next append must be refused",
    );

    // A second detach call from the same (now non-current) agent is
    // refused at the guard, before the handler runs at all -- there is
    // nothing for the tool itself to distinguish.
    await assert.rejects(
      call("msp_thread_agent_detach", signed("msp_thread_agent_detach", { thread_id: thread.threadId }, claims)),
      /agent_not_current/,
    );

    // Re-attach via the agent's own assertAgents.
    const reattached = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-detach" }, { ...claims, assertAgents: true }),
    );
    assert.equal(reattached.created, false);
    assert.equal(reattached.agentAttached, true);

    const appendAfterReattach = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "back again" },
        claims,
      ),
    );
    assert.ok(appendAfterReattach.message.messageId);
  } finally {
    await call.close();
    cleanup();
  }
});

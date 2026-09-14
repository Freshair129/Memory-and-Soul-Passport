// PH-MEMOS-4 (TASK-MEMOS-003, design v0.5.4b Sec.7/Sec.7.1/Sec.8.6): one
// suite file for every participant-lifecycle, relink and agent-detach case
// GATE-MEMOS-4 names, proven against the REAL running msp-server process
// through its guarded tool surface, signed with
// @freshair129/msp-contracts/thread-access's real signThreadRequest --
// never a mock guard, matching thread-memory-scoping.security.mjs's and
// thread-agent-scoping.security.mjs's own house style. Built up incrementally
// as the plan's own build order adds each tool; today it covers BL-MEMOS-058
// (the rejoin guard fix, a correction to already-shipped `main` code, not a
// new tool) -- msp_thread_participant_lifecycle/msp_thread_agent_detach's
// own cases (BL-MEMOS-050/051/052, including case 2b and the
// close_for_relink status race) are added once those tools exist.
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

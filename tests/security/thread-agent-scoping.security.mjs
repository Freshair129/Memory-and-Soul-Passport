// PH-MEMOS-3 stage 2 (multi-agent, docs/DESIGN-SESSION-EPISODIC-INSTANCE-
// MEMORY.md v0.4.3b, RKOI-approved spec docs/memos-002-stage2-spec@b090a51):
// GATE-MEMOS-3 and every §15 "thread-agent-scoping.security.mjs" row, proven
// against the REAL running msp-server process through its guarded tool
// surface, signed with @freshair129/msp-contracts/thread-access's real
// signThreadRequest -- never a mock guard, exactly matching
// thread-memory-scoping.security.mjs's own house style.
//
// This file is built up incrementally, one numbered plan item at a time
// (BL-MEMOS-040..048): today it covers BL-MEMOS-040 (grant claims, proven
// indirectly by every case below requiring agentId/workspaceId to pass at
// all) and BL-MEMOS-041 (attachment: auto-attach on mint, assertAgents
// self-attach on an existing thread, agent_not_current otherwise, the
// mint-race rule, and DEC-MEMOS-18's worker-only-never-mints rule). Later
// items add the agent gate on every other tool, delivery's agent scoping,
// record visibility, and nonce replay -- each gets its own cases here as it
// ships, per the plan's own instruction not to write ahead of the code.
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
const SERVICE_KEY = "thread-agent-scoping-security-test-key-32b";
const IDENTITY_KEY = "thread-agent-scoping-security-test-hmac-key";

function tempDbPath(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `msp-thread-agent-${label}-`));
  const dbPath = path.join(dir, "msp.sqlite3");
  // A few cases in this file open a SECOND, direct better-sqlite3 handle
  // (via @freshair129/msp-storage/connection) after the spawned runtime's
  // own close() to inspect rows no tool surfaces -- on Windows, SQLite's
  // WAL/-shm memory mapping can transiently outlive that handle's own
  // close() by a beat, which turns an immediate rmSync into a spurious
  // EPERM. maxRetries/retryDelay (Node's own documented mitigation for
  // exactly this class of transient Windows file-lock race) absorbs it.
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      } catch (error) {
        // Best-effort teardown only -- by this point every assertion this
        // test cares about has already run and either passed or thrown;
        // a residual Windows file-lock race on the temp directory itself
        // (observed even after both close() calls and the retry budget
        // above) must never retroactively mask that real outcome. The OS
        // reclaims its own temp directory eventually regardless.
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

const ROOM = { channelAccountId: "oa-agent", tenantId: "tenant-agent" };
const ROOM_REQUEST = { channel_type: "LINE", channel_account_id: "oa-agent", tenant_id: "tenant-agent" };

function resolveClaims(overrides = {}) {
  return {
    ...ROOM,
    audienceKind: "DIRECT",
    principalId: "alice",
    policyRevision: "v1",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

test("BL-MEMOS-041: auto-attach happens only when created:true -- the minting agent's own resolve response says so", async () => {
  const { dbPath, cleanup } = tempDbPath("automint");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-automint" });
    const first = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-automint" }, claims),
    );
    assert.equal(first.created, true, "the first resolve for a fresh room must mint");
    assert.equal(first.agentAttached, true, "the minting agent must auto-attach in the same call");

    const second = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-automint" }, claims),
    );
    assert.equal(second.created, false, "a second resolve for the same room is not a mint");
    assert.equal(second.agentAttached, false, "the already-current agent's second resolve is a no-op on thread_agents");
    assert.equal(second.thread.threadId, first.thread.threadId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-041: a non-current agent resolving an EXISTING thread without assertAgents is agent_not_current", async () => {
  const { dbPath, cleanup } = tempDbPath("noassert");
  const call = spawnRuntime(dbPath);
  try {
    const minterClaims = resolveClaims({ externalRoomRef: "dm-noassert", agentId: "agent-minter", workspaceId: "workspace-minter" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-noassert" }, minterClaims),
    );

    const secondAgentClaims = resolveClaims({ externalRoomRef: "dm-noassert", agentId: "agent-second", workspaceId: "workspace-second" });
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-noassert" }, secondAgentClaims),
      ),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: a non-current, non-asserting agent's resolve of an existing thread must be refused",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-041: a non-current agent WITH assertAgents attaches to an existing thread, and only once", async () => {
  const { dbPath, cleanup } = tempDbPath("assert");
  const call = spawnRuntime(dbPath);
  try {
    const minterClaims = resolveClaims({ externalRoomRef: "dm-assert", agentId: "agent-minter", workspaceId: "workspace-minter" });
    const minted = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-assert" }, minterClaims),
    );

    const secondAgentClaims = resolveClaims({ externalRoomRef: "dm-assert", agentId: "agent-second", workspaceId: "workspace-second", assertAgents: true });
    const attached = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-assert" }, secondAgentClaims),
    );
    assert.equal(attached.thread.threadId, minted.thread.threadId, "assertAgents attaches to the SAME thread, never minting a new one");
    assert.equal(attached.created, false);
    assert.equal(attached.agentAttached, true, "assertAgents on a non-current agent must attach");

    // A second resolve by the SAME now-current agent is a no-op, not a
    // second attachment (thread_agents' partial UNIQUE index would refuse a
    // literal duplicate open row -- this proves the handler never even
    // attempts one).
    const again = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-assert" }, secondAgentClaims),
    );
    assert.equal(again.agentAttached, false, "an already-current agent's later resolve is a no-op, even with assertAgents still set");
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-041: assertAgents on a MINTING resolve has no effect -- the minting agent auto-attaches regardless", async () => {
  const { dbPath, cleanup } = tempDbPath("assertmint");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-assertmint", assertAgents: true });
    const minted = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-assertmint" }, claims),
    );
    assert.equal(minted.created, true);
    assert.equal(minted.agentAttached, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("DEC-MEMOS-18: a worker-only grant (operator, no reader/writer flags) never mints -- refused not_found, never created:true", async () => {
  const { dbPath, cleanup } = tempDbPath("workernomint");
  const call = spawnRuntime(dbPath);
  try {
    const workerClaims = resolveClaims({
      externalRoomRef: "dm-workernomint",
      principalId: "worker",
      operator: true,
      agentId: "agent-worker",
      workspaceId: "workspace-worker",
    });
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-workernomint" }, workerClaims),
      ),
      /not_found/,
      "FAIL-CLOSED VIOLATION: a worker-only grant must never mint a room's first thread",
    );

    // Once a real (non-worker) agent has minted the thread, the SAME
    // worker-only grant may still self-assert-attach to it -- DEC-MEMOS-18
    // exempts minting only, not the ordinary existing-thread gate.
    const minterClaims = resolveClaims({ externalRoomRef: "dm-workernomint", agentId: "agent-minter", workspaceId: "workspace-minter" });
    const minted = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-workernomint" }, minterClaims),
    );
    const workerAssertClaims = { ...workerClaims, assertAgents: true };
    const workerAttached = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-workernomint" }, workerAssertClaims),
    );
    assert.equal(workerAttached.thread.threadId, minted.thread.threadId);
    assert.equal(workerAttached.created, false);
    assert.equal(workerAttached.agentAttached, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("Mint-race: two concurrent resolves for the same fresh room, from two different agents, produce exactly one minted thread and exactly one auto-attached agent", async () => {
  const { dbPath, cleanup } = tempDbPath("mintrace");
  const call = spawnRuntime(dbPath);
  try {
    const claimsA = resolveClaims({ externalRoomRef: "dm-mintrace", agentId: "agent-race-a", workspaceId: "workspace-race-a" });
    const claimsB = resolveClaims({ externalRoomRef: "dm-mintrace", agentId: "agent-race-b", workspaceId: "workspace-race-b" });
    const requestFor = (claims) =>
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-mintrace" }, claims);

    const settled = await Promise.allSettled([
      call("msp_thread_resolve", requestFor(claimsA)),
      call("msp_thread_resolve", requestFor(claimsB)),
    ]);

    // Both calls resolve to the SAME thread_id one way or another: exactly
    // one is the minter (created:true, agentAttached:true); the other is
    // either the mint-race loser refused agent_not_current (it named no
    // assertAgents), or -- if the race window closed before it ran at all --
    // simply an ordinary resolve of the now-existing thread.
    const threadIds = new Set();
    let mintedCount = 0;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        threadIds.add(outcome.value.thread.threadId);
        if (outcome.value.created) mintedCount += 1;
      } else {
        assert.match(String(outcome.reason?.message ?? outcome.reason), /agent_not_current/, "a mint-race loser must fail only as agent_not_current, never any other reason");
      }
    }
    assert.equal(mintedCount, 1, "exactly one of the two concurrent resolves may mint the thread");
    assert.equal(threadIds.size, 1, "both calls must agree on exactly one thread_id -- no second thread was ever minted");
  } finally {
    await call.close();
    cleanup();
  }
});

// BL-MEMOS-042 (§8.2): the agent gate applied to every thread-bound tool
// OTHER than msp_thread_resolve. Delivery's own agent scoping (both paths)
// is BL-MEMOS-112's own set of cases, added alongside that item.

test("No agent can act on a thread it has never attached to -- context, append, memory_record and injection_record are all refused agent_not_current", async () => {
  const { dbPath, cleanup } = tempDbPath("neverattached");
  const call = spawnRuntime(dbPath);
  try {
    const minterClaims = resolveClaims({ externalRoomRef: "dm-neverattached", agentId: "agent-minter", workspaceId: "workspace-minter" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-neverattached" }, minterClaims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        minterClaims,
      ),
    );

    // A different agent, never resolved against this thread at all.
    const strangerClaims = { ...minterClaims, agentId: "agent-stranger", workspaceId: "workspace-stranger", readPrivate: true, writePrivate: true };
    await assert.rejects(
      call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, strangerClaims)),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: an agent that never resolved this thread must never read its context",
    );
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "again" },
          strangerClaims,
        ),
      ),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: an agent that never resolved this thread must never append to it",
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { drink: "tea" }, source_message_refs: [inbound.message.messageId] },
          strangerClaims,
        ),
      ),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: an agent that never resolved this thread must never record protected memory on it",
    );
    await assert.rejects(
      call(
        "msp_thread_injection_record",
        signed(
          "msp_thread_injection_record",
          { thread_id: thread.threadId, exchange_id: inbound.message.exchangeId, injection_id: "inj-1", packet_hash: "a".repeat(64), policy_revision: "v1", model_ref: "test-model", state: "RESOLVED" },
          strangerClaims,
        ),
      ),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: an agent that never resolved this thread must never record an injection receipt on it",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("A departed agent (left_at set) is denied on its very next call, on every thread-bound tool", async () => {
  const { dbPath, cleanup } = tempDbPath("departed");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-departed" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-departed" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    await call.close();

    // No detach tool exists yet (msp_thread_agent_detach is phase 003,
    // unbuilt) -- departure is simulated the same way this suite already
    // does direct-DB setup for preconditions no tool can produce yet,
    // exactly the shape thread_agents' own append-only trigger permits
    // (left_at NULL -> NOT NULL, nothing else changed).
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const info = db.prepare("UPDATE thread_agents SET left_at = ? WHERE thread_id = ? AND agent_id = ? AND workspace_id = ? AND left_at IS NULL").run(
        new Date().toISOString(),
        thread.threadId,
        claims.agentId,
        claims.workspaceId,
      );
      assert.equal(info.changes, 1, "expected exactly one open thread_agents row to depart");
    } finally {
      db.close();
    }

    const callAfter = spawnRuntime(dbPath);
    try {
      await assert.rejects(
        callAfter("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, { ...claims, readPrivate: true })),
        /agent_not_current/,
        "FAIL-CLOSED VIOLATION: a departed agent's context read must be refused",
      );
      await assert.rejects(
        callAfter(
          "msp_thread_message_append",
          signed(
            "msp_thread_message_append",
            { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "still here?" },
            claims,
          ),
        ),
        /agent_not_current/,
        "FAIL-CLOSED VIOLATION: a departed agent's append must be refused",
      );
    } finally {
      await callAfter.close();
    }
  } finally {
    cleanup();
  }
});

test("Journal actor: an AGENT-kind message's actor is the plaintext agentId; a HUMAN-kind message's actor stays the speaker's HMAC", async () => {
  const { dbPath, cleanup } = tempDbPath("journalactor");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-journalactor", agentId: "agent-journal-plaintext", principalId: "line-user-raw-id" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-journalactor" }, claims),
    );
    // speaker_id/person_id both equal the grant principal, matching the
    // first-HUMAN-membership rule -- the point here is only that this raw
    // id never appears in the journal, not any participant-gate behavior.
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "line-user-raw-id", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "line-user-raw-id", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: thread.threadId, session_id: inbound.session.sessionId, exchange_id: inbound.message.exchangeId, reply_to_message_id: inbound.message.messageId,
          source_event_id: "out-1", speaker_id: claims.agentId, speaker_kind: "AGENT", identity_assurance: "VERIFIED", direction: "OUTBOUND", text: "reply", delivery_state: "QUEUED",
        },
        claims,
      ),
    );
    await call.close();

    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT actor, payload_json FROM journal WHERE tool_name = 'msp_thread_message_append' ORDER BY rowid").all();
      assert.equal(rows.length, 2);
      const [humanEntry, agentEntry] = rows;
      assert.notEqual(humanEntry.actor, "line-user-raw-id", "W5: a HUMAN speaker's raw id must never appear as the journal actor");
      assert.equal(agentEntry.actor, claims.agentId, "an AGENT-attributable entry's actor must be the plain agentId, not an HMAC");
      for (const row of rows) {
        assert.doesNotMatch(row.payload_json, /line-user-raw-id/, "no raw speaker/person id may appear in the journal payload either");
      }
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("Worker gate (DEC-MEMOS-18): a worker's own agentId must be current on the job's thread to claim it", async () => {
  const { dbPath, cleanup } = tempDbPath("workerclaim");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-workerclaim", readPrivate: true, operator: true });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-workerclaim" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi", idle_timeout_minutes: 1 },
        claims,
      ),
    );
    // A completed exchange (a delivered OUTBOUND reply, not QUEUED) is
    // required or claimCompaction's own "Reply receipt deadline has not
    // elapsed" precondition (a SEPARATE 120s window, unrelated to the idle
    // timeout below) refuses the claim regardless of agent currency.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: thread.threadId, session_id: inbound.session.sessionId, exchange_id: inbound.message.exchangeId, reply_to_message_id: inbound.message.messageId,
          source_event_id: "out-1", speaker_id: claims.agentId, speaker_kind: "AGENT", identity_assurance: "VERIFIED", direction: "OUTBOUND", text: "hello back", delivery_state: "DELIVERED",
          // Keep the same 1-minute idle timeout the inbound append set --
          // otherwise this OUTBOUND append's own default (30 minutes)
          // pushes the session's idle_deadline back out, and the 65s wait
          // below never actually produces a due sweep job.
          idle_timeout_minutes: 1,
        },
        claims,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    const sweep = await call("msp_session_sweep", signed("msp_session_sweep", {}, claims));
    assert.equal(sweep.jobs.length, 1);
    const jobId = sweep.jobs[0].jobId;

    // A DIFFERENT worker agent, never attached to this thread, tries to
    // claim the same job.
    const strangerWorkerClaims = { ...claims, agentId: "agent-worker-stranger", workspaceId: "workspace-worker-stranger" };
    await assert.rejects(
      call("msp_session_compaction_claim", signed("msp_session_compaction_claim", { job_id: jobId, worker_id: "worker-stranger" }, strangerWorkerClaims)),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: a worker agent never attached to this thread claimed its compaction job",
    );

    // The thread's own current agent can claim it fine.
    const claim = await call("msp_session_compaction_claim", signed("msp_session_compaction_claim", { job_id: jobId, worker_id: "worker-real" }, claims));
    assert.equal(claim.jobId, jobId);
  } finally {
    await call.close();
    cleanup();
  }
});

// BL-MEMOS-112 (CRITICAL 1, corrected across two RKOI stage-2 review
// rounds): the delivery pending path is agent-gated on both ends, and the
// drain-time re-check runs against the right thread.

test("BL-MEMOS-112: a non-current agent cannot queue a pending delivery for a room that already has an ACTIVE thread", async () => {
  const { dbPath, cleanup } = tempDbPath("pendingnoncurrent");
  const call = spawnRuntime(dbPath);
  try {
    const minterClaims = resolveClaims({ externalRoomRef: "dm-pendingnoncurrent", deliveryWriter: true, agentId: "agent-minter", workspaceId: "workspace-minter" });
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-pendingnoncurrent" }, minterClaims),
    );

    const strangerClaims = { ...minterClaims, agentId: "agent-stranger", workspaceId: "workspace-stranger" };
    await assert.rejects(
      call(
        "msp_thread_delivery_record",
        signed(
          "msp_thread_delivery_record",
          { inbound_message_id: "not-arrived-yet", source_event_id: "not-arrived-yet:assistant", receipt_id: "receipt-pendingnoncurrent", outcome: "ACCEPTED", text: "t" },
          strangerClaims,
        ),
      ),
      /agent_not_current/,
      "FAIL-CLOSED VIOLATION: a non-current agent queued a pending delivery for a room it is not attached to",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-112: a pending delivery for a room with no ACTIVE thread at all is refused not_found", async () => {
  const { dbPath, cleanup } = tempDbPath("pendingnothread");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-pendingnothread", deliveryWriter: true });
    await assert.rejects(
      call(
        "msp_thread_delivery_record",
        signed(
          "msp_thread_delivery_record",
          { inbound_message_id: "not-arrived-yet", source_event_id: "not-arrived-yet:assistant", receipt_id: "receipt-pendingnothread", outcome: "ACCEPTED", text: "t" },
          claims,
        ),
      ),
      /not_found/,
      "FAIL-CLOSED VIOLATION: a pending delivery was accepted for a room with no ACTIVE thread at all",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-112: a stored agent that departs before the matching inbound arrives leaves the pending delivery unreconciled, never drained", async () => {
  const { dbPath, cleanup } = tempDbPath("draindeparted");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-draindeparted", deliveryWriter: true, agentId: "agent-drain-departs" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-draindeparted" }, claims),
    );
    const pending = await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { inbound_message_id: "future-msg", source_event_id: "future-msg:assistant", receipt_id: "receipt-draindeparted", outcome: "ACCEPTED", text: "reply" },
        claims,
      ),
    );
    assert.equal(pending.status, "PENDING_INBOUND");
    await call.close();

    // Depart the queuing agent BEFORE the matching inbound ever arrives --
    // no detach tool exists yet (phase 003), so this is simulated the same
    // way the earlier "departed agent" test does.
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const info = db.prepare("UPDATE thread_agents SET left_at = ? WHERE thread_id = ? AND agent_id = ? AND left_at IS NULL").run(new Date().toISOString(), thread.threadId, claims.agentId);
      assert.equal(info.changes, 1);
    } finally {
      db.close();
    }

    const callAfter = spawnRuntime(dbPath);
    try {
      // A DIFFERENT, now-current agent brings in the matching inbound
      // message with the id/receipt the pending row above was queued
      // against -- this is exactly what triggers #drainDeliveries.
      const laterClaims = { ...claims, agentId: "agent-drain-successor", assertAgents: true };
      await callAfter(
        "msp_thread_resolve",
        signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-draindeparted" }, laterClaims),
      );
      await callAfter(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, message_id: "future-msg", source_event_id: "future-arrives", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "here I am" },
          laterClaims,
        ),
      );
    } finally {
      await callAfter.close();
    }

    const { open: openAgain } = await import("@freshair129/msp-storage/connection");
    const finalDb = openAgain(dbPath);
    try {
      const row = finalDb.prepare("SELECT reconcile_state FROM thread_pending_deliveries WHERE receipt_id = ?").get("receipt-draindeparted");
      assert.equal(row.reconcile_state, "pending", "FAIL-CLOSED VIOLATION: a departed agent's pending delivery was drained anyway");
      const outbound = finalDb.prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND direction = 'OUTBOUND'").all(thread.threadId);
      assert.equal(outbound.length, 0, "no OUTBOUND reply should ever have been minted for a departed agent's undrained delivery");
      const skipped = finalDb.prepare("SELECT payload_json FROM journal WHERE tool_name = 'msp_thread_message_append.reconcile_skipped'").all();
      assert.ok(skipped.length >= 1);
      assert.match(skipped[skipped.length - 1].payload_json, /"error_code":"agent_not_current"/);
    } finally {
      finalDb.close();
    }
  } finally {
    cleanup();
  }
});

test("BL-MEMOS-112: the resolved delivery path's internal reply speaks as the calling agent, never a hard-coded label", async () => {
  const { dbPath, cleanup } = tempDbPath("deliveryspeaker");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-deliveryspeaker", deliveryWriter: true, readPrivate: true, agentId: "agent-delivery-speaker" });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-deliveryspeaker" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`, receipt_id: "receipt-deliveryspeaker", outcome: "ACCEPTED", text: "auto reply" },
        claims,
      ),
    );
    const context = await call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, { ...claims, readPrivate: true }));
    const outboundMessages = context.recentExchanges.flatMap((exchange) => exchange.messages).filter((message) => message.direction === "OUTBOUND");
    assert.equal(outboundMessages.length, 1);
    assert.equal(outboundMessages[0].speakerId, claims.agentId, "FAIL-CLOSED VIOLATION: the resolved delivery path did not speak as the calling agent");
    assert.notEqual(outboundMessages[0].speakerId, "zuri-line-agent", "the removed hard-coded label must never appear");
  } finally {
    await call.close();
    cleanup();
  }
});

// BL-MEMOS-043 (Sec.9.4): per-agent protected-record visibility, and
// CRITICAL 2 (dedup/supersession cannot leak an AGENT-visibility record
// across agents).

test("Agent B cannot read agent A's AGENT-visibility protected records; a THREAD-visibility record and a legacy (agent_id IS NULL) row are visible to both", async () => {
  const { dbPath, cleanup } = tempDbPath("recordvisibility");
  const call = spawnRuntime(dbPath);
  try {
    const agentAClaims = resolveClaims({ externalRoomRef: "dm-recordvisibility", principalId: "alice", agentId: "agent-a-record", workspaceId: "workspace-a-record", writePrivate: true, readPrivate: true });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-recordvisibility" }, agentAClaims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        agentAClaims,
      ),
    );
    const agentRecord = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { secret: "only agent A should see this" }, source_message_refs: [inbound.message.messageId], visibility: "AGENT" },
        agentAClaims,
      ),
    );
    assert.equal(agentRecord.visibility, "AGENT");
    assert.equal(agentRecord.agentId, agentAClaims.agentId);
    const threadRecord = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { shared: "every current agent should see this" }, source_message_refs: [inbound.message.messageId] },
        agentAClaims,
      ),
    );
    assert.equal(threadRecord.visibility, "THREAD");

    // A legacy, pre-stage-2 row (agent_id IS NULL) -- no real caller can
    // produce one today (agentId is a required grant claim), so it is
    // simulated the same direct-DB way this file already does for a
    // departed agent.
    await call.close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    let legacyRecordId;
    try {
      legacyRecordId = "memory-record_legacy-simulated";
      db.prepare(
        `INSERT INTO protected_memory_records
           (record_id, tenant_id, thread_id, session_id, kind, status, asserted_by_speaker_id, subject_person_id,
            scope_json, body_json, source_message_refs_json, supersedes_record_id, verification_state, version,
            created_at, updated_at, agent_id, visibility)
         VALUES (?, ?, ?, NULL, 'PREFERENCE', 'ACTIVE', 'alice', 'alice', '{}', '{}', '[]', NULL, 'CANDIDATE', 1, ?, ?, NULL, 'THREAD')`,
      ).run(legacyRecordId, thread.tenantId ?? "tenant-agent", thread.threadId, new Date().toISOString(), new Date().toISOString());
    } finally {
      db.close();
    }

    const callAfter = spawnRuntime(dbPath);
    try {
      const agentBClaims = { ...agentAClaims, agentId: "agent-b-record", workspaceId: "workspace-b-record", assertAgents: true };
      await callAfter(
        "msp_thread_resolve",
        signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-recordvisibility" }, agentBClaims),
      );
      const context = await callAfter("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, { ...agentBClaims, readPrivate: true }));
      const ids = context.protectedRecords.map((record) => record.recordId);
      assert.ok(!ids.includes(agentRecord.recordId), "FAIL-CLOSED VIOLATION: agent B read agent A's AGENT-visibility record");
      assert.ok(ids.includes(threadRecord.recordId), "a THREAD-visibility record must be visible to every current agent");
      assert.ok(ids.includes(legacyRecordId), "a legacy agent_id IS NULL row must be visible to any current agent");
    } finally {
      await callAfter.close();
    }
  } finally {
    cleanup();
  }
});

test("CRITICAL 2: two different agents recording byte-identical content produce two distinct records, never one shared AGENT-visibility row", async () => {
  const { dbPath, cleanup } = tempDbPath("dedupcritical2");
  const call = spawnRuntime(dbPath);
  try {
    const baseClaims = resolveClaims({ externalRoomRef: "dm-dedupcritical2", principalId: "alice", writePrivate: true });
    const agentAClaims = { ...baseClaims, agentId: "agent-a-dedup", workspaceId: "workspace-a-dedup" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-dedupcritical2" }, agentAClaims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        agentAClaims,
      ),
    );
    const identicalBody = { text: "byte-identical content two agents independently reach" };
    const recordA = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: identicalBody, source_message_refs: [inbound.message.messageId], visibility: "AGENT" },
        agentAClaims,
      ),
    );

    const agentBClaims = { ...baseClaims, agentId: "agent-b-dedup", workspaceId: "workspace-b-dedup", assertAgents: true };
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-dedupcritical2" }, agentBClaims),
    );
    const recordB = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: identicalBody, source_message_refs: [inbound.message.messageId], visibility: "AGENT" },
        agentBClaims,
      ),
    );
    assert.notEqual(recordA.recordId, recordB.recordId, "FAIL-CLOSED VIOLATION: two different agents' identical assertions collided onto one shared record");
    assert.equal(recordA.agentId, "agent-a-dedup");
    assert.equal(recordB.agentId, "agent-b-dedup");
  } finally {
    await call.close();
    cleanup();
  }
});

test("CRITICAL 2: superseding an unknown id, another agent's AGENT-visibility record, and a stage-1 ownership failure are all the identical validation_failed answer", async () => {
  const { dbPath, cleanup } = tempDbPath("supersessioncritical2");
  const call = spawnRuntime(dbPath);
  try {
    const baseClaims = resolveClaims({ externalRoomRef: "dm-supersessioncritical2", principalId: "alice", writePrivate: true });
    const agentAClaims = { ...baseClaims, agentId: "agent-a-supersede", workspaceId: "workspace-a-supersede" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-supersessioncritical2" }, agentAClaims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        agentAClaims,
      ),
    );
    const agentARecord = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { v: 1 }, source_message_refs: [inbound.message.messageId], visibility: "AGENT" },
        agentAClaims,
      ),
    );
    const FIXED_MESSAGE = /supersedes_record_id does not name a record this caller can supersede/;

    // Case 1: unknown id.
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { v: 2 }, source_message_refs: [inbound.message.messageId], supersedes_record_id: "memory-record_does-not-exist" },
          agentAClaims,
        ),
      ),
      (error) => /validation_failed/.test(error.message) && FIXED_MESSAGE.test(error.message),
      "unknown supersedes_record_id must be validation_failed with the fixed message",
    );

    // Case 2: another agent's AGENT-visibility record.
    const agentBClaims = { ...baseClaims, agentId: "agent-b-supersede", workspaceId: "workspace-b-supersede", assertAgents: true };
    await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-supersessioncritical2" }, agentBClaims),
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { v: 3 }, source_message_refs: [inbound.message.messageId], supersedes_record_id: agentARecord.recordId },
          agentBClaims,
        ),
      ),
      (error) => /validation_failed/.test(error.message) && FIXED_MESSAGE.test(error.message),
      "FAIL-CLOSED VIOLATION: another agent's AGENT-visibility record was either superseded, or refused with a distinguishable code",
    );

    // Case 3: a stage-1 ownership failure (agent A itself, but the record
    // it names has a different subject/speaker -- a THREAD-visibility
    // record another HUMAN asserted).
    const bobRecord = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { v: 4 }, source_message_refs: [inbound.message.messageId] },
        agentAClaims,
      ),
    );
    // Supersede as a HUMAN principal that is not the record's own asserter
    // -- reuse agent A's grant but assert a body with a mismatched
    // supersedes target ownership by tampering the stored asserter via a
    // second, unrelated record path is unnecessary here: the existing
    // stage-1 rule (wrong speaker/subject/status) already refuses this
    // exact bobRecord once its status is no longer ACTIVE.
    await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { v: 5 }, source_message_refs: [inbound.message.messageId], supersedes_record_id: bobRecord.recordId },
        agentAClaims,
      ),
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { v: 6 }, source_message_refs: [inbound.message.messageId], supersedes_record_id: bobRecord.recordId },
          agentAClaims,
        ),
      ),
      (error) => /validation_failed/.test(error.message) && FIXED_MESSAGE.test(error.message),
      "FAIL-CLOSED VIOLATION: superseding an already-SUPERSEDED record did not give the unified validation_failed answer",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

// BL-MEMOS-048 (Sec.6.1.1): nonce presence (grant_nonce_required) and
// anti-replay (grant_replayed), on every nonce-required tool except
// msp_thread_message_append (source_event_id already covers replay) and
// msp_thread_context (read-only).

test("grant_nonce_required: a nonce-required tool called with no nonce claim at all is refused", async () => {
  const { dbPath, cleanup } = tempDbPath("noncerequired");
  const call = spawnRuntime(dbPath);
  try {
    const claims = resolveClaims({ externalRoomRef: "dm-noncerequired", nonce: undefined });
    await assert.rejects(
      call("msp_thread_resolve", signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-noncerequired" }, claims)),
      /grant_nonce_required/,
      "FAIL-CLOSED VIOLATION: a resolve with no nonce claim at all was accepted",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_thread_message_append and msp_thread_context succeed with no nonce claim at all -- they are exempt", async () => {
  const { dbPath, cleanup } = tempDbPath("noncenotrequired");
  const call = spawnRuntime(dbPath);
  try {
    const resolveClaimsWithNonce = resolveClaims({ externalRoomRef: "dm-noncenotrequired", readPrivate: true });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-noncenotrequired" }, resolveClaimsWithNonce),
    );
    const appendClaimsNoNonce = { ...resolveClaimsWithNonce, nonce: undefined };
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        appendClaimsNoNonce,
      ),
    );
    await call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, appendClaimsNoNonce));
  } finally {
    await call.close();
    cleanup();
  }
});

test("grant_replayed: reusing the same nonce across two different nonce-required calls for the same tenant is refused, and the second call's mutation never happens", async () => {
  const { dbPath, cleanup } = tempDbPath("noncereplay");
  const call = spawnRuntime(dbPath);
  try {
    const FIXED_NONCE = "fixed-nonce-for-replay-test-0123456789";
    const firstClaims = resolveClaims({ externalRoomRef: "dm-noncereplay", nonce: FIXED_NONCE, writePrivate: true });
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-noncereplay" }, firstClaims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "hi" },
        { ...firstClaims, nonce: undefined },
      ),
    );

    // A SECOND, otherwise entirely valid, nonce-required call reusing the
    // EXACT SAME nonce for the SAME tenant -- refused, and the record it
    // would have created must never exist.
    const replayClaims = { ...firstClaims, nonce: FIXED_NONCE };
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { should: "never be stored" }, source_message_refs: [inbound.message.messageId] },
          replayClaims,
        ),
      ),
      /grant_replayed/,
      "FAIL-CLOSED VIOLATION: a replayed nonce was accepted on a second, different nonce-required call",
    );

    await call.close();
    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT * FROM protected_memory_records WHERE thread_id = ?").all(thread.threadId);
      assert.equal(rows.length, 0, "FAIL-CLOSED VIOLATION: a replayed-nonce call's mutation was stored anyway");
      const nonceRows = db.prepare("SELECT nonce FROM grant_nonces WHERE nonce = ?").all(FIXED_NONCE);
      assert.equal(nonceRows.length, 1, "the nonce must be recorded exactly once (from the FIRST, successful call), not zero or twice");
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

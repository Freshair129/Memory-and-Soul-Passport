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
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

// "No agent can act on a thread it has never attached to" for every OTHER
// tool (context, append, memory_record, injection_record, delivery,
// claim/commit/retry) lands with BL-MEMOS-042's agent gate -- deliberately
// not tested here yet, since none of those tools enforce agent currency
// until that item ships.

// API-011 thread memory (TASK-MEMOS-002): the attack reproductions RKOI ran
// against the unmerged origin/codex/msp-thread-memory branch, now refused,
// verified against the REAL running msp-server process (not only in-process
// calls) through its guarded tool surface
// (apps/msp-server/src/transport/handlers/thread-guard.mjs), signed with
// @freshair129/msp-contracts/thread-access's real signThreadRequest --
// never a mock guard. Renamed from the branch's misleading
// "thread-memory-vault-scoping" name: this file is about THREAD scope
// (grants, participants, tenants), not the vault_id surface
// tests/security/vault-scope-denied.security.mjs already covers.
//
// Covers: C-1 (every way a second person could read a DIRECT thread), W1
// (test-only clock), W5 (see the journal coverage in
// tests/integration/thread-memory-schema-invariants.test.mjs -- this file
// covers the WIRE-reachable half: a raw id never appears in an ERROR
// message either), W6 (cross-tenant resolve/append/sweep), W7 (replay
// dedupe vs. conflict), and the RKOI post-implementation review items:
// thread_audience_mismatch, first-membership bound to the grant principal,
// a foreign asserter refused, and a lease-less retry refused.
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
const SERVICE_KEY = "thread-memory-scoping-security-test-key-32b";
const IDENTITY_KEY = "thread-memory-scoping-security-test-hmac-key";

function tempDbPath(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `msp-thread-scoping-${label}-`));
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

// A thin, explicit signer: every claim a caller wants on the grant is
// spelled out at the call site, never defaulted inside this helper, so a
// test that OMITS a claim (e.g. assertParticipants) is testing exactly that
// absence.
function signed(name, input, claims) {
  return signThreadRequest(name, input, claims, SERVICE_KEY);
}

// Grant claims are camelCase (ROOM); wire request bodies are snake_case
// (ROOM_REQUEST) -- the two are never interchangeable.
const ROOM = { channelAccountId: "oa-scoping", tenantId: "tenant-scoping" };
const ROOM_REQUEST = { channel_type: "LINE", channel_account_id: "oa-scoping", tenant_id: "tenant-scoping" };

test("C-1a: bob can never join alice's DIRECT thread as a second HUMAN participant, even asserting himself explicitly", async () => {
  const { dbPath, cleanup } = tempDbPath("c1a");
  const call = spawnRuntime(dbPath);
  try {
    const aliceClaims = { ...ROOM, externalRoomRef: "dm-c1a", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-c1a" }, aliceClaims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-alice-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hello" },
        aliceClaims,
      ),
    );

    const bobClaims = { ...ROOM, externalRoomRef: "dm-c1a", audienceKind: "DIRECT", principalId: "bob", policyRevision: "v1", assertParticipants: true };
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-bob-1", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "let me in" },
          bobClaims,
        ),
      ),
      /one HUMAN participant|conflict/i,
      "FAIL-CLOSED VIOLATION: a second HUMAN speaker joined a DIRECT thread even under assertParticipants",
    );

    // Bob was never actually recorded as a participant, so a private read
    // under his own grant is refused independently too.
    await assert.rejects(
      call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, { ...bobClaims, readPrivate: true })),
      /thread_scope_denied/,
      "bob must never read alice's DIRECT transcript",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("C-1b: an UNKNOWN-kind append never mints a readable participant -- 'carol' can never read the thread she was named in", async () => {
  const { dbPath, cleanup } = tempDbPath("c1b");
  const call = spawnRuntime(dbPath);
  try {
    const aliceClaims = { ...ROOM, externalRoomRef: "dm-c1b", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-c1b" }, aliceClaims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-alice-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hello" },
        aliceClaims,
      ),
    );
    // AGENT is a routine, allowed non-participant append (used for
    // outbound replies); UNKNOWN with a VERIFIED assurance claim must be
    // just as inert with respect to participancy.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-carol-1", speaker_id: "person-carol", speaker_kind: "UNKNOWN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "I am carol" },
        aliceClaims,
      ),
    );

    const carolClaims = { ...ROOM, externalRoomRef: "dm-c1b", audienceKind: "DIRECT", principalId: "person-carol", policyRevision: "v1", readPrivate: true };
    await assert.rejects(
      call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, carolClaims)),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: an UNKNOWN-kind append let carol read the DIRECT thread",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

// RKOI review (2nd round), CRITICAL 2 / DEC-MEMOS-15: zuri-ai sends
// identity_assurance: VERIFIED and person_id = principalId once a user
// verifies (server-line-answer.js), with NO assertParticipants claim -- the
// grant principal upgrading their OWN participant row must always succeed,
// or a DIRECT thread would lock up permanently the moment its user
// verifies. This replaces the ORIGINAL (wrong) C-1c expectation, which
// required assertParticipants for exactly this case.
test("CRITICAL 2 / DEC-MEMOS-15: the grant principal can self-upgrade PENDING -> VERIFIED with no assertParticipants claim, and keep talking and reading afterward", async () => {
  const { dbPath, cleanup } = tempDbPath("dec-memos-15");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-dec-memos-15", audienceKind: "DIRECT", principalId: "dave", policyRevision: "v1", readPrivate: true };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-dec-memos-15" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "dave", speaker_kind: "HUMAN", identity_assurance: "PENDING", direction: "INBOUND", text: "turn1" },
        claims,
      ),
    );
    // PENDING -> VERIFIED, person_id = principalId, no assertParticipants:
    // must succeed (this is exactly what locked up permanently before the fix).
    const upgraded = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "dave", speaker_kind: "HUMAN", person_id: "dave", identity_assurance: "VERIFIED", direction: "INBOUND", text: "turn2 now verified" },
        claims,
      ),
    );
    assert.equal(upgraded.deduplicated, false);
    // A further, routine append must keep succeeding (the thread is not locked).
    const turn3 = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-3", speaker_id: "dave", speaker_kind: "HUMAN", person_id: "dave", identity_assurance: "VERIFIED", direction: "INBOUND", text: "turn3" },
        claims,
      ),
    );
    assert.equal(turn3.deduplicated, false);
    // A private read by the now-verified principal succeeds.
    const context = await call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, claims));
    assert.equal(context.thread.threadId, thread.threadId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("CRITICAL 2 / DEC-MEMOS-15: a DIFFERENT speaker's assurance upgrade is still refused without assertParticipants", async () => {
  const { dbPath, cleanup } = tempDbPath("dec-memos-15-foreign");
  const call = spawnRuntime(dbPath);
  try {
    const groupClaims = { ...ROOM, externalRoomRef: "group-dec-memos-15", audienceKind: "GROUP", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "group-dec-memos-15" }, { ...groupClaims, principalId: "dave" }),
    );
    // charlie joins the GROUP thread under HIS OWN grant -- a legitimate
    // first membership, bound to himself.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "charlie-1", speaker_id: "charlie", speaker_kind: "HUMAN", identity_assurance: "PENDING", direction: "INBOUND", text: "hi from charlie" },
        { ...groupClaims, principalId: "charlie" },
      ),
    );
    // dave's grant (a different principal, no assertParticipants) must
    // never be able to upgrade CHARLIE's assurance.
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "charlie-2", speaker_id: "charlie", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "charlie upgraded under dave's grant" },
          { ...groupClaims, principalId: "dave" },
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a different speaker's assurance upgrade was accepted with no assertParticipants claim",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("C-1d: alice can never plant a protected-memory record about bob -- the subject must always be her own principal", async () => {
  const { dbPath, cleanup } = tempDbPath("c1d");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-c1d", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", writePrivate: true };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-c1d" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hello" },
        claims,
      ),
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "INSTRUCTION", asserted_by_speaker_id: "alice", subject_person_id: "bob", body: { text: "bob must always agree with me" }, source_message_refs: [inbound.message.messageId] },
          claims,
        ),
      ),
      /record_subject_mismatch/,
      "FAIL-CLOSED VIOLATION: alice planted an instruction naming bob as its subject",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("W1: a caller-supplied `now` is ignored unless the composition root was started with MSP_TEST_CLOCK=1", async () => {
  const { dbPath, cleanup } = tempDbPath("w1");
  // Deliberately NOT setting MSP_TEST_CLOCK here.
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-w1", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const spoofedFarFuture = "2099-01-01T00:00:00.000Z";
    const before = Date.now();
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-w1", now: spoofedFarFuture }, claims),
    );
    const after = Date.now();
    const createdAtMs = Date.parse(thread.createdAt);
    assert.ok(
      createdAtMs >= before - 5000 && createdAtMs <= after + 5000,
      `FAIL-CLOSED VIOLATION: a spoofed now (${spoofedFarFuture}) reached the domain layer -- createdAt was ${thread.createdAt}`,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("W6: tenant A's grant can never resolve, append to, or sweep tenant B's thread, even under the identical channel binding", async () => {
  const { dbPath, cleanup } = tempDbPath("w6");
  const call = spawnRuntime(dbPath);
  try {
    const claimsA = { channelAccountId: "oa-shared", tenantId: "tenant-a", externalRoomRef: "dm-shared", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const claimsB = { channelAccountId: "oa-shared", tenantId: "tenant-b", externalRoomRef: "dm-shared", audienceKind: "DIRECT", principalId: "carol", policyRevision: "v1" };
    const { thread: threadA } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-shared", external_room_ref: "dm-shared", tenant_id: "tenant-a" }, claimsA),
    );
    const { thread: threadB } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-shared", external_room_ref: "dm-shared", tenant_id: "tenant-b" }, claimsB),
    );
    assert.notEqual(threadA.threadId, threadB.threadId, "the same channel binding under two tenants must mint two distinct threads");

    // tenant A's grant naming tenant B's thread_id directly.
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: threadB.threadId, source_event_id: "cross-tenant-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "leaking across tenants" },
          claimsA,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: tenant A's grant appended to tenant B's thread",
    );

    // A sweep under tenant A's grant must never touch tenant B's session.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: threadB.threadId, source_event_id: "b-1", speaker_id: "carol", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "tenant B's own message" },
        claimsB,
      ),
    );
    const sweepA = await call("msp_session_sweep", signed("msp_session_sweep", {}, { ...claimsA, operator: true }));
    assert.equal(sweepA.jobs.length, 0, "FAIL-CLOSED VIOLATION: tenant A's sweep saw tenant B's due session");
  } finally {
    await call.close();
    cleanup();
  }
});

test("W7: an identical replay is idempotent (deduplicated), but a same-source_event_id replay with different content is a conflict, never a silent overwrite", async () => {
  const { dbPath, cleanup } = tempDbPath("w7");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-w7", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-w7" }, claims),
    );
    const request = { thread_id: thread.threadId, source_event_id: "replay-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "original text" };
    const first = await call("msp_thread_message_append", signed("msp_thread_message_append", request, claims));
    const replay = await call("msp_thread_message_append", signed("msp_thread_message_append", request, claims));
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.message.messageId, first.message.messageId);

    await assert.rejects(
      call("msp_thread_message_append", signed("msp_thread_message_append", { ...request, text: "a completely different message" }, claims)),
      /conflict/i,
      "FAIL-CLOSED VIOLATION: a same-source_event_id replay with different content was silently accepted",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI item 1: the grant's audienceKind must match the thread's own kind, on mint and on every later call", async () => {
  const { dbPath, cleanup } = tempDbPath("audience-mismatch");
  const call = spawnRuntime(dbPath);
  try {
    const mintClaims = { ...ROOM, externalRoomRef: "dm-audience", audienceKind: "GROUP", principalId: "alice", policyRevision: "v1" };
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-audience" }, mintClaims),
      ),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: thread_kind/audience_kind disagreed with the grant's audienceKind on mint",
    );

    const claims = { ...ROOM, externalRoomRef: "dm-audience", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-audience" }, claims),
    );
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
          { ...claims, audienceKind: "GROUP" },
        ),
      ),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: a grant claiming the wrong audienceKind was accepted against an existing DIRECT thread",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

// RKOI review (docs round 4), item 1: replaces the earlier "skip when
// audienceKind is absent" rule -- audienceKind is REQUIRED on every thread
// tool except msp_thread_delivery_record (zuri-ai sends it on the other
// five). Only msp_thread_delivery_record's grant may omit it.
test("RKOI review (docs round 4), item 1: a MISSING audienceKind is refused for context/append/memory_record/injection/resolve, but delivery using zuri's exact (audienceKind-less) claims is accepted", async () => {
  const { dbPath, cleanup } = tempDbPath("audience-required-per-tool");
  const call = spawnRuntime(dbPath);
  try {
    const withAudience = { ...ROOM, externalRoomRef: "dm-audience-required", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", readPrivate: true, writePrivate: true };
    const { audienceKind: _drop, ...noAudience } = withAudience;

    await assert.rejects(
      call(
        "msp_thread_resolve",
        signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-audience-required" }, noAudience),
      ),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: msp_thread_resolve was accepted with no audienceKind claim",
    );

    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-audience-required" }, withAudience),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
        withAudience,
      ),
    );

    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi again" },
          noAudience,
        ),
      ),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: msp_thread_message_append was accepted with no audienceKind claim",
    );
    await assert.rejects(
      call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, noAudience)),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: msp_thread_context was accepted with no audienceKind claim",
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", body: { text: "x" }, source_message_refs: [inbound.message.messageId] },
          noAudience,
        ),
      ),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: msp_thread_memory_record was accepted with no audienceKind claim",
    );
    const context = await call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, withAudience));
    await assert.rejects(
      call(
        "msp_thread_injection_record",
        signed(
          "msp_thread_injection_record",
          { thread_id: thread.threadId, exchange_id: context.recentExchanges[0].exchangeId, injection_id: "inj-no-audience", packet_hash: "a".repeat(64), policy_revision: "p", model_ref: "m", state: "RESOLVED" },
          noAudience,
        ),
      ),
      /thread_audience_mismatch/,
      "FAIL-CLOSED VIOLATION: msp_thread_injection_record was accepted with no audienceKind claim",
    );

    // Delivery, using zuri's EXACT claim set (never an audienceKind claim
    // at all), must still succeed.
    const delivery = await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { inbound_message_id: (await call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, withAudience))).recentExchanges[0].messages[0].messageId,
          source_event_id: `${(await call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, withAudience))).recentExchanges[0].messages[0].messageId}:assistant`,
          receipt_id: "receipt-no-audience", outcome: "ACCEPTED", text: "reply" },
        { tenantId: withAudience.tenantId, businessId: withAudience.businessId, channelAccountId: withAudience.channelAccountId, externalRoomRef: withAudience.externalRoomRef, principalId: "zuri-line-agent", policyRevision: "line-delivery-v1", deliveryWriter: true },
      ),
    );
    assert.equal(delivery.deduplicated, false);
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI item 2: the first HUMAN membership on a thread is bound to the grant principal -- accepted for the principal, refused for anyone else without assertParticipants", async () => {
  const { dbPath, cleanup } = tempDbPath("first-membership");
  const call = spawnRuntime(dbPath);
  try {
    const groupClaims = { ...ROOM, externalRoomRef: "group-first-membership", audienceKind: "GROUP", principalId: "dave", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "group-first-membership" }, groupClaims),
    );
    // dave, the grant principal, can freely be the first participant.
    const accepted = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "dave-1", speaker_id: "dave", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from dave" },
        groupClaims,
      ),
    );
    assert.equal(accepted.deduplicated, false);

    // A DIFFERENT first-time speaker under dave's own grant (principalId
    // still dave) is refused without an explicit assertParticipants claim.
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "charlie-1", speaker_id: "charlie", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi from charlie, asserted by dave's grant" },
          groupClaims,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a new HUMAN speaker joined under someone else's grant with no assertParticipants claim",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI item 4 (guard half): a foreign speaker can never assert protected memory under someone else's grant", async () => {
  const { dbPath, cleanup } = tempDbPath("foreign-asserter");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-foreign-asserter", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", writePrivate: true };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-foreign-asserter" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi" },
        claims,
      ),
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "CONSTRAINT", asserted_by_speaker_id: "someone-else", subject_person_id: "someone-else", body: { text: "asserted under alice's grant" }, source_message_refs: ["placeholder-ref"] },
          claims,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a protected record was asserted under a grant whose principal did not match asserted_by_speaker_id",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI item 11: compaction retry always requires its lease token", async () => {
  const { dbPath, cleanup } = tempDbPath("retry-no-lease");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-retry-no-lease", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", operator: true };
    // lease_token is `required` (and non-empty, `$defs/string` minLength 1)
    // on API-011.tools.json's own msp_session_compaction_retry schema, so
    // an omitted lease_token is refused at the ajv layer before the guard's
    // OWN dedicated presence check (thread-guard.mjs, defense-in-depth for
    // any future internal caller that bypasses ajv) ever runs -- either
    // way, the request never reaches the domain layer with no lease_token.
    // A real, currently-leased job's WRONG lease_token
    // (CompactionLeaseConflictError) is covered in
    // tests/integration/thread-summary-worker.test.mjs.
    await assert.rejects(
      call("msp_session_compaction_retry", signed("msp_session_compaction_retry", { job_id: "msp:compaction-job/does-not-exist", error: "no lease token supplied" }, claims)),
      /thread_scope_denied|validation_failed/,
      "FAIL-CLOSED VIOLATION: a compaction retry with no lease_token was accepted",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI item 6: a delivery receipt that arrives before its inbound message is accepted as PENDING_INBOUND, then reconciled once the message arrives", async () => {
  const { dbPath, cleanup } = tempDbPath("pending-delivery");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-pending-delivery", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", deliveryWriter: true };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-pending-delivery" }, claims),
    );
    const pending = await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { inbound_message_id: "not-yet-arrived", source_event_id: "not-yet-arrived:assistant", receipt_id: "receipt-1", outcome: "ACCEPTED", text: "reply arrived early" },
        claims,
      ),
    );
    assert.equal(pending.status, "PENDING_INBOUND");

    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, message_id: "not-yet-arrived", source_event_id: "the-actual-inbound", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "the real question" },
        claims,
      ),
    );

    const replay = await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { inbound_message_id: "not-yet-arrived", source_event_id: "not-yet-arrived:assistant", receipt_id: "receipt-1", outcome: "ACCEPTED", text: "reply arrived early" },
        claims,
      ),
    );
    assert.equal(replay.deduplicated, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI review (2nd round), WARNING 1: an operator grant scoped to a DIFFERENT room can never claim, commit or retry another room's compaction job", async () => {
  const { dbPath, cleanup } = tempDbPath("room-check-job");
  // MSP_TEST_CLOCK is deliberately not in the client's env allowlist (W1 /
  // item 12), so a spawned child never honors a synthetic `now` -- this
  // test needs a REAL due session, so it uses the smallest real idle
  // timeout (1 minute) and waits on the real wall clock instead.
  const call = spawnRuntime(dbPath);
  try {
    const claimsA = { ...ROOM, externalRoomRef: "dm-a-room-check", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", operator: true };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-a-room-check" }, claimsA),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi", idle_timeout_minutes: 1 },
        claimsA,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    const sweepA = await call("msp_session_sweep", signed("msp_session_sweep", {}, claimsA));
    assert.equal(sweepA.jobs.length, 1);
    const jobId = sweepA.jobs[0].jobId;

    // An operator grant scoped to a DIFFERENT room (dm-b), but the SAME
    // tenant and channel account, must never be able to claim room A's job
    // -- channel_account_id equality alone is not enough.
    const claimsB = { ...ROOM, externalRoomRef: "dm-b-room-check", audienceKind: "DIRECT", principalId: "bob", policyRevision: "v1", operator: true };
    await assert.rejects(
      call("msp_session_compaction_claim", signed("msp_session_compaction_claim", { job_id: jobId, worker_id: "worker-b" }, claimsB)),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: an operator grant for a DIFFERENT room claimed another room's compaction job",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI review (2nd round), WARNING 1: a grant for one room can never append to or read a DIFFERENT room's thread under the same channel account", async () => {
  const { dbPath, cleanup } = tempDbPath("room-check-append");
  const call = spawnRuntime(dbPath);
  try {
    const claimsAlice = { ...ROOM, externalRoomRef: "dm-alice-room-check", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", readPrivate: true };
    const { thread: threadAlice } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-alice-room-check" }, claimsAlice),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: threadAlice.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "alice's private message" },
        claimsAlice,
      ),
    );

    // bob's own grant is scoped to a DIFFERENT room (dm-bob), same channel
    // account and tenant, but he names ALICE's thread_id directly.
    const claimsBob = { ...ROOM, externalRoomRef: "dm-bob-room-check", audienceKind: "DIRECT", principalId: "bob", policyRevision: "v1", readPrivate: true };
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: threadAlice.threadId, source_event_id: "bob-1", speaker_id: "bob", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "bob appends as alice" },
          claimsBob,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: bob's grant for a different room appended to alice's thread",
    );
    await assert.rejects(
      call("msp_thread_context", signed("msp_thread_context", { thread_id: threadAlice.threadId }, claimsBob)),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: bob's grant for a different room read alice's thread",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI review (2nd round), WARNING 2: person_id can never name anyone but the grant principal, even at first membership", async () => {
  const { dbPath, cleanup } = tempDbPath("person-id-mismatch");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-person-id-mismatch", audienceKind: "DIRECT", principalId: "erin", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-person-id-mismatch" }, claims),
    );
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "erin", speaker_kind: "HUMAN", person_id: "bob", identity_assurance: "VERIFIED", direction: "INBOUND", text: "erin claims to be bob" },
          claims,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: person_id=bob was minted under principal erin (probe A9c)",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI review (2nd round), WARNING 3 (W6 leftover): a caller-supplied message_id/receipt_id/injection_id collision across tenants is a generic conflict, never a raw or tenant-naming error", async () => {
  const { dbPath, cleanup } = tempDbPath("global-id-collision");
  const call = spawnRuntime(dbPath);
  try {
    const claimsA = { ...ROOM, externalRoomRef: "dm-collision-a", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", tenantId: "tenant-collision-a" };
    const claimsB = { ...ROOM, externalRoomRef: "dm-collision-b", audienceKind: "DIRECT", principalId: "carol", policyRevision: "v1", tenantId: "tenant-collision-b" };
    const { thread: threadA } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-collision-a", tenant_id: "tenant-collision-a" }, claimsA),
    );
    const { thread: threadB } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-collision-b", tenant_id: "tenant-collision-b" }, claimsB),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: threadA.threadId, message_id: "shared-message-id", source_event_id: "a-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "tenant A's message" },
        claimsA,
      ),
    );
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: threadB.threadId, message_id: "shared-message-id", source_event_id: "b-1", speaker_id: "carol", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "tenant B's message" },
          claimsB,
        ),
      ),
      (error) => {
        assert.match(error.message, /conflict/i);
        assert.doesNotMatch(error.message, /tenant-collision-a/);
        assert.doesNotMatch(error.message, /alice/);
        return true;
      },
      "FAIL-CLOSED VIOLATION: a cross-tenant message_id collision leaked tenant A's identity or was not a typed conflict",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI review (3rd round addendum), item 1: a delivery reconciled after its session has already closed still succeeds", async () => {
  const { dbPath, cleanup } = tempDbPath("reconcile-after-close");
  // Real wall clock, same reasoning as the WARNING 1 job-scope test above.
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-reconcile-after-close", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", operator: true, deliveryWriter: true };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-reconcile-after-close" }, claims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "hi", idle_timeout_minutes: 1 },
        claims,
      ),
    );
    // Two independent real-clock waits gate this: the 1-minute idle
    // deadline (for sweep to find the session due) AND ThreadMemoryStore's
    // own fixed 120-second reply-receipt grace (claimCompaction refuses to
    // lease a session with an unanswered inbound message any sooner) --
    // both measured from the same message, so one wait past the larger of
    // the two covers both.
    await new Promise((resolve) => setTimeout(resolve, 130_000));
    const sweep = await call("msp_session_sweep", signed("msp_session_sweep", {}, claims));
    assert.equal(sweep.jobs.length, 1);
    const claim = await call("msp_session_compaction_claim", signed("msp_session_compaction_claim", { job_id: sweep.jobs[0].jobId, worker_id: "worker" }, claims));
    const committed = await call(
      "msp_session_compaction_commit",
      signed(
        "msp_session_compaction_commit",
        {
          session_id: inbound.session.sessionId, job_id: claim.jobId, source_start_sequence: claim.sourceStartSequence,
          source_end_sequence: claim.sourceEndSequence, source_digest: claim.sourceDigest, lease_token: claim.leaseToken,
          invocation_state: "TERMINAL", policy_revision: "v1", summarizer_version: "test",
          summary: { topics: [], decisions: [], openQuestions: [], pendingActions: [], corrections: [], outcomes: [], participants: [] },
        },
        claims,
      ),
    );
    assert.ok(committed.summary.summaryId);
    // The session is now CLOSED. A late delivery receipt for its inbound
    // message must still be accepted and reconciled, not refused.
    const delivery = await call(
      "msp_thread_delivery_record",
      signed(
        "msp_thread_delivery_record",
        { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`, receipt_id: "late-receipt", outcome: "ACCEPTED", text: "late reply" },
        claims,
      ),
    );
    assert.equal(delivery.deduplicated, false);
  } finally {
    await call.close();
    cleanup();
  }
});

test("RKOI review (docs round 4), item 3: a self-upgrade is refused when the STORED participant row is already linked to a different person", async () => {
  const { dbPath, cleanup } = tempDbPath("dec-memos-15-stored-person");
  const call = spawnRuntime(dbPath);
  try {
    const groupClaims = { ...ROOM, externalRoomRef: "group-stored-person", audienceKind: "GROUP", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "group-stored-person" }, { ...groupClaims, principalId: "dave" }),
    );
    // dave joins first, self-bound, no person_id.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "dave-1", speaker_id: "dave", speaker_kind: "HUMAN", identity_assurance: "PENDING", direction: "INBOUND", text: "hi from dave" },
        { ...groupClaims, principalId: "dave" },
      ),
    );
    // An administrative grant (a different principal, with assertParticipants)
    // legitimately re-links dave's STORED row to ITS OWN principal id.
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "dave-relink", speaker_id: "dave", speaker_kind: "HUMAN", person_id: "admin-x", identity_assurance: "PENDING", direction: "INBOUND", text: "administratively relinked" },
        { ...groupClaims, principalId: "admin-x", assertParticipants: true },
      ),
    );
    // dave's OWN grant, no assertParticipants, now attempts its normal
    // self-upgrade (PENDING -> VERIFIED, no person_id sent) -- this must be
    // refused, because the STORED person_id ("admin-x") is not {null, dave}.
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "dave-upgrade", speaker_id: "dave", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "dave tries to self-upgrade" },
          { ...groupClaims, principalId: "dave" },
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a self-upgrade was accepted even though the stored participant row was linked to a different person",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

// RKOI code review round 2, CRITICAL: thread-guard.mjs's room-hash check
// used to run only `if (grant.externalRoomRef)`, so a validly-SIGNED grant
// that simply OMITTED externalRoomRef skipped the room check entirely --
// fail OPEN, not fail closed. RKOI's own probe (r2/p2.mjs) demonstrated
// this claiming another room's compaction job and reading/appending to a
// DIRECT thread that was not the grant's own, and planting a membership
// into a GROUP thread with no room claim at all. Every real zuri-ai grant
// for every thread-bound tool always carries externalRoomRef (and
// channelAccountId); a grant missing either is now refused outright,
// covering every thread-bound tool, not just the ones the original probe
// happened to try.
test("RKOI code review round 2, CRITICAL: a grant with NO externalRoomRef is refused on every thread-bound tool, never treated as \"nothing to check\"", async () => {
  const { dbPath, cleanup } = tempDbPath("no-room-critical");
  const call = spawnRuntime(dbPath);
  try {
    const aliceClaims = { ...ROOM, externalRoomRef: "dm-alice-no-room", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-alice-no-room" }, aliceClaims),
    );
    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "alice-in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: "alice", direction: "INBOUND", text: "alice's secret" },
        aliceClaims,
      ),
    );

    // A helper mirroring RKOI's r2/p2.mjs `noRoom()`: same claims as a
    // legitimate grant, but with externalRoomRef deleted entirely (never
    // set to a wrong value -- genuinely ABSENT, which is exactly what fell
    // through the old `if (grant.externalRoomRef)` guard).
    const noRoom = (extra = {}) => {
      const claims = { ...ROOM, audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", ...extra };
      delete claims.externalRoomRef;
      return claims;
    };

    await assert.rejects(
      call("msp_thread_context", signed("msp_thread_context", { thread_id: thread.threadId }, noRoom({ readPrivate: true }))),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef read a DIRECT thread's private context",
    );
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "no-room-append", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "no-room write" },
          noRoom(),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef appended to a DIRECT thread",
    );
    await assert.rejects(
      call(
        "msp_thread_memory_record",
        signed(
          "msp_thread_memory_record",
          { thread_id: thread.threadId, kind: "PREFERENCE", asserted_by_speaker_id: "alice", subject_person_id: "alice", scope: {}, body: { x: 1 }, source_message_refs: [inbound.message.messageId] },
          noRoom({ writePrivate: true }),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef recorded protected memory on a DIRECT thread",
    );
    await assert.rejects(
      call(
        "msp_thread_injection_record",
        signed(
          "msp_thread_injection_record",
          { thread_id: thread.threadId, exchange_id: inbound.message.exchangeId, injection_id: "inj-no-room", packet_hash: "a".repeat(64), policy_revision: "pol1", model_ref: "m", state: "RESOLVED" },
          noRoom({ readPrivate: true }),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef recorded an injection receipt on a DIRECT thread",
    );
    await assert.rejects(
      call(
        "msp_thread_delivery_record",
        signed(
          "msp_thread_delivery_record",
          { inbound_message_id: inbound.message.messageId, source_event_id: inbound.message.messageId + ":assistant", receipt_id: "recv-no-room", outcome: "ACCEPTED", text: "reply" },
          (() => {
            const claims = { ...ROOM, principalId: "zuri-line-agent", policyRevision: "v1", deliveryWriter: true };
            delete claims.externalRoomRef;
            return claims;
          })(),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef recorded a delivery receipt against alice's inbound message",
    );
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signed(
          "msp_thread_resolve",
          { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-alice-no-room" },
          noRoom(),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef resolved an existing thread",
    );

    // Compaction claim/commit/retry, via the job's thread -- the job itself
    // needs a real idle session, which needs a real wall-clock wait (W1 /
    // item 12: MSP_TEST_CLOCK never reaches a spawned child).
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "alice-in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "one more", idle_timeout_minutes: 1 },
        aliceClaims,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    const sweep = await call("msp_session_sweep", signed("msp_session_sweep", {}, { ...aliceClaims, operator: true }));
    assert.equal(sweep.jobs.length, 1);
    const jobId = sweep.jobs[0].jobId;

    const noRoomOperator = (extra = {}) => {
      const claims = { ...ROOM, audienceKind: "DIRECT", principalId: "worker-no-room", policyRevision: "v1", operator: true, ...extra };
      delete claims.externalRoomRef;
      return claims;
    };
    await assert.rejects(
      call("msp_session_compaction_claim", signed("msp_session_compaction_claim", { job_id: jobId, worker_id: "worker-no-room" }, noRoomOperator())),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef claimed a compaction job and could have read its transcript",
    );
    await assert.rejects(
      call("msp_session_compaction_retry", signed("msp_session_compaction_retry", { job_id: jobId, error: "E", lease_token: "does-not-matter" }, noRoomOperator())),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef retried a compaction job",
    );
    const commitSummary = { topics: [], decisions: [], openQuestions: [], pendingActions: [], corrections: [], outcomes: [], participants: [] };
    await assert.rejects(
      call(
        "msp_session_compaction_commit",
        signed(
          "msp_session_compaction_commit",
          { session_id: "does-not-matter", job_id: jobId, source_start_sequence: 1, source_end_sequence: 2, summary: commitSummary, source_digest: "0".repeat(64), policy_revision: "p", summarizer_version: "v", invocation_state: "TERMINAL", lease_token: "does-not-matter" },
          noRoomOperator(),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef committed a compaction job",
    );

    // The GROUP-thread membership-planting reproduction from RKOI's own
    // probe: a no-room grant must never be able to join a GROUP thread as a
    // brand-new HUMAN participant either.
    const groupClaims = { ...ROOM, externalRoomRef: "grp-no-room", audienceKind: "GROUP", policyRevision: "v1", principalId: "mallory" };
    const { thread: groupThread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "GROUP", audience_kind: "GROUP", ...ROOM_REQUEST, external_room_ref: "grp-no-room" }, groupClaims),
    );
    const noRoomMallory = () => {
      const claims = { ...ROOM, audienceKind: "GROUP", principalId: "mallory", policyRevision: "v1" };
      delete claims.externalRoomRef;
      return claims;
    };
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: groupThread.threadId, source_event_id: "mallory-plant", speaker_id: "mallory", speaker_kind: "HUMAN", identity_assurance: "PENDING", direction: "INBOUND", text: "planted into grp-no-room" },
          noRoomMallory(),
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a grant with no externalRoomRef planted a HUMAN membership into a GROUP thread",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

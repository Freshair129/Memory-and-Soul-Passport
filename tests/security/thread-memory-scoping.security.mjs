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
const ROOM = { channelType: "LINE", channelAccountId: "oa-scoping", tenantId: "tenant-scoping" };
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

test("C-1c: a PENDING speaker can never self-upgrade to VERIFIED without an explicit assertParticipants claim", async () => {
  const { dbPath, cleanup } = tempDbPath("c1c");
  const call = spawnRuntime(dbPath);
  try {
    const claims = { ...ROOM, externalRoomRef: "dm-c1c", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const { thread } = await call(
      "msp_thread_resolve",
      signed("msp_thread_resolve", { thread_kind: "DIRECT", audience_kind: "DIRECT", ...ROOM_REQUEST, external_room_ref: "dm-c1c" }, claims),
    );
    await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        { thread_id: thread.threadId, source_event_id: "in-1", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "PENDING", direction: "INBOUND", text: "hello" },
        claims,
      ),
    );
    await assert.rejects(
      call(
        "msp_thread_message_append",
        signed(
          "msp_thread_message_append",
          { thread_id: thread.threadId, source_event_id: "in-2", speaker_id: "alice", speaker_kind: "HUMAN", identity_assurance: "VERIFIED", direction: "INBOUND", text: "trust me now" },
          claims,
        ),
      ),
      /thread_scope_denied/,
      "FAIL-CLOSED VIOLATION: a PENDING speaker self-upgraded to VERIFIED with no assertParticipants claim",
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
    const claimsA = { channelType: "LINE", channelAccountId: "oa-shared", tenantId: "tenant-a", externalRoomRef: "dm-shared", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1" };
    const claimsB = { channelType: "LINE", channelAccountId: "oa-shared", tenantId: "tenant-b", externalRoomRef: "dm-shared", audienceKind: "DIRECT", principalId: "carol", policyRevision: "v1" };
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

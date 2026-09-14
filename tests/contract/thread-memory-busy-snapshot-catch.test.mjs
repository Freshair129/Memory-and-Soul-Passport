// PH-MEMOS-4 (BL-MEMOS-050, design v0.5.4b Sec.7.1 WARNING 2, narrowed RKOI
// PH-MEMOS-4 review round 3): a unit-level proof of the store's own catch
// PREDICATE for the close_for_relink/in-flight-append status race --
// asserted directly against `ThreadMemoryStore#appendMessage` and
// `#participantLifecycle`'s own catch blocks, not by inducing a genuine
// SQLite lock-timeout end-to-end (slow and flaky; the design's own plan
// entry, BL-MEMOS-050's 0.1.16b revision, specifies this as a unit-level
// check on the catch predicate).
//
// The fake `db` below never runs either method's real transaction body at
// all: `db.transaction(fn)` returns a function that, when invoked, throws
// the given synthetic error immediately -- exactly simulating "the
// transaction's own commit/write raised this driver-level error", the
// shape #consumeNonce/the threads UPDATE would surface it in, without any
// real concurrency or timing dependency.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ThreadMemoryConflictError, ThreadMemoryStore } from "../../packages/msp-core/src/domain/thread-memory.mjs";
import { createServer } from "../../apps/msp-server/src/server.mjs";

const THREAD_ROW = {
  thread_id: "thread-fake",
  thread_kind: "DIRECT",
  channel_type: "LINE",
  channel_account_id: "oa-fake",
  external_room_ref_hmac: "hash-fake",
  tenant_id: "tenant-fake",
  business_id: null,
  status: "ACTIVE",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function makeFakeDb(transactionThrows) {
  return {
    prepare(sql) {
      return {
        get: () => (sql.includes("FROM threads WHERE thread_id") ? THREAD_ROW : undefined),
        run: () => ({ changes: 1 }),
        all: () => [],
      };
    },
    transaction() {
      return () => {
        throw transactionThrows;
      };
    },
  };
}

const IDENTITY_KEY = "x".repeat(32);

describe("BL-MEMOS-050 (design Sec.7.1 WARNING 2, round 3): the status-race catch predicate is exactly SQLITE_BUSY_SNAPSHOT", () => {
  it("participantLifecycle(close_for_relink) re-maps a raw error whose code is EXACTLY SQLITE_BUSY_SNAPSHOT to a typed conflict", () => {
    const busySnapshot = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_SNAPSHOT" });
    const store = new ThreadMemoryStore(makeFakeDb(busySnapshot), null, { identityHmacKey: IDENTITY_KEY });
    expect(() =>
      store.participantLifecycle({ threadId: "thread-fake", action: "close_for_relink", agentId: "agent-1", workspaceId: "workspace-1", nonce: "n", grantExpiresAt: Date.now() + 1000 }),
    ).toThrow(ThreadMemoryConflictError);
    expect(() =>
      store.participantLifecycle({ threadId: "thread-fake", action: "close_for_relink", agentId: "agent-1", workspaceId: "workspace-1", nonce: "n", grantExpiresAt: Date.now() + 1000 }),
    ).toThrow(/the thread's status changed while this call was in flight/);
  });

  it("participantLifecycle(close_for_relink) does NOT catch a plain SQLITE_BUSY (an unrelated lock timeout) -- it propagates unmapped, never remapped to the typed conflict", () => {
    const plainBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const store = new ThreadMemoryStore(makeFakeDb(plainBusy), null, { identityHmacKey: IDENTITY_KEY });
    let caught;
    try {
      store.participantLifecycle({ threadId: "thread-fake", action: "close_for_relink", agentId: "agent-1", workspaceId: "workspace-1", nonce: "n", grantExpiresAt: Date.now() + 1000 });
      expect.unreachable("expected participantLifecycle to throw");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(plainBusy);
    expect(caught.code).toBe("SQLITE_BUSY");
    expect(caught).not.toBeInstanceOf(ThreadMemoryConflictError);
  });

  it("appendMessage re-maps a raw error whose code is EXACTLY SQLITE_BUSY_SNAPSHOT to a typed conflict (the append side of the same race)", () => {
    const busySnapshot = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_SNAPSHOT" });
    const store = new ThreadMemoryStore(makeFakeDb(busySnapshot), null, { identityHmacKey: IDENTITY_KEY });
    expect(() =>
      store.appendMessage({ threadId: "thread-fake", sourceEventId: "evt-1", speakerId: "alice", speakerKind: "HUMAN", identityAssurance: "VERIFIED", direction: "INBOUND", text: "hi" }),
    ).toThrow(ThreadMemoryConflictError);
  });

  it("appendMessage does NOT catch a plain SQLITE_BUSY -- it propagates unmapped, never remapped to the typed conflict", () => {
    const plainBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const store = new ThreadMemoryStore(makeFakeDb(plainBusy), null, { identityHmacKey: IDENTITY_KEY });
    let caught;
    try {
      store.appendMessage({ threadId: "thread-fake", sourceEventId: "evt-1", speakerId: "alice", speakerKind: "HUMAN", identityAssurance: "VERIFIED", direction: "INBOUND", text: "hi" });
      expect.unreachable("expected appendMessage to throw");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(plainBusy);
    expect(caught.code).toBe("SQLITE_BUSY");
    expect(caught).not.toBeInstanceOf(ThreadMemoryConflictError);
  });
});

// RKOI PH-MEMOS-4 review round 4, RECOMMENDED item 4: the fake-db suite
// above pins the CATCH PREDICATE (which error code gets remapped), but its
// fake transaction throws before the status re-check itself ever runs --
// it never proves the re-check's own SQL actually refuses a genuinely
// CLOSED thread. This describe block exercises the real re-check, against
// a real migrated SQLite database, bypassing the guard entirely: the
// thread is flipped to CLOSED directly at the DB level (no
// close_for_relink call), and a FRESH ThreadMemoryStore instance --
// constructed directly, the same way apps/msp-server/src/transport/
// handlers/thread-handlers.mjs does, never through the guard -- is asked
// to append to it.
describe("BL-MEMOS-050 (RKOI PH-MEMOS-4 review round 4, item 4): the store's own status re-check, exercised directly against a real DB", () => {
  const roots = [];
  const servers = [];
  const IDENTITY_KEY_REAL = "y".repeat(32);

  afterEach(() => {
    while (servers.length) servers.pop().close();
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it("appendMessage throws ThreadMemoryConflictError against a thread that is CLOSED at the DB level, and writes zero rows to thread_messages/thread_participants", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "msp-recheck-append-"));
    roots.push(root);
    const server = createServer({ dbPath: path.join(root, "msp.sqlite3"), env: { ...process.env, MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY_REAL } });
    servers.push(server);

    const resolved = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE",
      channel_account_id: "oa-recheck",
      external_room_ref: "dm-recheck-append",
      tenant_id: "tenant-recheck",
      grant_agent_id: "agent-recheck",
      grant_workspace_id: "workspace-recheck",
      grant_may_mint: true,
      grant_nonce: "nonce-resolve-append",
      grant_expires_at: Date.now() + 60_000,
    });
    const threadId = resolved.thread.threadId;

    // No close_for_relink call at all -- the thread's status column is
    // flipped directly, simulating a concurrent close that committed in
    // the window between an earlier guard-level read and this write.
    server.db.prepare("UPDATE threads SET status = 'CLOSED' WHERE thread_id = ?").run(threadId);

    const directStore = new ThreadMemoryStore(server.db, server.journal, { identityHmacKey: IDENTITY_KEY_REAL });
    expect(() =>
      directStore.appendMessage({
        threadId,
        sourceEventId: "evt-recheck",
        speakerId: "alice",
        speakerKind: "HUMAN",
        identityAssurance: "VERIFIED",
        direction: "INBOUND",
        text: "hi",
        agentId: "agent-recheck",
        workspaceId: "workspace-recheck",
      }),
    ).toThrow(ThreadMemoryConflictError);
    expect(() =>
      directStore.appendMessage({
        threadId,
        sourceEventId: "evt-recheck-2",
        speakerId: "alice",
        speakerKind: "HUMAN",
        identityAssurance: "VERIFIED",
        direction: "INBOUND",
        text: "hi again",
        agentId: "agent-recheck",
        workspaceId: "workspace-recheck",
      }),
    ).toThrow(/the thread's status changed while this call was in flight/);

    const messageCount = server.db.prepare("SELECT COUNT(*) AS count FROM thread_messages WHERE thread_id = ?").get(threadId).count;
    const participantCount = server.db.prepare("SELECT COUNT(*) AS count FROM thread_participants WHERE thread_id = ?").get(threadId).count;
    expect(messageCount).toBe(0);
    expect(participantCount).toBe(0);
  });

  it("participantLifecycle(close_for_relink) throws ThreadMemoryConflictError when the thread is ALREADY CLOSED at the DB level, and never flips a second journal row", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "msp-recheck-relink-"));
    roots.push(root);
    const server = createServer({ dbPath: path.join(root, "msp.sqlite3"), env: { ...process.env, MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY_REAL } });
    servers.push(server);

    const resolved = await server.threadHandlers.msp_thread_resolve({
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE",
      channel_account_id: "oa-recheck",
      external_room_ref: "dm-recheck-relink",
      tenant_id: "tenant-recheck",
      grant_agent_id: "agent-recheck",
      grant_workspace_id: "workspace-recheck",
      grant_may_mint: true,
      grant_nonce: "nonce-resolve-relink",
      grant_expires_at: Date.now() + 60_000,
    });
    const threadId = resolved.thread.threadId;
    server.db.prepare("UPDATE threads SET status = 'CLOSED' WHERE thread_id = ?").run(threadId);

    const directStore = new ThreadMemoryStore(server.db, server.journal, { identityHmacKey: IDENTITY_KEY_REAL });
    expect(() =>
      directStore.participantLifecycle({
        threadId,
        action: "close_for_relink",
        agentId: "agent-recheck",
        workspaceId: "workspace-recheck",
        nonce: "nonce-relink-recheck",
        grantExpiresAt: Date.now() + 60_000,
      }),
    ).toThrow(/the thread's status changed while this call was in flight/);

    // A refused re-check must never write a journal entry for this tool
    // name -- the thread's own earlier resolve journal row uses
    // msp_thread_resolve, not msp_thread_participant_lifecycle.
    const journalCount = server.db.prepare("SELECT COUNT(*) AS count FROM journal WHERE tool_name = 'msp_thread_participant_lifecycle' AND ref = ?").get(threadId).count;
    expect(journalCount).toBe(0);
  });
});

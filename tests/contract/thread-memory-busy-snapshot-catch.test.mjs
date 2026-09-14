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
import { describe, expect, it } from "vitest";

import { ThreadMemoryConflictError, ThreadMemoryStore } from "../../packages/msp-core/src/domain/thread-memory.mjs";

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

// BL-MEMOS-049 (TASK-MEMOS-002 stage 2, RKOI ruling 2): the real-process
// proof for the optional per-tenant MSP_THREAD_SERVICE_KEYRING. Verified
// against the REAL running msp-server process (createMspStdioCaller +
// apps/msp-server/bin/msp-server.mjs), signed with
// @freshair129/msp-contracts/thread-access's real signThreadRequest --
// never a mock guard, mirroring tests/security/thread-memory-scoping.security.mjs.
//
// Covers exactly the rules in the ADR:
//   - a grant for tenant B signed with tenant A's key is refused;
//   - a grant signed with the OLD single default key is refused once a
//     keyring is configured (no fallback, for ANY tenant);
//   - a grant for a tenant missing from the keyring is refused
//     (grant_unconfigured, the existing vocabulary -- no new error code);
//   - a correctly keyed grant for each configured tenant succeeds;
//   - the single-key default path (no keyring set at all) is unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { signThreadRequest } from "../../packages/msp-contracts/src/contracts/thread-access.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

const IDENTITY_KEY = "thread-service-keyring-security-test-hmac-key";
const OLD_SINGLE_KEY = "old-single-default-key-0123456789ab"; // still set in env, must be ignored
const KEY_TENANT_A = "keyring-tenant-a-key-0123456789abcdef";
const KEY_TENANT_B = "keyring-tenant-b-key-0123456789abcdef";

function tempDbPath(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `msp-thread-keyring-${label}-`));
  const dbPath = path.join(dir, "msp.sqlite3");
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function spawnWithKeyring(dbPath, keyring) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: {
      ...process.env,
      MSP_DB_PATH: dbPath,
      // Deliberately still set, so a successful verify under it would prove
      // the "no fallback" rule broken.
      MSP_THREAD_SERVICE_KEY: OLD_SINGLE_KEY,
      MSP_THREAD_SERVICE_KEYRING: JSON.stringify(keyring),
      MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY,
    },
    timeoutMs: 10_000,
  });
}

function spawnSingleKeyOnly(dbPath) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEY: OLD_SINGLE_KEY, MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY },
    timeoutMs: 10_000,
  });
}

function signedWith(key, name, input, claims) {
  return signThreadRequest(name, input, claims, key);
}

function resolveInput(room, tenantId) {
  return { thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-keyring", external_room_ref: room, tenant_id: tenantId };
}

function claimsFor(room, tenantId, principalId) {
  return { channelAccountId: "oa-keyring", externalRoomRef: room, audienceKind: "DIRECT", tenantId, principalId, policyRevision: "v1" };
}

test("BL-MEMOS-049: a correctly keyed grant for each tenant succeeds once a keyring is configured", async () => {
  const { dbPath, cleanup } = tempDbPath("happy-path");
  const call = spawnWithKeyring(dbPath, { "tenant-a": KEY_TENANT_A, "tenant-b": KEY_TENANT_B });
  try {
    const a = await call("msp_thread_resolve", signedWith(KEY_TENANT_A, "msp_thread_resolve", resolveInput("dm-a", "tenant-a"), claimsFor("dm-a", "tenant-a", "alice")));
    assert.ok(a.thread.threadId, "tenant-a's grant, signed with tenant-a's own key, must succeed");
    const b = await call("msp_thread_resolve", signedWith(KEY_TENANT_B, "msp_thread_resolve", resolveInput("dm-b", "tenant-b"), claimsFor("dm-b", "tenant-b", "bob")));
    assert.ok(b.thread.threadId, "tenant-b's grant, signed with tenant-b's own key, must succeed");
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-049: a grant for tenant B signed with tenant A's key is refused (no cross-tenant verify)", async () => {
  const { dbPath, cleanup } = tempDbPath("cross-tenant");
  const call = spawnWithKeyring(dbPath, { "tenant-a": KEY_TENANT_A, "tenant-b": KEY_TENANT_B });
  try {
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signedWith(KEY_TENANT_A, "msp_thread_resolve", resolveInput("dm-cross", "tenant-b"), claimsFor("dm-cross", "tenant-b", "mallory")),
      ),
      /grant_signature_invalid/,
      "FAIL-CLOSED VIOLATION: a grant claiming tenant-b verified under tenant-a's key",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-049: a grant signed with the OLD single default key is refused once a keyring is configured (no fallback)", async () => {
  const { dbPath, cleanup } = tempDbPath("old-single-key");
  const call = spawnWithKeyring(dbPath, { "tenant-a": KEY_TENANT_A, "tenant-b": KEY_TENANT_B });
  try {
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signedWith(OLD_SINGLE_KEY, "msp_thread_resolve", resolveInput("dm-old-key", "tenant-a"), claimsFor("dm-old-key", "tenant-a", "alice")),
      ),
      /grant_signature_invalid/,
      "FAIL-CLOSED VIOLATION: the old single default key still verified a grant after a keyring was configured",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-049: a grant for a tenant missing from the keyring is refused with the existing grant_unconfigured vocabulary", async () => {
  const { dbPath, cleanup } = tempDbPath("missing-tenant");
  const call = spawnWithKeyring(dbPath, { "tenant-a": KEY_TENANT_A });
  try {
    await assert.rejects(
      call(
        "msp_thread_resolve",
        signedWith(KEY_TENANT_A, "msp_thread_resolve", resolveInput("dm-missing", "tenant-z"), claimsFor("dm-missing", "tenant-z", "nobody")),
      ),
      /grant_unconfigured/,
      "FAIL-CLOSED VIOLATION: a tenant absent from the keyring was not refused with grant_unconfigured",
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-049: with no MSP_THREAD_SERVICE_KEYRING set, the single-key default path is unchanged", async () => {
  const { dbPath, cleanup } = tempDbPath("single-key-default");
  const call = spawnSingleKeyOnly(dbPath);
  try {
    const result = await call(
      "msp_thread_resolve",
      signedWith(OLD_SINGLE_KEY, "msp_thread_resolve", resolveInput("dm-default", "tenant-any"), claimsFor("dm-default", "tenant-any", "alice")),
    );
    assert.ok(result.thread.threadId, "the single default key must still verify grants for any tenant when no keyring is configured");
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-049: a malformed keyring fails the real server process at start, before any request is served, and before a database file is created", () => {
  const { dbPath, cleanup } = tempDbPath("malformed-start");
  try {
    // A real, separate process (not createMspStdioCaller, which assumes a
    // working JSON-RPC handshake) -- bin/msp-server.mjs calls createServer
    // synchronously at the top level, so a malformed keyring must crash the
    // process itself (non-zero exit) before it ever starts speaking stdio.
    const result = spawnSync(process.execPath, [binPath], {
      env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEYRING: "{not json", MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, "FAIL-CLOSED VIOLATION: the server process exited 0 (or is still running) with a malformed keyring");
    assert.match(result.stderr, /thread_keyring_config_invalid/, "the crash must name the typed configuration error, not a raw stack trace only");
    // RKOI code review, WARNING 3: the keyring is parsed BEFORE open(dbPath)
    // now -- a malformed keyring must never create (or migrate) a database
    // file at all.
    assert.equal(existsSync(dbPath), false, "FAIL-CLOSED VIOLATION: a database file was created despite a malformed keyring");
  } finally {
    cleanup();
  }
});

test("BL-MEMOS-049: an empty {} keyring fails the real server process at start (a keyring naming no tenant can never be honoured)", () => {
  const { dbPath, cleanup } = tempDbPath("empty-start");
  try {
    const result = spawnSync(process.execPath, [binPath], {
      env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEYRING: "{}", MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, "FAIL-CLOSED VIOLATION: the server process exited 0 with an empty keyring");
    assert.match(result.stderr, /thread_keyring_config_invalid/);
    assert.equal(existsSync(dbPath), false);
  } finally {
    cleanup();
  }
});

// RKOI review, CRITICAL: the exact reproduction -- a reversed map
// ({key: tenantId} instead of {tenantId: key}) makes the KEY land where the
// parser expects a tenant id. Before this fix, the short-key/non-string
// error messages quoted that "tenant id" verbatim -- which, in a reversed
// map, IS the secret key -- and bin/msp-server.mjs's uncaught-exception
// handler wrote it to stderr, which
// packages/msp-client-js/src/msp-stdio-transport.mjs then folds into the
// error it raises to the calling application (msp-stdio-transport.mjs's
// stderr-tail-in-error behavior). Both halves of that path are checked
// directly against the REAL spawned process below: neither the child's own
// stderr, nor the error the stdio client raises to its caller, may ever
// contain the key.
test("CRITICAL: a reversed keyring map ({key: tenantId}) never leaks the key into the real child's stderr", () => {
  const { dbPath, cleanup } = tempDbPath("reversed-stderr");
  const leakedKey = "reversed-map-leak-check-key-0123456789ab";
  try {
    const result = spawnSync(process.execPath, [binPath], {
      env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEYRING: JSON.stringify({ [leakedKey]: "tenant-a" }), MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /thread_keyring_config_invalid/);
    assert.equal(result.stderr.includes(leakedKey), false, "FAIL-CLOSED VIOLATION: the reversed map's key leaked into the child's stderr");
    assert.equal(existsSync(dbPath), false);
  } finally {
    cleanup();
  }
});

test("CRITICAL: a reversed keyring map ({key: tenantId}) never leaks the key into the stdio client's own thrown error", async () => {
  const { dbPath, cleanup } = tempDbPath("reversed-client-error");
  const leakedKey = "reversed-map-client-leak-check-key-0123456789";
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEYRING: JSON.stringify({ [leakedKey]: "tenant-a" }), MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY },
    timeoutMs: 10_000,
  });
  try {
    let caught;
    try {
      await call("msp_ping", {});
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "msp_ping must reject when the server process crashed at start");
    assert.equal(caught.message.includes(leakedKey), false, "FAIL-CLOSED VIOLATION: the calling application's own error carried the reversed map's key");
  } finally {
    await call.close().catch(() => {});
    cleanup();
  }
});

// GHOST QA finding: V8's JSON.parse can hand back a corrupted non-first key
// name for a later, differently-escaped object parsed in the same process
// (values are unaffected). thread-service-keyring.mjs no longer reads a
// value via `parsed[tenantId]` on the native JSON.parse result (see its
// header comment) -- these end-to-end cases prove that fix reaches all the
// way through resolveThreadServiceKeyFor -> thread-guard.mjs ->
// verifyThreadGrant for the exact identifiers implicated (a literal quote,
// a literal backslash), through the REAL spawned server process, not just
// the pure parser in isolation (tests/contract/thread-service-keyring.test.mjs
// covers the in-process "primed" regression itself, which only reproduces
// within a single V8 instance and so cannot be shown across two spawned
// processes here).
test('BL-MEMOS-049: a tenant id that is a literal quote (") is accepted with its own correct key, through the real process', async () => {
  const { dbPath, cleanup } = tempDbPath("quote-tenant");
  const QUOTE = '"';
  const call = spawnWithKeyring(dbPath, { [QUOTE]: KEY_TENANT_A, "tenant-b": KEY_TENANT_B });
  try {
    const result = await call(
      "msp_thread_resolve",
      signedWith(KEY_TENANT_A, "msp_thread_resolve", resolveInput("dm-quote", QUOTE), claimsFor("dm-quote", QUOTE, "alice")),
    );
    assert.ok(result.thread.threadId, 'a tenant id of literal " must verify correctly against its own configured key');
    // Cross-check: the OTHER tenant's key must not verify this tenant's grant.
    await assert.rejects(
      call("msp_thread_resolve", signedWith(KEY_TENANT_B, "msp_thread_resolve", resolveInput("dm-quote-2", QUOTE), claimsFor("dm-quote-2", QUOTE, "mallory"))),
      /grant_signature_invalid/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("BL-MEMOS-049: a tenant id that is a literal backslash (\\) is accepted with its own correct key, through the real process", async () => {
  const { dbPath, cleanup } = tempDbPath("backslash-tenant");
  const BACKSLASH = "\\";
  const call = spawnWithKeyring(dbPath, { "tenant-a": KEY_TENANT_A, [BACKSLASH]: KEY_TENANT_B });
  try {
    const result = await call(
      "msp_thread_resolve",
      signedWith(KEY_TENANT_B, "msp_thread_resolve", resolveInput("dm-backslash", BACKSLASH), claimsFor("dm-backslash", BACKSLASH, "bob")),
    );
    assert.ok(result.thread.threadId, "a tenant id of literal \\ must verify correctly against its own configured key");
  } finally {
    await call.close();
    cleanup();
  }
});

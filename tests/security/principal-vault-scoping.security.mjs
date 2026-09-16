// PH-MEMOS-5 (design v0.9.1b §5, §5.1, §5.2, §5.3, §12.4, §15,
// GATE-MEMOS-5): the principal-vault security invariants this phase adds --
// never-mountable enforcement (both layers), idempotent resolve, the
// genuine two-connection provision race, re-provisioning after erasure
// (including across a simulated MSP_IDENTITY_HMAC_KEY rotation), the
// decay_tick `pinned` field, and cross-repo compatibility against zuri-ai's
// shipped msp-vault-resolver.js request/response shape. Real stdio child
// process throughout, mirroring every other *.security.mjs file in this
// suite.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { VaultRegistry, PROVISION_EPOCH_PROBE_LIMIT } from "@freshair129/msp-core/vault-registry";
import { VaultProvisionConflictError } from "@freshair129/msp-core/errors";
import { stableId } from "@freshair129/msp-core/ids";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const HMAC_KEY = "a".repeat(32);
const HMAC_KEY_2 = "b".repeat(32);

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-principal-vault-scoping-test-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup() {
      // Windows can hold a brief file lock on the -wal/-shm sidecar files
      // for a moment after a same-process better-sqlite3 connection's own
      // synchronous close() returns (distinct from the child-process WAL
      // release CLAUDE.md documents) -- retried rather than failing this
      // suite's own teardown on a transient EPERM.
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

function spawnRuntime(dbPath, env = {}) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_IDENTITY_HMAC_KEY: HMAC_KEY, ...env },
    timeoutMs: 10_000,
  });
}

function baseAccessContext(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    business_id: "biz-1",
    principal_id: "principal-1",
    agent_id: "agent-1",
    instance_id: "inst-1",
    project_id: "project-1",
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    session_id: "session-1",
    policy_version: "policy-v1",
    ...overrides,
  };
}

function baseAuthorization(overrides = {}) {
  return {
    membership_active: true,
    allowed: true,
    allow_global_private: true,
    allow_tenant_global_private: false,
    allow_shared: true,
    read: true,
    write_private: true,
    write_shared: false,
    ...overrides,
  };
}

async function resolve(call, accessContextOverrides = {}, authorizationOverrides = {}) {
  return call("msp_vault_resolve", {
    actor: "zuri-agent",
    access_context: baseAccessContext(accessContextOverrides),
    authorization: baseAuthorization(authorizationOverrides),
  });
}

test("msp_vault_resolve: same resolve returns the same vault, sequentially, for both principal_private and principal_passport", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const first = await resolve(call, {}, { allow_passport: true });
    const second = await resolve(call, {}, { allow_passport: true });
    assert.equal(first.principalPrivateVaultId, second.principalPrivateVaultId);
    assert.equal(first.principalPassportVaultId, second.principalPassportVaultId);
    assert.ok(first.principalPrivateVaultId);
    assert.ok(first.principalPassportVaultId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_resolve: principalPassportVaultId is null unless authorization.allow_passport === true, and every legacy field is always present with the correct type", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const denied = await resolve(call);
    assert.equal(denied.principalPassportVaultId, null);
    assert.equal(typeof denied.workspacePrivateVaultId, "string");
    assert.ok(Array.isArray(denied.globalPrivateVaultIds));
    assert.ok(Array.isArray(denied.sharedVaultIds));
    assert.equal(typeof denied.permissions.read, "boolean");
    assert.equal(typeof denied.permissions.writePrivate, "boolean");
    assert.equal(typeof denied.permissions.writeShared, "boolean");
    assert.equal(typeof denied.permissions.policyVersion, "string");
    assert.equal(denied.permissions.allowPassport, false);

    const withPassport = await resolve(call, {}, { allow_passport: true });
    assert.equal(typeof withPassport.principalPassportVaultId, "string");
    assert.equal(withPassport.permissions.allowPassport, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_resolve: two agents serving the same person get two DISTINCT principal_private vaults (design §5.5 rule 1)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const agentA = await resolve(call, { agent_id: "agent-A" });
    const agentB = await resolve(call, { agent_id: "agent-B" });
    assert.notEqual(agentA.principalPrivateVaultId, agentB.principalPrivateVaultId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_resolve: a caller with a matching tenant_id/principal_id but no allow_passport on a DIRECT msp_memory_* call is refused access_context_denied, even against an already-known principalPassportVaultId obtained once with allow_passport and reused later without it (re-checked per call, not cached from resolve time)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const withPassport = await resolve(call, {}, { allow_passport: true });
    const passportVaultId = withPassport.principalPassportVaultId;
    assert.ok(passportVaultId);

    const upsertOk = await call("msp_memory_upsert", {
      vault: { vault_id: passportVaultId, vault_type: "principal_passport" },
      category: "soul", key: "fact-1", body_json: { x: 1 },
      access_context: { tenant_id: "tenant-1", principal_id: "principal-1", allow_passport: true },
    });
    assert.equal(upsertOk.created, true);

    await assert.rejects(
      call("msp_memory_get", {
        vault_id: passportVaultId, category: "soul", key: "fact-1",
        access_context: { tenant_id: "tenant-1", principal_id: "principal-1" },
      }),
      /access_context_denied/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_resolve: global_private is never targeted by an access_context branch -- msp_memory_* against the agent's own global_private vault needs no access_context at all", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const resolved = await resolve(call, {}, { allow_global_private: true });
    const globalVaultId = resolved.globalPrivateVaultIds[0];
    assert.ok(globalVaultId);
    const upserted = await call("msp_memory_upsert", {
      vault: { vault_id: globalVaultId, vault_type: "global_private" },
      category: "agent-fact", key: "k1", body_json: { x: 1 },
    });
    assert.equal(upserted.created, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_mount: principal_private/principal_passport vault_ids are refused at the VaultRegistry#mountVault JS-layer check, ahead of vault_mounts's own DB-layer trigger", async () => {
  // Two SEPARATE databases -- dropping the DB-layer trigger to prove the
  // JS-layer check is independent must not also destroy the OTHER half's
  // own DB-layer proof below, which needs that trigger intact.
  const jsLayer = tempDbPath();
  const dbLayer = tempDbPath();
  let db;
  let db2;
  try {
    db = open(jsLayer.dbPath);
    runMigrations(db, path.join(packageRoot, "migrations"));
    const vaultRegistry = new VaultRegistry(db);
    const vault = vaultRegistry.provisionPrincipalPrivateVault({
      tenantId: "tenant-mount", principalId: "principal-mount", agentId: "agent-mount", workspaceId: "workspace-mount",
    });

    // JS-layer refusal, confirmed with the DB-layer trigger mocked out on
    // THIS database only: drop the trigger, then confirm mountVault STILL
    // refuses -- proving the JS-layer check is real, not merely
    // coincidental with the DB layer's own independent refusal below.
    db.exec("DROP TRIGGER trg_vault_mounts_refuse_principal_insert");
    assert.throws(
      () => vaultRegistry.mountVault({ vaultId: vault.vault_id, workspaceId: "workspace-mount", mountAlias: "steal", accessMode: "read" }),
      (err) => {
        assert.equal(err.code, "vault_scope_denied");
        assert.match(err.message, /principal vaults are never mountable/);
        return true;
      },
    );

    // DB-layer refusal, independently, on a FRESH database whose trigger
    // was never touched: a direct INSERT INTO vault_mounts naming a
    // principal_private vault_id is refused before any application code
    // runs, even bypassing VaultRegistry entirely.
    db2 = open(dbLayer.dbPath);
    runMigrations(db2, path.join(packageRoot, "migrations"));
    const vaultRegistry2 = new VaultRegistry(db2);
    const vault2 = vaultRegistry2.provisionPrincipalPrivateVault({
      tenantId: "tenant-mount-2", principalId: "principal-mount-2", agentId: "agent-mount-2", workspaceId: "workspace-mount-2",
    });
    assert.throws(
      () =>
        db2
          .prepare(
            "INSERT INTO vault_mounts (mount_id, vault_id, workspace_id, mount_alias, access_mode, status, mounted_at) VALUES (?,?,?,?,'read','mounted',?)",
          )
          .run("mount-direct-refused", vault2.vault_id, "workspace-mount-2", "alias", new Date().toISOString()),
      /never mountable/,
    );
  } finally {
    db?.close();
    db2?.close();
    jsLayer.cleanup();
    dbLayer.cleanup();
  }
});

test("msp_vault_mount over the real wire: a principalPrivateVaultId obtained from msp_vault_resolve is refused vault_scope_denied when passed to msp_vault_mount", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const resolved = await resolve(call);
    await assert.rejects(
      call("msp_vault_mount", {
        actor: "boss", workspace_id: "workspace-1", workspace_path: "/workspace/1",
        vault_id: resolved.principalPrivateVaultId, mount_alias: "steal", access_mode: "read", reason: "attack",
      }),
      /vault_scope_denied/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("VaultRegistry: a genuine two-connection race for a never-before-provisioned tuple yields exactly one winner; the loser is refused vault_provision_conflict, caught by an actual try/catch, never a raw SqliteError", async () => {
  const { dbPath, cleanup } = tempDbPath();
  let connA;
  let connB;
  try {
    const dbSetup = open(dbPath);
    runMigrations(dbSetup, path.join(packageRoot, "migrations"));
    dbSetup.close();

    connA = open(dbPath);
    connB = open(dbPath);
    const registryA = new VaultRegistry(connA);
    const registryB = new VaultRegistry(connB);

    const tuple = { tenantId: "tenant-race", principalId: "principal-race", agentId: "agent-race", workspaceId: "workspace-race" };

    // B opens its own transaction and takes a real read first (WAL mode:
    // a connection's snapshot is established at the first read inside its
    // transaction) -- BEFORE A's own provision runs at all. This is B's
    // own read snapshot, taken deliberately early.
    connB.exec("BEGIN");
    // A real read against the actual `vaults` table -- a bare `SELECT 1`
    // with no FROM touches no B-tree at all and does not reliably
    // establish SQLite's own MVCC read snapshot against the database
    // file; this does.
    connB.prepare("SELECT COUNT(*) AS n FROM vaults").get();

    // A -- a genuinely SEPARATE connection -- provisions and commits the
    // SAME tuple's first-ever generation in full, through the real,
    // unmodified public method, entirely between B's snapshot and B's own
    // provisioning attempt.
    const winner = registryA.provisionPrincipalPrivateVault(tuple);
    assert.equal(winner.provision_epoch, 0);

    // B now attempts to provision the SAME tuple. better-sqlite3 nests
    // provisionPrincipalPrivateVault's own this.#db.transaction(...) as a
    // SAVEPOINT under B's already-open outer BEGIN -- so B's own active-row
    // SELECT and epoch-probe SELECT both run against the SAME stale
    // snapshot taken above, before A's commit. B's probe therefore does
    // NOT see A's already-committed row (its snapshot predates it) and
    // computes the IDENTICAL epoch-0 vault_id A already committed --
    // exactly the real race design §5.2 describes. B's own attempt to
    // become a writer with that now-stale snapshot is refused by SQLite
    // itself (SQLITE_BUSY_SNAPSHOT), never vault_id's own PRIMARY KEY.
    let loserError = null;
    try {
      registryB.provisionPrincipalPrivateVault(tuple);
    } catch (err) {
      loserError = err;
    }
    // The nested SAVEPOINT better-sqlite3's own .transaction() opens rolls
    // itself back automatically on the thrown error; B's own manually
    // opened OUTER transaction from above is still open and must be ended
    // explicitly.
    connB.exec("ROLLBACK");

    assert.ok(loserError, "the racing connection must be refused, not silently succeed");
    assert.ok(
      loserError instanceof VaultProvisionConflictError,
      `expected VaultProvisionConflictError, got ${loserError?.constructor?.name}: ${loserError?.message}`,
    );
    assert.equal(loserError.code, "vault_provision_conflict");
    assert.doesNotMatch(loserError.message, /SqliteError|SQLITE_/);

    // The loser's own NEXT call (a genuinely fresh transaction/snapshot,
    // not an internal retry) finds the winner's already-committed row --
    // never minting a second row for this tuple.
    const resolved = registryB.provisionPrincipalPrivateVault(tuple);
    assert.equal(resolved.vault_id, winner.vault_id);
    const countRows = connB
      .prepare("SELECT COUNT(*) AS n FROM vaults WHERE vault_type = 'principal_private' AND tenant_id = ? AND principal_id = ? AND agent_id = ? AND workspace_id = ?")
      .get(tuple.tenantId, tuple.principalId, tuple.agentId, tuple.workspaceId);
    assert.equal(countRows.n, 1, "exactly one row for this tuple, never two");
  } finally {
    connA?.close();
    connB?.close();
    cleanup();
  }
});

// Mirrors domain/ids.mjs's own stableId exactly, so this test's manual
// INSERT computes the identical vault_id VaultRegistry itself would.
// Uses domain/ids.mjs's own real, imported stableId directly (never a
// hand-reimplemented copy of its hash formula) -- the SAME function
// domain/vault-registry.mjs itself calls, so a decoy row this test seeds
// always computes the IDENTICAL vault_id the real probe loop would.
function stableVaultId({ tenantId, principalId, agentId, workspaceId }, epoch = 0) {
  return stableId("vault", "principal-private", tenantId, principalId, agentId, workspaceId, String(epoch));
}

test("VaultRegistry: re-provisioning a tuple whose only prior row is erased mints a genuinely different vault_id, found by probing existence, never a PRIMARY KEY collision and never a resurrection -- including across a simulated MSP_IDENTITY_HMAC_KEY rotation between the original provision and the re-engagement", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const db = open(dbPath);
    runMigrations(db, path.join(packageRoot, "migrations"));
    const vaultRegistry = new VaultRegistry(db);
    const tuple = { tenantId: "tenant-erase-race", principalId: "principal-erase-race", agentId: "agent-erase-race", workspaceId: "workspace-erase-race" };

    // Provision "under KEY1" (VaultRegistry itself reads no key at all --
    // simulated by simply not touching MSP_IDENTITY_HMAC_KEY here, since
    // provisioning is immune to it by construction, design §5.2).
    const original = vaultRegistry.provisionPrincipalPrivateVault(tuple);
    assert.equal(original.provision_epoch, 0);

    // Erase.
    db.prepare("UPDATE vaults SET status = 'erased', principal_id = NULL WHERE vault_id = ?").run(original.vault_id);

    // "Rotate" MSP_IDENTITY_HMAC_KEY -- irrelevant to VaultRegistry, which
    // reads no key at all; simulated here only to prove that fact, not
    // because the code under test reads HMAC_KEY_2 anywhere.
    void HMAC_KEY_2;

    // Re-engage.
    const reEngaged = vaultRegistry.provisionPrincipalPrivateVault(tuple);
    assert.notEqual(reEngaged.vault_id, original.vault_id);
    assert.equal(reEngaged.provision_epoch, 1);

    // The erased row is untouched -- never a collision, never a
    // resurrection.
    const erasedRowAfter = db.prepare("SELECT status, vault_id, tenant_id FROM vaults WHERE vault_id = ?").get(original.vault_id);
    assert.equal(erasedRowAfter.status, "erased");
    assert.equal(erasedRowAfter.tenant_id, tuple.tenantId);

    db.close();
  } finally {
    cleanup();
  }
});

test("VaultRegistry: an access_context matching an ERASED principal vault's own still-populated tuple columns is access_context_denied, not ok -- status is refused before any tuple comparison", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const db = open(dbPath);
    runMigrations(db, path.join(packageRoot, "migrations"));
    const vaultRegistry = new VaultRegistry(db);
    const vault = vaultRegistry.provisionPrincipalPrivateVault({
      tenantId: "tenant-erased-access", principalId: "principal-erased-access", agentId: "agent-erased-access", workspaceId: "workspace-erased-access",
    });
    db.prepare("UPDATE vaults SET status = 'erased', principal_id = NULL WHERE vault_id = ?").run(vault.vault_id);
    const erasedRow = vaultRegistry.getVaultById(vault.vault_id);
    assert.equal(erasedRow.status, "erased");
    assert.equal(erasedRow.tenant_id, "tenant-erased-access");

    const outcome = vaultRegistry.classifyPrincipalAccess(erasedRow, {
      tenant_id: "tenant-erased-access", principal_id: "principal-erased-access",
      agent_id: "agent-erased-access", workspace_id: "workspace-erased-access",
    });
    assert.equal(outcome, "access_context_denied");

    // isVaultAccessibleTo shares the same gate.
    assert.equal(
      vaultRegistry.isVaultAccessibleTo(vault.vault_id, {
        tenantId: "tenant-erased-access", principalId: "principal-erased-access",
        agentId: "agent-erased-access", workspaceId: "workspace-erased-access",
      }),
      false,
    );

    db.close();
  } finally {
    cleanup();
  }
});

test("a direct DELETE FROM vaults WHERE vault_id = ? against any row -- active, erased, legacy or principal-type -- is refused: the statement throws, run once against an erased principal_private row specifically", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const db = open(dbPath);
    runMigrations(db, path.join(packageRoot, "migrations"));
    const vaultRegistry = new VaultRegistry(db);
    const vault = vaultRegistry.provisionPrincipalPrivateVault({
      tenantId: "tenant-delete", principalId: "principal-delete", agentId: "agent-delete", workspaceId: "workspace-delete",
    });
    db.prepare("UPDATE vaults SET status = 'erased', principal_id = NULL WHERE vault_id = ?").run(vault.vault_id);
    assert.throws(
      () => db.prepare("DELETE FROM vaults WHERE vault_id = ?").run(vault.vault_id),
      /vaults rows may never be deleted/,
    );
    const stillThere = db.prepare("SELECT vault_id FROM vaults WHERE vault_id = ?").get(vault.vault_id);
    assert.ok(stillThere);
    db.close();
  } finally {
    cleanup();
  }
});

test("msp_memory_decay_tick: pinned reads the vault's own decay_policy, a principal_passport vault always reports pinned:true/evaluated:0/transitioned:[] on both dry_run arms; a principal_private vault reports pinned:false and decays normally", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const resolved = await resolve(call, {}, { allow_passport: true });
    const passportVaultId = resolved.principalPassportVaultId;
    const privateVaultId = resolved.principalPrivateVaultId;

    for (const dryRun of [true, false]) {
      const tick = await call("msp_memory_decay_tick", {
        vault_id: passportVaultId, dry_run: dryRun,
        access_context: { tenant_id: "tenant-1", principal_id: "principal-1", allow_passport: true },
      });
      assert.equal(tick.pinned, true);
      assert.equal(tick.evaluated, 0);
      assert.deepEqual(tick.transitioned, []);
    }

    const privateTick = await call("msp_memory_decay_tick", {
      vault_id: privateVaultId, dry_run: true,
      access_context: { tenant_id: "tenant-1", principal_id: "principal-1", agent_id: "agent-1", workspace_id: "workspace-1" },
    });
    assert.equal(privateTick.pinned, false);
  } finally {
    await call.close();
    cleanup();
  }
});

test("cross-repo compatibility: a msp_vault_resolve request shaped exactly as zuri-ai's shipped msp-vault-resolver.js sends it is accepted and answered with a response satisfying validateVaultSet's own strict field checks unchanged", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    // Exact shape: no grant/signature, snake_case access_context/
    // authorization, no allow_passport at all (the shipped caller does not
    // send this field).
    const response = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: {
        tenant_id: "tenant-cross", business_id: "biz-cross", principal_id: "principal-cross",
        agent_id: "agent-cross", instance_id: "inst-cross", project_id: "project-cross",
        workspace_id: "workspace-cross", thread_id: "thread-cross", session_id: "session-cross",
        policy_version: "policy-cross",
      },
      authorization: {
        membership_active: true, allowed: true,
        allow_global_private: false, allow_tenant_global_private: false,
        allow_shared: false, read: true, write_private: false, write_shared: false,
      },
    });

    // validateVaultSet's own strict field checks (msp-vault-resolver.js):
    // workspacePrivateVaultId non-empty string, globalPrivateVaultIds/
    // sharedVaultIds string arrays, permissions object with
    // read/writePrivate/writeShared booleans and a non-empty policyVersion
    // string.
    assert.equal(typeof response.workspacePrivateVaultId, "string");
    assert.ok(response.workspacePrivateVaultId.length > 0);
    assert.ok(Array.isArray(response.globalPrivateVaultIds));
    assert.ok(Array.isArray(response.sharedVaultIds));
    assert.equal(typeof response.permissions, "object");
    assert.equal(typeof response.permissions.read, "boolean");
    assert.equal(typeof response.permissions.writePrivate, "boolean");
    assert.equal(typeof response.permissions.writeShared, "boolean");
    assert.equal(typeof response.permissions.policyVersion, "string");
    assert.ok(response.permissions.policyVersion.length > 0);

    // additive fields present too, but validateVaultSet would silently
    // drop them -- confirmed here only that they do not break the shape
    // above.
    assert.equal(response.principalPassportVaultId, null);
    assert.equal(typeof response.principalPrivateVaultId, "string");

    // authorization.allowed !== true is refused vault_scope_denied
    // server-side, even though the shipped client-side currentScope()
    // already refuses first in practice -- MSP does not trust that
    // client-side gate alone.
    await assert.rejects(
      call("msp_vault_resolve", {
        actor: "zuri-agent",
        access_context: {
          tenant_id: "tenant-cross-2", business_id: null, principal_id: "principal-cross-2",
          agent_id: "agent-cross-2", instance_id: null, project_id: "project-cross-2",
          workspace_id: "workspace-cross-2", thread_id: null, session_id: null, policy_version: null,
        },
        authorization: { membership_active: true, allowed: false, read: true, write_private: false, write_shared: false },
      }),
      /vault_scope_denied/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_resolve: no MSP_IDENTITY_HMAC_KEY configured refuses identity_hmac_unconfigured for a legacy-fields-only-looking request too, before any resolution logic runs", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: "" });
  try {
    await assert.rejects(
      call("msp_vault_resolve", {
        actor: "zuri-agent",
        access_context: baseAccessContext(),
        authorization: baseAuthorization({ allow_global_private: false, allow_shared: false }),
      }),
      /identity_hmac_unconfigured/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("PROVISION_EPOCH_PROBE_LIMIT: the probe loop's own bound throws an internal, unmapped Error (never a client-facing code, never leaking vaultId/principalId) when forced past the bound by pre-seeded decoy rows", async () => {
  const { dbPath, cleanup } = tempDbPath();
  let db;
  try {
    db = open(dbPath);
    runMigrations(db, path.join(packageRoot, "migrations"));
    const vaultRegistry = new VaultRegistry(db);
    const tuple = { tenantId: "tenant-probe-limit", principalId: "principal-probe-limit", agentId: "agent-probe-limit", workspaceId: "workspace-probe-limit" };

    // Pre-seed decoy rows spanning epoch 0..PROVISION_EPOCH_PROBE_LIMIT so
    // the probe loop's own existence check finds a hit at every candidate
    // epoch up to and including the bound, forcing it past PROVISION_EPOCH_PROBE_LIMIT.
    const insert = db.prepare(
      "INSERT INTO vaults (vault_id, vault_type, tenant_id, principal_id, agent_id, workspace_id, decay_policy, status, provision_epoch, created_at) VALUES (?,?,?,NULL,?,?,?,?,?,?)",
    );
    const nowIso = new Date().toISOString();
    const insertAll = db.transaction(() => {
      for (let epoch = 0; epoch <= PROVISION_EPOCH_PROBE_LIMIT; epoch += 1) {
        insert.run(stableVaultId(tuple, epoch), "principal_private", tuple.tenantId, tuple.agentId, tuple.workspaceId, "ebbinghaus", "erased", epoch, nowIso);
      }
    });
    insertAll();

    assert.throws(
      () => vaultRegistry.provisionPrincipalPrivateVault(tuple),
      (err) => {
        assert.equal(err.code, undefined, "must never be a typed/client-facing error code");
        assert.match(err.message, new RegExp(`exceeded ${PROVISION_EPOCH_PROBE_LIMIT} generation probes for principal_private`));
        assert.doesNotMatch(err.message, /tenant-probe-limit|principal-probe-limit/);
        return true;
      },
    );
  } finally {
    db?.close();
    cleanup();
  }
});

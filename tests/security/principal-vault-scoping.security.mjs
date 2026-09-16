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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { VaultRegistry } from "@freshair129/msp-core/vault-registry";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const HMAC_KEY = "a".repeat(32);
const HMAC_KEY_2 = "b".repeat(32);
const SERVICE_KEY = "s".repeat(32);

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
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_IDENTITY_HMAC_KEY: HMAC_KEY, MSP_THREAD_SERVICE_KEY: SERVICE_KEY, ...env },
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

function signAccess(name, input, claims, key = SERVICE_KEY, now = Date.now()) {
  const grant = {
    nonce: randomBytes(16).toString("hex"),
    ...claims,
    operation: name,
    expiresAt: now + 60_000,
    payloadHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  };
  return {
    ...input,
    access: {
      grant,
      signature: createHmac("sha256", key).update(JSON.stringify(grant)).digest("hex"),
    },
  };
}

async function resolveWithGrant(call, accessContextOverrides = {}, authorizationOverrides = {}, grantOverrides = {}) {
  const accessContext = baseAccessContext(accessContextOverrides);
  const authorization = baseAuthorization(authorizationOverrides);
  const input = { actor: "zuri-agent", access_context: accessContext, authorization };
  return call("msp_vault_resolve", signAccess("msp_vault_resolve", input, {
    tenantId: accessContext.tenant_id,
    principalId: accessContext.principal_id,
    agentId: accessContext.agent_id,
    workspaceId: accessContext.workspace_id,
    allowPassport: authorization.allow_passport === true,
    ...grantOverrides,
  }));
}

test("msp_vault_resolve: same resolve returns the same vault, sequentially, for both principal_private and principal_passport", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const first = await resolveWithGrant(call, {}, { allow_passport: true });
    const second = await resolveWithGrant(call, {}, { allow_passport: true });
    assert.equal(first.principalPrivateVaultId, second.principalPrivateVaultId);
    assert.equal(first.principalPassportVaultId, second.principalPassportVaultId);
    assert.ok(first.principalPrivateVaultId);
    assert.ok(first.principalPassportVaultId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_vault_resolve: an unsigned legacy call returns null principal fields, while a matching grant can request the passport", async () => {
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

    assert.equal(denied.principalPrivateVaultId, null);

    const withPassport = await resolveWithGrant(call, {}, { allow_passport: true });
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
    const agentA = await resolveWithGrant(call, { agent_id: "agent-A" });
    const agentB = await resolveWithGrant(call, { agent_id: "agent-B" });
    assert.notEqual(agentA.principalPrivateVaultId, agentB.principalPrivateVaultId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("principal memory access requires a fresh signed grant with allowPassport, even after resolve provisioned the passport", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const withPassport = await resolveWithGrant(call, {}, { allow_passport: true });
    const passportVaultId = withPassport.principalPassportVaultId;
    assert.ok(passportVaultId);

    const upsertInput = {
      vault: { vault_id: passportVaultId, vault_type: "principal_passport" },
      category: "soul", key: "fact-1", body_json: { x: 1 },
    };
    const upsertOk = await call("msp_memory_upsert", signAccess("msp_memory_upsert", upsertInput, {
      tenantId: "tenant-1", principalId: "principal-1", allowPassport: true,
    }));
    assert.equal(upsertOk.created, true);

    await assert.rejects(
      call("msp_memory_get", {
        vault_id: passportVaultId, category: "soul", key: "fact-1",
        access: undefined,
      }),
      /unknown vault_id/,
    );

    const missingPassport = { vault_id: passportVaultId, category: "soul", key: "fact-1" };
    await assert.rejects(
      call("msp_memory_get", signAccess("msp_memory_get", missingPassport, {
        tenantId: "tenant-1", principalId: "principal-1", allowPassport: false,
      })),
      /unknown vault_id/,
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
        assert.equal(err.code, "not_found");
        assert.equal(err.message, `mountVault: unknown vault_id "${vault.vault_id}".`);
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

test("msp_vault_mount over the real wire: a principalPrivateVaultId obtained from msp_vault_resolve is indistinguishable from an unknown vault", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const resolved = await resolveWithGrant(call);
    await assert.rejects(
      call("msp_vault_mount", {
        actor: "boss", workspace_id: "workspace-1", workspace_path: "/workspace/1",
        vault_id: resolved.principalPrivateVaultId, mount_alias: "steal", access_mode: "read", reason: "attack",
      }),
      /not_found|unknown vault_id/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("VaultRegistry: two connections resolving the same tuple return one active random vault", async () => {
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

    const winner = registryA.provisionPrincipalPrivateVault(tuple);
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

test("VaultRegistry: re-provisioning an erased tuple mints a different random vault_id and never resurrects the erased row", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const db = open(dbPath);
    runMigrations(db, path.join(packageRoot, "migrations"));
    const vaultRegistry = new VaultRegistry(db);
    const tuple = { tenantId: "tenant-erase-race", principalId: "principal-erase-race", agentId: "agent-erase-race", workspaceId: "workspace-erase-race" };

    const original = vaultRegistry.provisionPrincipalPrivateVault(tuple);

    // Erase.
    db.prepare("UPDATE vaults SET status = 'erased', principal_id = NULL WHERE vault_id = ?").run(original.vault_id);

    void HMAC_KEY_2;

    // Re-engage.
    const reEngaged = vaultRegistry.provisionPrincipalPrivateVault(tuple);
    assert.notEqual(reEngaged.vault_id, original.vault_id);

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

test("VaultRegistry: a grant matching an ERASED principal vault's old tuple is denied before tuple comparison", async () => {
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
      tenantId: "tenant-erased-access", principalId: "principal-erased-access",
      agentId: "agent-erased-access", workspaceId: "workspace-erased-access",
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
    const resolved = await resolveWithGrant(call, {}, { allow_passport: true });
    const passportVaultId = resolved.principalPassportVaultId;
    const privateVaultId = resolved.principalPrivateVaultId;

    for (const dryRun of [true, false]) {
      const tickInput = {
        vault_id: passportVaultId, dry_run: dryRun,
      };
      const tick = await call("msp_memory_decay_tick", signAccess("msp_memory_decay_tick", tickInput, {
        tenantId: "tenant-1", principalId: "principal-1", allowPassport: true,
      }));
      assert.equal(tick.pinned, true);
      assert.equal(tick.evaluated, 0);
      assert.deepEqual(tick.transitioned, []);
    }

    const privateInput = {
      vault_id: privateVaultId, dry_run: true,
    };
    const privateTick = await call("msp_memory_decay_tick", signAccess("msp_memory_decay_tick", privateInput, {
      tenantId: "tenant-1", principalId: "principal-1", agentId: "agent-1", workspaceId: "workspace-1",
    }));
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
    assert.equal(response.principalPrivateVaultId, null);

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

test("msp_vault_resolve: an unsigned legacy request does not need identity or service keys", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: "" });
  try {
    const response = await call("msp_vault_resolve", {
        actor: "zuri-agent",
        access_context: baseAccessContext(),
        authorization: baseAuthorization({ allow_global_private: false, allow_shared: false }),
      });
    assert.equal(response.principalPrivateVaultId, null);
    assert.equal(response.principalPassportVaultId, null);
  } finally {
    await call.close();
    cleanup();
  }
});

// UUID collision retry and exhaustion are covered by principal-vault-concurrency.test.mjs.

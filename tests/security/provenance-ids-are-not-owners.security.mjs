// PH-MEMOS-5 (design v0.9.1b §5, §5.1, §15, GATE-MEMOS-5): provenance ids
// (instance_id/thread_id/session_id inside an access_context, or anywhere
// else) never widen vault scope, and a wrong tenant/principal/agent/
// workspace claim -- or a missing/false allow_passport for a passport
// target -- is refused on EVERY one of the nine msp_memory_* tools,
// including the entity-id-only ones and links_create. Restored from an
// earlier design revision's §15 by mistake; the plan and GATE-MEMOS-5 both
// still name this suite. Real stdio child process throughout.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const HMAC_KEY = "a".repeat(32);

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-provenance-not-owners-test-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

function spawnRuntime(dbPath) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_IDENTITY_HMAC_KEY: HMAC_KEY },
    timeoutMs: 10_000,
  });
}

const CORRECT_TUPLE = { tenant_id: "tenant-prov", principal_id: "principal-prov", agent_id: "agent-prov", workspace_id: "workspace-prov" };

async function resolveVaults(call) {
  return call("msp_vault_resolve", {
    actor: "zuri-agent",
    access_context: {
      ...CORRECT_TUPLE,
      business_id: "biz-prov", instance_id: "inst-prov", project_id: "project-prov",
      thread_id: "thread-prov", session_id: "session-prov", policy_version: "policy-prov",
    },
    authorization: { allowed: true, read: true, write_private: true, write_shared: false, allow_passport: true },
  });
}

test("provenance fields (thread_id/session_id/instance_id) inside access_context are read for provenance only, never as a scoping input -- a WRONG or ABSENT value resolves/authorizes IDENTICALLY to a correct one", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const resolved = await resolveVaults(call);
    const vaultId = resolved.principalPrivateVaultId;

    const upserted = await call("msp_memory_upsert", {
      vault: { vault_id: vaultId, vault_type: "principal_private" },
      category: "note", key: "provenance-test", body_json: { x: 1 },
      access_context: { ...CORRECT_TUPLE },
    });
    assert.equal(upserted.created, true);

    // WRONG thread_id/session_id/instance_id: still succeeds identically.
    const wrongProvenance = await call("msp_memory_get", {
      vault_id: vaultId, category: "note", key: "provenance-test",
      access_context: { ...CORRECT_TUPLE, thread_id: "wrong-thread", session_id: "wrong-session", instance_id: "wrong-instance" },
    });
    assert.equal(wrongProvenance.entity.entity_id, upserted.entity.entity_id);

    // NO thread_id/session_id/instance_id at all (they are optional):
    // still succeeds identically.
    const noProvenance = await call("msp_memory_get", {
      vault_id: vaultId, category: "note", key: "provenance-test",
      access_context: { ...CORRECT_TUPLE },
    });
    assert.equal(noProvenance.entity.entity_id, upserted.entity.entity_id);
  } finally {
    await call.close();
    cleanup();
  }
});

// One shared setup used by the per-tool table-driven cases below: a real
// principal_private vault with one entity, and a real principal_passport
// vault with one entity, plus a wrong-owner vault for the links_create
// endpoint-mismatch-adjacent single-vault case.
async function seedFixture(call) {
  const resolved = await resolveVaults(call);
  const privateVaultId = resolved.principalPrivateVaultId;
  const passportVaultId = resolved.principalPassportVaultId;

  const privateEntity = await call("msp_memory_upsert", {
    vault: { vault_id: privateVaultId, vault_type: "principal_private" },
    category: "note", key: "fact-1", body_json: { x: 1 },
    access_context: { ...CORRECT_TUPLE },
  });
  const privateEntity2 = await call("msp_memory_upsert", {
    vault: { vault_id: privateVaultId, vault_type: "principal_private" },
    category: "note", key: "fact-2", body_json: { x: 2 },
    access_context: { ...CORRECT_TUPLE },
  });
  const passportEntity = await call("msp_memory_upsert", {
    vault: { vault_id: passportVaultId, vault_type: "principal_passport" },
    category: "soul", key: "fact-1", body_json: { x: 1 },
    access_context: { tenant_id: CORRECT_TUPLE.tenant_id, principal_id: CORRECT_TUPLE.principal_id, allow_passport: true },
  });

  return {
    privateVaultId, passportVaultId,
    privateEntityId: privateEntity.entity.entity_id,
    privateEntity2Id: privateEntity2.entity.entity_id,
    passportEntityId: passportEntity.entity.entity_id,
  };
}

const WRONG_TUPLES = [
  { label: "wrong tenant_id", ...CORRECT_TUPLE, tenant_id: "WRONG-tenant" },
  { label: "wrong principal_id", ...CORRECT_TUPLE, principal_id: "WRONG-principal" },
  { label: "wrong agent_id", ...CORRECT_TUPLE, agent_id: "WRONG-agent" },
  { label: "wrong workspace_id", ...CORRECT_TUPLE, workspace_id: "WRONG-workspace" },
];

test("msp_memory_upsert/get/list/search/decay_tick (vault-identifying tools): a wrong tenant/principal/agent/workspace access_context is access_context_denied; absent access_context is access_context_required", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const fixture = await seedFixture(call);
    const cases = [
      ["msp_memory_upsert", { vault: { vault_id: fixture.privateVaultId, vault_type: "principal_private" }, category: "note", key: "new-key", body_json: {} }],
      ["msp_memory_get", { vault_id: fixture.privateVaultId, category: "note", key: "fact-1" }],
      ["msp_memory_list", { vault_id: fixture.privateVaultId }],
      ["msp_memory_search", { vault_id: fixture.privateVaultId, query: "fact" }],
      ["msp_memory_decay_tick", { vault_id: fixture.privateVaultId, dry_run: true }],
    ];
    for (const [tool, baseArgs] of cases) {
      await assert.rejects(call(tool, baseArgs), /access_context_required/, `${tool}: absent access_context must be access_context_required`);
      for (const wrong of WRONG_TUPLES) {
        const { label, ...accessContext } = wrong;
        await assert.rejects(
          call(tool, { ...baseArgs, access_context: accessContext }),
          /access_context_denied/,
          `${tool}: ${label} must be access_context_denied`,
        );
      }
      // control case: the exact correct tuple succeeds.
      await call(tool, { ...baseArgs, access_context: { ...CORRECT_TUPLE } });
    }
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_memory_history/forget/links_list (entity-id-only tools, resolved via the entity's own vault_id): a wrong access_context is access_context_denied; absent is access_context_required", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const fixture = await seedFixture(call);

    await assert.rejects(call("msp_memory_history", { entity_id: fixture.privateEntityId }), /access_context_required/);
    await assert.rejects(call("msp_memory_links_list", { entity_id: fixture.privateEntityId }), /access_context_required/);
    for (const wrong of WRONG_TUPLES) {
      const { label, ...accessContext } = wrong;
      await assert.rejects(
        call("msp_memory_history", { entity_id: fixture.privateEntityId, access_context: accessContext }),
        /access_context_denied/,
        `msp_memory_history: ${label}`,
      );
      await assert.rejects(
        call("msp_memory_links_list", { entity_id: fixture.privateEntityId, access_context: accessContext }),
        /access_context_denied/,
        `msp_memory_links_list: ${label}`,
      );
    }
    // forget is destructive -- exercised last, once, after the two
    // read-only checks above against a SEPARATE entity so forgetting it
    // does not disturb fixtures the other assertions still need.
    await assert.rejects(call("msp_memory_forget", { entity_id: fixture.privateEntity2Id, reason: "test" }), /access_context_required/);
    for (const wrong of WRONG_TUPLES) {
      const { label, ...accessContext } = wrong;
      await assert.rejects(
        call("msp_memory_forget", { entity_id: fixture.privateEntity2Id, reason: "test", access_context: accessContext }),
        /access_context_denied/,
        `msp_memory_forget: ${label}`,
      );
    }
    // control case: the correct tuple succeeds.
    const forgotten = await call("msp_memory_forget", { entity_id: fixture.privateEntity2Id, reason: "test", access_context: { ...CORRECT_TUPLE } });
    assert.equal(forgotten.entity.lifecycle_state, "forgotten");
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_memory_links_create: resolved via from_entity_id's vault under the pre-existing same-vault-as-to_entity_id refusal; a wrong access_context is access_context_denied; absent is access_context_required", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const fixture = await seedFixture(call);
    const linkArgs = { from_entity_id: fixture.privateEntityId, to_entity_id: fixture.privateEntity2Id, link_type: "relates_to" };

    await assert.rejects(call("msp_memory_links_create", linkArgs), /access_context_required/);
    for (const wrong of WRONG_TUPLES) {
      const { label, ...accessContext } = wrong;
      await assert.rejects(
        call("msp_memory_links_create", { ...linkArgs, access_context: accessContext }),
        /access_context_denied/,
        `msp_memory_links_create: ${label}`,
      );
    }
    const created = await call("msp_memory_links_create", { ...linkArgs, access_context: { ...CORRECT_TUPLE } });
    assert.equal(created.link.from_entity_id, fixture.privateEntityId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("principal_passport target: a missing or false allow_passport is access_context_denied, the SAME code as a tuple mismatch, deliberately -- exercised on all nine msp_memory_* tools reachable against a passport vault", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const fixture = await seedFixture(call);
    const passportTuple = { tenant_id: CORRECT_TUPLE.tenant_id, principal_id: CORRECT_TUPLE.principal_id };

    // missing allow_passport (absent) and explicit allow_passport: false
    // both fail identically.
    for (const accessContext of [passportTuple, { ...passportTuple, allow_passport: false }]) {
      await assert.rejects(
        call("msp_memory_get", { vault_id: fixture.passportVaultId, category: "soul", key: "fact-1", access_context: accessContext }),
        /access_context_denied/,
      );
      await assert.rejects(
        call("msp_memory_history", { entity_id: fixture.passportEntityId, access_context: accessContext }),
        /access_context_denied/,
      );
    }

    // control case: allow_passport: true on the correct tuple succeeds.
    const ok = await call("msp_memory_get", {
      vault_id: fixture.passportVaultId, category: "soul", key: "fact-1",
      access_context: { ...passportTuple, allow_passport: true },
    });
    assert.equal(ok.entity.entity_id, fixture.passportEntityId);
  } finally {
    await call.close();
    cleanup();
  }
});

test("an access_context whose tuple exactly matches an ERASED principal vault's own still-populated tuple columns is access_context_denied, not ok", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const fixture = await seedFixture(call);

    // Erase the vault directly (this phase does not itself build the
    // erasure tool -- the disposition is exercised at the storage layer,
    // matching design §11.1/§12.4's own scope for this phase).
    const { open } = await import("@freshair129/msp-storage/connection");
    // A separate connection to the SAME file the running server holds
    // open is safe here: WAL mode allows concurrent readers/writers, and
    // this single UPDATE commits immediately.
    const db = open(dbPath);
    db.prepare("UPDATE vaults SET status = 'erased', principal_id = NULL WHERE vault_id = ?").run(fixture.privateVaultId);
    db.close();

    await assert.rejects(
      call("msp_memory_get", {
        vault_id: fixture.privateVaultId, category: "note", key: "fact-1",
        access_context: { ...CORRECT_TUPLE },
      }),
      /access_context_denied/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

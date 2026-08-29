// AC-01 (WP-17): a link whose endpoints are in two different vaults must be
// rejected. Security-relevant per this packet's own acceptance criteria;
// runs against the REAL stdio child process, mirroring
// test/memory-search-vault-scoping.security.mjs's convention.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-links-vault-scoping-test-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup (Windows file-lock race on child process exit)
      }
    },
  };
}

function spawnRuntime(dbPath) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 10_000,
  });
}

async function provisionVault(call, workspaceId) {
  await call("msp_workspace_register", {
    actor: "boss",
    workspace_id: workspaceId,
    project_id: null,
    workspace_path: `/workspace/${workspaceId}`,
  });
  const status = await call("msp_vault_status", {
    actor: "boss",
    workspace_id: workspaceId,
    workspace_path: `/workspace/${workspaceId}`,
    agent_id: null,
  });
  return status.vaults.find((v) => v.vault_type === "workspace_private").vault_id;
}

async function upsert(call, vaultId, key) {
  const result = await call("msp_memory_upsert", {
    vault: { vault_id: vaultId, vault_type: "workspace_private" },
    category: "note",
    key,
    body_json: {},
  });
  return result.entity.entity_id;
}

test("AC-01: msp_memory_links_create rejects a link whose two endpoints belong to different vaults", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-links-a");
    const vaultB = await provisionVault(call, "workspace-links-b");
    const entityA = await upsert(call, vaultA, "entity-a");
    const entityB = await upsert(call, vaultB, "entity-b");

    await assert.rejects(
      call("msp_memory_links_create", { from_entity_id: entityA, to_entity_id: entityB, link_type: "relates_to" }),
      /vault_scope_denied|different vaults/i,
      "FAIL-CLOSED VIOLATION: a cross-vault link was accepted",
    );
    await assert.rejects(
      call("msp_memory_links_create", { from_entity_id: entityB, to_entity_id: entityA, link_type: "relates_to" }),
      /vault_scope_denied|different vaults/i,
    );

    // No row was written by the rejected attempts.
    call.close();
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT COUNT(*) AS count FROM links").get();
      assert.strictEqual(rows.count, 0, "a rejected cross-vault link must not persist a row");
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("AC-01 control case: a same-vault link is still accepted (the guard is not over-broad)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-links-control-a");
    const entityA1 = await upsert(call, vaultA, "entity-a1");
    const entityA2 = await upsert(call, vaultA, "entity-a2");

    const result = await call("msp_memory_links_create", { from_entity_id: entityA1, to_entity_id: entityA2, link_type: "relates_to" });
    assert.deepStrictEqual(result, { link: { from_entity_id: entityA1, to_entity_id: entityA2, link_type: "relates_to" } });
  } finally {
    call.close();
    cleanup();
  }
});

test("msp_memory_links_list is vault-scoped through its entity_id -- vault B's same-(category, key) twin entities expose none of vault A's links", async () => {
  // memory-handlers.mjs's msp_memory_links_list carries a code-comment
  // argument instead of a test: "entity_id already uniquely, non-forgeably
  // determines its vault (computeEntityId folds vault_id into the hash),
  // and every link row was itself vault-checked at create time". This test
  // turns that argument into an executable proof: give vault B entities
  // with the SAME (category, key) names as vault A's linked entities --
  // the strongest identifier collision a vault-B caller can construct on
  // the wire -- and show that listing through them yields nothing of
  // vault A's, precisely because the same names in a different vault mint
  // different entity_ids.
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-links-list-a");
    const vaultB = await provisionVault(call, "workspace-links-list-b");
    const entityA1 = await upsert(call, vaultA, "link-twin-1");
    const entityA2 = await upsert(call, vaultA, "link-twin-2");
    const entityB1 = await upsert(call, vaultB, "link-twin-1");
    const entityB2 = await upsert(call, vaultB, "link-twin-2");

    // The non-forgeability premise itself, proven on the wire: identical
    // (category, key) in two vaults never collides on entity_id.
    assert.notEqual(entityB1, entityA1);
    assert.notEqual(entityB2, entityA2);

    // A link exists in vault A only.
    await call("msp_memory_links_create", { from_entity_id: entityA1, to_entity_id: entityA2, link_type: "relates_to" });

    // Vault B's twins see an empty link set, in every direction.
    for (const direction of ["outgoing", "incoming", "both"]) {
      const viaB1 = await call("msp_memory_links_list", { entity_id: entityB1, direction });
      assert.deepStrictEqual(
        viaB1.links,
        [],
        `FAIL-CLOSED VIOLATION: vault A's link leaked through vault B's twin entity (direction=${direction})`,
      );
      const viaB2 = await call("msp_memory_links_list", { entity_id: entityB2, direction });
      assert.deepStrictEqual(viaB2.links, []);
    }

    // Control case: vault A's own entity does list its link, and every
    // endpoint it returns is a vault A entity_id -- never vault B's twin.
    const viaA1 = await call("msp_memory_links_list", { entity_id: entityA1, direction: "both" });
    assert.deepStrictEqual(viaA1.links, [{ from_entity_id: entityA1, to_entity_id: entityA2, link_type: "relates_to" }]);

    // A forged/unknown entity_id fails closed as not_found rather than
    // returning an empty-but-plausible listing for a handle that names
    // nothing.
    await assert.rejects(
      call("msp_memory_links_list", { entity_id: "msp:entity/ffffffffffffffffffffffff" }),
      /no memory entity found/i,
    );

    // Direct DB proof that the wire behavior rests on vault-scoped rows,
    // not luck: the only link row is vault A's.
    call.close();
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT vault_id, from_entity_id, to_entity_id FROM links").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].vault_id, vaultA);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

// msp_memory_upsert as the ATTACK, not the setup. Every other
// *.security.mjs file in this suite uses msp_memory_upsert only to plant
// fixtures before attacking a read/search/forget/link path; none of them
// pointed the attacker at the write path itself. This file closes that gap
// at the wire level (real stdio child process, per this suite's
// convention): a caller writing through vault B must never overwrite,
// version-bump, or otherwise mutate vault A's row for the same
// (category, key) -- the UNIQUE(vault_id, category, key) schema constraint
// is the mechanism, but the proof here is observed behavior through the
// real server, not trust in the schema.
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
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-upsert-vault-scoping-test-"));
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

test("an upsert through vault B never overwrites or shadows vault A's same-(category, key) row -- wire-level", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const vaultA = await provisionVault(call, "workspace-upsert-victim-a");
    const vaultB = await provisionVault(call, "workspace-upsert-attacker-b");

    // Victim writes the row the attacker will aim at.
    const victim = await call("msp_memory_upsert", {
      vault: { vault_id: vaultA, vault_type: "workspace_private" },
      category: "secret",
      key: "takeover-key",
      body_json: { summary: "victim original body", owner: "vault-a" },
    });
    assert.equal(victim.created, true);
    const victimEntityId = victim.entity.entity_id;
    const victimSourceHash = victim.entity.source_hash;

    // Attacker upserts the SAME (category, key) through vault B with a
    // hostile body. If vault scoping were broken -- an upsert resolving by
    // (category, key) alone, or entity_ids colliding across vaults -- this
    // would arrive as changed:true against vault A's row instead of
    // created:true in vault B.
    const attack = await call("msp_memory_upsert", {
      vault: { vault_id: vaultB, vault_type: "workspace_private" },
      category: "secret",
      key: "takeover-key",
      body_json: { summary: "ATTACKER OVERWRITE", owner: "vault-b" },
    });
    assert.equal(attack.created, true, "the attacker's write must mint vault B's OWN new row, never update an existing one");
    assert.notEqual(attack.entity.entity_id, victimEntityId, "same (category, key) in another vault must mint a different entity_id");
    assert.equal(attack.entity.vault_id, vaultB);

    // Vault A's row after the attack: same entity, same body, same version,
    // same source hash -- byte-for-byte undisturbed.
    const afterAttack = await call("msp_memory_get", { vault_id: vaultA, category: "secret", key: "takeover-key" });
    assert.equal(afterAttack.entity.entity_id, victimEntityId);
    assert.equal(
      afterAttack.entity.body_json.summary,
      "victim original body",
      "FAIL-CLOSED VIOLATION: vault B's upsert overwrote vault A's body",
    );
    assert.equal(afterAttack.entity.current_version, victim.entity.current_version, "vault A's version must not advance from a vault B write");
    assert.equal(afterAttack.entity.source_hash, victimSourceHash);

    // Repeated attacker writes (an update in vault B this time) still never
    // ripple into vault A.
    const attackAgain = await call("msp_memory_upsert", {
      vault: { vault_id: vaultB, vault_type: "workspace_private" },
      category: "secret",
      key: "takeover-key",
      body_json: { summary: "ATTACKER OVERWRITE v2", owner: "vault-b" },
    });
    assert.equal(attackAgain.created, false);
    assert.equal(attackAgain.changed, true);
    const { history: victimHistory } = await call("msp_memory_history", { entity_id: victimEntityId });
    assert.equal(victimHistory.length, 1, "vault A's history must show exactly the victim's original write and nothing else");
    assert.ok(victimHistory.every((entry) => entry.vault_id === vaultA));

    // Direct DB proof behind the wire behavior: two rows exist for the
    // contested (category, key), one per vault, and vault A's body is the
    // victim's original.
    call.close();
    const db = open(dbPath);
    try {
      const rows = db
        .prepare("SELECT vault_id, body_json FROM entities WHERE category = 'secret' AND key = 'takeover-key' ORDER BY vault_id")
        .all();
      assert.equal(rows.length, 2, "the attack must shadow into vault B's namespace, not replace vault A's row");
      const rowA = rows.find((row) => row.vault_id === vaultA);
      const rowB = rows.find((row) => row.vault_id === vaultB);
      assert.ok(rowA && rowB);
      assert.equal(JSON.parse(rowA.body_json).summary, "victim original body");
      assert.equal(JSON.parse(rowB.body_json).summary, "ATTACKER OVERWRITE v2");
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

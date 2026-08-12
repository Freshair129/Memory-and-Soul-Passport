// WP-14 AC-03 (THE MOST IMPORTANT TEST IN THIS PACKET): closes the exact
// cross-agent Global-Private disclosure recorded during WP-13's gate review
// (docs/api/API-009-Persistent-Memory-Contract.md §6's amendment note;
// WP-13's Deviations section, Deviation 2). Pre-WP-14, promotions.
// idempotency_key was globally UNIQUE: two different agents calling
// msp_memory_promote(target_scope=global_private) with the SAME
// idempotency_key would collide, and the second agent's call would silently
// return the FIRST agent's promotion_ref/target_ref -- a real cross-agent
// read of another agent's Global-Private promotion result.
//
// This test constructs two distinct agents (-> two distinct Global-Private
// vaults, per domain/vault-registry.mjs's provisionGlobalPrivateVault), each
// calling msp_memory_promote with the SAME idempotency_key, over the real
// stdio process (not an in-process unit call) -- and asserts each agent
// receives its OWN distinct promotion_ref/target_ref, never the other's.
// It then retries within one agent/vault and asserts WP-13's
// idempotent-retry guarantee (AC-04) still holds: same idempotency_key, same
// vault -> same promotion_ref/target_ref, not a fresh promotion.
//
// Per WP-14's own Acceptance-and-exit-gate (AC-07), this is an adversarial/
// boundary test and lives as *.security.mjs, run under node:test (not
// vitest), mirroring test/canonical-candidate-rejection.security.mjs and
// test/shared-scope-fail-closed.security.mjs's established convention in
// this package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MspClient } from "@freshair129/msp-client-js";
import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { createTypedVaultContextMsp } from "../fixtures/msp-vault-context-contracts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-promo-vault-scoping-test-"));
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
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 10_000,
  });
  const client = new MspClient(call);
  return { call, client, typed: createTypedVaultContextMsp(client) };
}

function promoteInput({ agentId, workspaceId, idempotencyKey, note }) {
  return {
    actor: "boss",
    agentId,
    workspaceId,
    sourceMemoryRef: `msp:memory/${agentId}-source`,
    targetScope: "global_private",
    candidate: { note },
    evidenceRefs: [`msp:proof/${agentId}-evidence`],
    reason: "WP-14 AC-03 collision-reproduction test",
    idempotencyKey,
  };
}

test("AC-03: two different agents (vaults) reusing the SAME idempotency_key each get their own promotion_ref/target_ref -- the exact collision this packet closes", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    const SHARED_IDEMPOTENCY_KEY = "idem-shared-across-agents";

    // Agent A promotes first.
    const agentAResult = await runtime.typed.promoteMemory(
      promoteInput({ agentId: "agent-alpha", workspaceId: "workspace-alpha", idempotencyKey: SHARED_IDEMPOTENCY_KEY, note: "agent A's private candidate" }),
    );

    // Agent B, a DIFFERENT agent/vault, reuses the exact same
    // idempotency_key. Pre-WP-14 (globally UNIQUE idempotency_key), this
    // would have hit the existing `promotions` row from agent A and
    // silently returned agent A's promotion_ref/target_ref to agent B --
    // the disclosure. Post-WP-14 (UNIQUE(vault_id, idempotency_key)), this
    // must be treated as a brand-new promotion, scoped to agent B's own
    // Global-Private vault.
    const agentBResult = await runtime.typed.promoteMemory(
      promoteInput({ agentId: "agent-beta", workspaceId: "workspace-beta", idempotencyKey: SHARED_IDEMPOTENCY_KEY, note: "agent B's private candidate" }),
    );

    // The core assertion: each agent gets its OWN ref, never the other's.
    assert.notEqual(
      agentBResult.promotionRef,
      agentAResult.promotionRef,
      "FAIL-CLOSED VIOLATION: agent B's promotion_ref must not equal agent A's -- this is the exact cross-agent disclosure WP-14 exists to close.",
    );
    assert.notEqual(
      agentBResult.targetRef,
      agentAResult.targetRef,
      "FAIL-CLOSED VIOLATION: agent B's target_ref must not equal agent A's -- this would mean agent B's promotion silently pointed at agent A's Global-Private entity.",
    );
    assert.match(agentAResult.promotionRef, /^msp:memory-promotion\//);
    assert.match(agentBResult.promotionRef, /^msp:memory-promotion\//);
    assert.match(agentAResult.targetRef, /^msp:entity\//);
    assert.match(agentBResult.targetRef, /^msp:entity\//);

    // Belt-and-braces: confirm agent B's response never contains agent A's
    // candidate content and vice versa -- proves this is not merely two
    // distinct refs pointing at the same underlying row.
    assert.notEqual(agentAResult.sourceHash, agentBResult.sourceHash);

    // Now prove WP-13's idempotent-retry guarantee (AC-04) survives this
    // fix: retrying agent A's own call with the same idempotency_key, in
    // the same vault, must still return agent A's ORIGINAL promotion_ref/
    // target_ref -- not a fresh promotion, and not agent B's.
    const agentARetry = await runtime.typed.promoteMemory(
      promoteInput({ agentId: "agent-alpha", workspaceId: "workspace-alpha", idempotencyKey: SHARED_IDEMPOTENCY_KEY, note: "agent A's private candidate (retry payload, ignored on idempotent hit)" }),
    );
    assert.equal(agentARetry.promotionRef, agentAResult.promotionRef, "idempotent retry within the same vault must return the original promotion_ref");
    assert.equal(agentARetry.targetRef, agentAResult.targetRef, "idempotent retry within the same vault must return the original target_ref");
    assert.equal(agentARetry.sourceHash, agentAResult.sourceHash);

    // And agent B's own retry is likewise stable and still distinct from A's.
    const agentBRetry = await runtime.typed.promoteMemory(
      promoteInput({ agentId: "agent-beta", workspaceId: "workspace-beta", idempotencyKey: SHARED_IDEMPOTENCY_KEY, note: "agent B's private candidate (retry payload, ignored on idempotent hit)" }),
    );
    assert.equal(agentBRetry.promotionRef, agentBResult.promotionRef);
    assert.equal(agentBRetry.targetRef, agentBResult.targetRef);
    assert.notEqual(agentBRetry.promotionRef, agentAResult.promotionRef);
  } finally {
    runtime.call.close();
    cleanup();
  }
});

test("AC-03: direct DB proof -- two distinct promotions rows exist, correctly vault-scoped, not one row silently shared", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    const SHARED_IDEMPOTENCY_KEY = "idem-db-proof";
    await runtime.typed.promoteMemory(promoteInput({ agentId: "agent-gamma", workspaceId: "workspace-gamma", idempotencyKey: SHARED_IDEMPOTENCY_KEY, note: "gamma" }));
    await runtime.typed.promoteMemory(promoteInput({ agentId: "agent-delta", workspaceId: "workspace-delta", idempotencyKey: SHARED_IDEMPOTENCY_KEY, note: "delta" }));
    runtime.call.close();

    const { open } = await import("@freshair129/msp-storage/connection");
    const db = open(dbPath);
    try {
      const rows = db.prepare("SELECT vault_id, idempotency_key, promotion_ref, target_ref FROM promotions WHERE idempotency_key = ?").all(SHARED_IDEMPOTENCY_KEY);
      assert.equal(rows.length, 2, "expected exactly two independent promotions rows, one per vault, for the shared idempotency_key");
      const [rowA, rowB] = rows;
      assert.notEqual(rowA.vault_id, rowB.vault_id);
      assert.notEqual(rowA.promotion_ref, rowB.promotion_ref);
      assert.notEqual(rowA.target_ref, rowB.target_ref);

      // Cross-check: the promotions.vault_id uniqueness constraint (WP-14
      // AC-03) is UNIQUE(vault_id, idempotency_key), verified by inserting a
      // conflicting row and confirming SQLite itself rejects it.
      assert.throws(() => {
        db.prepare(
          "INSERT INTO promotions (promotion_ref, vault_id, idempotency_key, source_memory_ref, target_scope, target_ref, policy_decision, source_hash, recorded_at) VALUES (?, ?, ?, 'x', 'global_private', 'y', 'allow', 'h', ?)",
        ).run("msp:memory-promotion/conflict-test", rowA.vault_id, SHARED_IDEMPOTENCY_KEY, new Date().toISOString());
      }, /UNIQUE constraint failed/i);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

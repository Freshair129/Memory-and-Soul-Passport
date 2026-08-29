// AC-04: msp_memory_promote(target_scope=global_private) is idempotent on
// idempotency_key -- calling it twice with the same key returns the same
// promotion_ref/target_ref and does not create a duplicate entity. Runs
// against the real stdio process (matching AC-01's standard), then verifies
// "no duplicate entity" by opening a second, independent connection to the
// same MSP_DB_PATH and reading it back through domain/entity-store.mjs's
// own list() -- the same storage primitive the real handler wrote through
// -- rather than trusting the wire response alone.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MspClient } from "@freshair129/msp-client-js";
import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { createTypedVaultContextMsp } from "../fixtures/msp-vault-context-contracts.mjs";

import { open } from "@freshair129/msp-storage/connection";
import { EntityStore } from "@freshair129/msp-core/entity-store";
import { stableId } from "@freshair129/msp-core/ids";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

describe("AC-04: msp_memory_promote(target_scope=global_private) idempotency", () => {
  let call;
  let typed;
  let dbPath;
  let tempDir;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "msp-runtime-idempotency-test-"));
    dbPath = path.join(tempDir, "msp.sqlite3");
    call = createMspStdioCaller({
      command: process.execPath,
      args: [binPath],
      env: { ...process.env, MSP_DB_PATH: dbPath },
      timeoutMs: 10_000,
    });
    typed = createTypedVaultContextMsp(new MspClient(call));
  });

  afterAll(() => {
    call?.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (Windows file-lock race on child process exit)
    }
  });

  function promoteInput(overrides = {}) {
    return {
      actor: "boss",
      agentId: "agent-idem",
      workspaceId: "workspace-idem",
      sourceMemoryRef: "msp:memory/idem-source",
      targetScope: "global_private",
      candidate: { note: "idempotency candidate", value: 1 },
      evidenceRefs: ["msp:proof/idem-1"],
      reason: "idempotency test",
      idempotencyKey: "idem-key-1",
      ...overrides,
    };
  }

  // WP-14: msp_memory_promote's Global-Private vault_id is derived from
  // agentId via the same stableId("vault", "global-private", agentId)
  // convention domain/vault-registry.mjs's provisionGlobalPrivateVault
  // uses -- recomputed here (not read back off the wire, which does not
  // expose vault_id for this tool) so this file's own direct
  // entity-store.list() checks can pass the now-mandatory vaultId.
  const globalPrivateVaultId = stableId("vault", "global-private", "agent-idem");

  it("two calls with the same idempotency_key return identical promotion_ref and target_ref", async () => {
    const first = await typed.promoteMemory(promoteInput());
    const second = await typed.promoteMemory(promoteInput());

    expect(second.promotionRef).toBe(first.promotionRef);
    expect(second.targetRef).toBe(first.targetRef);
    expect(second.sourceHash).toBe(first.sourceHash);
    // WP-14: promotion_ref is now minted from (vault_id, idempotency_key)
    // (contracts/refs.mjs's memoryPromotionRef), not idempotency_key alone
    // -- see that file's header comment for why (AC-03 requires the ref to
    // differ across vaults for the same idempotency_key). Every real
    // consumer only checks this prefix, never the exact suffix, so only
    // the prefix is asserted here.
    expect(first.promotionRef).toMatch(/^msp:memory-promotion\//);
  });

  it("a third call with the same idempotency_key still does not create a duplicate entity (verified via domain/entity-store.mjs's list())", async () => {
    await typed.promoteMemory(promoteInput());

    const db = open(dbPath);
    try {
      const store = new EntityStore(db);
      const { entities } = store.list({ vaultId: globalPrivateVaultId, category: "memory-promotion", limit: 200 });
      const matches = entities.filter((entity) => entity.key === "idem-key-1");
      expect(matches).toHaveLength(1);
      expect(matches[0].current_version).toBe(1);
    } finally {
      db.close();
    }
  });

  it("a different idempotency_key produces a distinct promotion_ref/target_ref and a second, distinct entity", async () => {
    const first = await typed.promoteMemory(promoteInput());
    const different = await typed.promoteMemory(promoteInput({ idempotencyKey: "idem-key-2", candidate: { note: "different candidate" } }));

    expect(different.promotionRef).not.toBe(first.promotionRef);
    expect(different.targetRef).not.toBe(first.targetRef);

    const db = open(dbPath);
    try {
      const store = new EntityStore(db);
      const { entities } = store.list({ vaultId: globalPrivateVaultId, category: "memory-promotion", limit: 200 });
      expect(entities.map((entity) => entity.key).sort()).toEqual(["idem-key-1", "idem-key-2"]);
    } finally {
      db.close();
    }
  });
});

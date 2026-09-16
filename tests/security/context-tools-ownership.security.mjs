// PH-MEMOS-5 (design v0.9.1b §5.4, §12.4.1, §15, GATE-MEMOS-5): scoped
// `contexts` receipts. msp_context_resolve's own write path actually
// persists a scoped row (both tenant_id/principal_id non-null) when given
// an access_context, and a legacy row (both null) when not;
// msp_context_diff/audit/replay each require a matching access_context for
// a scoped row they name, unaffected for a legacy row; msp_context_diff's
// include_payload is refused unconditionally for a scoped row, even with a
// correctly-matching access_context. Restored from an earlier design
// revision's §15 by mistake; the plan and GATE-MEMOS-5 both still name
// this suite. Real stdio child process throughout.
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
  const dir = mkdtempSync(path.join(tmpdir(), "msp-context-tools-ownership-test-"));
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
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 10_000,
  });
}

async function resolveContext(call, { accessContext = undefined, workspaceId = "workspace-ctx", agentId = "agent-ctx" } = {}) {
  return call("msp_context_resolve", {
    workspace_id: workspaceId,
    agent_id: agentId,
    workspace_root: "/workspace/ctx",
    ...(accessContext !== undefined ? { access_context: accessContext } : {}),
  });
}

test("msp_context_resolve write path: access_context persists a SCOPED contexts row (both columns non-null); no access_context persists a LEGACY row (both null) -- proven by a direct SELECT, not merely the read side", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const legacy = await resolveContext(call);
    const scoped = await resolveContext(call, { accessContext: { tenant_id: "tenant-ctx", principal_id: "principal-ctx" } });

    // Direct DB proof against the real persisted rows (write-path proof,
    // not read-side only): a separate connection is safe here, WAL mode
    // allows concurrent readers while the server still holds the file
    // open.
    const db = open(dbPath);
    try {
      const legacyRow = db.prepare("SELECT tenant_id, principal_id FROM contexts WHERE context_id = ?").get(legacy.context_id);
      assert.deepEqual(legacyRow, { tenant_id: null, principal_id: null });

      const scopedRow = db.prepare("SELECT tenant_id, principal_id FROM contexts WHERE context_id = ?").get(scoped.context_id);
      assert.deepEqual(scopedRow, { tenant_id: "tenant-ctx", principal_id: "principal-ctx" });
    } finally {
      db.close();
    }
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit/msp_context_replay: a LEGACY row (both columns null) is unaffected -- no access_context needed at all", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const legacy = await resolveContext(call);
    const audit = await call("msp_context_audit", { actor: "boss", context_id: legacy.context_id });
    assert.equal(audit.context_id, legacy.context_id);
    const replay = await call("msp_context_replay", { context_id: legacy.context_id });
    assert.equal(replay.context_reproducible, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit/msp_context_replay: a SCOPED row requires a matching access_context -- missing is access_context_required, mismatched is access_context_denied, correct succeeds", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const scoped = await resolveContext(call, { accessContext: { tenant_id: "tenant-ctx", principal_id: "principal-ctx" } });

    await assert.rejects(call("msp_context_audit", { actor: "boss", context_id: scoped.context_id }), /access_context_required/);
    await assert.rejects(
      call("msp_context_audit", { actor: "boss", context_id: scoped.context_id, access_context: { tenant_id: "WRONG", principal_id: "principal-ctx" } }),
      /access_context_denied/,
    );
    const auditOk = await call("msp_context_audit", {
      actor: "boss", context_id: scoped.context_id, access_context: { tenant_id: "tenant-ctx", principal_id: "principal-ctx" },
    });
    assert.equal(auditOk.context_id, scoped.context_id);

    await assert.rejects(call("msp_context_replay", { context_id: scoped.context_id }), /access_context_required/);
    await assert.rejects(
      call("msp_context_replay", { context_id: scoped.context_id, access_context: { tenant_id: "tenant-ctx", principal_id: "WRONG" } }),
      /access_context_denied/,
    );
    const replayOk = await call("msp_context_replay", {
      context_id: scoped.context_id, access_context: { tenant_id: "tenant-ctx", principal_id: "principal-ctx" },
    });
    assert.equal(replayOk.context_reproducible, true);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_diff: the check applies INDEPENDENTLY to each named row -- a legacy row is unaffected; a scoped row requires a matching access_context; scoped-to-DIFFERENT-principals fires the mismatch naturally", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const legacyBase = await resolveContext(call, { workspaceId: "workspace-diff-a" });
    const legacyTarget = await resolveContext(call, { workspaceId: "workspace-diff-b" });
    const diffLegacy = await call("msp_context_diff", {
      actor: "boss", base_context_id: legacyBase.context_id, target_context_id: legacyTarget.context_id,
    });
    assert.equal(diffLegacy.base_context_id, legacyBase.context_id);

    const scopedA = await resolveContext(call, { workspaceId: "workspace-diff-c", accessContext: { tenant_id: "tenant-diff", principal_id: "principal-A" } });
    const scopedB = await resolveContext(call, { workspaceId: "workspace-diff-d", accessContext: { tenant_id: "tenant-diff", principal_id: "principal-B" } });

    // missing access_context entirely.
    await assert.rejects(
      call("msp_context_diff", { actor: "boss", base_context_id: scopedA.context_id, target_context_id: scopedB.context_id }),
      /access_context_required/,
    );

    // scoped to DIFFERENT principals: no single access_context can match
    // both -- the mismatch fires naturally on whichever row it does not
    // match, no separate cross-principal-diff rule needed.
    await assert.rejects(
      call("msp_context_diff", {
        actor: "boss", base_context_id: scopedA.context_id, target_context_id: scopedB.context_id,
        access_context: { tenant_id: "tenant-diff", principal_id: "principal-A" },
      }),
      /access_context_denied/,
    );

    // a legacy row paired with a scoped row: the legacy row itself is
    // unaffected, but the scoped row still requires a match.
    await assert.rejects(
      call("msp_context_diff", { actor: "boss", base_context_id: legacyBase.context_id, target_context_id: scopedA.context_id }),
      /access_context_required/,
    );
    const mixedOk = await call("msp_context_diff", {
      actor: "boss", base_context_id: legacyBase.context_id, target_context_id: scopedA.context_id,
      access_context: { tenant_id: "tenant-diff", principal_id: "principal-A" },
    });
    assert.equal(mixedOk.target_context_id, scopedA.context_id);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_diff: include_payload is refused UNCONDITIONALLY for a scoped row, even with a correctly-matching access_context -- proving the refusal is defense in depth, not a fallback for an unauthorized caller", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const legacyBase = await resolveContext(call, { workspaceId: "workspace-payload-a" });
    const legacyTarget = await resolveContext(call, { workspaceId: "workspace-payload-b" });
    const legacyDiff = await call("msp_context_diff", {
      actor: "boss", base_context_id: legacyBase.context_id, target_context_id: legacyTarget.context_id, include_payload: true,
    });
    assert.ok(legacyDiff.payload, "a legacy-only diff must still carry the payload when requested");

    const scopedBase = await resolveContext(call, { workspaceId: "workspace-payload-c", accessContext: { tenant_id: "tenant-payload", principal_id: "principal-payload" } });
    const scopedTarget = await resolveContext(call, { workspaceId: "workspace-payload-d", accessContext: { tenant_id: "tenant-payload", principal_id: "principal-payload" } });

    await assert.rejects(
      call("msp_context_diff", {
        actor: "boss", base_context_id: scopedBase.context_id, target_context_id: scopedTarget.context_id, include_payload: true,
        access_context: { tenant_id: "tenant-payload", principal_id: "principal-payload" },
      }),
      /include_payload/,
    );

    // Without include_payload, the same correctly-scoped diff succeeds.
    const scopedNoPayload = await call("msp_context_diff", {
      actor: "boss", base_context_id: scopedBase.context_id, target_context_id: scopedTarget.context_id,
      access_context: { tenant_id: "tenant-payload", principal_id: "principal-payload" },
    });
    assert.equal(scopedNoPayload.payload, undefined);
  } finally {
    await call.close();
    cleanup();
  }
});

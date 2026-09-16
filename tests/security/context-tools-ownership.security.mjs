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

function spawnRuntime(dbPath, extraEnv = {}) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, ...extraEnv },
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

// RKOI round-1 CRITICAL 1: msp_context_audit's access_context gate ran only
// against context_id's own row (`if (contextRow)`), while journal.read()
// ORs cache_id and injection_id in as INDEPENDENTLY, substring-matched
// filters -- so a caller could move a victim's identifier into cache_id or
// injection_id, pair it with a bogus (or merely a different, already-
// authorized) context_id, and read findings the gate never authorized.
// Fixed by requiring cache_id/injection_id to be verified as belonging to
// the SAME context_id the gate just ran against, before either reaches
// journal.read() at all.
const VAULT_HMAC_KEY = "a".repeat(32);

test("msp_context_audit: a real victim cache_id cannot be read by pairing it with an UNRESOLVABLE context_id -- the exact RKOI probe shape, now refused rather than leaking findings", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const victim = await resolveContext(call, { workspaceId: "workspace-cache-bypass" });
    assert.ok(victim.cache_id);

    await assert.rejects(
      call("msp_context_audit", { actor: "attacker", context_id: "msp:context/does-not-exist", cache_id: victim.cache_id }),
      /context_identifier_mismatch/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit: a real victim injection_id cannot be read by pairing it with an UNRESOLVABLE context_id -- same shape via msp_context_injection_record's own state row", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const victim = await resolveContext(call, { workspaceId: "workspace-injection-bypass" });
    const injectionId = `inject_${Math.random().toString(16).slice(2)}`;
    await call("msp_context_injection_record", {
      injection_id: injectionId,
      context_id: victim.context_id,
      cache_id: victim.cache_id,
      agent_id: "agent-ctx",
      workspace_id: "workspace-injection-bypass",
    });

    await assert.rejects(
      call("msp_context_audit", { actor: "attacker", context_id: "msp:context/nope", injection_id: injectionId }),
      /context_identifier_mismatch/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit: a principal vault's own vault_id, placed in cache_id, cannot be used to reach its msp_vault_resolve journal receipt (principal_hmac actor included) -- the strongest form of RKOI's probe, needle from a wholly unrelated surface", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: VAULT_HMAC_KEY });
  try {
    const vaultResolve = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: { tenant_id: "tenant-v2", principal_id: "principal-v2", agent_id: "agent-v2", workspace_id: "ws-v2", project_id: "proj-v2", policy_version: "1" },
      authorization: { allowed: true, read: true, write_private: true, write_shared: false, allow_passport: true },
    });
    assert.ok(vaultResolve.principalPrivateVaultId);

    await assert.rejects(
      call("msp_context_audit", { actor: "attacker", context_id: "msp:context/nope", cache_id: vaultResolve.principalPrivateVaultId }),
      /context_identifier_mismatch/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit: a victim's cache_id cannot be read even when the attacker pairs it with their OWN real, gate-passing context_id -- the gate authorizes a context_id, not whatever cache_id/injection_id rides along with it", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const victim = await resolveContext(call, { workspaceId: "workspace-own-context-a" });
    const attacker = await resolveContext(call, { workspaceId: "workspace-own-context-b" });

    // Sanity: attacker's own context_id genuinely passes the gate alone.
    const ownAudit = await call("msp_context_audit", { actor: "attacker", context_id: attacker.context_id });
    assert.equal(ownAudit.context_id, attacker.context_id);

    await assert.rejects(
      call("msp_context_audit", { actor: "attacker", context_id: attacker.context_id, cache_id: victim.cache_id }),
      /context_identifier_mismatch/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit: the caller's OWN context_id + OWN cache_id/injection_id from the same msp_context_resolve/msp_context_injection_record calls still succeeds -- the fix refuses cross-identifier mismatches, not legitimate same-context use", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const ctx = await resolveContext(call, { workspaceId: "workspace-own-match" });
    const injectionId = `inject_${Math.random().toString(16).slice(2)}`;
    await call("msp_context_injection_record", {
      injection_id: injectionId,
      context_id: ctx.context_id,
      cache_id: ctx.cache_id,
      agent_id: "agent-ctx",
      workspace_id: "workspace-own-match",
    });

    const audit = await call("msp_context_audit", {
      actor: "boss", context_id: ctx.context_id, cache_id: ctx.cache_id, injection_id: injectionId,
    });
    assert.equal(audit.context_id, ctx.context_id);
    assert.ok(audit.findings.some((f) => f.tool_name === "msp_context_injection_record"));
  } finally {
    await call.close();
    cleanup();
  }
});

// Independent-review fold-in (same round, after RKOI's own CRITICAL 1
// findings above): the fixes above only ever run when cache_id/injection_id
// is non-null. contextId ITSELF was still handed to journal.read()
// unverified whenever it did not resolve to a `contexts` row -- and
// journal.read()'s `(ref = ? OR payload_json LIKE ?)` WHERE has no notion
// of "this string claims to be a context_id": a principal vault's vault_id
// equality-matches its own msp_vault_resolve receipt's `ref` directly, and
// ANY guessable substring (a tenant id, an entity id) LIKE-matches any
// journal row whose payload happens to mention it, for every tool that
// ever journals -- not only context-shaped ones. Proven live against a
// real stdio server before this fix (see the coordinator's own probe
// output); fixed by never calling journal.read() at all unless contextId
// resolved to a real `contexts` row.
test("msp_context_audit: a victim's principal-vault vault_id, placed directly in context_id (no cache_id/injection_id at all), cannot reach that vault's own msp_vault_resolve journal receipt via journal.read's exact ref= match", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: VAULT_HMAC_KEY });
  try {
    const vaultResolve = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: { tenant_id: "tenant-fold", principal_id: "principal-fold", agent_id: "agent-fold", workspace_id: "ws-fold", project_id: "proj-fold", policy_version: "1" },
      authorization: { allowed: true, read: true, write_private: true, write_shared: false, allow_passport: true },
    });
    assert.ok(vaultResolve.principalPrivateVaultId);

    const audit = await call("msp_context_audit", { actor: "attacker", context_id: vaultResolve.principalPrivateVaultId });
    assert.equal(audit.replayable, false);
    assert.deepEqual(audit.findings, []);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit: a bare guessable tenant_id string, placed directly in context_id, cannot LIKE-match any journal row whose payload merely mentions it", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: VAULT_HMAC_KEY });
  try {
    const tenantId = "tenantA-guessable";
    await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: { tenant_id: tenantId, principal_id: "principal-fold-2", agent_id: "agent-fold-2", workspace_id: "ws-fold-2", project_id: "proj-fold-2", policy_version: "1" },
      authorization: { allowed: true, read: true, write_private: true, write_shared: false },
    });

    const audit = await call("msp_context_audit", { actor: "attacker", context_id: tenantId });
    assert.equal(audit.replayable, false);
    assert.deepEqual(audit.findings, []);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_audit: a victim's msp_memory_upsert entity_id, placed directly in context_id, cannot reach that entity's own journal receipt either -- the same unverified-contextId shape applies to msp_memory_* refs, not only context/vault ones", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: VAULT_HMAC_KEY });
  try {
    const vaultResolve = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: { tenant_id: "tenant-fold-3", principal_id: "principal-fold-3", agent_id: "agent-fold-3", workspace_id: "ws-fold-3", project_id: "proj-fold-3", policy_version: "1" },
      authorization: { allowed: true, read: true, write_private: true, write_shared: false },
    });
    const upserted = await call("msp_memory_upsert", {
      vault: { vault_id: vaultResolve.workspacePrivateVaultId, vault_type: "workspace_private" },
      category: "secret", key: "fold-in", body_json: { value: "must-not-leak" },
      epistemic_state: "hypothesis", confidence: 0.5, valid_from: "2026-09-16T00:00:00Z", valid_to: null,
    });
    assert.ok(upserted.entity.entity_id);

    const audit = await call("msp_context_audit", { actor: "attacker", context_id: upserted.entity.entity_id });
    assert.equal(audit.replayable, false);
    assert.deepEqual(audit.findings, []);
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_diff: naming a victim's vault_id or a bare tenant_id string as base_context_id/target_context_id is refused not_found -- it can never resolve to a `contexts` row, so nothing is ever compared or leaked", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: VAULT_HMAC_KEY });
  try {
    const legacy = await resolveContext(call, { workspaceId: "workspace-diff-fold" });
    const vaultResolve = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: { tenant_id: "tenant-diff-fold", principal_id: "principal-diff-fold", agent_id: "agent-diff-fold", workspace_id: "ws-diff-fold", project_id: "proj-diff-fold", policy_version: "1" },
      authorization: { allowed: true, read: true, write_private: true, write_shared: false },
    });

    await assert.rejects(
      call("msp_context_diff", { actor: "boss", base_context_id: legacy.context_id, target_context_id: vaultResolve.principalPrivateVaultId }),
      /Unknown target_context_id/,
    );
    await assert.rejects(
      call("msp_context_diff", { actor: "boss", base_context_id: "tenant-diff-fold", target_context_id: legacy.context_id }),
      /Unknown base_context_id/,
    );
  } finally {
    await call.close();
    cleanup();
  }
});

test("msp_context_replay: naming a victim's vault_id or a bare tenant_id string as context_id answers context_not_found, with context_reproducible:false and no data about the named string's real owner", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath, { MSP_IDENTITY_HMAC_KEY: VAULT_HMAC_KEY });
  try {
    const vaultResolve = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: { tenant_id: "tenant-replay-fold", principal_id: "principal-replay-fold", agent_id: "agent-replay-fold", workspace_id: "ws-replay-fold", project_id: "proj-replay-fold", policy_version: "1" },
      authorization: { allowed: true, read: true, write_private: true, write_shared: false },
    });

    const replayByVault = await call("msp_context_replay", { context_id: vaultResolve.principalPrivateVaultId });
    assert.equal(replayByVault.context_reproducible, false);
    assert.ok(replayByVault.diagnostics.some((d) => d.startsWith("context_not_found")));

    const replayByTenant = await call("msp_context_replay", { context_id: "tenant-replay-fold" });
    assert.equal(replayByTenant.context_reproducible, false);
    assert.ok(replayByTenant.diagnostics.some((d) => d.startsWith("context_not_found")));
  } finally {
    await call.close();
    cleanup();
  }
});

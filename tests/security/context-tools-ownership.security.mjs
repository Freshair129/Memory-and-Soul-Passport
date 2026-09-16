// PH-MEMOS-5 v0.9.9b §5.0.7: real-process signed context reads and unknown-row equivalence.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
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

const CONTEXT_SERVICE_KEY = "synthetic-context-service-key-32-bytes";

function spawnRuntime(dbPath, extraEnv = {}) {
  return createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEY: CONTEXT_SERVICE_KEY, ...extraEnv },
    timeoutMs: 10_000,
  });
}


function signedInput(name, input, claims, overrides = {}) {
  const grant = {
    ...claims, operation: name, expiresAt: Date.now() + 60_000,
    payloadHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), ...overrides,
  };
  return { ...input, access: { grant, signature: createHmac("sha256", CONTEXT_SERVICE_KEY).update(JSON.stringify(grant)).digest("hex") } };
}

function resolvePrincipalVault(call, input) {
  const ctx = input.access_context;
  return call("msp_vault_resolve", signedInput("msp_vault_resolve", input, {
    tenantId: ctx.tenant_id, principalId: ctx.principal_id, agentId: ctx.agent_id,
    workspaceId: ctx.workspace_id, allowPassport: input.authorization.allow_passport === true, nonce: randomUUID(),
  }));
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

test("scoped context reads require signed tenant/principal claims; every grant failure follows the unknown-row branch", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const scoped = await resolveContext(call, { accessContext: { tenant_id: "tenant-ctx", principal_id: "principal-ctx" } });
    const claims = { tenantId: "tenant-ctx", principalId: "principal-ctx" };
    for (const name of ["msp_context_audit", "msp_context_replay"]) {
      const input = { actor: "boss", context_id: scoped.context_id };
      const good = signedInput(name, input, claims);
      const badSignature = structuredClone(good);
      badSignature.access.signature = "00".repeat(32);
      const variants = [
        input,
        { ...input, access_context: { tenant_id: "tenant-ctx", principal_id: "principal-ctx" } },
        badSignature,
        signedInput(name, input, claims, { expiresAt: 1 }),
        signedInput(name, input, claims, { operation: "msp_thread_context" }),
        signedInput(name, input, claims, { payloadHash: "wrong" }),
        signedInput(name, input, { ...claims, tenantId: "foreign-tenant" }),
        signedInput(name, input, { ...claims, principalId: "foreign-principal" }),
        signedInput(name, input, { ...claims, tenantId: 5 }),
        signedInput(name, input, { ...claims, principalId: "x".repeat(129) }),
      ];
      for (const [variantIndex, deniedInput] of variants.entries()) {
        const denied = await call(name, deniedInput);
        if (name === "msp_context_audit") {
          assert.equal(denied.replayable, false, `${name} grant-failure variant ${variantIndex}`);
          assert.equal(denied.hash_valid, false);
          assert.deepEqual(denied.findings, []);
        } else {
          assert.equal(denied.context_reproducible, false, `${name} grant-failure variant ${variantIndex}`);
          assert.ok(denied.diagnostics[0].startsWith("context_not_found:"));
        }
      }
      // No agent/workspace/policyRevision/nonce required by a context grant.
      const allowed = await call(name, good);
      assert.equal(name === "msp_context_audit" ? allowed.replayable : allowed.context_reproducible, true);
    }
  } finally { await call.close(); cleanup(); }
});

test("context diff authorizes base before target and refuses cross-principal rows with the same not-found error", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const legacy = await resolveContext(call);
    const base = await resolveContext(call, { accessContext: { tenant_id: "tenant-diff", principal_id: "principal-A" } });
    const foreign = await resolveContext(call, { accessContext: { tenant_id: "tenant-diff", principal_id: "principal-B" } });
    const input = { actor: "boss", base_context_id: base.context_id, target_context_id: foreign.context_id };
    for (const target of [foreign.context_id, "msp:context/nonexistent"]) {
      await assert.rejects(call("msp_context_diff", { ...input, target_context_id: target }), /Unknown base_context_id/);
    }
    const claims = { tenantId: "tenant-diff", principalId: "principal-A" };
    await assert.rejects(call("msp_context_diff", signedInput("msp_context_diff", input, claims)), /Unknown target_context_id/);
    const ownAndLegacy = { ...input, target_context_id: legacy.context_id };
    const result = await call("msp_context_diff", signedInput("msp_context_diff", ownAndLegacy, claims));
    assert.equal(result.base_context_id, base.context_id);
    const legacyOnly = await call("msp_context_diff", { actor: "boss", base_context_id: legacy.context_id, target_context_id: legacy.context_id, access: { grant: {}, signature: "invalid" } });
    assert.equal(legacyOnly.base_context_id, legacy.context_id);
  } finally { await call.close(); cleanup(); }
});

test("context diff refuses payload for either scoped side even with a matching signed grant", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const legacy = await resolveContext(call);
    const scoped = await resolveContext(call, { accessContext: { tenant_id: "tenant-payload", principal_id: "principal-payload" } });
    const claims = { tenantId: "tenant-payload", principalId: "principal-payload" };
    const legacyPayload = await call("msp_context_diff", { actor: "boss", base_context_id: legacy.context_id, target_context_id: legacy.context_id, include_payload: true });
    assert.ok(legacyPayload.payload);
    for (const [base, target] of [[scoped, legacy], [legacy, scoped], [scoped, scoped]]) {
      const input = { actor: "boss", base_context_id: base.context_id, target_context_id: target.context_id, include_payload: true };
      await assert.rejects(call("msp_context_diff", signedInput("msp_context_diff", input, claims)), /include_payload/);
      const withoutPayload = { ...input, include_payload: false };
      const result = await call("msp_context_diff", signedInput("msp_context_diff", withoutPayload, claims));
      assert.equal(result.payload, undefined);
    }
  } finally { await call.close(); cleanup(); }
});

test("denied context audit collapses before cache and injection checks, identically to unknown context", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    const scoped = await resolveContext(call, { accessContext: { tenant_id: "tenant-order", principal_id: "principal-order" } });
    const injectionId = randomUUID();
    await call("msp_context_injection_record", { injection_id: injectionId, context_id: scoped.context_id, cache_id: scoped.cache_id, agent_id: "agent-ctx", workspace_id: "workspace-ctx" });
    for (const extra of [{ cache_id: scoped.cache_id }, { injection_id: injectionId }, { cache_id: scoped.cache_id, injection_id: injectionId }]) {
      const messages = [];
      for (const contextId of [scoped.context_id, "msp:context/unknown"]) {
        await assert.rejects(call("msp_context_audit", { actor: "boss", context_id: contextId, ...extra }), (error) => {
          assert.match(error.message, /context_identifier_mismatch/);
          messages.push(error.message);
          return true;
        });
      }
      assert.equal(messages[0], messages[1]);
    }
    const input = { actor: "boss", context_id: scoped.context_id, cache_id: scoped.cache_id, injection_id: injectionId };
    const allowed = await call("msp_context_audit", signedInput("msp_context_audit", input, { tenantId: "tenant-order", principalId: "principal-order" }));
    assert.equal(allowed.replayable, true);
    assert.ok(allowed.findings.some((item) => item.tool_name === "msp_context_injection_record"));
  } finally { await call.close(); cleanup(); }
});

test("context write stays unsigned but refuses half-scoped requests", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const call = spawnRuntime(dbPath);
  try {
    for (const accessContext of [{ tenant_id: "tenant-only" }, { principal_id: "principal-only" }]) {
      const missingField = accessContext.tenant_id ? "principal_id" : "tenant_id";
      await assert.rejects(resolveContext(call, { accessContext }), {
        message: `access_context.${missingField} is required.`,
      });
    }
  } finally { await call.close(); cleanup(); }
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
    const vaultResolve = await resolvePrincipalVault(call, {
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
    const vaultResolve = await resolvePrincipalVault(call, {
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
    await resolvePrincipalVault(call, {
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
    const vaultResolve = await resolvePrincipalVault(call, {
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
    const vaultResolve = await resolvePrincipalVault(call, {
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
    const vaultResolve = await resolvePrincipalVault(call, {
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

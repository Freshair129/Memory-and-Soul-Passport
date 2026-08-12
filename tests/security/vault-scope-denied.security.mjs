// WP-14 AC-04: every tool accepting a vault_id (directly, or via
// vault:{vault_id, vault_type}) returns vault_scope_denied (API-009 §5) when
// the caller's vault_id is not mounted/owned by them, verified against the
// real running process (not only in-process unit calls).
//
// Bounded-Scope investigation finding (recorded here, and in the final
// report): of packages/msp-runtime's actual delivered tool surface
// (WP-12/WP-13), msp_vault_mount is the ONLY tool whose request carries a
// real, caller-supplied vault_id. msp_context_resolve takes workspace_id/
// agent_id (no vault_id field at all -- verified directly against
// packages/govibe-core/src/msp-client.mjs's resolveContext() and
// transport/handlers/context-handlers.mjs's msp_context_resolve).
// msp_memory_promote takes agent_id and derives its Global-Private vault_id
// internally via domain/vault-registry.mjs's provisionGlobalPrivateVault --
// it never accepts a caller-supplied vault_id on the wire (verified against
// scripts/mcp/msp-vault-context-contracts.mjs's promoteMemory() and
// transport/handlers/lifecycle-handlers.mjs). WP-14's Explicit Exclusions
// forbid adding a new vault_id parameter to either tool's wire shape ("Any
// change to the msp_*/msp_memory_* wire request/response shapes beyond the
// new vault_scope_denied error path"), so this test file exercises
// msp_vault_mount, the one tool this enforcement genuinely applies to today.
//
// Per AC-07, this is an adversarial/boundary test and lives as
// *.security.mjs, run under node:test, mirroring
// test/canonical-candidate-rejection.security.mjs's convention.
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
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-vault-scope-denied-test-"));
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

test("AC-04: msp_vault_mount denies mounting ANOTHER workspace's private vault_id, real vault_id but not owned/mounted for the caller", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    // Workspace A registers and gets its own workspace_private vault_id.
    await runtime.client.registerWorkspace({
      actor: "boss",
      workspaceId: "workspace-owner",
      projectId: null,
      workspacePath: "/workspace/owner",
      vaultBindings: null,
      recordId: "record-owner",
      runId: "run-owner",
      timestamp: new Date().toISOString(),
      sourceHash: "a".repeat(64),
    });
    const statusA = await runtime.typed.getVaultStatus({
      actor: "boss",
      workspaceId: "workspace-owner",
      workspacePath: "/workspace/owner",
      agentId: null,
    });
    const ownerVault = statusA.vaults.find((v) => v.vault_type === "workspace_private");
    assert.ok(ownerVault, "workspace-owner must have a real, provisioned workspace_private vault");

    // Workspace B (a different, unrelated caller) tries to mount workspace
    // A's private vault_id -- a real vault_id, but not theirs.
    await assert.rejects(
      runtime.typed.mountVault({
        actor: "boss",
        workspaceId: "workspace-intruder",
        workspacePath: "/workspace/intruder",
        vaultId: ownerVault.vault_id,
        mountAlias: "stolen",
        accessMode: "read",
        reason: "attempting to mount a vault that is not mine",
      }),
      /vault_scope_denied/,
      "mounting a real vault_id that does not belong to the caller must be denied with vault_scope_denied, not a silent success",
    );
  } finally {
    runtime.call.close();
    cleanup();
  }
});

test("AC-04: msp_vault_mount denies mounting a Shared vault belonging to a DIFFERENT project", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    // Workspace/project A.
    await runtime.client.registerWorkspace({
      actor: "boss",
      workspaceId: "workspace-project-a",
      projectId: "project-a",
      workspacePath: "/workspace/project-a",
      vaultBindings: null,
      recordId: "record-project-a",
      runId: "run-project-a",
      timestamp: new Date().toISOString(),
      sourceHash: "a".repeat(64),
    });
    const statusA = await runtime.typed.getVaultStatus({
      actor: "boss",
      workspaceId: "workspace-project-a",
      workspacePath: "/workspace/project-a",
      agentId: null,
    });
    const sharedVaultA = statusA.vaults.find((v) => v.vault_type === "shared");
    assert.ok(sharedVaultA, "project-a must have a real, provisioned shared vault");

    // Workspace/project B, a different project entirely.
    await runtime.client.registerWorkspace({
      actor: "boss",
      workspaceId: "workspace-project-b",
      projectId: "project-b",
      workspacePath: "/workspace/project-b",
      vaultBindings: null,
      recordId: "record-project-b",
      runId: "run-project-b",
      timestamp: new Date().toISOString(),
      sourceHash: "a".repeat(64),
    });

    await assert.rejects(
      runtime.typed.mountVault({
        actor: "boss",
        workspaceId: "workspace-project-b",
        workspacePath: "/workspace/project-b",
        vaultId: sharedVaultA.vault_id,
        mountAlias: "cross-project-shared",
        accessMode: "read",
        reason: "attempting to mount another project's shared vault",
      }),
      /vault_scope_denied/,
      "mounting a different project's shared vault must be denied with vault_scope_denied",
    );
  } finally {
    runtime.call.close();
    cleanup();
  }
});

test("AC-04 control case: mounting one's OWN workspace_private vault still succeeds (the guard is not over-broad)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    await runtime.client.registerWorkspace({
      actor: "boss",
      workspaceId: "workspace-self",
      projectId: null,
      workspacePath: "/workspace/self",
      vaultBindings: null,
      recordId: "record-self",
      runId: "run-self",
      timestamp: new Date().toISOString(),
      sourceHash: "a".repeat(64),
    });
    const status = await runtime.typed.getVaultStatus({
      actor: "boss",
      workspaceId: "workspace-self",
      workspacePath: "/workspace/self",
      agentId: null,
    });
    const ownVault = status.vaults.find((v) => v.vault_type === "workspace_private");

    const result = await runtime.typed.mountVault({
      actor: "boss",
      workspaceId: "workspace-self",
      workspacePath: "/workspace/self",
      vaultId: ownVault.vault_id,
      mountAlias: "own-primary",
      accessMode: "read",
      reason: "mounting my own vault",
    });
    assert.equal(result.mounted, true);
    assert.equal(result.policyDecision, "allow");
  } finally {
    runtime.call.close();
    cleanup();
  }
});

test("AC-04: an UNKNOWN vault_id still surfaces the pre-existing not_found error, not vault_scope_denied (the two conditions are distinct)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    await runtime.client.registerWorkspace({
      actor: "boss",
      workspaceId: "workspace-unknown-vault",
      projectId: null,
      workspacePath: "/workspace/unknown-vault",
      vaultBindings: null,
      recordId: "record-unknown-vault",
      runId: "run-unknown-vault",
      timestamp: new Date().toISOString(),
      sourceHash: "a".repeat(64),
    });

    await assert.rejects(
      runtime.typed.mountVault({
        actor: "boss",
        workspaceId: "workspace-unknown-vault",
        workspacePath: "/workspace/unknown-vault",
        vaultId: "vault_this-does-not-exist",
        mountAlias: "nope",
        accessMode: "read",
        reason: "mounting a nonexistent vault_id",
      }),
      (error) => {
        assert.match(error.message, /unknown vault_id/i);
        assert.doesNotMatch(error.message, /vault_scope_denied/);
        return true;
      },
    );
  } finally {
    runtime.call.close();
    cleanup();
  }
});

test("AC-04: re-mounting an already-legitimately-mounted vault_id (idempotent re-mount, different alias) is still allowed, not denied", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const runtime = spawnRuntime(dbPath);
  try {
    await runtime.client.registerWorkspace({
      actor: "boss",
      workspaceId: "workspace-remount",
      projectId: null,
      workspacePath: "/workspace/remount",
      vaultBindings: null,
      recordId: "record-remount",
      runId: "run-remount",
      timestamp: new Date().toISOString(),
      sourceHash: "a".repeat(64),
    });
    const status = await runtime.typed.getVaultStatus({
      actor: "boss",
      workspaceId: "workspace-remount",
      workspacePath: "/workspace/remount",
      agentId: null,
    });
    const ownVault = status.vaults.find((v) => v.vault_type === "workspace_private");

    const first = await runtime.typed.mountVault({
      actor: "boss",
      workspaceId: "workspace-remount",
      workspacePath: "/workspace/remount",
      vaultId: ownVault.vault_id,
      mountAlias: "alias-one",
      accessMode: "read",
      reason: "first mount",
    });
    assert.equal(first.mounted, true);

    const second = await runtime.typed.mountVault({
      actor: "boss",
      workspaceId: "workspace-remount",
      workspacePath: "/workspace/remount",
      vaultId: ownVault.vault_id,
      mountAlias: "alias-two",
      accessMode: "read",
      reason: "second mount, different alias",
    });
    assert.equal(second.mounted, true);
  } finally {
    runtime.call.close();
    cleanup();
  }
});

// WP-14 AC-05: vaults.role column exists, matching
// docs/architecture/SDD-Persistent-Memory-MSP-Runtime.md §5's vaults row.
// domain/vault-registry.mjs's provisionGlobalPrivateVault populates it for
// at least one provisioning path (per ADR-020's "memory is keyed by role /
// named-agent" framing -- Global-Private is the one vault_type with a real
// agent-role concept; Shared and Workspace-Private vaults have no single
// owning agent, so this packet deliberately leaves their role null rather
// than inventing a value -- see domain/vault-registry.mjs's provisionShared/
// WorkspacePrivateVault comments for the reasoning).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { VaultRegistry } from "@freshair129/msp-core/vault-registry";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function freshRegistry() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-vaults-role-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = open(path.join(dir, "db.sqlite3"));
  cleanups.push(() => db.close());
  runMigrations(db, migrationsDir);
  return { db, vaultRegistry: new VaultRegistry(db) };
}

describe("WP-14 AC-05: vaults.role column", () => {
  it("the column exists on the vaults table, nullable TEXT (no universal non-null default across vault_types)", () => {
    const { db } = freshRegistry();
    const columns = db.prepare("PRAGMA table_info(vaults)").all();
    const roleColumn = columns.find((col) => col.name === "role");
    expect(roleColumn).toBeTruthy();
    expect(roleColumn.type.toUpperCase()).toBe("TEXT");
    expect(roleColumn.notnull).toBe(0);
  });

  it("provisionGlobalPrivateVault populates role: an explicit role is recorded as given", () => {
    const { vaultRegistry } = freshRegistry();
    const vault = vaultRegistry.provisionGlobalPrivateVault("agent-explicit-role", { role: "backend-engineer" });
    expect(vault.role).toBe("backend-engineer");
  });

  it("provisionGlobalPrivateVault populates role: with no explicit role, falls back to the agent_id itself (an honest default, not left unset)", () => {
    const { vaultRegistry } = freshRegistry();
    const vault = vaultRegistry.provisionGlobalPrivateVault("agent-default-role");
    expect(vault.role).toBe("agent-default-role");
  });

  it("role is idempotent across repeated provisioning calls for the same agent_id: the first call's role wins, not overwritten by a later call", () => {
    const { vaultRegistry } = freshRegistry();
    const first = vaultRegistry.provisionGlobalPrivateVault("agent-idem-role", { role: "first-role" });
    const second = vaultRegistry.provisionGlobalPrivateVault("agent-idem-role", { role: "second-role" });
    expect(first.vault_id).toBe(second.vault_id);
    expect(second.role).toBe("first-role");
  });

  it("Shared and Workspace-Private vaults leave role null (no single owning agent to attribute a role to)", () => {
    const { vaultRegistry } = freshRegistry();
    const shared = vaultRegistry.provisionSharedVault("project-role-test");
    const workspacePrivate = vaultRegistry.provisionWorkspacePrivateVault("workspace-role-test");
    expect(shared.role).toBeNull();
    expect(workspacePrivate.role).toBeNull();
  });

  it("role survives a raw read back from the vaults table (not just the in-memory rowToVault projection)", () => {
    const { db, vaultRegistry } = freshRegistry();
    const vault = vaultRegistry.provisionGlobalPrivateVault("agent-raw-read", { role: "qa-engineer" });
    const row = db.prepare("SELECT role FROM vaults WHERE vault_id = ?").get(vault.vault_id);
    expect(row.role).toBe("qa-engineer");
  });
});

// RKOI round-1 WARNING 4: no contract test covered msp_vault_resolve or
// API-010.tools.json at all. This file follows the exact shape
// api-009-conformance.test.mjs already uses: pin the schema's own
// doc_id/version/tool list first, then prove the tool is actually
// REGISTERED on a real stdio server (not merely present in the schema
// file) by making a real, well-formed call and checking its response
// shape -- an unregistered tool would answer "unknown tool"/"method not
// found", not a vault-shaped result.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const binPath = path.join(repoRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const schemaPath = path.join(repoRoot, "packages", "msp-contracts", "schemas", "API-010.tools.json");
const expectedTools = ["msp_vault_resolve"];
const IDENTITY_HMAC_KEY = "d".repeat(32);

let call;
let tempDir;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "msp-api-010-contract-"));
  call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: path.join(tempDir, "msp.sqlite3"), MSP_IDENTITY_HMAC_KEY: IDENTITY_HMAC_KEY },
    timeoutMs: 15_000,
  });
});

afterAll(async () => {
  // close() resolves on the child's real exit, so no sleep-and-retry dance is
  // needed to get past the WAL sidecar files it holds until then.
  await call?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("API-010 machine contract", () => {
  it("pins the schema's own doc_id, version and tool list", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.contract).toMatchObject({
      doc_id: "API-010-VAULT-RESOLVE-CONTRACT",
      version: "0.1.0b",
    });
    expect(schema.tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
    for (const tool of schema.tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("API-010 request/response conformance over real stdio", () => {
  it("msp_vault_resolve is registered on the real server and answers the shipped zuri-ai caller's request shape", async () => {
    const result = await call("msp_vault_resolve", {
      actor: "zuri-agent",
      access_context: {
        tenant_id: "tenant-api-010",
        principal_id: "principal-api-010",
        agent_id: "agent-api-010",
        workspace_id: "workspace-api-010",
        project_id: "project-api-010",
        policy_version: "policy-v1",
      },
      authorization: {
        allowed: true,
        allow_global_private: true,
        allow_shared: true,
        read: true,
        write_private: true,
        write_shared: false,
        allow_passport: true,
      },
    });

    expect(typeof result.workspacePrivateVaultId).toBe("string");
    expect(Array.isArray(result.globalPrivateVaultIds)).toBe(true);
    expect(Array.isArray(result.sharedVaultIds)).toBe(true);
    expect(typeof result.principalPrivateVaultId).toBe("string");
    expect(typeof result.principalPassportVaultId).toBe("string");
    expect(result.permissions).toMatchObject({
      read: true,
      writePrivate: true,
      writeShared: false,
      policyVersion: "policy-v1",
      allowPassport: true,
    });
  });
});

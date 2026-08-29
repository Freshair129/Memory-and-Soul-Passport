import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MspClient } from "@freshair129/msp-client-js";
import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const providerPath = path.join(here, "fixtures", "reference-gks-provider.mjs");

function candidate(key = "knowledge-1", hash = "a".repeat(64)) {
  return {
    schema_version: "govibe-knowledge-candidate/v1",
    idempotency_key: key,
    run_id: "run-provider-1",
    stage: 1,
    source_snapshot_hash: hash,
    provenance_ref: "msp:proof/provider-1",
    candidate: { atoms: [{ id: "candidate-1" }] },
  };
}

function runtime(dbPath, statePath, extraEnv = {}) {
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    timeoutMs: 15_000,
    env: {
      ...process.env,
      MSP_DB_PATH: dbPath,
      MSP_GKS_COMMAND: process.execPath,
      MSP_GKS_ARGS: JSON.stringify([providerPath]),
      GKS_FIXTURE_STATE_PATH: statePath,
      ...extraEnv,
    },
  });
  return { call, client: new MspClient(call) };
}

// The unconfigured direction of the same bridge: an env with NO
// MSP_GKS_COMMAND at all (explicitly stripped from the inherited
// process.env too, so an ambiently-configured host can never turn this
// into a false pass). This is what this file's name promises alongside the
// configured-success and configured-malformed cases below.
function unconfiguredRuntime(dbPath) {
  const env = { ...process.env, MSP_DB_PATH: dbPath };
  delete env.MSP_GKS_COMMAND;
  delete env.MSP_GKS_ARGS;
  delete env.GKS_FIXTURE_STATE_PATH;
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    timeoutMs: 15_000,
    env,
  });
  return { call, client: new MspClient(call) };
}

describe("MSP GKS provider bridge", () => {
it("validates GKS MCP results and persists an idempotent canonical promotion receipt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-gks-provider-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  const statePath = path.join(dir, "gks-state.json");
  let firstRuntime;
  let restartedRuntime;
  try {
    firstRuntime = runtime(dbPath, statePath);
    const first = await firstRuntime.client.submitKnowledgeCandidate(candidate());
    expect(first.knowledgeRef).toMatch(/^gks:knowledge\//);
    expect(first.promotionRef).toMatch(/^msp:promotion\//);
    expect(first.sourceHash).toBe("a".repeat(64));
    firstRuntime.call.close();

    restartedRuntime = runtime(dbPath, statePath);
    const retry = await restartedRuntime.client.submitKnowledgeCandidate(candidate());
    expect(retry).toEqual(first);
    const providerState = JSON.parse(readFileSync(statePath, "utf8"));
    expect(Object.keys(providerState)).toHaveLength(1);

    const db = open(dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_promotions").get().count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    firstRuntime?.call.close();
    restartedRuntime?.call.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

it("rejects a malformed GKS result and leaves no promotion receipt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-gks-invalid-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  const statePath = path.join(dir, "gks-state.json");
  const instance = runtime(dbPath, statePath, { GKS_FIXTURE_BAD_RESPONSE: "1" });
  try {
    await expect(instance.client.submitKnowledgeCandidate(candidate("knowledge-invalid"))).rejects.toThrow(/gks_provider_invalid_response/);
    const db = open(dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_promotions").get().count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    instance.call.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

it("msp_knowledge_promote fails closed with gks_provider_unconfigured when no provider is configured, and persists no receipt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-gks-unconfigured-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  const instance = unconfiguredRuntime(dbPath);
  try {
    let thrown;
    try {
      await instance.client.submitKnowledgeCandidate(candidate("knowledge-unconfigured"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "an unconfigured bridge must reject, never silently no-op").toBeDefined();
    expect(thrown.message).toMatch(/gks_provider_unconfigured/);
    // Fail-closed means fail-closed: no fabricated canonical reference in
    // the error surface, and no promotion receipt row on disk.
    expect(thrown.message.toLowerCase()).not.toMatch(/gks:/);
    const db = open(dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_promotions").get().count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    instance.call.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

it("msp_memory_promote(target_scope=shared) fails closed with gks_provider_unconfigured when no provider is configured, and persists no promotion row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-gks-unconfigured-memory-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  const instance = unconfiguredRuntime(dbPath);
  try {
    let thrown;
    try {
      await instance.call("msp_memory_promote", {
        schema_version: "govibe-memory-promotion/v1",
        actor: "boss",
        agent_id: "agent-unconfigured",
        workspace_id: "workspace-unconfigured",
        source_memory_ref: "msp:memory/unconfigured-source",
        target_scope: "shared",
        candidate: { note: "must be denied without a provider" },
        evidence_refs: ["msp:proof/unconfigured-1"],
        reason: "gks bridge unconfigured integration test",
        idempotency_key: "promo-unconfigured-1",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "an unconfigured bridge must reject, never silently no-op").toBeDefined();
    expect(thrown.message).toMatch(/gks_provider_unconfigured/);
    expect(thrown.message.toLowerCase()).not.toMatch(/gks:/);
    const db = open(dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM promotions").get().count).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_promotions").get().count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    instance.call.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
});

// AC-05: msp_context_replay's execution_reproducible and output_identical
// are hard-coded false with a diagnostic reason in every case (ADR-027 "What
// this ADR does not claim" -- this runtime has no execution authority);
// context_reproducible is a real hash comparison against the persisted
// contexts row, tested with both a matching-hash and a tampered-hash case.
// Runs against the real stdio process, using the exact request shape
// scripts/mcp/vault-context-surface-v2.mjs sends through
// MspClient.replayContext (actor, context_id, cache_id, run_id, turn_id) --
// see test/contract-conformance.test.mjs's header comment for why this
// shape is ground truth. This file additionally exercises the tampered-hash
// case using the source_hash field this runtime's own
// msp_context_resolve/msp_context_replay pair supports for that purpose
// (see transport/handlers/context-handlers.mjs's header comment on
// msp_context_replay for why that field's shape was this packet's own
// design choice, since no consumer file constrains msp_context_replay's
// request beyond context_id).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MspClient } from "@freshair129/msp-client-js";
import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

describe("AC-05: msp_context_replay", () => {
  let call;
  let client;
  let dbPath;
  let tempDir;
  let contextId;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "msp-runtime-replay-test-"));
    dbPath = path.join(tempDir, "msp.sqlite3");
    call = createMspStdioCaller({
      command: process.execPath,
      args: [binPath],
      env: { ...process.env, MSP_DB_PATH: dbPath },
      timeoutMs: 10_000,
    });
    client = new MspClient(call);

    const authority = {
      schemaVersion: "govibe-context-authority/v1",
      identity: { taskId: "T", agentId: "agent-replay", workspaceId: "workspace-replay", runId: "run-replay", sessionId: "session-replay", turnId: "turn-replay" },
      sources: [{ id: "API-009", version: "0.1.0", hash: "a".repeat(64) }],
      requiredReasonRefs: ["issue:replay"],
      traversal: { relationAllowlist: ["implements"], retrievalRadius: 1, inclusions: [], exclusions: [] },
      knowledgeRefs: [],
      budget: { maxTokens: 1024, compaction: "bounded" },
      lineage: { contextId: "ctx-replay", cacheId: "cache-replay", parentContextId: null },
      unresolvedAssumptions: [],
    };
    const resolved = await client.resolveContext({
      workspacePath: "/workspace/replay",
      workspaceId: "workspace-replay",
      agentId: "agent-replay",
      contextProfile: "T-ctx",
      contextAuthority: authority,
    });
    contextId = resolved.contextId;
  });

  afterAll(() => {
    call?.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (Windows file-lock race on child process exit)
    }
  });

  it("execution_reproducible and output_identical are always false, with a diagnostic reason, on a matching-hash replay", async () => {
    // Re-resolve to obtain the real persisted source_hash (the raw wire
    // response carries it even though MspClient.resolveContext's own
    // camelCase projection does not surface it under a name any consumer
    // reads).
    const raw = await call("msp_context_resolve", {
      workspace_root: "/workspace/replay",
      workspace_id: "workspace-replay",
      agent_id: "agent-replay",
      context_profile: "T-ctx",
    });
    const localContextId = raw.context_id;
    const localSourceHash = raw.source_hash;
    expect(typeof localSourceHash).toBe("string");

    const result = await client.replayContext({
      actor: "boss",
      context_id: localContextId,
      cache_id: null,
      run_id: "run-replay",
      turn_id: "turn-replay",
      source_hash: localSourceHash,
    });

    expect(result.replayRef).toMatch(/^msp:replay\//);
    expect(result.contextReproducible).toBe(true);
    expect(result.executionReproducible).toBe(false);
    expect(result.outputIdentical).toBe(false);
  });

  it("context_reproducible is false for a real, persisted context when the supplied hash is tampered", async () => {
    const raw = await call("msp_context_resolve", {
      workspace_root: "/workspace/replay",
      workspace_id: "workspace-replay",
      agent_id: "agent-replay",
      context_profile: "T-ctx",
    });

    const tampered = "f".repeat(64);
    expect(tampered).not.toBe(raw.source_hash);

    const result = await client.replayContext({
      actor: "boss",
      context_id: raw.context_id,
      cache_id: null,
      run_id: "run-replay",
      turn_id: "turn-replay",
      source_hash: tampered,
    });

    expect(result.contextReproducible).toBe(false);
    // Always false regardless of the context_reproducible outcome.
    expect(result.executionReproducible).toBe(false);
    expect(result.outputIdentical).toBe(false);
  });

  it("context_reproducible is false and diagnostics explain why for an unknown context_id", async () => {
    const result = await client.replayContext({
      actor: "boss",
      context_id: "msp:context/does-not-exist",
      cache_id: null,
      run_id: "run-replay",
      turn_id: "turn-replay",
    });

    expect(result.contextReproducible).toBe(false);
    expect(result.executionReproducible).toBe(false);
    expect(result.outputIdentical).toBe(false);
  });

  it("raw wire response carries a non-empty diagnostics array explaining the always-false fields, in every case", async () => {
    const raw = await call("msp_context_replay", {
      actor: "boss",
      context_id: contextId,
      cache_id: null,
      run_id: "run-replay",
      turn_id: "turn-replay",
    });
    expect(raw.execution_reproducible).toBe(false);
    expect(raw.output_identical).toBe(false);
    expect(Array.isArray(raw.diagnostics)).toBe(true);
    expect(raw.diagnostics.some((line) => /execution_reproducible and output_identical are always false/i.test(line))).toBe(true);
  });
});

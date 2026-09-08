import { describe, it, expect } from "vitest";
import { createPipelineHandlers } from "../../apps/msp-server/src/transport/handlers/pipeline-handlers.mjs";
import { validatePipelineResponse, parsePrincipals, PIPELINE_VERSION } from "@freshair129/msp-contracts/pipeline";

const scope = { portfolioId: "p", tenantId: "t", businessId: "b", workspaceId: "", agentId: "", visibility: "private" };
const envelope = { schemaVersion: PIPELINE_VERSION, scope };
const env = { MSP_GKS_PIPELINE_CREDENTIAL: "relay-test", MSP_PIPELINE_PRINCIPALS: JSON.stringify([
  { credential: "source-test", principalId: "source", role: "source", scope },
  { credential: "worker-test", principalId: "worker", role: "worker", scope },
]) };
const metrics = { records_in: 2, records_out: 1, records_quarantined: 1, error_count: 0, retry_count: 0, duration_ms: 5 };
const row = { ...envelope, cursor: 1, runId: "run", pipelineStageId: "stage-9", executionStepId: "step-9", attemptId: "attempt-9", stageNumber: 9, outcome: "SUCCEEDED", startedAt: "2026-09-07T00:00:00Z", finishedAt: "2026-09-07T00:00:01Z", metrics, details: {} };

describe("genesisrag17 relay contract", () => {
  it("preserves pending submit acknowledgements and enforces PASS-only publication", () => {
    const submit = { ...envelope, batch: { batchId: "batch" } };
    const pending = { ...envelope, batchId: "batch", decisionId: null, status: "PENDING" };
    expect(validatePipelineResponse(pending, submit, "submit")).toEqual(pending);
    const request = { ...envelope, decisionId: "decision", decisionHash: "a".repeat(64) };
    for (const verdict of ["PASS", "WARN", "FAIL"]) {
      const denied = { ...envelope, verdict: { ...request, verdict, allowPublication: false } };
      expect(validatePipelineResponse(denied, request, "gate")).toEqual(denied);
      const allowed = { ...envelope, verdict: { ...denied.verdict, allowPublication: true } };
      if (verdict === "PASS") expect(validatePipelineResponse(allowed, request, "gate")).toEqual(allowed);
      else expect(() => validatePipelineResponse(allowed, request, "gate")).toThrow(/invalid_response/);
    }
  });

  it("replaces caller identity, relays exact batch and journals no payload or credential", async () => {
    const calls = [], journal = [];
    const handlers = createPipelineHandlers({ env, journal: { append: (entry) => journal.push(entry) }, gksProvider: { pipelineCall: async (...args) => { calls.push(args); return { ...envelope, batchId: "batch", decisionId: "decision", status: "READY" }; } } });
    const batch = { ...envelope, batchId: "batch", idempotencyKey: "stable-key", source: { content: "private document" } };
    const request = { ...envelope, credential: "source-test", actor: "forged", relayCredential: "forged", authenticatedPrincipal: { principalId: "forged" }, batch };
    await handlers.msp_pipeline_submit(request);
    expect(calls[0][0]).toBe("submit");
    expect(calls[0][1]).toEqual({ ...envelope, batch, relayCredential: "relay-test", authenticatedPrincipal: { principalId: "source", role: "source", scope } });
    expect(JSON.stringify(journal)).not.toMatch(/private document|source-test|relay-test|forged/);
    expect(request.actor).toBe("forged");
  });

  it("fails closed when provider or runtime relay credential is missing", async () => {
    const args = { ...envelope, credential: "worker-test", limit: 1 };
    await expect(createPipelineHandlers({ env }).msp_pipeline_claim(args)).rejects.toThrow(/unconfigured/);
    await expect(createPipelineHandlers({ env: { ...env, MSP_GKS_PIPELINE_CREDENTIAL: "" }, gksProvider: { pipelineCall() { throw new Error("called"); } } }).msp_pipeline_claim(args)).rejects.toThrow(/unconfigured/);
  });

  it("rejects missing metrics, late identity mismatch and cursor leaps over invalid evidence", () => {
    const request = { ...envelope, runId: "run", afterCursor: 0, limit: 100 };
    const page = { ...envelope, rows: [row], nextCursor: 1 };
    expect(validatePipelineResponse(page, request, "evidence")).toEqual(page);
    for (const bad of [
      { ...row, attemptId: null }, { ...row, runId: "other" }, { ...row, metrics: { records_in: 1 } },
      { ...row, metrics: { ...metrics, retry_count: -1 } }, { ...row, finishedAt: "2026-09-06T00:00:00Z" },
      { ...row, scope: { ...scope, tenantId: "other" } },
    ]) expect(() => validatePipelineResponse({ ...page, rows: [bad] }, request, "evidence")).toThrow(/invalid_response/);
    expect(() => validatePipelineResponse({ ...page, nextCursor: 100 }, request, "evidence")).toThrow(/invalid_response/);
    expect(() => validatePipelineResponse({ ...page, rows: [row, { ...row, cursor: 2 }], nextCursor: 2 }, request, "evidence")).toThrow(/invalid_response/);
  });

  it("allows only explicit loopback origin and does not follow query redirects", async () => {
    const args = { ...envelope, credential: "source-test", query: "Where does Alice work?", topK: 5 };
    let options;
    const fetchImpl = async (url, init) => { options = init; expect(url.href).toBe("http://127.0.0.1:1234/query"); return { ok: true, json: async () => ({ ...envelope, snapshotId: "snapshot", generation: "1", results: [] }) }; };
    const handlers = createPipelineHandlers({ env: { ...env, MSP_PIPELINE_WORKER_URL: "http://127.0.0.1:1234", MSP_PIPELINE_WORKER_TOKEN: "query-test" }, fetchImpl });
    await handlers.msp_pipeline_query(args);
    expect(options.redirect).toBe("error");
    expect(options.headers.authorization).toBe("Bearer query-test");
    expect(JSON.parse(options.body)).toEqual({ ...envelope, query: args.query, topK: 5 });
    for (const url of ["https://example.com", "http://localhost:1", "http://127.0.0.1@evil.test", "http://127.0.0.1/foo"]) {
      const other = createPipelineHandlers({ env: { ...env, MSP_PIPELINE_WORKER_URL: url, MSP_PIPELINE_WORKER_TOKEN: "query-test" }, fetchImpl: () => { throw new Error("called"); } });
      await expect(other.msp_pipeline_query(args)).rejects.toThrow(/loopback/);
    }
  });

  it("refuses malformed config instead of selecting an ambiguous privileged grant", () => {
    expect(() => parsePrincipals("{bad")).toThrow(/config/);
    const grant = { credential: "same", principalId: "p", role: "source", scope };
    expect(() => parsePrincipals(JSON.stringify([grant, { ...grant, role: "worker" }]))).toThrow(/ambiguous/);
  });
});

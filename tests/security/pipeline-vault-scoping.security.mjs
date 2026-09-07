import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { createPipelineHandlers } from "../../apps/msp-server/src/transport/handlers/pipeline-handlers.mjs";
import { PIPELINE_VERSION, PIPELINE_ROLES, SCOPE_KEYS } from "@freshair129/msp-contracts/pipeline";

const scope = { portfolioId: "p", tenantId: "tenant-a", businessId: "b", workspaceId: "w", agentId: "a", visibility: "private" };
const base = { schemaVersion: PIPELINE_VERSION, scope };
const env = { MSP_GKS_PIPELINE_CREDENTIAL: "relay", MSP_PIPELINE_PRINCIPALS: JSON.stringify([
  { credential: "source", principalId: "source", role: "source", scope },
  { credential: "worker", principalId: "worker", role: "worker", scope },
]) };

for (const suffix of Object.keys(PIPELINE_ROLES)) {
  test(`${suffix} denies every wrong scope before provider or query access`, async () => {
    let calls = 0;
    const handlers = createPipelineHandlers({ env, gksProvider: { pipelineCall: () => { calls++; } }, fetchImpl: () => { calls++; } });
    const credential = PIPELINE_ROLES[suffix][0];
    for (const key of SCOPE_KEYS) {
      await assert.rejects(handlers[`msp_pipeline_${suffix}`]({ ...base, credential, scope: { ...scope, [key]: "other" } }), /scope/);
    }
    await assert.rejects(handlers[`msp_pipeline_${suffix}`]({ ...base, credential: "forged", actor: "worker" }), /scope/);
    assert.equal(calls, 0);
  });
}

test("source cannot impersonate a physical receipt reporter", async () => {
  let calls = 0;
  const handlers = createPipelineHandlers({ env, gksProvider: { pipelineCall: () => { calls++; } } });
  for (const suffix of ["claim", "graph_receipt", "write_receipt", "gate", "publication_receipt"]) {
    await assert.rejects(handlers[`msp_pipeline_${suffix}`]({ ...base, credential: "source", actor: "worker", authenticatedPrincipal: { role: "worker" }, receipt: base }), /scope/);
  }
  assert.equal(calls, 0);
});

test("nested foreign-scope batch/receipt is rejected with a valid outer grant", async () => {
  const handlers = createPipelineHandlers({ env, gksProvider: { pipelineCall: () => { throw new Error("should never relay"); } } });
  await assert.rejects(handlers.msp_pipeline_submit({ ...base, credential: "source", batch: { ...base, scope: { ...scope, tenantId: "tenant-b" } } }), /scope/);
  await assert.rejects(handlers.msp_pipeline_write_receipt({ ...base, credential: "worker", receipt: { ...base, scope: { ...scope, portfolioId: "other" } } }), /scope/);
});

test("real stdio registration enforces every pipeline grant before unconfigured providers", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "msp-ki17-auth-"));
  const runtimeEnv = { ...process.env, ...env, MSP_DB_PATH: path.join(temp, "test.sqlite") };
  delete runtimeEnv.MSP_GKS_COMMAND;
  delete runtimeEnv.MSP_PIPELINE_WORKER_URL;
  const call = createMspStdioCaller({ command: process.execPath, args: [path.resolve("apps/msp-server/bin/msp-server.mjs")], env: runtimeEnv });
  try {
    for (const suffix of Object.keys(PIPELINE_ROLES)) {
      const credential = PIPELINE_ROLES[suffix][0];
      for (const key of SCOPE_KEYS) await assert.rejects(call(`msp_pipeline_${suffix}`, { ...base, credential, scope: { ...scope, [key]: "foreign" } }), /scope/);
      await assert.rejects(call(`msp_pipeline_${suffix}`, { ...base, credential: "unknown", actor: "worker" }), /scope/);
    }
    await assert.rejects(call("msp_pipeline_claim", { ...base, credential: "worker", limit: 1 }), /unconfigured/);
  } finally {
    call.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

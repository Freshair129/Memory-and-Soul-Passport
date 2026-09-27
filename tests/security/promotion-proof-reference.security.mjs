import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../../apps/msp-server/src/server.mjs";

function proofBatch(workspaceId, idempotencyKey) {
  return {
    actor: "proof-test",
    schema_version: "govibe-proof-batch/v1",
    idempotency_key: idempotencyKey,
    run_id: `run-${idempotencyKey}`,
    workspace_id: workspaceId,
    stage: 1,
    source_snapshot_hash: "a".repeat(64),
    verification: { verdict: "passed" },
  };
}

function memoryPromotion(workspaceId, evidenceRef, idempotencyKey) {
  return {
    actor: "promotion-test",
    agent_id: "agent-promotion-test",
    workspace_id: workspaceId,
    source_memory_ref: "opaque source value",
    target_scope: "global_private",
    candidate: { note: "proof reference security case" },
    evidence_refs: [evidenceRef],
    reason: "proof reference security test",
    idempotency_key: idempotencyKey,
  };
}

function knowledgePromotion(workspaceId, provenanceRef, idempotencyKey) {
  return {
    schema_version: "govibe-knowledge-candidate/v1",
    idempotency_key: idempotencyKey,
    run_id: `run-${idempotencyKey}`,
    workspace_id: workspaceId,
    stage: 1,
    source_snapshot_hash: "a".repeat(64),
    provenance_ref: provenanceRef,
    candidate: { note: "proof reference security case" },
  };
}

async function assertInvalidProof(callPromise) {
  const error = await callPromise.then(() => null, (rejection) => rejection);
  assert.ok(error, "expected proof validation to fail");
  assert.equal(error.code, "invalid_request");
  assert.equal(error.message, "Proof reference is invalid or unavailable.");
  return error;
}

test("promotion proof refs must name an allowed receipt in the same workspace", async () => {
  const server = createServer({ dbPath: ":memory:" });
  const call = async (name, input) => (await server.toolRegistry.dispatch(name, input)).structuredContent;
  try {
    await assert.rejects(
      call("msp_evidence_record", { ...proofBatch("", "proof-empty-workspace"), workspace_id: "" }),
      (error) => error.code === "invalid_request",
    );

    const proof = await call("msp_evidence_record", proofBatch("workspace-a", "proof-workspace-a"));
    server.journal.append({
      actor: "proof-test",
      toolName: "msp_evidence_record",
      ref: "msp:proof/proof-denied",
      workspaceId: "workspace-a",
      payload: {},
      policyDecision: "deny",
    });
    const validMemoryPromotion = await call(
      "msp_memory_promote",
      memoryPromotion("workspace-a", proof.proof_ref, "promotion-workspace-a"),
    );
    assert.equal(validMemoryPromotion.policy_decision, "allow");

    const invalidMemoryPromotions = [
      memoryPromotion("workspace-a", "trust me", "promotion-arbitrary-proof"),
      memoryPromotion("workspace-a", "msp:wrong-kind/proof", "promotion-malformed-proof"),
      memoryPromotion("workspace-a", "gks:evidence/foreign", "promotion-foreign-proof"),
      memoryPromotion("workspace-b", proof.proof_ref, "promotion-cross-workspace"),
      memoryPromotion("workspace-a", "msp:proof/never-recorded", "promotion-missing-proof"),
      memoryPromotion("workspace-a", "msp:proof/proof-denied", "promotion-denied-proof"),
    ];
    for (const input of invalidMemoryPromotions) {
      await assertInvalidProof(call("msp_memory_promote", input));
    }

    await assert.rejects(
      call("msp_knowledge_promote", knowledgePromotion("workspace-a", proof.proof_ref, "knowledge-workspace-a")),
      (error) => error.code === "gks_provider_unconfigured",
    );
    await assert.rejects(
      call("msp_knowledge_promote", knowledgePromotion("", proof.proof_ref, "knowledge-empty-workspace")),
      (error) => error.code === "invalid_request" && error.message === "workspace_id is required.",
    );
    const invalidKnowledgePromotions = [
      knowledgePromotion("workspace-a", "trust me", "knowledge-arbitrary-proof"),
      knowledgePromotion("workspace-a", "msp:wrong-kind/proof", "knowledge-malformed-proof"),
      knowledgePromotion("workspace-a", "gks:evidence/foreign", "knowledge-foreign-proof"),
      knowledgePromotion("workspace-b", proof.proof_ref, "knowledge-cross-workspace"),
      knowledgePromotion("workspace-a", "msp:proof/never-recorded", "knowledge-missing-proof"),
      knowledgePromotion("workspace-a", "msp:proof/proof-denied", "knowledge-denied-proof"),
    ];
    for (const input of invalidKnowledgePromotions) {
      await assertInvalidProof(call("msp_knowledge_promote", input));
    }

    await assertInvalidProof(call("msp_memory_promote", { ...memoryPromotion("workspace-a", proof.proof_ref, "promotion-no-refs"), evidence_refs: [] }));
    await assertInvalidProof(call("msp_knowledge_promote", { ...knowledgePromotion("workspace-a", proof.proof_ref, "knowledge-no-ref"), provenance_ref: undefined }));
  } finally {
    server.close();
  }
});

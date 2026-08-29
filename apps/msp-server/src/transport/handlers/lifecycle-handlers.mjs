// transport/handlers/lifecycle-handlers: msp_evidence_record,
// msp_knowledge_promote (fail-closed stub), msp_memory_promote (WP-13
// Bounded Scope item 6).
import { proofRef, memoryPromotionRef, knowledgePromotionRef } from "@freshair129/msp-contracts/refs";
import { rejectCanonicalCandidate, requireNoGksRefs } from "@freshair129/msp-contracts/namespace-guard";
import { GksProviderInvalidResponseError, GksProviderUnconfiguredError, ValidationError } from "@freshair129/msp-contracts/errors";

const HASH = /^[a-f0-9]{64}$/i;
// Mirrors packages/govibe-core/src/msp-client.mjs's KNOWLEDGE_FIELDS
// exactly: a proof batch must not smuggle in knowledge-shaped content.
const KNOWLEDGE_FIELDS = ["atoms", "symbols", "relations", "nodes", "edges", "communities", "processes", "context_snapshots"];

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required.`);
  return value.trim();
}

function resolveActor(args) {
  if (typeof args.actor === "string" && args.actor.trim()) return args.actor.trim();
  if (typeof args.run_id === "string" && args.run_id.trim()) return args.run_id.trim();
  return "system";
}

// Re-validates the exact shape validateProofBatch in
// packages/govibe-core/src/msp-client.mjs already enforces client-side --
// defense in depth, not trust in the caller (WP-13 Bounded Scope item 3):
// schema_version, idempotency_key, run_id, stage 0-12, source_snapshot_hash
// (64-hex), verification.verdict in actual/blocked/failed/passed, and no
// KNOWLEDGE_FIELDS present anywhere in the batch.
function validateProofBatch(input) {
  if (!input || typeof input !== "object") throw new ValidationError("Proof batch is required.");
  if (KNOWLEDGE_FIELDS.some((field) => field in input)) {
    throw new ValidationError("MSP proof batches cannot contain knowledge fields.");
  }
  if (input.schema_version !== "govibe-proof-batch/v1") throw new ValidationError("Invalid proof batch schema version.");
  requireString(input.idempotency_key, "idempotency_key");
  requireString(input.run_id, "run_id");
  if (!Number.isInteger(input.stage) || input.stage < 0 || input.stage > 12) {
    throw new ValidationError("Proof batch stage must be 0-12.");
  }
  if (!HASH.test(input.source_snapshot_hash ?? "")) throw new ValidationError("Proof batch source snapshot hash is invalid.");
  if (!["actual", "blocked", "failed", "passed"].includes(input.verification?.verdict)) {
    throw new ValidationError("Invalid verification verdict.");
  }
}

function validateKnowledgeCandidate(input) {
  if (!input || typeof input !== "object") throw new ValidationError("Knowledge candidate is required.");
  if (input.schema_version !== "govibe-knowledge-candidate/v1") throw new ValidationError("Invalid knowledge candidate schema version.");
  requireString(input.idempotency_key, "idempotency_key");
  requireString(input.run_id, "run_id");
  if (!Number.isInteger(input.stage) || input.stage < 1 || input.stage > 12) throw new ValidationError("Knowledge candidate stage must be 1-12.");
  if (!HASH.test(input.source_snapshot_hash ?? "")) throw new ValidationError("Knowledge candidate source snapshot hash is invalid.");
  const provenance = requireString(input.provenance_ref, "provenance_ref");
  if (!provenance.startsWith("msp:proof/")) throw new ValidationError("Knowledge candidate provenance must be an msp:proof reference.");
  requireNoGksRefs([provenance], "provenance_ref");
  rejectCanonicalCandidate(input.candidate ?? {});
}

function validateGksResult(result, expectedHash) {
  if (!result || typeof result !== "object" || typeof result.knowledge_ref !== "string" || !result.knowledge_ref.startsWith("gks:")) {
    throw new GksProviderInvalidResponseError();
  }
  if (!HASH.test(result.source_hash ?? "") || result.source_hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new GksProviderInvalidResponseError("gks_provider_invalid_response: source_hash does not match the candidate snapshot.");
  }
  if (typeof result.idempotent !== "boolean") throw new GksProviderInvalidResponseError();
  return { knowledge_ref: result.knowledge_ref, source_hash: result.source_hash.toLowerCase(), idempotent: result.idempotent };
}

export function createLifecycleHandlers({ db, entityStore, vaultRegistry, journal, gksProvider = null }) {
  // WP-14: promotions is re-keyed to UNIQUE(vault_id, idempotency_key) (was
  // UNIQUE(idempotency_key) globally) -- this is the direct fix for the
  // cross-agent Global-Private disclosure this packet exists to close (see
  // migration 0003_vault_scoping.sql's header comment). The idempotency
  // check and the promotions row itself are now both scoped by the calling
  // agent's Global-Private vault_id, not by idempotency_key alone.
  const selectPromotion = db.prepare("SELECT * FROM promotions WHERE vault_id = ? AND idempotency_key = ?");
  const insertPromotion = db.prepare(`
    INSERT INTO promotions (promotion_ref, vault_id, idempotency_key, source_memory_ref, target_scope, target_ref, policy_decision, source_hash, recorded_at)
    VALUES (@promotion_ref, @vault_id, @idempotency_key, @source_memory_ref, @target_scope, @target_ref, @policy_decision, @source_hash, @recorded_at)
  `);
  const selectKnowledgePromotion = db.prepare("SELECT * FROM knowledge_promotions WHERE idempotency_key = ?");
  const insertKnowledgePromotion = db.prepare(`
    INSERT INTO knowledge_promotions (promotion_ref, idempotency_key, knowledge_ref, source_hash, recorded_at)
    VALUES (@promotion_ref, @idempotency_key, @knowledge_ref, @source_hash, @recorded_at)
  `);

  // AC-04 (WP-13) / AC-03 (WP-14): the whole vault-provision + idempotency-
  // check + write path runs inside one db.transaction() (better-sqlite3
  // nests entity-store's own internal transaction() call as a SAVEPOINT) so
  // a retry with the same idempotency_key can never observe or create a
  // duplicate entity, even under pipelined concurrent calls -- and, as of
  // WP-14, so the vault_id used for the idempotency check and the vault_id
  // used for the entity-store write are always the exact same value,
  // computed once.
  const runGlobalPrivatePromotion = db.transaction(({ actor, agentId, idempotencyKey, sourceMemoryRef, targetScope, candidate, evidenceRefs, reason }) => {
    const globalPrivateVault = vaultRegistry.provisionGlobalPrivateVault(agentId);
    const vaultId = globalPrivateVault.vault_id;

    const existing = selectPromotion.get(vaultId, idempotencyKey);
    if (existing) {
      return {
        promotion_ref: existing.promotion_ref,
        target_ref: existing.target_ref,
        policy_decision: existing.policy_decision,
        source_hash: existing.source_hash,
      };
    }

    const { entity } = entityStore.upsert({
      vaultId,
      category: "memory-promotion",
      key: idempotencyKey,
      bodyJson: { candidate, sourceMemoryRef, evidenceRefs, reason },
      actor,
      reason: "memory_promote:global_private",
    });

    const promotion_ref = memoryPromotionRef(vaultId, idempotencyKey);
    insertPromotion.run({
      promotion_ref,
      vault_id: vaultId,
      idempotency_key: idempotencyKey,
      source_memory_ref: sourceMemoryRef,
      target_scope: targetScope,
      target_ref: entity.entity_id,
      policy_decision: "allow",
      source_hash: entity.source_hash,
      recorded_at: new Date().toISOString(),
    });

    return { promotion_ref, target_ref: entity.entity_id, policy_decision: "allow", source_hash: entity.source_hash };
  });

  return {
    // Request fields as built by recordEvidence in msp-client.mjs: whatever
    // shape validateProofBatch accepts, forwarded verbatim.
    async msp_evidence_record(args = {}) {
      validateProofBatch(args);
      const actor = resolveActor(args);
      const ref = proofRef(args.idempotency_key);

      journal.append({
        actor,
        toolName: "msp_evidence_record",
        ref,
        workspaceId: args.workspace_id ?? null,
        payload: {
          idempotency_key: args.idempotency_key,
          run_id: args.run_id,
          stage: args.stage,
          verdict: args.verification?.verdict,
        },
        policyDecision: "allow",
      });

      return { proof_ref: ref };
    },

    async msp_knowledge_promote(args = {}) {
      validateKnowledgeCandidate(args);
      const actor = resolveActor(args);
      const existing = selectKnowledgePromotion.get(args.idempotency_key);
      if (existing) {
        if (existing.source_hash !== args.source_snapshot_hash.toLowerCase()) {
          throw new ValidationError("Knowledge promotion idempotency key is already bound to a different source hash.");
        }
        return { knowledge_ref: existing.knowledge_ref, source_hash: existing.source_hash, promotion_ref: existing.promotion_ref };
      }
      if (!gksProvider) {
        journal.append({ actor, toolName: "msp_knowledge_promote", ref: null, workspaceId: args.workspace_id ?? null, payload: { idempotency_key: args.idempotency_key, denied: true }, policyDecision: "deny", reason: "gks_provider_unconfigured" });
        throw new GksProviderUnconfiguredError("gks_provider_unconfigured: MSP_GKS_COMMAND is not configured.");
      }
      const promoted = validateGksResult(await gksProvider.promote(args), args.source_snapshot_hash);
      const result = db.transaction(() => {
        const concurrent = selectKnowledgePromotion.get(args.idempotency_key);
        if (concurrent) {
          if (concurrent.source_hash !== promoted.source_hash || concurrent.knowledge_ref !== promoted.knowledge_ref) {
            throw new GksProviderInvalidResponseError("gks_provider_invalid_response: conflicting promotion receipt.");
          }
          return { knowledge_ref: concurrent.knowledge_ref, source_hash: concurrent.source_hash, promotion_ref: concurrent.promotion_ref };
        }
        const promotion_ref = knowledgePromotionRef(args.idempotency_key);
        insertKnowledgePromotion.run({ promotion_ref, idempotency_key: args.idempotency_key, knowledge_ref: promoted.knowledge_ref, source_hash: promoted.source_hash, recorded_at: new Date().toISOString() });
        return { knowledge_ref: promoted.knowledge_ref, source_hash: promoted.source_hash, promotion_ref };
      })();
      journal.append({ actor, toolName: "msp_knowledge_promote", ref: result.promotion_ref, workspaceId: args.workspace_id ?? null, payload: { idempotency_key: args.idempotency_key, knowledge_ref: result.knowledge_ref }, policyDecision: "allow" });
      return result;
    },

    // Request fields as built by promoteMemory in
    // msp-vault-context-contracts.mjs: schema_version, actor, agent_id,
    // workspace_id, source_memory_ref, target_scope, candidate,
    // evidence_refs, reason, idempotency_key.
    async msp_memory_promote(args = {}) {
      const actor = requireString(args.actor, "actor");
      const agentId = requireString(args.agent_id, "agent_id");
      const workspaceId = requireString(args.workspace_id, "workspace_id");
      const sourceMemoryRef = requireString(args.source_memory_ref, "source_memory_ref");
      const targetScope = requireString(args.target_scope, "target_scope");
      const idempotencyKey = requireString(args.idempotency_key, "idempotency_key");
      const reason = requireString(args.reason, "reason");
      if (!Array.isArray(args.evidence_refs) || args.evidence_refs.length === 0) {
        throw new ValidationError("evidence_refs must contain at least one reference.");
      }
      // AC-06 defense in depth: reject a canonical-identity candidate or a
      // gks:-namespaced evidence/source ref server-side, independent of the
      // GoVibe-side rejectCanonicalCandidate guard that already runs before
      // this request is ever sent.
      requireNoGksRefs(args.evidence_refs, "evidence_refs");
      requireNoGksRefs([sourceMemoryRef], "source_memory_ref");
      const candidate = rejectCanonicalCandidate(args.candidate ?? {});

      if (targetScope === "shared") {
        journal.append({
          actor,
          toolName: "msp_memory_promote",
          ref: null,
          workspaceId,
          payload: { idempotency_key: idempotencyKey, target_scope: targetScope, denied: true },
          policyDecision: "deny",
          reason: "gks_provider_unconfigured",
        });
        throw new GksProviderUnconfiguredError(
          "msp_memory_promote(target_scope=shared) is a fail-closed stub: gks_provider_unconfigured (no GKS provider exists in v1, per ADR-027).",
        );
      }

      if (targetScope !== "global_private") {
        throw new ValidationError(
          `Unsupported target_scope "${targetScope}"; only "global_private" and "shared" are recognized.`,
        );
      }

      const result = runGlobalPrivatePromotion({
        actor,
        agentId,
        idempotencyKey,
        sourceMemoryRef,
        targetScope,
        candidate,
        evidenceRefs: args.evidence_refs,
        reason,
      });

      journal.append({
        actor,
        toolName: "msp_memory_promote",
        ref: result.promotion_ref,
        workspaceId,
        payload: { idempotency_key: idempotencyKey, target_scope: targetScope, target_ref: result.target_ref },
        policyDecision: "allow",
      });

      return result;
    },
  };
}

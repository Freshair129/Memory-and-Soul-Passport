import { buildBoundedGraphQuery } from "./authority-enforcement.mjs";
import { createMspStdioCaller } from "./msp-stdio-transport.mjs";

export class MspUnavailableError extends Error {
  constructor(message = "MSP transport is unavailable.") {
    super(message);
    this.name = "MspUnavailableError";
  }
}

export class MspConfigurationError extends Error {
  constructor(message, code = "MSP_CONFIGURATION_INVALID") {
    super(message);
    this.name = "MspConfigurationError";
    this.code = code;
  }
}

const HASH = /^[a-f0-9]{64}$/i;
const KNOWLEDGE_FIELDS = ["atoms", "symbols", "relations", "nodes", "edges", "communities", "processes", "context_snapshots"];

function requireRef(value, prefix, label) {
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new Error(`MSP returned an invalid ${label} reference.`);
  return value;
}

function validateProofBatch(input) {
  if (!input || typeof input !== "object") throw new TypeError("Proof batch is required.");
  if (KNOWLEDGE_FIELDS.some((field) => field in input)) throw new TypeError("MSP proof batches cannot contain knowledge fields.");
  if (input.schema_version !== "govibe-proof-batch/v1") throw new TypeError("Invalid proof batch schema version.");
  if (typeof input.idempotency_key !== "string" || !input.idempotency_key) throw new TypeError("Proof batch idempotency key is required.");
  if (typeof input.run_id !== "string" || !input.run_id) throw new TypeError("Proof batch run ID is required.");
  if (!Number.isInteger(input.stage) || input.stage < 0 || input.stage > 12) throw new TypeError("Proof batch stage must be 0-12.");
  if (!HASH.test(input.source_snapshot_hash ?? "")) throw new TypeError("Proof batch source snapshot hash is invalid.");
  if (!["actual", "blocked", "failed", "passed"].includes(input.verification?.verdict)) throw new TypeError("Invalid verification verdict.");
}

function validateKnowledgeCandidate(input) {
  if (!input || input.schema_version !== "govibe-knowledge-candidate/v1") throw new TypeError("Invalid knowledge candidate schema version.");
  if (typeof input.idempotency_key !== "string" || !input.idempotency_key) throw new TypeError("Knowledge candidate idempotency key is required.");
  if (typeof input.run_id !== "string" || !input.run_id) throw new TypeError("Knowledge candidate run ID is required.");
  if (!Number.isInteger(input.stage) || input.stage < 1 || input.stage > 12) throw new TypeError("Knowledge candidate stage must be 1-12.");
  if (!HASH.test(input.source_snapshot_hash ?? "")) throw new TypeError("Knowledge candidate source snapshot hash is invalid.");
  if (!requireRef(input.provenance_ref, "msp:proof/", "provenance")) throw new TypeError("Knowledge candidate provenance is required.");
}

export class MspClient {
  constructor(callTool) {
    this.callTool = callTool;
  }

  async call(name, input) {
    if (typeof this.callTool !== "function") throw new MspUnavailableError();
    return this.callTool(name, input);
  }

  registerWorkspace(input) {
    return this.call("msp_workspace_register", {
      schema_version: "govibe-workspace-registration/v1",
      actor: input.actor,
      workspace_id: input.workspaceId,
      project_id: input.projectId ?? null,
      workspace_path: input.workspacePath,
      vault_bindings: input.vaultBindings ?? null,
      idempotency_key: input.recordId,
      run_id: input.runId,
      recorded_at: input.timestamp,
      source_hash: input.sourceHash,
    }).then((result) => ({
      workspaceRef: requireRef(result?.workspace_ref ?? result?.workspaceRef, "msp:workspace/", "workspace"),
      registryRef: result?.registry_ref ?? result?.registryRef ?? null,
    }));
  }

  async resolveContext(input) {
    const boundedGraphQuery = buildBoundedGraphQuery(input.contextAuthority);
    const result = await this.call("msp_context_resolve", {
      workspace_root: input.workspacePath,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      context_profile: input.contextProfile ?? "T-ctx",
      parent_context_id: input.parentContextId ?? null,
      workflow_ref: input.workflowRef ?? null,
      mode: input.mode ?? "codev",
      state_keys: input.stateKeys ?? [],
      knowledge_refs: input.knowledgeRefs ?? [],
      context_authority: input.contextAuthority,
      bounded_graph_query: boundedGraphQuery,
    });
    const normalizeRefs = (refs, label, prefix) => (refs ?? []).map((item) => {
      const ref = item?.ref;
      const sourceHash = item?.sourceHash ?? item?.source_hash;
      if (typeof ref !== "string" || !ref || typeof sourceHash !== "string" || !HASH.test(sourceHash)) {
        throw new Error(`MSP returned an invalid ${label} reference.`);
      }
      if (!ref.startsWith(prefix)) throw new Error(`MSP returned an out-of-namespace ${label} reference.`);
      return { ref, sourceHash: sourceHash.toLowerCase(), version: item.version ?? null };
    });
    const policyDecisions = (result.policyDecisions ?? result.policy_decisions ?? []).map((item) => {
      if (!["allow", "deny", "shadow"].includes(item?.decision) || typeof item?.ref !== "string" || typeof item?.reason !== "string") {
        throw new Error("MSP returned an invalid policy decision.");
      }
      return { decision: item.decision, ref: item.ref, reason: item.reason };
    });
    return {
      contextId: result.context_id ?? result.contextId ?? null,
      cacheId: result.cache_id ?? result.cacheId ?? null,
      policyDecision: result.policy_decision ?? result.policyDecision ?? null,
      sources: result.sources ?? input.contextAuthority.sources,
      lineage: result.lineage ?? {
        runId: input.contextAuthority.identity.runId,
        sessionId: input.contextAuthority.identity.sessionId,
        turnId: input.contextAuthority.identity.turnId,
      },
      boundedGraphQuery: result.bounded_graph_query ?? result.boundedGraphQuery ?? boundedGraphQuery,
      globalPrivateVaultRefs: normalizeRefs(result.global_private_vault_refs ?? result.globalStateRefs, "global private vault", "msp:vault/"),
      workspacePrivateVaultRefs: normalizeRefs(result.workspace_private_vault_refs ?? result.workspaceStateRefs, "workspace private vault", "msp:vault/"),
      sharedVaultRefs: normalizeRefs(result.shared_vault_refs ?? result.knowledgeRefs, "shared vault", "gks:"),
      workflowRef: result.workflow_ref ?? result.workflowRef ?? null,
      diffRef: result.diff_ref ?? result.diffRef ?? null,
      policyDecisions,
      diagnostics: result.diagnostics ?? [],
    };
  }

  async submitKnowledgeCandidate(input) {
    validateKnowledgeCandidate(input);
    const result = await this.call("msp_knowledge_promote", input);
    return {
      knowledgeRef: requireRef(result?.knowledge_ref ?? result?.knowledgeRef, "gks:", "knowledge"),
      sourceHash: (() => {
        const value = result?.source_hash ?? result?.sourceHash;
        if (!HASH.test(value ?? "")) throw new Error("MSP returned an invalid promoted knowledge hash.");
        return value.toLowerCase();
      })(),
      promotionRef: requireRef(result?.promotion_ref ?? result?.promotionRef, "msp:promotion/", "promotion"),
    };
  }

  async recordContextInjection(input) {
    const result = await this.call("msp_context_injection_record", input);
    return { injectionRef: requireRef(result?.injection_ref ?? result?.injectionRef, "msp:context-injection/", "context injection") };
  }

  async replayContext(input) {
    const result = await this.call("msp_context_replay", input);
    return {
      replayRef: requireRef(result?.replay_ref ?? result?.replayRef, "msp:replay/", "replay"),
      contextReproducible: Boolean(result?.context_reproducible ?? result?.contextReproducible),
      executionReproducible: Boolean(result?.execution_reproducible ?? result?.executionReproducible),
      outputIdentical: Boolean(result?.output_identical ?? result?.outputIdentical),
    };
  }

  async recordEvidence(input) {
    validateProofBatch(input);
    const result = await this.call("msp_evidence_record", input);
    return { proofRef: requireRef(result?.proof_ref ?? result?.proofRef, "msp:proof/", "proof") };
  }
}

export function createUnavailableMspClient() {
  return new MspClient(undefined);
}

function parseMspConfiguration(env = process.env) {
  const command = env.GOVIBE_MSP_COMMAND;
  if (command == null || command === "") return { status: "unconfigured", command: null, args: [], cwd: null };
  if (typeof command !== "string" || !command.trim()) {
    throw new MspConfigurationError("GOVIBE_MSP_COMMAND must be a non-empty string.");
  }
  let args = [];
  if (env.GOVIBE_MSP_ARGS) {
    try {
      args = JSON.parse(env.GOVIBE_MSP_ARGS);
    } catch {
      throw new MspConfigurationError("GOVIBE_MSP_ARGS must be valid JSON.");
    }
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      throw new MspConfigurationError("GOVIBE_MSP_ARGS must be a JSON array of strings.");
    }
  }
  if (env.GOVIBE_MSP_CWD != null && (typeof env.GOVIBE_MSP_CWD !== "string" || !env.GOVIBE_MSP_CWD.trim())) {
    throw new MspConfigurationError("GOVIBE_MSP_CWD must be a non-empty string when provided.");
  }
  return { status: "configured", command: command.trim(), args, cwd: env.GOVIBE_MSP_CWD?.trim() ?? null };
}

/**
 * Configuration-only preflight. A configured transport is not evidence that
 * the MSP process is running or that its downstream GKS/storage is healthy.
 */
export function inspectMspConfiguration(env = process.env) {
  try {
    const configuration = parseMspConfiguration(env);
    return {
      ...configuration,
      dispatchable: false,
      reason: configuration.status === "configured" ? "msp_parent_not_probed" : "msp_command_missing",
    };
  } catch (error) {
    return {
      status: "invalid",
      dispatchable: false,
      reason: error instanceof MspConfigurationError ? error.code.toLowerCase() : "msp_configuration_invalid",
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function createMspClientFromEnvironment(env = process.env) {
  const configuration = parseMspConfiguration(env);
  if (configuration.status === "unconfigured") return createUnavailableMspClient();
  return new MspClient(createMspStdioCaller({ command: configuration.command, args: configuration.args, cwd: configuration.cwd ?? undefined, env }));
}

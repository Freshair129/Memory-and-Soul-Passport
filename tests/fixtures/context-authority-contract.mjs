const HASH = /^(?:sha256:)?[a-f0-9]{64}$/i;

export class ContextAuthorityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ContextAuthorityError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function fail(code, message, details) {
  throw new ContextAuthorityError(code, message, details);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) fail("missing_authority_field", `${field} is required.`, { field });
  return value.trim();
}

function requireStringArray(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()) || value.length < min) {
    fail("invalid_authority_field", `${field} must contain at least ${min} non-empty string value(s).`, { field, min });
  }
  return value.map((item) => item.trim());
}

function normalizeSources(value) {
  if (!Array.isArray(value) || value.length === 0) fail("missing_source_lineage", "sources must contain at least one versioned source.", { field: "sources" });
  return value.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) fail("invalid_source_lineage", "Each source must be an object.", { index });
    const id = requireString(source.id, `sources[${index}].id`);
    const version = requireString(source.version, `sources[${index}].version`);
    const hash = requireString(source.hash, `sources[${index}].hash`);
    if (!HASH.test(hash)) fail("invalid_source_hash", `sources[${index}].hash must be a SHA-256 digest.`, { index, hash });
    return { id, version, hash: hash.toLowerCase() };
  });
}

export function validateContextAuthorityRequest(args = {}) {
  const identity = {
    taskId: requireString(args.taskId, "taskId"),
    agentId: requireString(args.agentId, "agentId"),
    workspaceId: requireString(args.workspaceId, "workspaceId"),
    runId: requireString(args.runId, "runId"),
    sessionId: requireString(args.sessionId, "sessionId"),
    turnId: requireString(args.turnId, "turnId"),
  };

  const requiredReasonRefs = requireStringArray(args.requiredReasonRefs, "requiredReasonRefs", { min: 1 });
  const relationAllowlist = requireStringArray(args.relationAllowlist, "relationAllowlist", { min: 1 });
  if (relationAllowlist.includes("*") || relationAllowlist.includes("unrestricted")) {
    fail("unrestricted_traversal", "Unrestricted relation traversal is prohibited.", { relationAllowlist });
  }

  const retrievalRadius = Number(args.retrievalRadius);
  if (!Number.isInteger(retrievalRadius) || retrievalRadius < 0 || retrievalRadius > 6) {
    fail("invalid_retrieval_radius", "retrievalRadius must be an integer from 0 to 6.", { retrievalRadius: args.retrievalRadius });
  }

  const unresolvedAssumptions = requireStringArray(args.unresolvedAssumptions ?? [], "unresolvedAssumptions");
  if (unresolvedAssumptions.length > 0) {
    fail("unresolved_assumption", "Context dispatch is blocked while assumptions remain unresolved.", { unresolvedAssumptions });
  }

  const exclusions = requireStringArray(args.exclusions ?? [], "exclusions");
  const inclusions = requireStringArray(args.inclusions ?? [], "inclusions");
  const knowledgeRefs = requireStringArray(args.knowledgeRefs ?? [], "knowledgeRefs");
  const sources = normalizeSources(args.sources);

  const budget = args.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) fail("missing_budget", "budget is required.", { field: "budget" });
  const maxTokens = Number(budget.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) fail("invalid_budget", "budget.maxTokens must be a positive integer.", { maxTokens: budget.maxTokens });

  const lineage = args.lineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) fail("missing_replay_lineage", "lineage is required.", { field: "lineage" });
  const normalizedLineage = {
    contextId: requireString(lineage.contextId, "lineage.contextId"),
    cacheId: requireString(lineage.cacheId, "lineage.cacheId"),
    parentContextId: lineage.parentContextId == null ? null : requireString(lineage.parentContextId, "lineage.parentContextId"),
  };

  return {
    schemaVersion: "govibe-context-authority/v1",
    identity,
    sources,
    requiredReasonRefs,
    traversal: { relationAllowlist, retrievalRadius, inclusions, exclusions },
    knowledgeRefs,
    budget: { ...budget, maxTokens },
    lineage: normalizedLineage,
    unresolvedAssumptions: [],
  };
}

export function validateContextAuthorityResponse(response, requestContract) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail("invalid_msp_response", "MSP context response must be an object.");
  }

  const policyDecision = requireString(response.policyDecision ?? response.policy_decision, "policyDecision");
  if (!['allow', 'deny', 'shadow'].includes(policyDecision)) {
    fail("invalid_policy_decision", "MSP returned an invalid policy decision.", { policyDecision });
  }
  if (policyDecision !== "allow") {
    fail("context_policy_denied", "MSP did not authorize context use.", { policyDecision });
  }

  const contextId = requireString(response.contextId ?? response.context_id, "contextId");
  const cacheId = requireString(response.cacheId ?? response.cache_id, "cacheId");
  const returnedSources = normalizeSources(response.sources ?? requestContract.sources);
  const expected = new Map(requestContract.sources.map((source) => [`${source.id}@${source.version}`, source.hash]));
  for (const source of returnedSources) {
    const expectedHash = expected.get(`${source.id}@${source.version}`);
    if (!expectedHash || expectedHash !== source.hash) {
      fail("source_lineage_mismatch", "MSP response changed the requested source lineage.", { source });
    }
  }

  const lineage = response.lineage && typeof response.lineage === "object" ? response.lineage : {};
  return {
    ...response,
    contextId,
    cacheId,
    policyDecision,
    sources: returnedSources,
    lineage: {
      contextId,
      cacheId,
      parentContextId: lineage.parentContextId ?? lineage.parent_context_id ?? requestContract.lineage.parentContextId,
      runId: lineage.runId ?? lineage.run_id ?? requestContract.identity.runId,
      sessionId: lineage.sessionId ?? lineage.session_id ?? requestContract.identity.sessionId,
      turnId: lineage.turnId ?? lineage.turn_id ?? requestContract.identity.turnId,
    },
  };
}

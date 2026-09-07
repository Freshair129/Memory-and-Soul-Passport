// genesisrag17.v1: authenticated scope is a runtime grant, never a caller actor.
import { timingSafeEqual } from "node:crypto";
import { ValidationError, VaultScopeDeniedError, GksProviderInvalidResponseError } from "./errors.mjs";

export const PIPELINE_VERSION = "genesisrag17.v1";
export const SCOPE_KEYS = ["portfolioId", "tenantId", "businessId", "workspaceId", "agentId", "visibility"];
export const PIPELINE_ROLES = Object.freeze({
  submit: ["source"], evidence: ["source"], query: ["source", "worker"],
  claim: ["worker"], graph_receipt: ["worker"], write_receipt: ["worker"], gate: ["worker"], publication_receipt: ["worker"], stage_failure: ["worker"],
});
const COUNTERS = ["records_in", "records_out", "records_quarantined", "error_count", "retry_count", "duration_ms"];

export function scopeKey(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).length !== SCOPE_KEYS.length ||
      SCOPE_KEYS.some((key) => typeof scope[key] !== "string") ||
      !scope.portfolioId || !scope.tenantId || !scope.businessId || scope.visibility !== "private") {
    throw new ValidationError("pipeline_invalid_scope: explicit private six-field scope required");
  }
  return JSON.stringify(SCOPE_KEYS.map((key) => scope[key]));
}

export function sameScope(a, b) { return scopeKey(a) === scopeKey(b); }

function secretEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parsePrincipals(raw) {
  if (!raw) return [];
  let values;
  try { values = JSON.parse(raw); } catch { throw new ValidationError("pipeline_invalid_config: principals must be JSON"); }
  if (!Array.isArray(values)) throw new ValidationError("pipeline_invalid_config: principals must be an array");
  const seen = new Set();
  for (const row of values) {
    if (!row || typeof row.credential !== "string" || !row.credential ||
        typeof row.principalId !== "string" || !row.principalId || !["source", "worker"].includes(row.role) ||
        seen.has(row.credential)) throw new ValidationError("pipeline_invalid_config: invalid or ambiguous grant");
    scopeKey(row.scope);
    seen.add(row.credential);
  }
  return structuredClone(values);
}

// Catch nested cross-tenant receipts and batches before passing any payload to GKS.
function scopedEnvelopes(value, scope, depth = 0) {
  if (depth > 32) throw new ValidationError("pipeline_invalid_request: nested envelope too deep");
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "scope") && !sameScope(value.scope, scope)) throw new VaultScopeDeniedError();
  for (const child of Object.values(value)) if (child && typeof child === "object") scopedEnvelopes(child, scope, depth + 1);
}

export function authorizePipeline(args, suffix, principals) {
  if (!args || args.schemaVersion !== PIPELINE_VERSION) throw new ValidationError("pipeline_schema_version: genesisrag17.v1 required");
  scopeKey(args.scope);
  const principal = principals.find((entry) => secretEqual(args.credential, entry.credential));
  if (!principal || !PIPELINE_ROLES[suffix]?.includes(principal.role) || !sameScope(principal.scope, args.scope)) {
    throw new VaultScopeDeniedError("vault_scope_denied: pipeline credential does not grant this role and scope");
  }
  scopedEnvelopes(args, args.scope);
  return { principalId: principal.principalId, role: principal.role, scope: structuredClone(principal.scope) };
}

export function validatePipelineRequest(args, suffix) {
  const string = (value) => typeof value === "string" && value.length > 0;
  if (suffix === "stage_failure" && ![13, 15, 16].includes(args.stage?.stageNumber)) throw new ValidationError("pipeline_stage_failure_not_worker_owned");
  if (suffix === "stage_failure" && (!string(args.runId) || !string(args.decisionId) || !/^[a-f0-9]{64}$/.test(args.decisionHash) || !args.stage || args.stage.runId !== args.runId || !string(args.stage.pipelineStageId) || !string(args.stage.executionStepId) || !string(args.stage.attemptId) || !args.metrics || COUNTERS.some((key) => !Number.isFinite(args.metrics[key]) || args.metrics[key] < 0) || !Number.isFinite(Date.parse(args.startedAt)) || !Number.isFinite(Date.parse(args.finishedAt)) || Date.parse(args.finishedAt) < Date.parse(args.startedAt) || !string(args.error?.code) || !string(args.error?.message))) throw new ValidationError("pipeline_invalid_stage_failure");
  if (suffix === "submit" && (!args.batch || args.batch.schemaVersion !== PIPELINE_VERSION || !string(args.batch.batchId) || !string(args.batch.idempotencyKey) || !sameScope(args.batch.scope, args.scope))) throw new ValidationError("pipeline_invalid_batch");
  if (["graph_receipt", "write_receipt", "publication_receipt"].includes(suffix) && (!args.receipt || args.receipt.schemaVersion !== PIPELINE_VERSION || !sameScope(args.receipt.scope, args.scope))) throw new ValidationError("pipeline_invalid_receipt");
  if (suffix === "gate" && (!string(args.decisionId) || !/^[a-f0-9]{64}$/.test(args.decisionHash))) throw new ValidationError("pipeline_invalid_decision");
  if (suffix === "claim" && args.limit !== undefined && args.limit !== 1) throw new ValidationError("pipeline_invalid_limit: claim limit is one");
  if (suffix === "evidence" && (!string(args.runId) || !Number.isSafeInteger(args.afterCursor ?? 0) || (args.afterCursor ?? 0) < 0 || !Number.isSafeInteger(args.limit ?? 100) || (args.limit ?? 100) < 1 || (args.limit ?? 100) > 100)) throw new ValidationError("pipeline_invalid_cursor");
  if (suffix === "query" && (!string(args.query) || args.query.length > 16000 || !Number.isSafeInteger(args.topK ?? 5) || (args.topK ?? 5) < 1 || (args.topK ?? 5) > 100 || (args.snapshotId !== undefined && !string(args.snapshotId)))) throw new ValidationError("pipeline_invalid_query");
}

export function validatePipelineResponse(result, request, suffix) {
  const invalid = () => { throw new GksProviderInvalidResponseError("pipeline_invalid_response: provider envelope, scope or evidence is invalid"); };
  try {
    if (!result || result.schemaVersion !== PIPELINE_VERSION || !sameScope(result.scope, request.scope)) invalid();
    scopedEnvelopes(result, request.scope);
    if (suffix === "stage_failure" && result.accepted !== true) invalid();
    if (suffix === "submit" && (result.batchId !== request.batch.batchId || !(result.decisionId === null || (typeof result.decisionId === "string" && result.decisionId)) || typeof result.status !== "string")) invalid();
    if (suffix === "claim" && (!Array.isArray(result.decisions) || result.decisions.length > 1 || result.decisions.some((d) => !d.decisionId || !/^[a-f0-9]{64}$/.test(d.decisionHash) || d.schemaVersion !== PIPELINE_VERSION || !sameScope(d.scope, request.scope)))) invalid();
    if (["graph_receipt", "write_receipt", "publication_receipt"].includes(suffix) && result.accepted !== true) invalid();
    if (suffix === "graph_receipt" && (!/^[a-f0-9]{64}$/.test(result.graphReceiptHash) || !/^[a-f0-9]{64}$/.test(result.derivedHash) || !Array.isArray(result.derived))) invalid();
    if (suffix === "write_receipt" && !/^[a-f0-9]{64}$/.test(result.receiptHash)) invalid();
    if (suffix === "gate" && (!result.verdict || result.verdict.decisionId !== request.decisionId || result.verdict.decisionHash !== request.decisionHash || !["PASS", "WARN", "FAIL"].includes(result.verdict.verdict) || typeof result.verdict.allowPublication !== "boolean")) invalid();
    if (suffix === "evidence") {
      if (!Array.isArray(result.rows) || result.rows.length > (request.limit ?? 100)) invalid();
      let cursor = request.afterCursor ?? 0;
      const terminals = new Set();
      for (const row of result.rows) {
        if (!Number.isSafeInteger(row.cursor) || row.cursor <= cursor || row.schemaVersion !== PIPELINE_VERSION || !sameScope(row.scope, request.scope) || row.runId !== request.runId ||
            !row.pipelineStageId || !row.executionStepId || !row.attemptId || !Number.isInteger(row.stageNumber) || row.stageNumber < 9 || row.stageNumber > 17 || !["SUCCEEDED", "FAILED"].includes(row.outcome) ||
            !Number.isFinite(Date.parse(row.startedAt)) || !Number.isFinite(Date.parse(row.finishedAt)) || Date.parse(row.finishedAt) < Date.parse(row.startedAt) ||
            !row.metrics || COUNTERS.some((key) => typeof row.metrics[key] !== "number" || !Number.isFinite(row.metrics[key]) || row.metrics[key] < 0)) invalid();
        const key = JSON.stringify([row.runId, row.pipelineStageId, row.executionStepId, row.attemptId]);
        if (terminals.has(key)) invalid();
        terminals.add(key); cursor = row.cursor;
      }
      if (result.nextCursor !== cursor) invalid();
    }
    if (suffix === "query" && (!result.snapshotId || !result.generation || !Array.isArray(result.results) || result.results.length > (request.topK ?? 5) || (request.snapshotId && request.snapshotId !== result.snapshotId) || result.results.some((row) => !row.id || !Number.isFinite(row.score) || typeof row.text !== "string" || !row.citation || ["sourceId", "rawArtifactId", "parsedArtifactId", "chunkId", "contentHash"].some((key) => !row.citation[key])))) invalid();
    return result;
  } catch { return invalid(); }
}

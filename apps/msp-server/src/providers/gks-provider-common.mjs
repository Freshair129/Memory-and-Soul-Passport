import crypto from "node:crypto";
import { GksProviderUnavailableError } from "@freshair129/msp-contracts/errors";

export const GKS_REQUEST_TIMEOUT_MS = 10_000;
export const GKS_NORMAL_REQUEST_LIMIT_BYTES = 1 * 1024 * 1024;
export const GKS_PIPELINE_REQUEST_LIMIT_BYTES = 8 * 1024 * 1024;
export const GKS_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

export function unavailable(message) {
  return new GksProviderUnavailableError(`gks_provider_unavailable: ${message}`);
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("scope is required for GKS MSP auth.");
  const normalized = {
    portfolioId: typeof scope.portfolioId === "string" ? scope.portfolioId.trim() : "",
    tenantId: typeof scope.tenantId === "string" ? scope.tenantId.trim() : "",
    businessId: typeof scope.businessId === "string" ? scope.businessId.trim() : "",
    workspaceId: typeof scope.workspaceId === "string" ? scope.workspaceId.trim() : "",
    projectId: typeof scope.projectId === "string" ? scope.projectId.trim() : "",
    sharing: scope.sharing ?? "private",
  };
  if (!normalized.portfolioId) throw new Error("scope.portfolioId is required for GKS MSP auth.");
  return normalized;
}

function scopeForAuth(toolName, input, defaultPortfolioId) {
  if (toolName === "gks_knowledge_promote" && !input.scope) {
    return normalizeScope({
      portfolioId: defaultPortfolioId,
      tenantId: input.tenant_id,
      businessId: input.business_id,
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      sharing: "private",
    });
  }
  return normalizeScope(input.scope);
}

function mspScopeDigest(scope) {
  return crypto.createHash("sha256").update([
    scope.portfolioId,
    scope.tenantId,
    scope.businessId,
    scope.workspaceId,
    scope.projectId,
    scope.sharing,
  ].join("\u0000"), "utf8").digest("hex");
}

export function authMetaFor(toolName, input, mspAuth) {
  if (!mspAuth) return undefined;
  const scope = scopeForAuth(toolName, input, mspAuth.defaultPortfolioId);
  return {
    gksMspAuth: {
      version: "gks-msp-auth/v1",
      principalId: "msp-runtime",
      role: "msp",
      relayCredential: mspAuth.relayCredential,
      scopeDigest: mspScopeDigest(scope),
    },
  };
}

export function structuredGksResult(result) {
  if (result?.isError) {
    const text = result.content?.find((item) => item.type === "text")?.text;
    throw unavailable(text ?? "GKS tool returned an error.");
  }
  return result?.structuredContent ?? {};
}

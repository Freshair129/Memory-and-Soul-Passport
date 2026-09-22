import { GksProviderUnavailableError } from "@freshair129/msp-contracts/errors";
import { containsEscapedObjectKey } from "../transport/escaped-object-key-scan.mjs";
import {
  GKS_NORMAL_REQUEST_LIMIT_BYTES,
  GKS_PIPELINE_REQUEST_LIMIT_BYTES,
  GKS_REQUEST_TIMEOUT_MS,
  GKS_RESPONSE_LIMIT_BYTES,
  authMetaFor,
  structuredGksResult,
  unavailable,
} from "./gks-provider-common.mjs";

const PIPELINE_SUFFIXES = new Set([
  "submit",
  "claim",
  "graph_receipt",
  "write_receipt",
  "gate",
  "publication_receipt",
  "stage_failure",
  "evidence",
]);

function endpoint(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

export function normalizeGksHttpUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw unavailable("MSP_GKS_HTTP_URL is required for HTTP transport.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw unavailable("MSP_GKS_HTTP_URL must be a valid absolute URL.");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw unavailable("MSP_GKS_HTTP_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

async function readResponseBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    let text;
    try {
      text = await response.text();
    } catch {
      throw unavailable("GKS HTTP response could not be read.");
    }
    if (Buffer.byteLength(text, "utf8") > GKS_RESPONSE_LIMIT_BYTES) {
      throw unavailable("GKS HTTP response exceeds the configured limit.");
    }
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > GKS_RESPONSE_LIMIT_BYTES) {
        void reader.cancel().catch(() => {});
        throw unavailable("GKS HTTP response exceeds the configured limit.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GksProviderUnavailableError) throw error;
    throw unavailable("GKS HTTP response could not be read.");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function postJson({ fetchImpl, url, payload, bearerCredential, timeoutMs }) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (bearerCredential) headers.authorization = `Bearer ${bearerCredential}`;

  const body = encodeBoundedRequest(payload);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body,
    });
  } catch {
    throw unavailable("GKS HTTP request failed.");
  }
  if (!response || typeof response.ok !== "boolean") throw unavailable("GKS HTTP response was invalid.");
  if (!response.ok) {
    if (typeof response.body?.cancel === "function") void Promise.resolve(response.body.cancel()).catch(() => {});
    throw unavailable(`GKS HTTP request failed with status ${response.status}.`);
  }

  const text = await readResponseBody(response);
  if (!text.trim()) return null;
  if (containsEscapedObjectKey(text)) throw unavailable("GKS HTTP response contained an object key with an escape sequence.");

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw unavailable("GKS HTTP response was malformed JSON.");
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    throw unavailable("GKS HTTP response was not a JSON-RPC 2.0 object.");
  }
  if (message.error) throw unavailable(message.error.message ?? "GKS returned an MCP error.");
  return message.result;
}

function encodeBoundedRequest(payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw unavailable("GKS HTTP request could not be encoded.");
  }
  const requestLimit = payload.method === "tools/call" && payload.params?.name?.startsWith("gks_pipeline_")
    ? GKS_PIPELINE_REQUEST_LIMIT_BYTES
    : GKS_NORMAL_REQUEST_LIMIT_BYTES;
  if (Buffer.byteLength(body, "utf8") > requestLimit) throw unavailable("GKS HTTP request exceeds the configured limit.");
  return body;
}

async function callGksTool({ baseUrl, fetchImpl, timeoutMs, bearerCredential, mspAuth }, toolName, input) {
  const mcpUrl = endpoint(baseUrl, "/mcp");
  const params = { name: toolName, arguments: input };
  const authMeta = authMetaFor(toolName, input, mspAuth);
  if (authMeta) params._meta = authMeta;
  const toolPayload = { jsonrpc: "2.0", id: 2, method: "tools/call", params };
  // Reject the complete tool frame before even starting the handshake. This
  // keeps oversized input from opening a network connection and mirrors GKS's
  // pre-dispatch frame limit.
  encodeBoundedRequest(toolPayload);

  const initialize = await postJson({
    fetchImpl,
    url: mcpUrl,
    timeoutMs,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "govibe-msp-runtime", version: "0.1.0" },
      },
    },
  });
  if (!initialize || typeof initialize !== "object") throw unavailable("GKS HTTP initialize response was invalid.");

  await postJson({
    fetchImpl,
    url: mcpUrl,
    timeoutMs,
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const result = await postJson({
    fetchImpl,
    url: mcpUrl,
    timeoutMs,
    bearerCredential,
    payload: toolPayload,
  });
  return structuredGksResult(result);
}

export function createGksHttpProviderFromEnvironment(env = process.env, { fetchImpl = globalThis.fetch, timeoutMs = GKS_REQUEST_TIMEOUT_MS } = {}) {
  const baseUrl = normalizeGksHttpUrl(env.MSP_GKS_HTTP_URL);
  if (env.GKS_MSP_AUTH_REQUIRED !== "1") throw unavailable("GKS_MSP_AUTH_REQUIRED=1 is required for HTTP transport.");
  const relayCredential = env.GKS_MSP_RELAY_CREDENTIAL?.trim();
  if (!relayCredential) throw unavailable("GKS_MSP_RELAY_CREDENTIAL is required for HTTP transport.");
  if (typeof fetchImpl !== "function") throw unavailable("fetch is required for HTTP transport.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw unavailable("HTTP timeout must be a positive number.");

  const mspAuth = {
    relayCredential,
    defaultPortfolioId: env.GKS_DEFAULT_PORTFOLIO_ID?.trim(),
  };
  return {
    async pipelineCall(suffix, request) {
      if (!PIPELINE_SUFFIXES.has(suffix)) throw unavailable("unsupported pipeline operation");
      return callGksTool({ baseUrl, fetchImpl, timeoutMs, bearerCredential: relayCredential, mspAuth: null }, `gks_pipeline_${suffix}`, request);
    },
    async promote(candidate) {
      return callGksTool({ baseUrl, fetchImpl, timeoutMs, bearerCredential: relayCredential, mspAuth }, "gks_knowledge_promote", candidate);
    },
    async exportStageEvidence(request) {
      return callGksTool({ baseUrl, fetchImpl, timeoutMs, bearerCredential: relayCredential, mspAuth }, "gks_stage_evidence_export", request);
    },
  };
}

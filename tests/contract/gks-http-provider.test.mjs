import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { createGksHttpProviderFromEnvironment, normalizeGksHttpUrl } from "../../apps/msp-server/src/providers/gks-http-provider.mjs";
import { createGksProviderFromEnvironment } from "../../apps/msp-server/src/providers/gks-provider.mjs";

const scope = {
  portfolioId: "portfolio-http",
  tenantId: "tenant-http",
  businessId: "business-http",
  workspaceId: "workspace-http",
  projectId: "project-http",
  sharing: "private",
};

const env = {
  MSP_GKS_HTTP_URL: "http://gks.internal:19418",
  GKS_MSP_AUTH_REQUIRED: "1",
  GKS_MSP_RELAY_CREDENTIAL: "http-relay-secret",
  GKS_DEFAULT_PORTFOLIO_ID: scope.portfolioId,
};

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async text() {
      return value === null ? "" : JSON.stringify(value);
    },
  };
}

function rpcResult(id, structuredContent) {
  return response({ jsonrpc: "2.0", id, result: { structuredContent } });
}

function digestFor(value) {
  return crypto.createHash("sha256").update([
    value.portfolioId,
    value.tenantId,
    value.businessId,
    value.workspaceId,
    value.projectId,
    value.sharing,
  ].join("\u0000"), "utf8").digest("hex");
}

describe("GKS HTTP provider", () => {
  it("performs the MCP handshake and preserves the authenticated scope envelope", async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      if (body.method === "initialize") return response({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } });
      if (body.method === "notifications/initialized") return response(null, 204);
      return rpcResult(body.id, { knowledge_ref: "gks:knowledge/http" });
    };
    const provider = createGksHttpProviderFromEnvironment(env, { fetchImpl });

    await expect(provider.promote({ scope, source_snapshot_hash: "a".repeat(64) })).resolves.toEqual({ knowledge_ref: "gks:knowledge/http" });

    expect(requests).toHaveLength(3);
    expect(requests[0].url).toBe("http://gks.internal:19418/mcp");
    expect(requests[0].options.headers.authorization).toBeUndefined();
    expect(requests[1].options.headers.authorization).toBeUndefined();
    expect(requests[2].options.redirect).toBe("error");
    expect(requests[2].options.headers.authorization).toBe("Bearer http-relay-secret");
    expect(requests[2].body.params._meta.gksMspAuth).toEqual({
      version: "gks-msp-auth/v1",
      principalId: "msp-runtime",
      role: "msp",
      relayCredential: "http-relay-secret",
      scopeDigest: digestFor(scope),
    });
    expect(JSON.stringify(requests[0].body)).not.toContain("http-relay-secret");
  });

  it("uses the transport bearer for pipeline calls without fabricating legacy scope metadata", async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      if (body.method === "initialize") return response({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } });
      if (body.method === "notifications/initialized") return response(null, 204);
      return rpcResult(body.id, { status: "accepted" });
    };
    const provider = createGksHttpProviderFromEnvironment(env, { fetchImpl });

    await expect(provider.pipelineCall("submit", { scope, relayCredential: "pipeline-secret" })).resolves.toEqual({ status: "accepted" });

    const call = requests[2];
    expect(call.options.headers.authorization).toBe("Bearer http-relay-secret");
    expect(call.body.params.name).toBe("gks_pipeline_submit");
    expect(call.body.params._meta).toBeUndefined();
  });

  it("fails closed for invalid transport configuration and non-success HTTP responses", async () => {
    expect(() => createGksHttpProviderFromEnvironment({ ...env, GKS_MSP_AUTH_REQUIRED: "0" })).toThrow(/GKS_MSP_AUTH_REQUIRED/);
    expect(() => createGksHttpProviderFromEnvironment({ ...env, MSP_GKS_HTTP_URL: "http://gks.internal/mcp" })).toThrow(/origin/);
    expect(() => normalizeGksHttpUrl("https://user:pass@gks.internal")).toThrow(/origin/);

    const provider = createGksHttpProviderFromEnvironment(env, {
      fetchImpl: async () => response({ error: "private body must not be surfaced" }, 401),
    });
    await expect(provider.promote({ scope, source_snapshot_hash: "b".repeat(64) })).rejects.toThrow(/status 401/);
    await expect(provider.promote({ scope, source_snapshot_hash: "b".repeat(64) })).rejects.not.toThrow(/private body/);
  });

  it("refuses an oversized normal request before opening the network", async () => {
    let calls = 0;
    const provider = createGksHttpProviderFromEnvironment(env, {
      fetchImpl: async () => {
        calls += 1;
        return response(null, 204);
      },
    });
    await expect(provider.exportStageEvidence({ scope, since_cursor: 0, limit: 1, padding: "x".repeat(1_100_000) })).rejects.toThrow(/exceeds the configured limit/);
    expect(calls).toBe(0);
  });

  it("requires explicit HTTP selection and keeps the legacy default fail-closed", () => {
    expect(createGksProviderFromEnvironment({ MSP_GKS_HTTP_URL: env.MSP_GKS_HTTP_URL })).toBeNull();
    expect(createGksProviderFromEnvironment({ ...env, MSP_GKS_TRANSPORT: "http" })).toEqual(expect.objectContaining({ pipelineCall: expect.any(Function) }));
    expect(() => createGksProviderFromEnvironment({ MSP_GKS_TRANSPORT: "grpc" })).toThrow(/MSP_GKS_TRANSPORT/);
  });
});

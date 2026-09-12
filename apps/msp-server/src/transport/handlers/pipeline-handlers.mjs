// GenesisRAG17 relay: no stage logic, content store, cursor or caller-selected reporter.
import { authorizePipeline, parsePrincipals, validatePipelineRequest, validatePipelineResponse, PIPELINE_ROLES } from "@freshair129/msp-contracts/pipeline";
import { GksProviderUnconfiguredError, GksProviderUnavailableError, ValidationError } from "@freshair129/msp-contracts/errors";

export function createPipelineHandlers({ gksProvider, journal, env = process.env, fetchImpl = fetch } = {}) {
  const principals = parsePrincipals(env.MSP_PIPELINE_PRINCIPALS);
  const handlers = {};
  for (const suffix of Object.keys(PIPELINE_ROLES)) {
    const name = `msp_pipeline_${suffix}`;
    handlers[name] = async (args = {}) => {
      const principal = authorizePipeline(args, suffix, principals);
      validatePipelineRequest(args, suffix);
      const { credential, actor, authenticatedPrincipal, relayCredential, ...payload } = args;
      let result;
      if (suffix === "query") {
        if (!env.MSP_PIPELINE_WORKER_URL || !env.MSP_PIPELINE_WORKER_TOKEN) throw new GksProviderUnconfiguredError("pipeline_worker_unconfigured");
        const url = new URL(env.MSP_PIPELINE_WORKER_URL);
        if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname)) throw new ValidationError("pipeline_worker_url: explicit loopback HTTP origin required");
        url.pathname = "/query";
        let response;
        try {
          response = await fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(120000), headers: { "content-type": "application/json", authorization: `Bearer ${env.MSP_PIPELINE_WORKER_TOKEN}` }, body: JSON.stringify(payload) });
        } catch { throw new GksProviderUnavailableError("pipeline_worker_unavailable"); }
        if (!response.ok) throw new GksProviderUnavailableError(`pipeline_worker_query_failed: ${response.status}`);
        result = await response.json();
      } else {
        if (!gksProvider?.pipelineCall || !env.MSP_GKS_PIPELINE_CREDENTIAL) throw new GksProviderUnconfiguredError("gks_provider_unconfigured: pipeline relay credential and provider required");
        result = await gksProvider.pipelineCall(suffix, { ...payload, relayCredential: env.MSP_GKS_PIPELINE_CREDENTIAL, authenticatedPrincipal: principal });
      }
      validatePipelineResponse(result, payload, suffix);
      journal?.append({ actor: principal.principalId, toolName: name, ref: null, workspaceId: principal.scope.workspaceId || null, payload: { tenant_id: principal.scope.tenantId, portfolio_id: principal.scope.portfolioId, rows: result.rows?.length ?? result.results?.length ?? result.decisions?.length ?? 0 }, policyDecision: "allow" });
      return result;
    };
  }
  return handlers;
}

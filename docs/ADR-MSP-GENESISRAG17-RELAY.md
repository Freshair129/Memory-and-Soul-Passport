---
version: "1.0.0b"
created_at: "2026-09-08T00:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-08T00:00:00+07:00,ATHER"
status: "beta"
superseded_by: null
attributes:
  domain: "mission-state-protocol"
  doc_type: "architecture-decision"
  scope: "MSP boundary for the authenticated GenesisRAG17 relay"
---

# ADR-MSP-GENESISRAG17-RELAY

## Status

Accepted for the isolated GenesisRAG17 test integration. This ADR is limited
to MSP's Tier 2 boundary and does not authorize production deployment,
production credentials, or a new stage owner.

## Context

The zuri-ai pipeline has seventeen stages distributed across Tier 1 zuri-ai,
Tier 3 GKS, and Tier 4 GenesisBlockDB. MSP is the session, authority and
policy layer between those systems. A relay that treats MSP as an execution
stage would duplicate lineage, make caller-supplied identity authoritative,
or allow a successful response to stand in for physical publication evidence.

The wire authority is the [zuri-ai GenesisRAG17
contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md),
`genesisrag17.v1`. The implementation and acceptance branch is
[`codex/ki17-integration`](https://github.com/Freshair129/zuri.ai/tree/codex/ki17-integration);
the acceptance proof is pinned to
[`b64b46df057d3160c659afa3c34628ee86520257`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257).

## Decision

MSP exposes nine authenticated `msp_pipeline_*` relay tools. It validates the
outer schema, exact six-field scope, runtime grant, role and nested envelopes,
then forwards the request to GKS or the explicit Tier 4 query loopback. It
validates the downstream response and journals identities and counts only.
MSP keeps no source payload, canonical decision, stage cursor, worker result,
quality verdict, graph/vector object or publication pointer.

The nine operations are:

| Operation | Allowed role | Destination |
|---|---|---|
| `submit` | source | GKS `gks_pipeline_submit` |
| `evidence` | source | GKS `gks_pipeline_evidence` |
| `query` | source or worker | Tier 4 loopback `POST /query` |
| `claim` | worker | GKS `gks_pipeline_claim` |
| `graph_receipt` | worker | GKS `gks_pipeline_graph_receipt` |
| `write_receipt` | worker | GKS `gks_pipeline_write_receipt` |
| `gate` | worker | GKS `gks_pipeline_gate` |
| `publication_receipt` | worker | GKS `gks_pipeline_publication_receipt` |
| `stage_failure` | worker | GKS `gks_pipeline_stage_failure` |

The source and worker grants are separate runtime credentials. A caller's
`actor`, supplied `authenticatedPrincipal`, supplied relay credential and
claimed worker role are input data only. MSP derives the authenticated
principal from `MSP_PIPELINE_PRINCIPALS` and adds the relay credential from
`MSP_GKS_PIPELINE_CREDENTIAL`. GKS verifies that value against
`GKS_PIPELINE_RELAY_CREDENTIAL`. Child-process environment construction
strips the MSP principal list and Tier 4 query token before GKS starts.

## Scope decision

The request scope is exactly:

```text
{ portfolioId, tenantId, businessId, workspaceId, agentId, visibility }
```

Every value is a string, the first three are non-empty, and `visibility` is
`private` in this contract. Equality compares all six values in the declared
order. Any nested scope in a batch, receipt, fact, derived row or query result
must match the outer scope. Unknown credentials, malformed grants, role
mismatches, missing or extra scope fields and foreign nested scope fail before
the downstream call.

## Execution decision

The call sequence is fixed:

1. Tier 1 owns raw input, parser/version lineage, source mentions and stages
   1–8. It submits one batch for one exact Stage 9 attempt.
2. GKS owns stages 9–12 and returns one immutable canonical decision. The
   worker claims at most one pending decision; claim is not a destructive
   dequeue.
3. Tier 4 commits graph nodes/edges and sends `graph_receipt`. GKS validates
   that physical receipt and performs Stage 14 enrichment.
4. Tier 4 computes embeddings and index readback for stages 15–16, then sends
   `write_receipt` with graph and derived hashes plus actual operation times.
5. The worker asks GKS for the quality/policy gate. A passing gate is bound to
   the exact decision and worker receipt.
6. Only an allowed gate permits the worker to switch the publication pointer
   and send `publication_receipt` for Stage 17. A denied policy produces a
   failed Stage 17 evidence record without a publication receipt.
7. The source pulls evidence with its own cursor. Source or worker queries a
   single published Tier 4 generation through MSP's loopback route.

MSP does not own any of these stages. A delivery retry retains the original
`runId`, `pipelineStageId`, `executionStepId`, `attemptId`, batch id and
idempotency key. MSP keeps no pipeline state between calls beyond its count-only
journal entry; durable receipt and retry ownership stays with the source/worker
and the downstream stores.

## Query decision

The query relay is not a GKS call. `MSP_PIPELINE_WORKER_URL` must be an
explicit loopback HTTP origin at `127.0.0.1` or `::1`; the URL may not include
credentials, a path, query, hash or redirect target. MSP posts to `/query`
with `Bearer MSP_PIPELINE_WORKER_TOKEN` and rejects non-2xx, malformed or
cross-scope results. The worker authenticates the token with
`GENESIS_WORKER_QUERY_TOKEN`, selects one published generation for the complete
request, and returns citation fields that point to the Tier 1 source lineage.
Absent worker configuration is an error, never an empty successful result.

## Extension decision

The following changes belong elsewhere:

- Parsing, normalization, source mentions, correction and raw lineage belong in
  zuri-ai Tier 1 and are measured in its stages 1–8.
- Canonical entities, facts, ontology, temporal decisions, graph enrichment
  and quality dimensions belong in GKS.
- Physical graph/vector/index writes, readback, publication and query serving
  belong in GenesisBlockDB/Tier 4.

An MSP extension may change only runtime grants, role/scope policy, relay
transport, response validation, count-only journaling or the explicit Tier 4
query hop. A new request or response field requires a coordinated update to
the zuri-ai contract, GKS contract, MSP machine schema and the relevant
security/acceptance proof. An unknown field is not an extension mechanism;
`actor`, `details` and alternate credentials cannot be used as a backdoor.

## Consequences

This decision keeps the boundary auditable and prevents a relay success from
being mistaken for a stage completion or publication. It also means MSP cannot
answer a pipeline query or relay a worker result without its explicit runtime
peer being configured. The source/worker caller must retain durable retry
state, and all four repositories must review a contract change together.

## Evidence and implementation map

- Runtime relay: [`apps/msp-server/src/transport/handlers/pipeline-handlers.mjs`](../apps/msp-server/src/transport/handlers/pipeline-handlers.mjs)
- GKS process boundary: [`apps/msp-server/src/providers/gks-stdio-provider.mjs`](../apps/msp-server/src/providers/gks-stdio-provider.mjs)
- Guard implementation: [`packages/msp-contracts/src/contracts/pipeline.mjs`](../packages/msp-contracts/src/contracts/pipeline.mjs)
- Machine schema: [`packages/msp-contracts/schemas/GENESISRAG17.tools.json`](../packages/msp-contracts/schemas/GENESISRAG17.tools.json)
- Contract proof: [`tests/contract/pipeline-relay.test.mjs`](../tests/contract/pipeline-relay.test.mjs)
- Scope and role proof: [`tests/security/pipeline-vault-scoping.security.mjs`](../tests/security/pipeline-vault-scoping.security.mjs)
- Local process runbook: [`RUNBOOK-GENESISRAG17-LOCAL.md`](RUNBOOK-GENESISRAG17-LOCAL.md)

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.0.0b | 2026-09-08 | beta | Accepted the MSP-only authenticated relay boundary, nine operations, exact grants/scope, ordered execution, Tier 4 query route and coordinated extension rules. | working-tree | ATHER |

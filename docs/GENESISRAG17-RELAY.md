---
version: "1.3.0b"
created_at: "2026-09-07T23:00:00+07:00,RWANG,working-tree"
last_update: "2026-09-08T00:00:00+07:00,ATHER"
status: "beta"
superseded_by: null
attributes:
  domain: "mission-state-protocol"
  doc_type: "cross-repository-boundary"
  scope: "authenticated GenesisRAG17 relay and Tier 2 ownership"
---

# GenesisRAG17 authenticated relay

This document records the MSP side of the isolated `genesisrag17.v1` test
pipeline. It is a relay contract and boundary record. MSP authenticates the
caller, enforces the six-field scope and role grant, forwards a request to the
right downstream owner, validates the returned envelope, and journals counts.
MSP owns **no pipeline stage, content store, execution cursor, canonical
decision, quality verdict, embedding, graph write, or publication pointer**.

The cross-repository wire authority is the [zuri-ai GenesisRAG17
contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md),
version `genesisrag17.v1`. The stage explanations are in the [stage
specification](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-SPEC.md)
and [stage flow](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-FLOW.md).
The machine-readable MSP copy is
[`packages/msp-contracts/schemas/GENESISRAG17.tools.json`](../packages/msp-contracts/schemas/GENESISRAG17.tools.json),
and its runtime guard is
[`packages/msp-contracts/src/contracts/pipeline.mjs`](../packages/msp-contracts/src/contracts/pipeline.mjs).

## Boundary and call direction

```text
Tier 1 zuri-ai source stages 1–8
        │ source request: submit / evidence
        ▼
      MSP relay ───────────── authenticated ───────────► Tier 3 GKS
        ▲                                                  │
        │ source response: decision/evidence              │ validated response
        └──────────────────────────────────────────────────┘

Tier 4 GenesisBlock worker stages 13 / 15 / 16 and publication
        │ worker request: claim / receipt / gate / failure
        ▼
      MSP relay ───────────── authenticated ───────────► Tier 3 GKS
        ▲                                                  │
        │ worker response: receipt / verdict               │ validated response
        └──────────────────────────────────────────────────┘

Tier 1 source or Tier 4 worker ── query ──► MSP ── loopback POST /query ──► Tier 4
Tier 4 query response ────────────────────► MSP ───────────────► caller
```

The worker performs the native graph transaction before requesting
`msp_pipeline_graph_receipt`. GKS verifies that receipt, performs its
canonical enrichment, and returns the immutable `derivedHash`. The worker then
performs embeddings and index readback, sends the final write receipt, obtains
the GKS gate, and sends a publication receipt only after the physical pointer
switch. GKS never calls outward. Tier 1 never calls GKS or Tier 4 directly.

Ownership is therefore:

| Owner | Owns | Does not own |
|---|---|---|
| zuri-ai / Tier 1 | raw-to-parsed-to-chunk lineage, source mentions, stages 1–8, run and attempt identity, source cursor, local counts | GKS decisions, physical receipt production, embeddings, publication pointer |
| MSP / Tier 2 | runtime grants, exact scope checks, relay transport, downstream response validation, count-only journal entries, Tier 4 query hop | every stage, payload persistence, stage cursor, canonical facts, gate verdict, physical storage |
| GKS / Tier 3 | canonical entity/fact/ontology/temporal/graph decision, stages 9–14, quality dimensions, receipt matching | outward calls, embeddings, physical publication, caller authority |
| GenesisBlock / Tier 4 | graph/vector/index writes, stages 13/15/16, readback, benchmark, publication pointer, loopback query server | canonical identity, MSP grants, GKS gate decision |

The authoritative zuri-ai boundary record is the [ADR-050 knowledge
ingestion boundary](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-050-KNOWLEDGE-INGESTION-TIER-BOUNDARY.md).
The MSP-specific decision is [ADR-MSP-GENESISRAG17-RELAY](ADR-MSP-GENESISRAG17-RELAY.md).

## Authentication and scope

Every new request has this outer shape:

```json
{
  "schemaVersion": "genesisrag17.v1",
  "scope": {
    "portfolioId": "portfolio-test",
    "tenantId": "tenant-test",
    "businessId": "business-test",
    "workspaceId": "workspace-test",
    "agentId": "agent-test",
    "visibility": "private"
  },
  "credential": "synthetic-source-credential"
}
```

The scope has exactly six string fields in this order:
`portfolioId`, `tenantId`, `businessId`, `workspaceId`, `agentId`, and
`visibility`. The first three are non-empty and `visibility` is `private` for
this contract. Empty workspace and agent values are valid only when the
caller intentionally has no narrower identity; the fields may not be omitted,
renamed, or replaced by a delimiter-joined string. Nested `batch`, `receipt`,
fact, derived, and result envelopes must carry the same six values.

`MSP_PIPELINE_PRINCIPALS` is a JSON array of runtime grants. Each grant has
`credential`, `principalId`, `role` (`source` or `worker`), and the exact
scope. Credentials are compared in constant time; duplicate credentials,
invalid grants, unknown credentials, role mismatches, missing fields, and
cross-scope nested envelopes fail before a provider call.

The request's `actor`, `authenticatedPrincipal`, `relayCredential`, and any
caller-selected worker identity are not authority. MSP discards those caller
fields, derives `authenticatedPrincipal` from the matched runtime grant, and
adds `relayCredential` from `MSP_GKS_PIPELINE_CREDENTIAL` for the GKS hop.
GKS authenticates that relay credential against its own
`GKS_PIPELINE_RELAY_CREDENTIAL`. A GKS child process receives neither the MSP
principal list nor the worker query token.

The grants are deliberately separate:

| Role | Allowed MSP tools |
|---|---|
| `source` | `msp_pipeline_submit`, `msp_pipeline_evidence`, `msp_pipeline_query` |
| `worker` | `msp_pipeline_claim`, `msp_pipeline_graph_receipt`, `msp_pipeline_write_receipt`, `msp_pipeline_gate`, `msp_pipeline_publication_receipt`, `msp_pipeline_stage_failure`, `msp_pipeline_query` |

The source grant cannot claim a decision, report a physical receipt, request a
gate, or publish. The worker grant cannot submit source content or pull the
source evidence cursor. `query` is intentionally available to both because it
is a read-only, scope-checked Tier 4 operation.

## Nine operations

The nine `msp_pipeline_*` tools are registered by the MSP composition root and
served over the existing newline-delimited JSON-RPC `tools/call` transport.
MSP relays the first eight to the configured GKS stdio provider. Query is the
exception: it is sent to the explicit Tier 4 loopback HTTP server.

| MSP tool | Grant | Request payload | Validated response | Downstream owner |
|---|---|---|---|---|
| `msp_pipeline_submit` | source | `batch` with `batchId`, stable `idempotencyKey`, `runId`, exact `stages`, `source`, `policy`, `chunks`, `mentions` | `batchId`, `decisionId` (`null` while pending or a string), `status` | GKS accepts the source batch and owns the decision |
| `msp_pipeline_claim` | worker | optional `limit`, which must be `1` | at most one scoped `decision` in `decisions` | GKS returns a pending canonical decision without destructive dequeue |
| `msp_pipeline_graph_receipt` | worker | graph-only receipt with transaction, readback, six metrics and actual times | `accepted`, `graphReceiptHash`, `derivedHash`, `derived[]` | GKS verifies Stage 13 and performs Stage 14 enrichment |
| `msp_pipeline_write_receipt` | worker | final receipt with snapshot, generation, model, transaction, readback, lane manifest, benchmark, hashes and execution times | `accepted`, `receiptHash` | GKS records stages 15/16 only after graph receipt matches |
| `msp_pipeline_gate` | worker | exact `decisionId` and 64-character `decisionHash` | verdict bound to both ids/hashes, receipt and five dimensions | GKS is the quality and publication-policy authority |
| `msp_pipeline_publication_receipt` | worker | exact published snapshot, generation, receipt hash, pointer hash, model revision, transaction frontier and readback | `accepted` | GKS records Stage 17 only after the physical pointer switch |
| `msp_pipeline_stage_failure` | worker | exact stage identity, six measured metrics, times and bounded `{code,message}` error | `accepted` | GKS records a single failed terminal for Stage 13, 15, or 16 |
| `msp_pipeline_evidence` | source | `runId`, caller-owned `afterCursor`, `limit` from 1–100 | ordered `rows` and `nextCursor` | GKS returns durable stage evidence; MSP stores no cursor |
| `msp_pipeline_query` | source or worker | `query`, `topK` from 1–100, optional `snapshotId` | one scoped generation and results with four citation ids plus content hash | Tier 4 loopback `/query`, never GKS |

The exact nested fields and required properties live in the machine schema. A
few invariants are repeated here because they define the boundary:

- Stage identity is `{runId,pipelineStageId,executionStepId,attemptId}`.
  `runId` is the Tier 1 execution run, not an MSP database row id. A delivery
  retry reuses the exact identity, batch id and idempotency key.
- `msp_pipeline_evidence` rows contain `cursor`, the exact stage identity,
  `stageNumber`, `outcome`, `startedAt`, `finishedAt`, and exactly six metric
  keys: `records_in`, `records_out`, `records_quarantined`, `error_count`,
  `retry_count`, and `duration_ms`. Every metric is a finite non-negative
  number. A page may not leap over an invalid row or repeat a terminal identity.
- Stage failure accepts only stage numbers 13, 15, or 16. It records the actual
  failure and never synthesizes downstream success.
- A passing gate must bind the exact decision and matching worker receipt. A
  successful Stage 17 requires a matching publication receipt. A denied policy
  produces failed Stage 17 evidence and no publication receipt.
- Query results require `snapshotId`, `generation`, `id`, numeric `score`, text,
  and citation fields `sourceId`, `rawArtifactId`, `parsedArtifactId`,
  `chunkId`, and `contentHash`. MSP rejects a scope mismatch, malformed
  response, redirect, non-loopback origin, or missing worker configuration.

## Ordered execution and recovery

```text
Tier 1: stages 1–8 and source materialization
  → submit one batch for the exact Stage 9 attempt
GKS: stages 9–12 and immutable canonical decision
  → worker claims one decision
Tier 4: graph write for Stage 13
  → msp_pipeline_graph_receipt
GKS: verifies graph receipt and enriches Stage 14
Tier 4: embeddings Stage 15, index/readback Stage 16
  → msp_pipeline_write_receipt
Worker: asks for GKS gate
  → if allowed, publishes and sends publication receipt for Stage 17
  → if denied, records failed Stage 17 without a publication receipt
Source: pulls evidence through msp_pipeline_evidence
Source or worker: queries one published Tier 4 generation through MSP
```

MSP does not implement a durable queue or cache worker results. The source or
worker retains a failed or lost request and retries it with the same
idempotency and attempt identity. GKS and Tier 4 own their durable receipt and
publication idempotency. Repeated identical receipts are safe; a different
payload for an existing identity is a conflict. A cursor belongs to the
evidence puller, so restarting a caller means reopening its own cursor and
re-reading an already durable page.

The only worker HTTP hop is `POST /query` at
`MSP_PIPELINE_WORKER_URL`. It must be an explicit `http://127.0.0.1:<port>` or
`http://[::1]:<port>` origin with no credentials, path, query, or hash. MSP
sends `Bearer MSP_PIPELINE_WORKER_TOKEN`, sets redirect handling to `error`,
and requires the worker to validate `GENESIS_WORKER_QUERY_TOKEN` and the exact
scope. The worker binds one published generation for the complete query.

## Extension rules

The boundary is extended in this order:

1. Update the cross-repository zuri-ai contract and the corresponding GKS
   contract first. Add a new field to the coordinated schema; do not smuggle
   it through `actor`, `authenticatedPrincipal`, an unvalidated `details`
   object, or an alternate credential field.
2. If the change concerns input parsing, normalization, source mentions,
   correction, or lineage, implement and measure it in zuri-ai Tier 1 Stage 2
   or its assigned Stage 1–8 owner. MSP must not parse or classify source
   content.
3. If it concerns canonical entities, facts, ontology, temporal decisions,
   graph enrichment, or quality dimensions, implement it in GKS. MSP forwards
   the authenticated request and validates the result; it does not decide.
4. MSP changes are limited to runtime grants, role/scope validation, relay
   transport, response validation, count-only journaling, and the explicit
   Tier 4 query hop. The source/worker grant table must be updated together
   with the machine schema and security cases.
5. Add contract, malformed-response, wrong-scope, credential-separation,
   restart/retry, and cross-repository acceptance evidence. Update this
   document, [the MSP ADR](ADR-MSP-GENESISRAG17-RELAY.md), and the [local
   runbook](RUNBOOK-GENESISRAG17-LOCAL.md).

An extension is not accepted because an old relay happens to forward an
unknown field. Unknown schema versions, missing fields, extra scope fields,
and uncoordinated role grants fail closed.

## Code and test map

| Concern | Source or proof |
|---|---|
| Server registration | [`apps/msp-server/src/server.mjs`](../apps/msp-server/src/server.mjs) |
| MSP relay and Tier 4 query validation | [`apps/msp-server/src/transport/handlers/pipeline-handlers.mjs`](../apps/msp-server/src/transport/handlers/pipeline-handlers.mjs) |
| GKS child-process boundary and credential stripping | [`apps/msp-server/src/providers/gks-stdio-provider.mjs`](../apps/msp-server/src/providers/gks-stdio-provider.mjs) |
| Runtime grant and envelope guards | [`packages/msp-contracts/src/contracts/pipeline.mjs`](../packages/msp-contracts/src/contracts/pipeline.mjs) |
| Machine-readable request/response surface | [`packages/msp-contracts/schemas/GENESISRAG17.tools.json`](../packages/msp-contracts/schemas/GENESISRAG17.tools.json) |
| Contract and redirect tests | [`tests/contract/pipeline-relay.test.mjs`](../tests/contract/pipeline-relay.test.mjs) |
| Scope, role and nested-envelope security tests | [`tests/security/pipeline-vault-scoping.security.mjs`](../tests/security/pipeline-vault-scoping.security.mjs) |
| Real MSP stdio registration and provider boundary | [`tests/security/pipeline-vault-scoping.security.mjs`](../tests/security/pipeline-vault-scoping.security.mjs) starts the MSP child process; [`tests/integration/gks-provider-bridge.test.mjs`](../tests/integration/gks-provider-bridge.test.mjs) proves the configured GKS stdio bridge |
| Cross-repository raw-to-publication acceptance | [pinned zuri-ai acceptance at `b64b46d`](https://github.com/Freshair129/zuri.ai/blob/b64b46df057d3160c659afa3c34628ee86520257/apps/server/tests/acceptance/genesisrag17-e2e.test.js) |

Run the standalone smoke and the full isolated acceptance with the commands in
[`RUNBOOK-GENESISRAG17-LOCAL.md`](RUNBOOK-GENESISRAG17-LOCAL.md). Do not call a
successful relay response completion evidence by itself; the caller must read
the matching evidence and, for successful Stage 17, a matching publication
receipt.

## Version diff

`1.3.0b` expands the relay record into the complete nine-operation contract,
states the exact role/scope and credential boundary, documents the ordered
13 → 14 → 15 → 16 path, separates Tier 4 query from GKS, records extension
rules, and links the pinned cross-repository proof. It also removes local
checkout paths from the cross-repository references.

`1.2.0b` recorded worker-only stage failures and the graph receipt amendment.
`1.1.0b` added the graph receipt needed to establish Stage 13 before GKS
enrichment and worker embeddings. `1.0.0b` introduced the authenticated relay
with no changes to the frozen API-009 memory surface.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.3.0b | 2026-09-08 | beta | Documented all nine authenticated operations, ownership, exact grants/scope, ordered execution, query loopback, extension rules, code/test paths and pinned zuri-ai acceptance. | working-tree | ATHER |
| 1.2.0b | 2026-09-07 | beta | Authenticated stage failures terminate honestly; publication receipt is required only for successful completion. | working-tree | RWANG |
| 1.1.0b | 2026-09-07 | beta | Added graph-only receipt acknowledgement before GKS enrichment and physical embedding/indexing. | working-tree | RWANG |
| 1.0.0b | 2026-09-07 | beta | Introduced the authenticated `genesisrag17.v1` relay without changing the frozen memory contract. | working-tree | RWANG |

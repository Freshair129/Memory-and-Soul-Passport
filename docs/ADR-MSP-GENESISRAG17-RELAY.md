---
version: "1.0.4b"
created_at: "2026-09-08T00:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-11T00:00:00+07:00,KIN"
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
the current isolated execution and publication decision is [ADR-073 —
GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md);
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
`GKS_PIPELINE_RELAY_CREDENTIAL`. Child-process environment construction is an
explicit allowlist, not a blocklist: every GKS spawn (pipeline relay,
`promote`, stage-evidence export) gets only OS basics and GKS's own `GKS_*`
configuration, never a copy of MSP's own process environment. That excludes
the MSP principal list and Tier 4 query token by construction, along with
anything else MSP's own caller may have handed it (`apps/msp-server/src/providers/gks-stdio-provider.mjs`).

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

## Accepted extension — structured-record profile, contract revision 2 (2026-09-11)

zuri-ai's ADR-075 proposes a GenesisRAG17 structured-record profile for the
SmartGift catalog (a new `ontology_v2` predicate/type vocabulary — `PRICED_AT`,
`HAS_COMPONENT`, `IN_CATEGORY` and the `PACKAGE`/`CATEGORY`/`PRICE_TIER` entity
types — plus a per-record claim/descriptive chunk rendering). The four-repo
review on 2026-09-11 (contract revision 2, owner decisions O-1..O-3) found
**MSP needs no code change**. This section records that finding as the MSP
acceptance note required by the Phase 2 gate.

Per the [Extension decision](#extension-decision) above, "Canonical entities,
facts, ontology, temporal decisions, graph enrichment and quality dimensions
belong in GKS" — the ontology change is exactly that class of change, and MSP's
role stays a pass-through: it validates the outer envelope (schema version,
scope, role/grant) and forwards the request body opaquely. Re-verified at
`origin/main` (15b4565) on 2026-09-11:

- `validatePipelineRequest` (`packages/msp-contracts/src/contracts/pipeline.mjs:66-76`)
  checks only envelope-level fields per operation — `schemaVersion`, `scope`,
  `batchId`/`idempotencyKey`, receipt `scope`, `decisionId`/`decisionHash`
  shape, cursor/limit bounds, query length — and never inspects the shape of a
  batch's nested facts, chunks or mentions. A new predicate, entity type or
  claim-chunk rendering rule changes none of these checks.
- `packages/msp-contracts/schemas/GENESISRAG17.tools.json` has no nested
  `additionalProperties` or enum constraint on batch/chunk/mention content: the
  only `additionalProperties: false` in the file is the `scope` `$def` (line 12,
  the six-field `{ portfolioId, tenantId, businessId, workspaceId, agentId,
  visibility }` shape), and the only string-length limit anywhere in the schema
  is `msp_pipeline_query.query`'s `maxLength: 16000` (line 305). Neither
  constrains a fact's subject/predicate/object or a chunk's text.
- `git grep -n -E "semanticType|predicate|ontologyVersion|qualifiers"` over the
  repo returns zero matches — MSP's contracts, schema and handlers name none of
  the vocabulary this profile introduces or the deferred `qualifiers` field, so
  there is nothing in MSP that a new ontology version or field could collide
  with.
- `apps/msp-server/src/transport/handlers/pipeline-handlers.mjs:28` forwards the
  request body opaquely: `{ ...payload, relayCredential: ..., authenticatedPrincipal:
  ... }` (`payload` itself is `args` with only `credential`, `actor`,
  `authenticatedPrincipal` and `relayCredential` stripped, line 13). A batch's
  `facts[]` contents — whatever predicates, endpoint types or claim-chunk shape
  Tier 1/Tier 3 agree on — pass through this spread unexamined.

**Option A** (a tier-qualified price as a distinct `PRICED_AT` fact/entity,
O-1) is relay-transparent by the evidence above: it needs no MSP change.
**Option B** (an optional `qualifiers` field on facts/edges, O-2) is deferred by
the owner, not rejected — if it is proposed later, the same four points apply
today (`validatePipelineRequest` does not inspect fact/edge internals, the
schema has no nested constraint that would reject an added field, and the
opaque spread in `pipeline-handlers.mjs:28` would forward it as-is), so it too
would pass through unchanged. It still needs its own four-repo gate when
proposed, because it changes the frozen decision shape zuri-ai's contract doc
pins and every `decisionHash` input — a change MSP cannot see or validate from
its boundary, which is exactly why the gate is a four-repo one and not an
MSP-only sign-off.

The `ontology_v2` rollout order (C-3: worker accepts both versions, then GKS
accepts both and starts producing `ontology_v2`, then zuri-ai starts sending
parser-2 batches) needs nothing from MSP at any step — MSP has no version
literal, no ontology table and no stage ownership to update (see "The
seventeen-stage pipeline: MSP owns no stage" in `CLAUDE.md`); it relays
whichever `ontologyVersion` the stored decision already carries.

Recommended for implementation, not required by this note: a structured-batch
relay case in `tests/contract/pipeline-relay.test.mjs` that submits a batch
carrying `ontology_v2` predicates/types end-to-end through the relay and
asserts the response is returned unmodified, proving relay transparency in the
test suite rather than by code inspection alone (C-8 already lists this as
MSP's optional local case).

This acceptance is one of the four notes (zuri-ai Tier 1, MSP Tier 2, GKS
Tier 3, GenesisBlock worker Tier 4) the ADR-075 Phase 2 gate requires before
implementation may start.

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
| 1.0.2b | 2026-09-11 | beta | Accepted the GenesisRAG17 structured-record profile (ADR-075 contract revision 2, Option A) as relay-transparent — no MSP code change; recorded deferred Option B (`qualifiers`) as pass-through pending its own four-repo gate, and confirmed the `ontology_v2` rollout order needs nothing from MSP. One of the four repos' acceptance notes gating ADR-075 Phase 2. | working-tree | ATHER |
| 1.0.3b | 2026-09-11 | beta | Added the recommended structured-batch relay case to `tests/contract/pipeline-relay.test.mjs`: byte-for-byte submit relay of `ontology_v2` chunks/mentions, unchanged claim/write_receipt relay of `PRICED_AT`/`HAS_COMPONENT`/`IN_CATEGORY` facts and a `PRICE_TIER` entity, and a direct proof that `validatePipelineRequest`/`validatePipelineResponse` add no nested validation for the profile (including the deferred `qualifiers` field). Fulfils the C-8 recommendation from the 1.0.2b acceptance note; no code change. | test/structured-batch-relay | CLAUDE |
| 1.0.4b | 2026-09-11 | beta | Child-process environment construction for every GKS spawn (not only the pipeline relay) is now an explicit `GKS_*` + OS-basics allowlist instead of a fixed credential blocklist over a copy of MSP's own process environment. Security fix — MSP no longer relies on its caller (zuri-ai) never handing it production secrets. | fix/gks-child-env-allowlist | KIN |

## Reference version diff — 2026-09-08

"1.0.0b → 1.0.1b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.

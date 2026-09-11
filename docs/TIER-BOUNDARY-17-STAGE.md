---
version: "0.4.2b"
created_at: "2026-08-29T14:45:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-09-11T00:00:00+07:00,Claude Opus 5"
status: "beta"
attributes:
  domain: "mission-state-protocol"
  doc_type: "cross-repository-boundary"
  scope: "MSP's role in zuri-ai's seventeen-stage knowledge ingestion pipeline — caller, not stage owner"
---

# Tier boundary — the seventeen-stage knowledge ingestion pipeline

**Why this file exists.** A pipeline defined in another repository assigns stages
across four tiers, and MSP sits in the middle of the call path it uses. Until
2026-08-29 nothing here said so — a grep for `DPS-KI`, `17-stage`, `FR-109` or
`ADR-050` returned zero hits. This file records where MSP stands so nobody has to
infer it, and so nobody assumes MSP owes work it does not.

## MSP owns no stage

**This is the whole point of the file.** zuri-ai's ADR-050 assigns all seventeen
stages to three tiers, and MSP is in none of them:

| Tier | System | Stages |
|---|---|---|
| 1 — Execution | zuri-ai | 1–8 (shipped) |
| **2 — Memory** | **MSP** | **none** |
| 3 — Knowledge | [Genesis Knowledge System](https://github.com/Freshair129/Genesis-Knowledge-System/tree/codex/ki17-integration) | 9–14, and 17 with Tier 4 |
| 4 — Substrate | [GenesisBlock worker / DB](https://github.com/Freshair129/GenesisBlock/tree/codex/ki17-integration/genesisrag17-worker) | 15–16, and 13 with Tier 3 |

MSP's role in that four-tier stack is agent session control, unified thread id
authority and memory policy — not pipeline execution. **No stage of the
seventeen is MSP's to build, report, or be blocked on.**

## What MSP is on the path for

MSP is the **sole caller of GKS** (`Zuri / GoVibe -> MSP -> GKS`), so every
Tier 3 stage that GKS eventually executes is reached through a path MSP owns.
For the isolated GenesisRAG17 contract, MSP also relays the worker's
authenticated receipts and the source's evidence pull, while forwarding
read-only queries to the explicit Tier 4 loopback. Two consequences, both
already true and neither new work:

- **The GKS bridge must keep failing closed.** `msp_knowledge_promote` and
  `msp_memory_promote` answer `gks_provider_unconfigured` when no provider is
  configured. As GKS grows stages behind that bridge, the failure mode matters
  more, not less: a pipeline stage that silently no-ops is worse than one that
  refuses, because the count would move on nothing.
- **Vault scope travels with the call.** A promotion into GKS carries the vault
  scope it was made under. GKS gaining pipeline responsibilities does not widen
  what a caller scoped to vault A may reach.

If a future stage needs MSP to carry a field it does not carry today, that is a
wire-contract change to `docs/API-009-Persistent-Memory-Contract.md` and it goes
through the normal review — it does not make MSP a stage owner.

## The GenesisRAG17 relay boundary

The nine `msp_pipeline_*` operations are a Tier 2 transport boundary, not a
stage assignment:

| Grant | Operations | Destination |
|---|---|---|
| source | `submit`, `evidence`, `query` | GKS for submit/evidence; Tier 4 loopback for query |
| worker | `claim`, `graph_receipt`, `write_receipt`, `gate`, `publication_receipt`, `stage_failure`, `query` | GKS for worker lifecycle/receipts; Tier 4 loopback for query |

The request must use `schemaVersion: "genesisrag17.v1"` and exactly
`portfolioId`, `tenantId`, `businessId`, `workspaceId`, `agentId`, and
`visibility` in its scope. `MSP_PIPELINE_PRINCIPALS` grants a credential to
one role and one exact scope. Caller `actor`, caller credentials and a supplied
worker identity are never authority. MSP derives the authenticated principal,
adds `MSP_GKS_PIPELINE_CREDENTIAL` for the GKS hop. No GKS child process — for
this hop or for `promote`/stage-evidence export — ever receives a copy of
MSP's own environment: its environment is built from an explicit allowlist
(OS basics plus GKS's own `GKS_*` configuration), which excludes the source
grant list, the Tier 4 query token and everything else MSP's own caller may
have handed it, by construction.

MSP stores no stage payload, source lineage, canonical decision, worker
receipt, evidence cursor or verdict. It validates downstream envelopes and
journals counts only. Source parsing and lineage stay in zuri-ai stages 1–8;
canonical decisions and quality stay in GKS; physical graph/vector/index
writes and publication stay in the GenesisBlock worker and its DB. The [full relay contract](GENESISRAG17-RELAY.md)
and [MSP ADR](ADR-MSP-GENESISRAG17-RELAY.md) define the extension rule: new
input parsing belongs to zuri-ai, canonical fields belong to GKS, and any new
wire field requires coordinated contract/schema changes across repositories.

The cross-repository authority is zuri-ai's [GenesisRAG17 contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md),
[stage specification](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-SPEC.md),
and [stage flow](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-FLOW.md).
The current isolated execution and publication decision is [ADR-073 —
GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md).
The raw-to-publication acceptance is pinned to [zuri-ai commit `b64b46df`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257).

## What MSP relays for the evidence pull (2026-09-07)

GKS's `ADR-GKS-LEDGER-REPORTING` (accepted 2026-08-31) decided that Tier-3
stage evidence leaves GKS as a cursor **pull** — GKS never calls outward — and
that zuri-ai pulls it "through MSP". The relay is
**`msp_knowledge_evidence_export`** (`apps/msp-server/src/transport/handlers/
lifecycle-handlers.mjs`): it takes the caller's `scope`, `since_cursor` and
`limit`, calls GKS's `gks_stage_evidence_export` through the configured
provider, validates the page it gets back the same way `msp_knowledge_promote`
validates a promotion receipt (definition and contract ids, ascending cursors,
the six NFR-020 metrics present and numeric, `records` an array), journals
the call with counts only, and returns the page rebuilt from the validated
fields. Three things it deliberately does not do, all of them consequences of
"MSP owns no stage": it keeps **no cursor** (the puller owns it), it adds
**no scope** (it relays the caller's envelope; GKS applies it in SQL), and it
answers **nothing at all** without a provider — `gks_provider_unconfigured`,
the same fail-closed refusal as promotion. Proven through the real MSP
process against GKS's reference fixture
(`tests/integration/gks-provider-bridge.test.mjs`) and against the real GKS
(GKS's `msp-service-chain` and zuri-ai's `fr110-knowledge-evidence-chain`).

## Where completion is reported — and it is not MSP reporting it

The approved isolated pipeline adds authenticated batch, decision pull, physical
receipt, gate, publication receipt and query relays:
[GenesisRAG17 relay](GENESISRAG17-RELAY.md). GKS evaluates the combined quality
gate; the Tier4 worker publishes physically. MSP performs neither operation.

Stage completion is recorded in zuri-ai, in two places:

1. **`PRJ-KNOWLEDGE-17S`** — a Project in the zuri-ai application, one task per
   stage, currently 8/17 = 47.1%.
2. **`docs/roadmap/ROADMAP.md`**, row `PHASE-ZAI-KNOWLEDGE`.

MSP has nothing to report there. **If someone asks this repository to update the
seventeen-stage progress, the answer is that MSP owns no stage** — the question
belongs to GKS or to zuri-ai itself; this MSP record remains a boundary copy,
not a stage ledger.

## Source of truth

Authoritative in zuri-ai:

- [ADR-050 knowledge-ingestion tier boundary](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-050-KNOWLEDGE-INGESTION-TIER-BOUNDARY.md)
- [ADR-073 GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md)
- [FR-109 stage catalog](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/domains/knowledge/features/FR-109-knowledge-ingestion-stage-catalog.md)
- [GenesisRAG17 contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md)

If this file and those disagree, those win.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.4.2b | 2026-09-11 | beta | Every GKS child spawn now builds its environment from an explicit `GKS_*` + OS-basics allowlist instead of forwarding a copy of MSP's own environment with a fixed credential blocklist applied only to the pipeline relay. Security fix. | working-tree | Claude Opus 5 |
| 0.4.0b | 2026-09-08 | beta | Added the complete authenticated GenesisRAG17 relay boundary, source/worker grant split, Tier 4 query route, extension rules and pinned zuri-ai links; removed local checkout paths. | working-tree | ATHER |
| 0.2.0b | 2026-09-07 | beta | Added the one relay MSP carries for the evidence pull, `msp_knowledge_evidence_export` — GKS's `gks_stage_evidence_export` validated and handed back, no cursor, no added scope, fail-closed without a provider — with the provider method and the reference fixture that prove it. MSP still owns no stage. | working-tree | Claude Fable 5.1 |
| 0.1.0b | 2026-08-29 | beta | Recorded that MSP owns none of the seventeen pipeline stages, and what it is on the call path for — neither of which was written anywhere in this repository before. | working-tree | Claude Opus 5 |

## Reference version diff — 2026-09-08

"0.4.0b → 0.4.1b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.

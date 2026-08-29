---
version: "0.1.0b"
created_at: "2026-08-29T14:45:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-08-29T14:45:00+07:00,Claude Opus 5"
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
| 3 — Knowledge | GKS (`D:\gks`) | 9–14, and 17 with Tier 4 |
| 4 — Substrate | GenesisBlockDB | 15–16, and 13 with Tier 3 |

MSP's role in that four-tier stack is agent session control, unified thread id
authority and memory policy — not pipeline execution. **No stage of the
seventeen is MSP's to build, report, or be blocked on.**

## What MSP is on the path for

MSP is the **sole caller of GKS** (`Zuri / GoVibe -> MSP -> GKS`), so every
Tier 3 stage that GKS eventually executes is reached through a path MSP owns.
Two consequences, both already true and neither new work:

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

## Where completion is reported — and it is not MSP reporting it

Stage completion is recorded in zuri-ai, in two places:

1. **`PRJ-KNOWLEDGE-17S`** — a Project in the zuri-ai application, one task per
   stage, currently 8/17 = 47.1%.
2. **`docs/roadmap/ROADMAP.md`**, row `PHASE-ZAI-KNOWLEDGE`.

MSP has nothing to report there. **If someone asks this repository to update the
seventeen-stage progress, the answer is that MSP owns no stage** — the question
belongs to GKS (`D:\gks\docs\TIER-BOUNDARY-17-STAGE.md`) or to zuri-ai itself.

## Source of truth

Authoritative in zuri-ai:

- `docs/decisions/ADR-050-KNOWLEDGE-INGESTION-TIER-BOUNDARY.md`
- `docs/domains/knowledge/features/FR-109-knowledge-ingestion-stage-catalog.md`

If this file and those disagree, those win.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-29 | beta | Recorded that MSP owns none of the seventeen pipeline stages, and what it is on the call path for — neither of which was written anywhere in this repository before. | working-tree | Claude Opus 5 |

---
version: "0.1.0b"
created_at: "2026-09-14T12:00:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-09-14T12:00:00+07:00,Claude Opus 5"
status: "proposed"
attributes:
  domain: "mission-state-protocol"
  doc_type: "implementation-plan"
  scope: "PLAN-MSP-MEMOS — MSP as a complete multi-user, multi-agent memory runtime: phases, sprints, backlog, gates, decisions, risks"
---

# PLAN-MSP-MEMOS — Implementation plan: MSP memory OS (multi-user, multi-agent)

## สรุปภาษาไทย

แผนนี้ทำให้ MSP เป็นระบบความจำที่สมบูรณ์ รองรับหลายผู้ใช้ (principal) และหลาย agent โดย**ยังไม่เชื่อมกับ LINE OA** ตามคำสั่งเจ้าของเมื่อ 2026-09-14 งานแบ่งเป็นสามระดับ และทุกรายการมี id กำกับ

- **Phase** (`PH-MEMOS-*`) เป็นขั้นตอนใหญ่ แต่ละ phase ต้องผ่าน gate ของตัวเองก่อนไปต่อ
- **Sprint** (`SPR-MEMOS-*`) คือรอบการส่งมอบ หนึ่ง sprint ประกอบด้วยงานที่รีวิวและ merge ร่วมกัน
- **Backlog item** (`BL-MEMOS-*`) คืองานย่อยที่ลงมือทำได้จริง แต่ละรายการระบุ epic, phase, sprint, ผู้รับผิดชอบ, สิ่งที่ต้องทำก่อน และหลักฐานที่ต้องแสดงก่อนปิดงาน

Epic ใช้ id `TASK-MEMOS-001..010` เดิมจาก roadmap ของ zuri-ai (PR #380) เพื่อให้สองเอกสารอ้างถึงกันได้

ลำดับงานมีดังนี้

1. **PH-MEMOS-0** รากฐาน (เสร็จแล้ว)
2. **PH-MEMOS-1** บันทึกการตัดสินใจและ contract
3. **PH-MEMOS-2** thread memory ที่ปลอดภัยต่อหลายผู้ใช้
4. **PH-MEMOS-3** multi-agent
5. **PH-MEMOS-4** participant lifecycle และการลบข้อมูล
6. **PH-MEMOS-5** vault รายบุคคลและ `msp_vault_resolve`
7. **PH-MEMOS-6** consolidation และ passport
8. **PH-MEMOS-7** hardening และ release
9. **PH-MEMOS-8** เชื่อมช่องทางจริง (เลื่อนออกไปตามคำสั่งเจ้าของ)

## 1. Purpose and scope

**Goal.** MSP becomes a complete memory runtime in which:

- every read and write is scoped to one tenant;
- a person's private memory is visible only to that person's own authorised context;
- two agents serving the same person keep separate episodic memory and share only what the model explicitly shares;
- all of the above is proven by suites that run through the real `msp-server` process.

**In scope.** MSP repository work only:

- the thread/session surface (API-011);
- principal vaults and `msp_vault_resolve` (API-010);
- the API-009 caller-identity amendment;
- participant and agent lifecycle;
- erasure and retention;
- consolidation;
- migration-runner follow-ups;
- the release.

**Out of scope for now.** Everything that needs a channel. Real-process LINE proof, the LINE canary and production summary hosting are `TASK-MEMOS-005..007`, parked in PH-MEMOS-8 by owner direction (2026-09-14). The same applies to any zuri-ai code change.

**Sources this plan is built from.**

- [`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`](DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md) v0.2.3b, which is being rewritten as v0.3.0b in BL-MEMOS-011.
- RKOI's clause-by-clause comparison (2026-09-14) of that design against the unmerged branch `codex/msp-thread-memory` (`50859fb`, `e4303cb`).
- RKOI's reviews of MSP PRs #16–#19.
- zuri-ai `docs/roadmap/PLAN-MSP-MEMORY-OS-LINE-AGENT.md` (PR #380).

## 2. Identifier scheme

Every item carries exactly one id. Ids are keys: never renumber or reuse them. Mark a dropped item `cancelled` and keep its number burnt, following the zuri-ai convention in AGENTS.md §18.

| Family | Form | Meaning |
|---|---|---|
| Plan | `PLAN-MSP-MEMOS` | this document |
| Phase | `PH-MEMOS-<n>` | a stage with an exit gate |
| Gate | `GATE-MEMOS-<n>` | exit criteria of phase `n` |
| Sprint | `SPR-MEMOS-<nn>` | one delivery increment, ending in reviewed merges |
| Epic | `TASK-MEMOS-<nnn>` | the ten roadmap items in zuri-ai `ROADMAP.md` (rev 2.74.0b) |
| Backlog item | `BL-MEMOS-<nnn>` | an implementable unit with an owner, dependencies and proof |
| Decision | `DEC-MEMOS-<nn>` | an owner decision; ten adopted defaults are pending confirmation |
| Risk | `RSK-MEMOS-<nn>` | a tracked risk with a mitigation |

BL numbers are grouped by phase: 001–009 for phase 0, 010–019 for phase 1, 020–039 for phase 2, and so on. Gaps are reserved for items discovered inside that phase.

**Status vocabulary:** `done`, `in-progress`, `review`, `planned`, `blocked`, `deferred`, `cancelled`.

**Owners** follow the repo roster in `CLAUDE.md`:

| Owner | Responsibility |
|---|---|
| KIN | code |
| JANUS | migrations, packaging |
| GHOST | suites |
| ATHER | documents |
| RKOI | review gate |
| OWNER | decisions |
| COORD | commits, PRs, integration |

## 3. Phases

| Phase | Epics | Goal | Exit gate | Status |
|---|---|---|---|---|
| PH-MEMOS-0 | — | Foundations: migration runner safe for parent rebuilds, first design, roadmap | GATE-MEMOS-0 | done |
| PH-MEMOS-1 | TASK-MEMOS-001 | Decision record and design v0.3.0b around API-011, including the multi-user/multi-agent model | GATE-MEMOS-1 | in-progress |
| PH-MEMOS-2 | TASK-MEMOS-002 (stage 1) | Thread memory on `main`, safe for many users: C-1/C-2 closed, tenant-scoped, pseudonymous journal | GATE-MEMOS-2 | in-progress |
| PH-MEMOS-3 | TASK-MEMOS-002 (stage 2) | Multi-agent: agent identity in the grant, thread agents, per-agent record visibility | GATE-MEMOS-3 | planned |
| PH-MEMOS-4 | TASK-MEMOS-003, TASK-MEMOS-004 | Participant and agent lifecycle; erasure, retention and export for thread tables | GATE-MEMOS-4 | planned |
| PH-MEMOS-5 | TASK-MEMOS-008 | Principal vaults, API-010 `msp_vault_resolve`, API-009 access context, scoped context receipts | GATE-MEMOS-5 | planned |
| PH-MEMOS-6 | TASK-MEMOS-009 | Consolidation into principal vaults, passport, cross-thread recall, vault erasure | GATE-MEMOS-6 | planned |
| PH-MEMOS-7 | TASK-MEMOS-010 | Hardening and release: runner follow-ups, end-to-end multi-user/multi-agent acceptance, Gate A re-baseline, client release | GATE-MEMOS-7 | planned |
| PH-MEMOS-8 | TASK-MEMOS-005, TASK-MEMOS-006, TASK-MEMOS-007 | Channel activation (LINE OA): real-process proof, canary, production summaries | GATE-MEMOS-8 | deferred (owner direction 2026-09-14) |

### Exit gates

Every gate also requires:

- `npm test`, meaning `test:vitest` plus `test:security`;
- `npm run test:integration`, including `gks-provider-bridge.test.mjs`;
- `dependency-boundaries.test.mjs` passing;
- RKOI APPROVED with 0 critical;
- the updated rows in `docs/GATE-A.md`, `docs/NOTES.md` and `docs/MIGRATION.md` that ATHER's checklist requires.

- **GATE-MEMOS-0 (met)**
  - MSP PRs #15–#19 merged with CI green on Node 22 and 24.
  - Zuri-ai PR #380 merged.
- **GATE-MEMOS-1**
  - The ADR and design v0.3.0b are merged.
  - Every adopted default is recorded as pending confirmation.
  - The API-011 tool shapes are fully specified, with no field zuri-ai sends changed except those named in RSK-MEMOS-01.
- **GATE-MEMOS-2**
  - Migration 0008 is on `main`, and the real-graph migration tests (fresh and populated) pass.
  - Each C-1 attack is reproduced and refused through the real process: a second person joining, an UNKNOWN-kind bypass, a PENDING self-upgrade, and a planted record.
  - The C-2 decoupling assertion passes.
  - W1, W5, W6, W7 and W10 are proven.
- **GATE-MEMOS-3**
  - Agent B cannot read agent A's AGENT-visibility records.
  - A departed agent is denied on its next call.
  - No agent can act on a thread it is not attached to.
  - The journal actor is the agent id, and no raw principal id appears anywhere in the journal.
  - A replayed grant on any mutating tool other than append is refused.
- **GATE-MEMOS-4**
  - A relinked or departed principal cannot read the old DIRECT thread, including history from before departure.
  - After erasure, direct database assertions show no content of the erased person in any thread table, and every tool is blind to them.
  - Erasure is idempotent.
- **GATE-MEMOS-5**
  - A wrong tenant, principal, agent or workspace is denied on every new tool and on all nine `msp_memory_*` tools.
  - Principal vaults are never mountable.
  - The same resolve returns the same vault.
  - Scoped `contexts` rows need a matching access context.
  - 0009 migrates fresh and populated databases.
- **GATE-MEMOS-6**
  - No fact lands in a vault that a direct upsert under the same context would be denied.
  - A group thread never leaks into a private context.
  - Two agents serving one person keep separate episodic vaults.
  - Erasure extends to entities, history, FTS and embeddings.
- **GATE-MEMOS-7**
  - The end-to-end acceptance suite (2 tenants × 3 principals × 2 agents × DIRECT/GROUP) passes through the real process.
  - Gate A is re-baselined.
  - `pack:client` is clean.
  - DEC-MEMOS-01..10 are confirmed by the owner, or amended and re-reviewed.
- **GATE-MEMOS-8 (deferred)**
  - The zuri-ai PLAN exit gates, re-opened by the owner.

## 4. Sprints

Sprints are nominally one week. Dates are planning targets, not commitments. A sprint ends when its items are merged, and it does not end on the calendar date if the RKOI gate has not passed.

| Sprint | Target window | Phases | Sprint goal | Backlog items |
|---|---|---|---|---|
| SPR-MEMOS-00 | ≤ 2026-09-14 | PH-MEMOS-0 | Foundations merged | BL-MEMOS-001..006 |
| SPR-MEMOS-01 | 2026-09-14 → 09-20 | PH-MEMOS-1, PH-MEMOS-2, PH-MEMOS-7 | Decision record under review; thread memory port and C-1/C-2 fixes written; small runner follow-ups | BL-MEMOS-010..014, BL-MEMOS-020..032, BL-MEMOS-080..082 |
| SPR-MEMOS-02 | 09-21 → 09-27 | PH-MEMOS-2 | Thread memory merged on `main` (GATE-MEMOS-2) | BL-MEMOS-033 plus any RKOI fix-ups |
| SPR-MEMOS-03 | 09-28 → 10-04 | PH-MEMOS-3 | Multi-agent merged (GATE-MEMOS-3) | BL-MEMOS-040..049 |
| SPR-MEMOS-04 | 10-05 → 10-11 | PH-MEMOS-4 | Lifecycle and thread erasure merged (GATE-MEMOS-4) | BL-MEMOS-050..057 |
| SPR-MEMOS-05 | 10-12 → 10-18 | PH-MEMOS-5 | Vault types, `msp_vault_resolve`, API-009 amendment | BL-MEMOS-060..063, BL-MEMOS-067 |
| SPR-MEMOS-06 | 10-19 → 10-25 | PH-MEMOS-5 | Scoped context receipts, multi-agent vault rules, suites; merged (GATE-MEMOS-5) | BL-MEMOS-064..066, BL-MEMOS-068 |
| SPR-MEMOS-07 | 10-26 → 11-01 | PH-MEMOS-6 | Consolidation, passport, cross-thread recall, vault erasure (GATE-MEMOS-6) | BL-MEMOS-070..075 |
| SPR-MEMOS-08 | 11-02 → 11-08 | PH-MEMOS-7 | Acceptance, re-baseline, client release, owner confirmation (GATE-MEMOS-7) | BL-MEMOS-083..088 |
| SPR-MEMOS-09+ | not scheduled | PH-MEMOS-8 | Channel activation | BL-MEMOS-090..096 |

## 5. Backlog

Columns: **Owner**, **Depends** (items that must be done first) and **Proof** (what closes the item). "Real process" means through `apps/msp-server/bin/msp-server.mjs` via `createMspStdioCaller`, awaiting `close()` before cleanup.

### PH-MEMOS-0 — Foundations (SPR-MEMOS-00)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-001 | — | Session/episodic/instance memory design v0.1.0b → v0.2.3b | ATHER/COORD | — | MSP PR #15 merged (`9ce0d72`); design v0.2.3b erratum `2a3c039` | done |
| BL-MEMOS-002 | TASK-MEMOS-010 | Migration-runner `foreign-keys=off` mode for parent-table rebuilds | JANUS | — | MSP PR #16 merged (`869108d`) | done |
| BL-MEMOS-003 | TASK-MEMOS-010 | Refuse near-miss directive spellings; separate in-transaction prefix | JANUS | BL-MEMOS-002 | MSP PR #17 merged (`6600aa1`) | done |
| BL-MEMOS-004 | TASK-MEMOS-010 | Structural FK check on every pending migration, delegated to SQLite | JANUS | BL-MEMOS-003 | MSP PR #18 merged (`fcd17ba`) | done |
| BL-MEMOS-005 | TASK-MEMOS-010 | FK target type via `PRAGMA table_list`; directive post-exec probe; shadow non-key refusal | JANUS | BL-MEMOS-004 | MSP PR #19 merged (`ad83bc0`) | done |
| BL-MEMOS-006 | — | Memory OS phase and TASK-MEMOS-001..010 in zuri-ai roadmap | COORD | — | zuri-ai PR #380 merged (`f48b06a3`) | done |

### PH-MEMOS-1 — Decisions and contract (TASK-MEMOS-001, SPR-MEMOS-01)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-010 | TASK-MEMOS-001 | `docs/ADR-MSP-MEMORY-OS-MULTI-USER-MULTI-AGENT.md`: DEC-MEMOS-01..10 as adopted defaults pending confirmation; multi-user and multi-agent model | ATHER | — | ADR file; linked from `docs/ARCHITECTURE.md` (0.2.7b) | review |
| BL-MEMOS-011 | TASK-MEMOS-001 | Design v0.3.0b rewritten around API-011: §6–§11 and §13 replaced; migrations 0008/0009 specified; §15 suites; §18 MSP-only packets; concept mapping v0.2.3b → API-011 | ATHER | — | design file with §0 review response | review |
| BL-MEMOS-012 | TASK-MEMOS-001 | RKOI review of BL-MEMOS-010 and BL-MEMOS-011 | RKOI | BL-MEMOS-010, BL-MEMOS-011 | APPROVED, 0 critical | planned |
| BL-MEMOS-013 | TASK-MEMOS-001 | Commit ADR and design; PR; merge | COORD | BL-MEMOS-012 | PR merged with CI green | planned |
| BL-MEMOS-014 | TASK-MEMOS-001 | Owner confirmation request for DEC-MEMOS-01..10, raised with the recommendation for each | COORD/OWNER | BL-MEMOS-013 | owner's answers recorded in the ADR; not required to start PH-MEMOS-2..6; required for GATE-MEMOS-7 | planned |

### PH-MEMOS-2 — Thread memory safe for many users (TASK-MEMOS-002 stage 1, SPR-MEMOS-01/02)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-020 | TASK-MEMOS-002 | Port `codex/msp-thread-memory` onto `main` on branch `feat/memos-002-thread-memory`; fold branch 0008 and 0009 into one `migrations/0008_thread_memory.sql` | KIN | BL-MEMOS-005 | migration applies under `main`'s runner; branch integration/worker/cross tests adapted and green | in-progress |
| BL-MEMOS-021 | TASK-MEMOS-002 | Schema corrections in 0008: tenant-scoped uniques (binding, `source_event_id` per thread); `external_room_ref_hmac`; `audience_kind = thread_kind`; tombstone-ready triggers and `redaction_state` on messages, summaries, receipt text and records | KIN | BL-MEMOS-020 | schema tests; trigger allows only the tombstone transition with every other column pinned | in-progress |
| BL-MEMOS-022 | TASK-MEMOS-002 | Membership rows: `membership_id`, `tenant_id`, load-bearing `left_at`, partial unique on the open row, leave-only UPDATE, no DELETE, one HUMAN per DIRECT thread for life | KIN | BL-MEMOS-021 | trigger tests; second-human insert refused | in-progress |
| BL-MEMOS-023 | TASK-MEMOS-002 | C-1 rules: participant change only under `assertParticipants`; AGENT/OPERATOR/UNKNOWN never readable; assurance upgrade only by the principal; private read = DIRECT + current VERIFIED HUMAN + `readPrivate` | KIN | BL-MEMOS-022 | BL-MEMOS-031 cases | in-progress |
| BL-MEMOS-024 | TASK-MEMOS-002 | Protected record subject bound to the asserter (the grant principal); null-subject records visible to the asserter only | KIN | BL-MEMOS-023 | planted-record case refused | in-progress |
| BL-MEMOS-025 | TASK-MEMOS-002 | C-2: thread/participant/session/job lookups move out of `msp-contracts`; pure grant verification plus `assertThreadScope(boolean)`; decoupling assertion in `dependency-boundaries.test.mjs` | KIN | BL-MEMOS-020 | boundary test | in-progress |
| BL-MEMOS-026 | TASK-MEMOS-002 | W1: caller `now` honoured only when `MSP_TEST_CLOCK=1`, injected at the composition root | KIN | BL-MEMOS-020 | lease-theft case refused | in-progress |
| BL-MEMOS-027 | TASK-MEMOS-002 | W5: journal carries `principal_hmac`; no raw person id or room ref in any journal payload or error | KIN | BL-MEMOS-021 | journal scan after a full flow | in-progress |
| BL-MEMOS-028 | TASK-MEMOS-002 | W6/W7: tenant-scoped existence (no cross-tenant leak); `source_event_id` required, replay returns `deduplicated` | KIN | BL-MEMOS-021 | cross-tenant resolve and reuse cases; replayed signed append | in-progress |
| BL-MEMOS-029 | TASK-MEMOS-002 | W10: typed errors (`validation_failed`, `not_found`, `thread_scope_denied`, `conflict`, `identity_hmac_unconfigured`, `payload_too_large`) | KIN | BL-MEMOS-020 | contract tests assert codes | in-progress |
| BL-MEMOS-030 | TASK-MEMOS-002 | Rename contract API-010 → API-011 (doc + schema); client env allowlist gains `MSP_THREAD_SERVICE_KEY`, `MSP_IDENTITY_HMAC_KEY`; client CHANGELOG | KIN | BL-MEMOS-020 | `msp-client-env-allowlist.test.mjs`; keys never journaled or echoed | in-progress |
| BL-MEMOS-031 | TASK-MEMOS-002 | `tests/security/thread-memory-scoping.security.mjs`: all four C-1 attacks and the planted record, W1, W5, W6, W7, cross-tenant resolve/append/sweep | KIN/GHOST | BL-MEMOS-023..028 | suite green through the real process | in-progress |
| BL-MEMOS-032 | TASK-MEMOS-002 | `migrate.test.mjs`: real graph 0001–0008 on fresh and populated databases; hard-coded migration counts updated; temp follow-up migration renumbered | KIN/JANUS | BL-MEMOS-021 | tests green | in-progress |
| BL-MEMOS-033 | TASK-MEMOS-002 | RKOI review of stage 1; fix-ups; PR; merge | RKOI/COORD | BL-MEMOS-020..032 | APPROVED 0 critical; PR merged; Gate A / NOTES rows updated | planned |

### PH-MEMOS-3 — Multi-agent (TASK-MEMOS-002 stage 2, SPR-MEMOS-03)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-040 | TASK-MEMOS-002 | Grant requires `agentId` and `workspaceId`; journal `actor = agentId` | KIN | BL-MEMOS-013, BL-MEMOS-033 | grant tests; journal scan | planned |
| BL-MEMOS-041 | TASK-MEMOS-002 | `thread_agents (thread_id, agent_id, workspace_id, joined_at, left_at)`: append-only, partial unique on the open row, attached under `assertAgents` or by the creating agent on resolve | KIN | BL-MEMOS-040 | schema and trigger tests (migration per design v0.3.0b) | planned |
| BL-MEMOS-042 | TASK-MEMOS-002 | Agent gate: only a current agent of the thread may append AGENT messages, read context, record injection/delivery, or claim/commit/retry compaction | KIN | BL-MEMOS-041 | BL-MEMOS-045 cases | planned |
| BL-MEMOS-043 | TASK-MEMOS-002 | Protected records gain `agent_id` and visibility `AGENT` or `THREAD` | KIN | BL-MEMOS-041 | visibility cases | planned |
| BL-MEMOS-044 | TASK-MEMOS-002 | Summaries shared among the thread's current agents; a departed agent loses reads on its next call | KIN | BL-MEMOS-042 | departure case | planned |
| BL-MEMOS-045 | TASK-MEMOS-002 | `tests/security/thread-agent-scoping.security.mjs`: agent B vs agent A records; departed agent; unattached agent; cross-tenant agent; compaction lease across agents | GHOST | BL-MEMOS-042..044 | suite green through the real process | planned |
| BL-MEMOS-046 | TASK-MEMOS-002 | API-011 contract update for agent fields; record the zuri-ai follow-up (grant must add `agentId`) against RSK-MEMOS-01 | KIN/ATHER | BL-MEMOS-040 | contract doc and schema; RSK-MEMOS-01 updated | planned |
| BL-MEMOS-047 | TASK-MEMOS-002 | RKOI review of stage 2; PR; merge | RKOI/COORD | BL-MEMOS-040..046, BL-MEMOS-048, BL-MEMOS-049 | APPROVED 0 critical; merged | planned |
| BL-MEMOS-048 | TASK-MEMOS-002 | Grant replay protection for every mutating thread tool except `msp_thread_message_append` (which keeps `source_event_id` idempotency): grant nonce recorded in a `grant_nonces` table, as the ADR specifies; a replayed nonce is refused | KIN | BL-MEMOS-040 | replayed-grant cases for record, injection, delivery, lifecycle and compaction tools | planned |
| BL-MEMOS-049 | TASK-MEMOS-002 | Optional per-tenant `MSP_THREAD_SERVICE_KEYRING` alongside the single-key default, as the ADR specifies; a tenant-A key can never verify a tenant-B grant | KIN | BL-MEMOS-040 | cross-tenant forged-grant case refused when the keyring is configured; single-key default unchanged | planned |

### PH-MEMOS-4 — Lifecycle, erasure, retention (TASK-MEMOS-003, TASK-MEMOS-004, SPR-MEMOS-04)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-050 | TASK-MEMOS-003 | Participant lifecycle tool: leave and relink under an explicit claim; closes the old membership; a new principal never inherits it | KIN | BL-MEMOS-047 | relink case | planned |
| BL-MEMOS-051 | TASK-MEMOS-003 | Agent detach tool on `thread_agents` under an explicit claim | KIN | BL-MEMOS-047 | detach case | planned |
| BL-MEMOS-052 | TASK-MEMOS-003 | Lifecycle security cases: relinked principal denied on the old DIRECT thread, including pre-departure history; detached agent denied | GHOST | BL-MEMOS-050, BL-MEMOS-051 | added to BL-MEMOS-031 / BL-MEMOS-045 suites | planned |
| BL-MEMOS-053 | TASK-MEMOS-004 | Principal erasure for thread tables: tombstone authored messages, receipt and pending-delivery text, records; summaries covering the principal go to redaction states; `erasure_receipts`; journal pseudonym only; idempotent by key | KIN | BL-MEMOS-050 | direct-database assertions after `close()`; tools blind | planned |
| BL-MEMOS-054 | TASK-MEMOS-004 | Retention tick for thread tables, operator-bound to its own tenant, `dry_run` supported | KIN | BL-MEMOS-053 | cross-tenant operator case refused | planned |
| BL-MEMOS-055 | TASK-MEMOS-004 | Principal export for thread data: own messages, own records, own view of summaries; self or `data_subject_admin` within the tenant | KIN | BL-MEMOS-053 | export contains only the principal's own material | planned |
| BL-MEMOS-056 | TASK-MEMOS-004 | `tests/security/thread-erasure.security.mjs`: direct-table and tool assertions; idempotency; export and erase cannot name another principal without the flag | GHOST | BL-MEMOS-053..055 | suite green | planned |
| BL-MEMOS-057 | TASK-MEMOS-003/004 | RKOI review; PR; merge | RKOI/COORD | BL-MEMOS-050..056 | APPROVED 0 critical; merged | planned |

### PH-MEMOS-5 — Principal vaults and API-010 (TASK-MEMOS-008, SPR-MEMOS-05/06)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-060 | TASK-MEMOS-008 | Migration 0009 principal vault types: directive rebuild of `vaults` in safe order; per-type owner CHECKs exempting erased rows; partial uniques on active rows; never-mountable INSERT and UPDATE triggers; `decay_policy` | JANUS/KIN | BL-MEMOS-057 | runner check passes; schema tests | planned |
| BL-MEMOS-061 | TASK-MEMOS-008 | `VaultRegistry`: principal branches ahead of the mount short-circuit; `isVaultAccessibleTo(vaultId, {workspaceId, agentId, tenantId, principalId, allowPassport})`; `mountVault` refuses principal types | KIN | BL-MEMOS-060 | registry tests; legacy callers unchanged | planned |
| BL-MEMOS-062 | TASK-MEMOS-008 | API-010 `msp_vault_resolve`: provisioning in one transaction; receipts to journal with `principal_hmac`; contract doc and `API-010.tools.json` | KIN | BL-MEMOS-061 | contract tests; same resolve returns the same vault | planned |
| BL-MEMOS-063 | TASK-MEMOS-008 | API-009 0.2.0 amendment: optional `access_context`, mandatory for principal vault types on all nine `msp_memory_*` tools (entity-id-only tools resolve entity → vault); `pinned` on decay tick | KIN/ATHER | BL-MEMOS-061 | `api-009-conformance.test.mjs`: absent ⇒ unchanged for legacy, denied for principal | planned |
| BL-MEMOS-064 | TASK-MEMOS-008 | Scoped `contexts` receipts: tenant/principal columns (own migration); context diff/audit/replay require a matching access context for scoped rows; `include_payload` refused for them | KIN | BL-MEMOS-062 | `context-tools-ownership.security.mjs` | planned |
| BL-MEMOS-065 | TASK-MEMOS-008 | Multi-agent vault rules: two agents serving one person get distinct episodic vaults; passport readable only with `allow_passport`; `global_private` agent vault never targeted by principal facts | KIN | BL-MEMOS-062 | vault multi-agent cases | planned |
| BL-MEMOS-066 | TASK-MEMOS-008 | Suites: `principal-vault-scoping`, `provenance-ids-are-not-owners`, decay pinned case, `shared-scope-fail-closed` extension | GHOST | BL-MEMOS-061..065 | suites green | planned |
| BL-MEMOS-067 | TASK-MEMOS-008 | Real-graph migration tests for 0009: fresh and populated 0001–0008; child `REFERENCES` still name `vaults`; unexpected `vaults.status` row refused | JANUS | BL-MEMOS-060 | `migrate.test.mjs` cases (moved from WP-E0 per design v0.2.3b) | planned |
| BL-MEMOS-068 | TASK-MEMOS-008 | RKOI review; PR; merge | RKOI/COORD | BL-MEMOS-060..067 | APPROVED 0 critical; merged | planned |

### PH-MEMOS-6 — Consolidation, passport, cross-thread recall (TASK-MEMOS-009, SPR-MEMOS-07)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-070 | TASK-MEMOS-009 | Consolidation: CONFIRMED protected records and summary items become entities in the owner's episodic vault, under the owner's own access context only; `entity_provenance` table | KIN | BL-MEMOS-068 | "no fact lands where a direct upsert would be denied" case | planned |
| BL-MEMOS-071 | TASK-MEMOS-009 | Passport promotion policy: confidence and multi-episode thresholds, `allow_passport`, `passport_deferred` reported | KIN | BL-MEMOS-070 | policy tests | planned |
| BL-MEMOS-072 | TASK-MEMOS-009 | Context read extension: passport and episodic-recall slices gated by access context; cross-thread digest from the principal's own DIRECT threads only; reference-only receipt | KIN | BL-MEMOS-070, BL-MEMOS-064 | cross-thread digest case | planned |
| BL-MEMOS-073 | TASK-MEMOS-009 | Erasure extension to vaults: entity and history body tombstones, embeddings deleted, FTS re-indexed, vault rows erased and cleared in one UPDATE | KIN | BL-MEMOS-070, BL-MEMOS-053 | direct-database assertions incl. `entities_fts` MATCH | planned |
| BL-MEMOS-074 | TASK-MEMOS-009 | Suites: `consolidation-vault-scoping`, `cross-thread-digest-scoping`, `group-thread-private-context`, extended erasure | GHOST | BL-MEMOS-070..073 | suites green | planned |
| BL-MEMOS-075 | TASK-MEMOS-009 | RKOI review; PR; merge | RKOI/COORD | BL-MEMOS-070..074 | APPROVED 0 critical; merged | planned |

### PH-MEMOS-7 — Hardening and release (TASK-MEMOS-010, SPR-MEMOS-01 and SPR-MEMOS-08)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-080 | TASK-MEMOS-010 | Policy line in `docs/MIGRATION.md`: no foreign key into FTS5/rtree shadow tables, even when SQLite accepts it | ATHER | — | doc row; RKOI #19 advisory closed | planned |
| BL-MEMOS-081 | TASK-MEMOS-010 | rtree runner test uses `it.skipIf(!rtreeAvailable)` instead of a silent FTS5 fallback | JANUS | — | test shows skipped when the module is absent | planned |
| BL-MEMOS-082 | TASK-MEMOS-010 | Near-miss review follow-ups: document that header scanning stops after an exact line 1, with a test; rename the "not accepted via trim()" test title | JANUS | — | doc and test | planned |
| BL-MEMOS-083 | TASK-MEMOS-010 | End-to-end acceptance suite through the real process: 2 tenants × 3 principals × 2 agents × DIRECT and GROUP threads, covering resolve, append, context, record, summary, vault resolve, consolidation, erase | GHOST | BL-MEMOS-075 | suite green; isolation matrix recorded | planned |
| BL-MEMOS-084 | TASK-MEMOS-010 | Gate A re-baseline: "vault and thread isolation" row, suite counts, migration lineage 0008–0011 | ATHER | BL-MEMOS-083 | `docs/GATE-A.md` updated with evidence | planned |
| BL-MEMOS-085 | TASK-MEMOS-010 | Client release: `@freshair129/msp-client-js` version, CHANGELOG, env allowlist names, `npm run pack:client` clean | JANUS | BL-MEMOS-083 | pack dry-run output | planned |
| BL-MEMOS-086 | TASK-MEMOS-010 | Documentation closure: README, ARCHITECTURE layering for thread and vault surfaces, NOTES gaps closed (API-009 caller identity, context-tool ownership) | ATHER | BL-MEMOS-083 | frontmatter and CHANGELOG rows | planned |
| BL-MEMOS-087 | TASK-MEMOS-001 | Owner confirms or amends DEC-MEMOS-01..10; ADR status → accepted; amendments re-reviewed | OWNER/RKOI | BL-MEMOS-014 | ADR updated | planned |
| BL-MEMOS-088 | TASK-MEMOS-010 | Release review and merge; tag the release | RKOI/COORD | BL-MEMOS-083..087 | GATE-MEMOS-7 met | planned |

### PH-MEMOS-8 — Channel activation (deferred; TASK-MEMOS-005..007)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-090 | TASK-MEMOS-005 | zuri-ai grant adds `agentId`/`workspaceId`; transport allowlist passes `MSP_THREAD_SERVICE_KEY` and `MSP_IDENTITY_HMAC_KEY` | zuri-ai owner | BL-MEMOS-088 | zuri-ai PR | deferred |
| BL-MEMOS-091 | TASK-MEMOS-005 | Real-process contract proof from zuri-ai over stdio; settle raw `externalThreadId` and `PENDING_INBOUND` handling | zuri-ai owner | BL-MEMOS-090 | acceptance test | deferred |
| BL-MEMOS-092 | TASK-MEMOS-003 | zuri-ai calls the lifecycle tool on Person relink/merge and Membership revocation | zuri-ai owner | BL-MEMOS-090 | cross-repo test | deferred |
| BL-MEMOS-093 | TASK-MEMOS-004 | zuri-ai PDPA erasure calls MSP erasure | zuri-ai owner | BL-MEMOS-090 | cross-repo test | deferred |
| BL-MEMOS-094 | TASK-MEMOS-006 | LINE canary on one DIRECT account with rollback runbook | zuri-ai owner/OWNER | BL-MEMOS-091..093 | canary evidence | deferred |
| BL-MEMOS-095 | TASK-MEMOS-007 | LINE worker hosts the MSP summary worker | zuri-ai owner | BL-MEMOS-094 | summaries cited in production | deferred |
| BL-MEMOS-096 | — | Re-open decision: owner lifts the PH-MEMOS-8 deferral | OWNER | BL-MEMOS-088 | owner instruction | deferred |

## 6. Decisions (adopted defaults, pending owner confirmation)

These ten were raised by RKOI's reconciliation. The owner has not answered them. Per the owner's 2026-09-14 direction to proceed, implementation uses the recommended default for each. BL-MEMOS-014 asks for confirmation, and BL-MEMOS-087 records the outcome.

| ID | Decision | Adopted default | Affects |
|---|---|---|---|
| DEC-MEMOS-01 | API numbering | API-010 = `msp_vault_resolve` (zuri-ai ADR-022); thread surface = API-011 | BL-MEMOS-030, BL-MEMOS-062 |
| DEC-MEMOS-02 | Canonical thread surface | The branch's `msp_thread_*` tools; no field zuri-ai sends changes except RSK-MEMOS-01 | PH-MEMOS-2, PH-MEMOS-3 |
| DEC-MEMOS-03 | Instances / agent leg | Dropped for server channels; the signed per-room grant is the recorded relation; agents are modelled by `thread_agents` | BL-MEMOS-041 |
| DEC-MEMOS-04 | Identity changes | MSP provides a lifecycle tool; callers wire it later | BL-MEMOS-050, BL-MEMOS-092 |
| DEC-MEMOS-05 | Erasure before activation | Erasure (PH-MEMOS-4, extended in PH-MEMOS-6) gates any channel activation | GATE-MEMOS-8 |
| DEC-MEMOS-06 | Room refs at rest | Stored as HMAC under `MSP_IDENTITY_HMAC_KEY` | BL-MEMOS-021 |
| DEC-MEMOS-07 | Migration order | 0008 thread memory, then 0009 principal vaults, then scoped context and consolidation migrations | BL-MEMOS-020, BL-MEMOS-060 |
| DEC-MEMOS-08 | Thread memory vs vaults | Thread-scoped memory stays in thread tables; CONFIRMED items consolidate into principal vaults under the owner's context | BL-MEMOS-070 |
| DEC-MEMOS-09 | Caller `now` | Test-only (`MSP_TEST_CLOCK=1`) | BL-MEMOS-026 |
| DEC-MEMOS-10 | Extractive fallback | Not built; `coverageGap` is the mechanism | PH-MEMOS-6 |

Two earlier open design questions carry over and are tracked as risks rather than defaults, because no recommendation was agreed: tombstone retention horizon (design v0.2.3b §19.7) and identity key presence at startup (§19.8).

## 7. Risks

| ID | Risk | Likelihood / impact | Mitigation | Owner |
|---|---|---|---|---|
| RSK-MEMOS-01 | Multi-agent makes `agentId` a required grant claim. zuri-ai does not send it today, so this is a cross-repo wire change before any activation. | certain / medium | Record in BL-MEMOS-046; zuri-ai change is BL-MEMOS-090; no activation until then (PH-MEMOS-8 deferred) | COORD |
| RSK-MEMOS-02 | Adopted defaults overturned by the owner after implementation | low–medium / high for DEC-MEMOS-01, -02, -07 | Confirmation requested early (BL-MEMOS-014); nothing merged past PH-MEMOS-2 changes a shipped migration without review | COORD/OWNER |
| RSK-MEMOS-03 | Design v0.3.0b (BL-MEMOS-011) and the stage-1 code (BL-MEMOS-020..032) are written in parallel and may diverge. Known divergences so far: the ADR puts `thread_kind` as the single persisted kind and checks the grant's audience against it; it adds grant nonces for non-append mutating tools (BL-MEMOS-048) and an optional per-tenant keyring (BL-MEMOS-049). Stage 1 was briefed before the ADR existed. | medium / medium | RKOI reviews both against each other at BL-MEMOS-012 and BL-MEMOS-033; code follows the ADR where they differ | RKOI |
| RSK-MEMOS-04 | Migration 0008 lands and is later found wrong; checksum-locked lineage needs a corrective migration | low / high | Real-graph fresh and populated tests (BL-MEMOS-032); RKOI gate before merge; nothing past 0007 has shipped yet | JANUS |
| RSK-MEMOS-05 | A single all-tenant `MSP_THREAD_SERVICE_KEY`; capability flags are unverified Tier-1 claims | certain / high if transport widens | Trust boundary stays stdio-only (design §13.1); any network transport re-opens the design | RKOI |
| RSK-MEMOS-06 | Tombstoned rows kept indefinitely may not satisfy a tenant's PDPA position | unknown / medium | Owner question carried from design §19.7; resolve before GATE-MEMOS-7 | OWNER |
| RSK-MEMOS-07 | Identity key absent at startup leaves the thread and vault surfaces dark without a loud signal | medium / medium | Design §6.2 default (startup diagnostic, `msp_ping` report, opt-in fail-closed boot); resolve before GATE-MEMOS-7 | OWNER |
| RSK-MEMOS-08 | zuri-ai roadmap ids and revisions move fast (#379, #381, #382 each collided with PR #380) | high / low | Fetch and rebase immediately before any zuri-ai push; TASK-MEMOS family kept separate from TASK-ZAI | COORD |

## 8. Traceability

| Epic (zuri-ai roadmap) | Phases | Backlog items |
|---|---|---|
| TASK-MEMOS-001 | PH-MEMOS-1, PH-MEMOS-7 | BL-MEMOS-010..014, BL-MEMOS-087 |
| TASK-MEMOS-002 | PH-MEMOS-2, PH-MEMOS-3 | BL-MEMOS-020..033, BL-MEMOS-040..049 |
| TASK-MEMOS-003 | PH-MEMOS-4, PH-MEMOS-8 | BL-MEMOS-050..052, BL-MEMOS-057, BL-MEMOS-092 |
| TASK-MEMOS-004 | PH-MEMOS-4, PH-MEMOS-8 | BL-MEMOS-053..057, BL-MEMOS-093 |
| TASK-MEMOS-005 | PH-MEMOS-8 | BL-MEMOS-090, BL-MEMOS-091 |
| TASK-MEMOS-006 | PH-MEMOS-8 | BL-MEMOS-094 |
| TASK-MEMOS-007 | PH-MEMOS-8 | BL-MEMOS-095 |
| TASK-MEMOS-008 | PH-MEMOS-5 | BL-MEMOS-060..068 |
| TASK-MEMOS-009 | PH-MEMOS-6 | BL-MEMOS-070..075 |
| TASK-MEMOS-010 | PH-MEMOS-0, PH-MEMOS-7 | BL-MEMOS-002..005, BL-MEMOS-080..086, BL-MEMOS-088 |

The zuri-ai roadmap orders the epics for the LINE agent: 001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010. This plan re-sequences them for an MSP-only build. Vaults (008) come before consolidation (009). Erasure is split: thread tables in PH-MEMOS-4, and vault extension in PH-MEMOS-6. The channel epics 005–007 are deferred. The epic ids and their meaning are unchanged.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-14 | proposed | Initial implementation plan PLAN-MSP-MEMOS: identifier scheme; nine phases PH-MEMOS-0..8 with gates GATE-MEMOS-0..8; sprints SPR-MEMOS-00..09+; backlog BL-MEMOS-001..096 (including BL-MEMOS-048 grant nonces and BL-MEMOS-049 per-tenant keyring from the ADR) mapped to epics TASK-MEMOS-001..010; decisions DEC-MEMOS-01..10 as adopted defaults pending confirmation; risks RSK-MEMOS-01..08; channel activation deferred by owner direction. | working-tree | Claude Opus 5 |

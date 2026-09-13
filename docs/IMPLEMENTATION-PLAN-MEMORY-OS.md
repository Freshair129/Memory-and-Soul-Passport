---
version: "0.1.5b"
created_at: "2026-09-14T12:00:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-09-15T03:00:00+07:00,ATHER"
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

- [`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`](DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md), now at v0.3.5b after three RKOI NEEDS REVISION rounds (v0.3.0b, v0.3.1b, v0.3.2b), one APPROVED-with-warnings docs round (v0.3.3b → v0.3.4b) and one stage-1 code-review round (v0.3.4b → v0.3.5b) (BL-MEMOS-011, BL-MEMOS-012); each round reads the shipped stage-1 code (and, from round three on, zuri-ai's own real signer) more directly than the last as the source of truth for wire/schema shapes.
- KIN's stage-1 port, `feat/memos-002-thread-memory` (worktree `agent-ab508b7a790efd268`): `migrations/0008_thread_memory.sql`, `packages/msp-core/src/domain/thread-memory.mjs`, `packages/msp-contracts/src/contracts/thread-access.mjs`, `apps/msp-server/src/transport/handlers/thread-guard.mjs`, `docs/API-011-THREAD-MEMORY-CONTRACT.md`.
- RKOI's own review findings (rounds one through four), each backed by direct inspection of zuri-ai's real code and the shipped migration; per RKOI's own instruction, this plan cites the findings and the backlog items that prove them, not the session-scratch scripts RKOI used to derive them.
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

BL numbers are grouped by phase: 001–009 for phase 0, 010–019 for phase 1, 020–039 for phase 2, and so on. Gaps are reserved for items discovered inside that phase. **Where a phase's block is already fully allocated (2026-09-14 revision: phase 3's 040–049 has no free slot), a newly discovered item takes the next free number in the 100+ range instead of renumbering anything**; its Epic/phase columns still say which phase it belongs to. This is itself a convention change, recorded in this revision's CHANGELOG row rather than applied silently.

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
| PH-MEMOS-1 | TASK-MEMOS-001 | Decision record and design (current: v0.3.5b) around API-011, including the multi-user/multi-agent model | GATE-MEMOS-1 | in-progress |
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
  - The ADR (current: v0.1.5b) and design (current: v0.3.5b) are merged.
  - Every adopted default (DEC-MEMOS-01..16) is recorded as pending confirmation.
  - The API-011 tool shapes are fully specified, with no field zuri-ai sends changed except those named in RSK-MEMOS-01.
- **GATE-MEMOS-2** — every case below runs in `tests/security/thread-memory-scoping.security.mjs` (design §15) unless noted:
  - Migration 0008 is on `main`, and the real-graph migration tests (fresh and populated) pass.
  - Each C-1 attack is reproduced and refused through the real process: a second person joining, an UNKNOWN-kind bypass, a PENDING self-upgrade without the DEC-MEMOS-15 conditions, and a planted record.
  - DEC-MEMOS-15's self-upgrade succeeds under its full condition set (incoming request and stored row) and is refused, or silently ignored for the downgrade case, the instant any one condition does not hold.
  - **A grant scoped to room R1's hash is refused against a thread that only shares R1's tenant/business/channel-account, including via `msp_session_compaction_claim`/`commit`/`retry` resolving through the job's own thread (`BL-MEMOS-111`).**
  - **A grant with no room claim at all (`externalRoomRef` or `channelAccountId` absent) is refused `thread_scope_denied` on every thread-bound tool — `context`, `append`, `memory_record`, `injection`, `delivery`, `claim`, `commit`, `retry` — never allowed to pass on tenant/business/account alone (`BL-MEMOS-111`, CRITICAL on the code, KIN fixing it).**
  - `audienceKind` is required and enforced on `resolve`/`append`/`context`/`memory_record`/`injection_record`; `msp_thread_delivery_record` is the one exempt tool, scoped instead by the inbound message's thread and the room hash.
  - A `msp_thread_resolve` whose `channel_type` differs from an existing `ACTIVE` thread's stored `channel_type`, for the same tenant/account/room hash, is refused `conflict` (DEC-MEMOS-16).
  - `msp_session_sweep` is refused when its grant carries no room claim, exactly like the other seven thread-bound tools — it is room-scoped, not tenant-scoped.
  - The C-2 decoupling assertion passes (`dependency-boundaries.test.mjs`).
  - W1, W5, W6, W7 and W10 are proven.
  - `tests/cross/zuri-thread-contract.test.mjs` passes via `npm run test:cross-zuri` against a read-only extract of zuri-ai `origin/main` (`BL-MEMOS-110`).
- **GATE-MEMOS-3** — every case below runs in `tests/security/thread-agent-scoping.security.mjs` (design §15):
  - Agent B cannot read agent A's AGENT-visibility records.
  - A departed agent is denied on its next call.
  - No agent can act on a thread it is not attached to.
  - The journal actor is the agent id, and no raw principal id appears anywhere in the journal.
  - A replayed grant on any mutating tool other than append is refused.
- **GATE-MEMOS-4** — suites as named by `BL-MEMOS-052` and `BL-MEMOS-056`:
  - A relinked or departed principal cannot read the old DIRECT thread, including history from before departure (`tests/security/participant-lifecycle-relink.security.mjs`, `BL-MEMOS-052`; design §15).
  - After erasure, direct database assertions show no content of the erased person in any thread table, and every tool is blind to them (`tests/security/thread-erasure.security.mjs`, `BL-MEMOS-056`).
  - Erasure is idempotent (`tests/security/thread-erasure.security.mjs`, `BL-MEMOS-056`).
- **GATE-MEMOS-5** — every case below runs in `tests/security/principal-vault-scoping.security.mjs` plus `provenance-ids-are-not-owners.security.mjs` and `context-tools-ownership.security.mjs` (design §15):
  - A wrong tenant, principal, agent or workspace is denied on every new tool and on all nine `msp_memory_*` tools.
  - Principal vaults are never mountable.
  - The same resolve returns the same vault.
  - Scoped `contexts` rows need a matching access context.
  - The principal-vaults migration (number assigned at merge, per DEC-MEMOS-14 — not pre-bound to `0009`) migrates fresh and populated databases.
- **GATE-MEMOS-6** — every case below runs in `tests/security/consolidation-vault-scoping.security.mjs`, `cross-thread-digest-scoping.security.mjs` and `group-thread-private-context.security.mjs`, plus the extended `erasure-invalidates-retrieval.security.mjs` (suites as named by `BL-MEMOS-074`):
  - No fact lands in a vault that a direct upsert under the same context would be denied.
  - A group thread never leaks into a private context.
  - Two agents serving one person keep separate episodic vaults.
  - Erasure extends to entities, history, FTS and embeddings.
- **GATE-MEMOS-7**
  - The end-to-end acceptance suite (2 tenants × 3 principals × 2 agents × DIRECT/GROUP) passes through the real process.
  - Gate A is re-baselined.
  - `pack:client` is clean.
  - DEC-MEMOS-01..16 are confirmed by the owner, or amended and re-reviewed.
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
| BL-MEMOS-010 | TASK-MEMOS-001 | `docs/ADR-MSP-MEMORY-OS-MULTI-USER-MULTI-AGENT.md`: DEC-MEMOS-01..16 as adopted defaults pending confirmation; multi-user and multi-agent model; RKOI's rulings on four judgement calls; cross-repo change list | ATHER | — | ADR file (current: v0.1.5b); linked from `docs/ARCHITECTURE.md` (0.2.7b) | review |
| BL-MEMOS-011 | TASK-MEMOS-001 | Design rewritten around API-011's real branch wire shapes: §6–§11 and §13 replaced; stage-1 migration `0008` and the stage-2 multi-agent migration specified; §15 suites; §18 MSP-only packets; concept mapping v0.2.3b → API-011 | ATHER | — | design file (current: v0.3.5b) with §0 review response | review |
| BL-MEMOS-012 | TASK-MEMOS-001 | RKOI review of BL-MEMOS-010 and BL-MEMOS-011 | RKOI | BL-MEMOS-010, BL-MEMOS-011 | Round 1 (commit `2f4d584`): NEEDS REVISION, 3 critical — answered in ADR v0.1.1b / design v0.3.1b. Round 2 (commit `92cb591`): NEEDS REVISION, 1 critical (wire values still did not match the shipped stage-1 code) — answered in ADR v0.1.2b / design v0.3.2b. Round 3 (commit `6d1a801`): NEEDS REVISION, 1 critical (the delivery grant's real claim set) — answered in ADR v0.1.3b / design v0.3.3b. Round 4 (commit `1c4a62f`): **APPROVED, 0 critical**, 9 warnings folded into ADR v0.1.4b / design v0.3.4b ahead of merge. Stage-1 code review round 2 (commit `445bd90`): a CRITICAL room-claim-required gap on the code (KIN fixing it), plus `DEC-MEMOS-16` and sweep/worker-grant corrections, folded into ADR v0.1.5b / design v0.3.5b | in-progress |
| BL-MEMOS-013 | TASK-MEMOS-001 | Commit ADR and design; PR; merge | COORD | BL-MEMOS-012 | PR merged with CI green | planned |
| BL-MEMOS-014 | TASK-MEMOS-001 | Owner confirmation request for DEC-MEMOS-01..16, raised with the recommendation for each | COORD/OWNER | BL-MEMOS-013 | owner's answers recorded in the ADR; not required to start PH-MEMOS-2..6; required for GATE-MEMOS-7 | planned |

### PH-MEMOS-2 — Thread memory safe for many users (TASK-MEMOS-002 stage 1, SPR-MEMOS-01/02)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-020 | TASK-MEMOS-002 | Port `codex/msp-thread-memory` onto `main` on branch `feat/memos-002-thread-memory`; fold branch 0008 and 0009 into one `migrations/0008_thread_memory.sql` | KIN | BL-MEMOS-005 | migration applies under `main`'s runner; branch integration/worker/cross tests adapted and green | in-progress |
| BL-MEMOS-021 | TASK-MEMOS-002 | Schema corrections in 0008 per design v0.3.5b §12.1 (**corrected, round two**: binding fields live directly on `threads`, pinned for the row's life — there is no separate `thread_bindings` table to restore, see `BL-MEMOS-100`'s cancellation): `threads`' own `channel_type`/`channel_account_id`/`external_room_ref_hmac`/`business_id` columns pinned by an UPDATE trigger, tenant-scoped `ACTIVE`-only unique binding via `idx_threads_active_binding`; `thread_kind`/`audience_kind`/grant `audienceKind` required equal on mint; tombstone-ready triggers and `redaction_state` on messages, summaries, receipt text and records; tenant-consistency triggers on every denormalized `tenant_id` (W3) | KIN | BL-MEMOS-020, **BL-MEMOS-012** | schema tests; trigger allows only the tombstone transition with every other column pinned | in-progress |
| BL-MEMOS-022 | TASK-MEMOS-002 | Membership rows: `membership_id`, `tenant_id`, load-bearing `left_at`, partial unique on the open row, leave-only UPDATE, no DELETE, one HUMAN per DIRECT thread for life; DEC-MEMOS-11 relink closes the thread and mints a new one (not a membership rewrite) | KIN | BL-MEMOS-021, **BL-MEMOS-012** | trigger tests; second-human insert refused; relink case | in-progress |
| BL-MEMOS-023 | TASK-MEMOS-002 | C-1 rules per design v0.3.5b §7: first HUMAN membership created by append bound to `grant.principalId` (DEC-MEMOS-12), no `participants` field on resolve; every other participant change requires `assertParticipants`, never `writePrivate` (W13 fix); AGENT/OPERATOR/UNKNOWN never readable; **assurance upgrade (corrected, round four): a `PENDING → VERIFIED` self-upgrade on a later append needs no claim under DEC-MEMOS-15's conditions (checked against both the incoming request and the stored row); every other assurance change still needs `assertParticipants` or the (unbuilt) lifecycle tool; a self-upgrade closes the old row and inserts a new one in one transaction, never an in-place `UPDATE`** | KIN | BL-MEMOS-022, **BL-MEMOS-012** | BL-MEMOS-031 cases | in-progress |
| BL-MEMOS-024 | TASK-MEMOS-002 | Protected record subject bound to the asserter's own principal via a BEFORE INSERT trigger (not a CHECK subquery — SQLite forbids it, RKOI finding 1); HUMAN-asserted ⇒ subject NOT NULL and self-bound; null-subject records visible to the asserter only; never surfaced to a different HUMAN participant of a GROUP/ROOM thread | KIN | BL-MEMOS-023, **BL-MEMOS-012** | planted-record case refused; trigger fires on insert, not a rejected CHECK | in-progress |
| BL-MEMOS-025 | TASK-MEMOS-002 | C-2: thread/participant/session/job lookups stay in `msp-core` (DEC-MEMOS-13, no separate package); pure grant verification plus `grant-scope-guard.mjs`'s `assertGrantScope(boolean)` in `msp-contracts`; decoupling assertion in `dependency-boundaries.test.mjs`, extended to scan for `.prepare(`/`.exec(`/`.pragma(` (W7) | KIN | BL-MEMOS-020 | boundary test | in-progress |
| BL-MEMOS-026 | TASK-MEMOS-002 | W1: caller `now` honoured only when `MSP_TEST_CLOCK=1` (renamed from `MSP_ALLOW_TEST_CLOCK`, W8), injected at the composition root, kept out of the client env allowlist | KIN | BL-MEMOS-020 | lease-theft case refused | in-progress |
| BL-MEMOS-027 | TASK-MEMOS-002 | W5: journal carries `principal_hmac`; no raw person id or room ref in any journal payload or error | KIN | BL-MEMOS-021 | journal scan after a full flow | in-progress |
| BL-MEMOS-028 | TASK-MEMOS-002 | W6/W7: tenant-scoped existence (no cross-tenant leak); `source_event_id` required, replay with identical content returns `deduplicated`, replay with different content returns `conflict` (RKOI finding 2) | KIN | BL-MEMOS-021 | cross-tenant resolve and reuse cases; replayed signed append; mismatched-content replay case | in-progress |
| BL-MEMOS-029 | TASK-MEMOS-002 | W10: typed errors per design v0.3.5b §14 (`validation_failed`, `not_found`, `thread_scope_denied`, `thread_audience_mismatch`, `conflict`, `identity_hmac_unconfigured`, `payload_too_large`, `record_subject_mismatch`, `compaction_lease_conflict`) — `agent_not_current` is a stage-2 code, not shipped in stage 1 | KIN | BL-MEMOS-020, **BL-MEMOS-012** | contract tests assert codes | in-progress |
| BL-MEMOS-030 | TASK-MEMOS-002 | Rename contract API-010 → API-011 (doc + schema) using the branch's actual frozen wire shapes per design v0.3.5b §12.1/§13 (flat epoch/hex grant, snake_case fields, `text`/`exchange_id`/`direction`/`kind`, not the invented camelCase/nested shapes RKOI rejected); client env allowlist gains `MSP_THREAD_SERVICE_KEY`, `MSP_IDENTITY_HMAC_KEY`; client CHANGELOG | KIN | BL-MEMOS-020, **BL-MEMOS-012** | `msp-client-env-allowlist.test.mjs`; keys never journaled or echoed; contract tests match the branch's real field names | in-progress |
| BL-MEMOS-031 | TASK-MEMOS-002 | `tests/security/thread-memory-scoping.security.mjs`: all four C-1 attacks and the planted record, W1, W5, W6, W7, cross-tenant resolve/append/sweep | KIN/GHOST | BL-MEMOS-023..028 | suite green through the real process | in-progress |
| BL-MEMOS-032 | TASK-MEMOS-002 | `migrate.test.mjs`: real graph 0001–0008 on fresh and populated databases; hard-coded migration counts updated; temp follow-up migration renumbered | KIN/JANUS | BL-MEMOS-021 | tests green | in-progress |
| BL-MEMOS-033 | TASK-MEMOS-002 | RKOI review of stage 1; fix-ups; PR; merge; must include running `tests/cross/zuri-thread-contract.test.mjs` via `npm run test:cross-zuri` with `MSP_TEST_ZURI_ROOT` set to the `origin/main` extract (BL-MEMOS-110) | RKOI/COORD | BL-MEMOS-020..032, BL-MEMOS-102, BL-MEMOS-103, BL-MEMOS-108, BL-MEMOS-109, BL-MEMOS-110, BL-MEMOS-111 | Docs review round 4 (commit `1c4a62f`): **APPROVED, 0 critical**, 9 warnings folded into design v0.3.4b/ADR v0.1.4b/this plan ahead of merge — including a new cross-room gap (`BL-MEMOS-111`) found with no backlog row at all. **Stage-1 code review round 2 (commit `445bd90`)** then found the room claim itself must be required (CRITICAL, KIN fixing it), a `channel_type`-mismatch gap (`DEC-MEMOS-16`), and the sweep/worker-grant corrections folded into design v0.3.5b/ADR v0.1.5b/this plan. A docs approval is not the same as this backlog item's own code review, which is still open; fix-ups across every round remain in progress | in-progress |
| BL-MEMOS-100 | — | ~~Restore `thread_bindings` as its own table~~ — **cancelled 2026-09-14.** Reading the shipped code (`migrations/0008_thread_memory.sql`) found binding fields (`channel_type`, `channel_account_id`, `external_room_ref_hmac`, `business_id`) already live directly on `threads`, pinned for the row's life by `trg_threads_pin_identity` — there was never a separate table to restore. Identity-key rotation is recorded as an accepted stage-1 gap instead (design v0.3.5b §6.2, §19); a future rotation packet would need its own migration to extract a binding table, not a fix to `0008`. Id burned, not reused, per the plan's own identifier rule | — | — | superseded by design v0.3.5b §6.2 | cancelled |
| BL-MEMOS-101 | TASK-MEMOS-010 | `msp_ping` reports `identity_surface: "configured"\|"unconfigured"`; one stderr startup diagnostic when `MSP_IDENTITY_HMAC_KEY` is absent (design §6.2) | KIN | BL-MEMOS-020 | `msp_ping` contract case; startup log assertion | **Moved out of PH-MEMOS-2/GATE-MEMOS-2 to PH-MEMOS-7 (release hardening)**: confirmed against the shipped code that stage 1's `msp_ping` (`apps/msp-server/src/server.mjs:94`) returns only `{ok, timestamp}` today — `identity_surface` is not shipped, so it cannot be a stage-1 gate criterion | planned |
| BL-MEMOS-102 | TASK-MEMOS-002 | Consistency-trigger gaps confirmed against the shipped `0008`, corrected from an earlier, wrong table list (that list named `thread_bindings` and `exchanges`, neither of which exists — see BL-MEMOS-100's cancellation): `thread_summary_invalidations.tenant_id` is `NOT NULL` with **no default** in the `CREATE TABLE` (0008 is unshipped, so this is an ordinary edit, not a follow-up migration), a tenant-consistency trigger using `IS NOT` (not `<>`, which is not NULL-safe), a no-update/no-delete trigger, and **the reconciliation handler must change from `INSERT OR IGNORE` to `INSERT ... ON CONFLICT(summary_id) DO NOTHING`** so a forgotten `tenant_id` is refused loudly instead of `OR IGNORE` silently absorbing it the same way it absorbs a legitimate duplicate-insert (**diagnosis corrected, round four**: the old `DEFAULT ''` actually *refused* the mismatched insert via the trigger's `<>` comparison — it never succeeded silently; the real bug only exists once the column is `NOT NULL` and the handler is left on `OR IGNORE`); a `chat_sessions` `UPDATE` trigger barring `tenant_id`/`thread_id` from changing after insert, and (subject to `BL-MEMOS-033` proving every flow — rotation, reconciliation, idle sweep — preserves it) a `UNIQUE (thread_id) WHERE status = 'OPEN'` index stating "at most one `OPEN` session per thread," never a claim about `CLOSING`, since reconciliation legitimately leaves one `CLOSING` and one `OPEN` session on a thread at once; a `thread_messages` trigger checking `session_id`/`exchange_id`/`reply_to_message_id` all belong to the same `thread_id`; a `thread_participants` INSERT-time tenant-consistency trigger (had none at all); `session_compaction_jobs` gains an INSERT-time session-belongs-to-thread-and-tenant check plus an identity-pinning UPDATE trigger; the same session-belongs-to-thread check is added to `session_summaries` and `protected_memory_records` (design v0.3.5b §12.1). **Extended (RKOI stage-1 code review round 2 on code commit `95629e2` — KIN is adding these to `0008` directly):** an `exchange_id`-leading index supporting the `thread_messages` exchange-consistency trigger's own lookup; typed error codes for the `exchange_id` and `reply_to` triggers specifically (not a generic refusal), with **no foreign-tenant existence oracle** (the trigger's own error must not let a caller distinguish "wrong tenant" from "no such exchange/message" by its wording or code); `thread_summary_invalidations` rows fully immutable (no permitted `UPDATE` shape at all, not even a state/status column, since these are audit-only); a `thread_injection_receipts` trigger checking its own `exchange_id` belongs to its own `thread_id` (the same cross-consistency shape `thread_messages` already needs, applied here too); `threads` rows are not deletable (a `no_delete` trigger, matching every other table's convention); `thread_delivery_receipts.message_id` must reference an `OUTBOUND` message only, never `INBOUND` | KIN | BL-MEMOS-021 | mismatched-tenant insert refused on `thread_summary_invalidations` and `thread_participants`; an INSERT to `thread_summary_invalidations` omitting `tenant_id` is refused (the tenant-consistency trigger fires before the NOT NULL check, so assert refusal, not a specific NOT NULL message) and is not swallowed by `ON CONFLICT(summary_id) DO NOTHING`; post-insert `UPDATE` of `chat_sessions`/`session_compaction_jobs` identity columns refused; a second `OPEN` session on the same thread is refused (or, if left code-enforced pending `BL-MEMOS-033`'s proof, at least tested through the real process) while a `CLOSING` + `OPEN` pair on one thread is accepted; cross-thread `session_id`/`exchange_id`/`reply_to_message_id` insert refused on `thread_messages`, `session_summaries` and `protected_memory_records`, each with its own typed error and no tenant-existence signal leaked; a `session_compaction_jobs` row naming another thread's or tenant's session is refused; a `thread_summary_invalidations` row can never be updated by any statement shape; a `thread_injection_receipts` row naming an `exchange_id` of a different thread is refused; `DELETE FROM threads` is refused; a `thread_delivery_receipts` row naming an `INBOUND` message is refused; **a delivery reconciled after its session has already closed still succeeds, and the resulting invalidation row for that summary can be queried directly from the database** — not merely that the call itself succeeds (`tests/security/thread-memory-scoping.security.mjs`, design §15) | planned |
| BL-MEMOS-103 | TASK-MEMOS-002 | `dependency-boundaries.test.mjs` source-scans `packages/msp-contracts/src` for `.prepare(`, `.exec(`, `.pragma(` (W7, the structural C-2 proof) — **already shipped**, confirmed against `thread-access.mjs`'s own header comment describing this exact scan | GHOST | BL-MEMOS-025 | test fails if any of the three substrings appears | done |
| BL-MEMOS-108 | TASK-MEMOS-002 | An `UPDATE`-pinning trigger for `thread_injection_receipts`'s state machine (design v0.3.5b §9.3, §12.1) — confirmed against the shipped code that this transition is enforced in JS only (`thread-memory.mjs:1074-1092`), with no database trigger backstop, unlike every other content table's tombstone/status trigger. **The trigger must also pin `injection_id` itself**: a primary-key-only rewrite (state/version untouched) was accepted by a draft trigger that pinned every other column but not the key | KIN | BL-MEMOS-021 | a direct `UPDATE` bypassing the handler (e.g. `RESOLVED → COMPLETED` skipping `SUBMITTED`) is refused at the database layer; a bare `UPDATE ... SET injection_id = ?` with state/version unchanged is refused (`tests/security/thread-memory-scoping.security.mjs`) | planned |
| BL-MEMOS-109 | TASK-MEMOS-002 | **Widened again (RKOI round four, correcting round three's own "check when present" framing)** — zuri-ai's real delivery grant is exactly `{tenantId, businessId, channelAccountId, externalRoomRef, principalId, policyRevision, deliveryWriter}` — no `audienceKind`, no `channelType`, and the other five thread tools' grants always carry `audienceKind`. Fixes to `thread-guard.mjs`: (1) require `audienceKind` on `resolve`/`append`/`context`/`memory_record`/`injection_record`, refusing it when absent — not merely "check when present"; (2) `msp_thread_delivery_record` is the one named exemption from that requirement, scoped instead by the inbound message's own thread plus the room hash; if a delivery grant ever does carry `audienceKind` anyway it is still checked; (3) stop requiring a `channelType` claim on any grant, and re-derive the delivery scope check from exactly `tenantId`/`businessId`/`channelAccountId`/`externalRoomRef` (design v0.3.5b §6.1, §9.2, §13); (4) update `docs/API-011-THREAD-MEMORY-CONTRACT.md:54,196` and the `test:cross-zuri` harness's own header comment, both of which still describe the four-segment room hash | KIN | BL-MEMOS-020 | Acceptance test uses zuri's exact delivery claims (no `audienceKind`, no `channelType`) on **both** paths: a delivery record for a thread whose inbound message already exists succeeds, and a delivery record whose inbound message has not been seen yet stays correctly `pending`; missing `audienceKind` on any of the other five tools is refused. Also passes `npm run test:cross-zuri` with `MSP_TEST_ZURI_ROOT` set (BL-MEMOS-110) | planned |
| BL-MEMOS-110 | TASK-MEMOS-002 | **Reworded (RKOI round four): the script and the test already exist.** Make `npm run test:cross-zuri` (`tests/cross/zuri-thread-contract.test.mjs`) pass against a read-only extract of zuri-ai `origin/main` via `MSP_TEST_ZURI_ROOT`, and wire it into `GATE-MEMOS-2` — this item is about making it pass and gating on it, not building it from nothing | JANUS/GHOST | BL-MEMOS-020 | `npm run test:cross-zuri` passes in CI and locally against a real `MSP_TEST_ZURI_ROOT` extract; `GATE-MEMOS-2` names it explicitly | planned |
| BL-MEMOS-111 | TASK-MEMOS-002 | **New (RKOI round four): no backlog row previously covered this at all.** A call against an existing thread checks tenant, business and channel account, but not the room; `msp_session_compaction_claim` resolves its thread via `job_id` with no scope check of any kind. Fix: recompute the grant's own room hash (`tenant_id\|channel_account_id\|external_room_ref` under `MSP_IDENTITY_HMAC_KEY`) and compare it against the resolved thread's stored `external_room_ref_hmac` on **every** thread-bound call, including `claim`/`commit`/`retry` via the job's own thread — not only `resolve` and not only the tools that take a `thread_id`/`session_id` directly (design §6.3, §12.1, §15). **Widened (RKOI stage-1 code review round 2 on code commit `95629e2`) — CRITICAL on the code, KIN fixing it: the room claim itself must be required, not merely compared when present.** The shipped guard's check is gated `if (grant.externalRoomRef)`, so a grant with no room claim at all currently skips the comparison and passes on tenant/business/account alone. Fix: any thread-bound call whose grant lacks `externalRoomRef` or `channelAccountId` is refused `thread_scope_denied` outright — `context`, `append`, `memory_record`, `injection_record`, `delivery_record`, `claim`, `commit`, `retry`, and `sweep` | KIN | BL-MEMOS-021 | a grant scoped to room R1 is refused against a thread that only shares R1's tenant/business/channel-account, including via `claim`/`commit`/`retry`; a `claim` response never leaks a different room's `sources`; a grant with no room claim at all is refused on every one of the eight thread-bound tools listed above, not merely mismatched-but-refused (`tests/security/thread-memory-scoping.security.mjs`) | planned |

### PH-MEMOS-3 — Multi-agent (TASK-MEMOS-002 stage 2, SPR-MEMOS-03)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-040 | TASK-MEMOS-002 | Grant requires `agentId` and `workspaceId`; journal `actor = agentId` | KIN | BL-MEMOS-013, BL-MEMOS-033 | grant tests; journal scan | planned |
| BL-MEMOS-041 | TASK-MEMOS-002 | `thread_agents (thread_id, agent_id, workspace_id, tenant_id, joined_at, left_at)`: append-only, partial unique on the open row, tenant-consistency trigger; attached only when the calling agent's own resolve mints the thread (`created: true`) or its own grant carries `assertAgents` — never by resolving an existing thread with no assertion (design §8, fixing the self-attach defect RKOI found in the first design draft) | KIN | BL-MEMOS-040 | schema and trigger tests (design v0.3.5b §12.2, stage-2 migration, number assigned at merge per DEC-MEMOS-14) | planned |
| BL-MEMOS-042 | TASK-MEMOS-002 | Agent gate: only a current agent of the thread may append AGENT messages, read context, record injection/delivery, or claim/commit/retry compaction | KIN | BL-MEMOS-041 | BL-MEMOS-045 cases | planned |
| BL-MEMOS-043 | TASK-MEMOS-002 | Protected records gain `agent_id` and visibility `AGENT` or `THREAD` | KIN | BL-MEMOS-041 | visibility cases | planned |
| BL-MEMOS-044 | TASK-MEMOS-002 | Summaries shared among the thread's current agents; a departed agent loses reads on its next call | KIN | BL-MEMOS-042 | departure case | planned |
| BL-MEMOS-045 | TASK-MEMOS-002 | `tests/security/thread-agent-scoping.security.mjs`: agent B vs agent A records; departed agent; unattached agent; cross-tenant agent; compaction lease across agents | GHOST | BL-MEMOS-042..044 | suite green through the real process | planned |
| BL-MEMOS-046 | TASK-MEMOS-002 | API-011 contract update for agent fields; record the zuri-ai follow-up (grant must add `agentId`) against RSK-MEMOS-01 | KIN/ATHER | BL-MEMOS-040 | contract doc and schema; RSK-MEMOS-01 updated | planned |
| BL-MEMOS-047 | TASK-MEMOS-002 | RKOI review of stage 2; PR; merge | RKOI/COORD | BL-MEMOS-040..046, BL-MEMOS-048, BL-MEMOS-049 | APPROVED 0 critical; merged | planned |
| BL-MEMOS-048 | TASK-MEMOS-002 | Grant replay protection for every mutating thread tool except `msp_thread_message_append` (which keeps `source_event_id` idempotency): grant nonce recorded in a `grant_nonces` table, as the ADR specifies; a replayed nonce is refused | KIN | BL-MEMOS-040 | replayed-grant cases for record, injection, delivery, lifecycle and compaction tools | planned |
| BL-MEMOS-049 | TASK-MEMOS-002 | Optional per-tenant `MSP_THREAD_SERVICE_KEYRING` alongside the single-key default, as the ADR specifies; key selected by the grant's own unverified `tenantId` then verified; when configured, the single default key is disabled for every tenant; a tenant-A key can never verify a tenant-B grant | KIN | BL-MEMOS-040 | cross-tenant forged-grant case refused when the keyring is configured; single-key default unchanged; no fallback to the default once a keyring is set | planned |
| BL-MEMOS-104 | TASK-MEMOS-002 | Opportunistic `grant_nonces` pruning on insert (`DELETE ... WHERE tenant_id = ? AND expires_at < ?`), not dependent on the operator retention tick (RKOI ruling 3) | KIN | BL-MEMOS-048 | expired-row prune observed on a subsequent insert without a retention tick call | planned |

### PH-MEMOS-4 — Lifecycle, erasure, retention (TASK-MEMOS-003, TASK-MEMOS-004, SPR-MEMOS-04)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-050 | TASK-MEMOS-003 | Participant lifecycle tool: leave and relink under an explicit claim; closes the old membership; a new principal never inherits it | KIN | BL-MEMOS-047 | relink case | planned |
| BL-MEMOS-051 | TASK-MEMOS-003 | `msp_thread_agent_detach`: closes the calling agent's own `thread_agents` row (`left_at`); no mechanism to detach a *different* agent's identity, mirroring design §8 rule 2's "every attachment is the joining agent's own grant" — reconciled with design §13 (2026-09-14 revision) | KIN | BL-MEMOS-047 | detach case; `agent_not_current` on the very next call from the detached agent | planned |
| BL-MEMOS-052 | TASK-MEMOS-003 | Lifecycle security cases: relinked principal denied on the old (now-closed) DIRECT thread, including pre-departure history, and the new thread carries none of the old one's data; detached agent denied | GHOST | BL-MEMOS-050, BL-MEMOS-051 | `tests/security/participant-lifecycle-relink.security.mjs` — one suite file for every relink case, not split across `thread-memory-scoping`/`thread-agent-scoping` (design §15, RKOI review) | planned |
| BL-MEMOS-053 | TASK-MEMOS-004 | Principal erasure for thread tables: tombstone authored messages, receipt and pending-delivery text, records; summaries covering the principal go to redaction states; `erasure_receipts`; journal pseudonym only; idempotent by key | KIN | BL-MEMOS-050 | direct-database assertions after `close()`; tools blind | planned |
| BL-MEMOS-054 | TASK-MEMOS-004 | Retention tick for thread tables, operator-bound to its own tenant, `dry_run` supported | KIN | BL-MEMOS-053 | cross-tenant operator case refused | planned |
| BL-MEMOS-055 | TASK-MEMOS-004 | Principal export for thread data: own messages, own records, own view of summaries; self or `data_subject_admin` within the tenant | KIN | BL-MEMOS-053 | export contains only the principal's own material | planned |
| BL-MEMOS-056 | TASK-MEMOS-004 | `tests/security/thread-erasure.security.mjs`: direct-table and tool assertions; idempotency; export and erase cannot name another principal without the flag | GHOST | BL-MEMOS-053..055 | suite green | planned |
| BL-MEMOS-057 | TASK-MEMOS-003/004 | RKOI review; PR; merge | RKOI/COORD | BL-MEMOS-050..056 | APPROVED 0 critical; merged | planned |

### PH-MEMOS-5 — Principal vaults and API-010 (TASK-MEMOS-008, SPR-MEMOS-05/06)

| ID | Epic | Title | Owner | Depends | Proof | Status |
|---|---|---|---|---|---|---|
| BL-MEMOS-060 | TASK-MEMOS-008 | Principal vault types migration (number assigned at merge per DEC-MEMOS-14, not pre-bound to `0009`): directive rebuild of `vaults` in safe order; per-type owner CHECKs exempting erased rows; partial uniques on active rows; never-mountable INSERT and UPDATE triggers; `decay_policy` | JANUS/KIN | BL-MEMOS-057 | runner check passes; schema tests | planned |
| BL-MEMOS-061 | TASK-MEMOS-008 | `VaultRegistry`: principal branches ahead of the mount short-circuit; `isVaultAccessibleTo(vaultId, {workspaceId, agentId, tenantId, principalId, allowPassport})`; `mountVault` refuses principal types | KIN | BL-MEMOS-060 | registry tests; legacy callers unchanged | planned |
| BL-MEMOS-062 | TASK-MEMOS-008 | API-010 `msp_vault_resolve`: provisioning in one transaction; receipts to journal with `principal_hmac`; contract doc and `API-010.tools.json` | KIN | BL-MEMOS-061 | contract tests; same resolve returns the same vault | planned |
| BL-MEMOS-063 | TASK-MEMOS-008 | API-009 0.2.0 amendment: optional `access_context`, mandatory for principal vault types on all nine `msp_memory_*` tools (entity-id-only tools resolve entity → vault); `pinned` on decay tick | KIN/ATHER | BL-MEMOS-061 | `api-009-conformance.test.mjs`: absent ⇒ unchanged for legacy, denied for principal | planned |
| BL-MEMOS-064 | TASK-MEMOS-008 | Scoped `contexts` receipts: tenant/principal columns (own migration); context diff/audit/replay require a matching access context for scoped rows; `include_payload` refused for them | KIN | BL-MEMOS-062 | `context-tools-ownership.security.mjs` | planned |
| BL-MEMOS-065 | TASK-MEMOS-008 | Multi-agent vault rules: two agents serving one person get distinct episodic vaults; passport readable only with `allow_passport`; `global_private` agent vault never targeted by principal facts | KIN | BL-MEMOS-062 | vault multi-agent cases | planned |
| BL-MEMOS-066 | TASK-MEMOS-008 | Suites: `principal-vault-scoping`, `provenance-ids-are-not-owners`, decay pinned case, `shared-scope-fail-closed` extension | GHOST | BL-MEMOS-061..065 | suites green | planned |
| BL-MEMOS-067 | TASK-MEMOS-008 | Real-graph migration tests for the principal-vaults migration: fresh and populated 0001–0008 (plus whatever stage-2 migration has merged by then); child `REFERENCES` still name `vaults`; unexpected `vaults.status` row refused | JANUS | BL-MEMOS-060 | `migrate.test.mjs` cases (moved from WP-E0 per design v0.2.3b) | planned |
| BL-MEMOS-068 | TASK-MEMOS-008 | RKOI review; PR; merge | RKOI/COORD | BL-MEMOS-060..067, BL-MEMOS-105 | APPROVED 0 critical; merged | planned |
| BL-MEMOS-105 | TASK-MEMOS-008 | Cross-repo verification: read zuri-ai's `msp-vault-resolver.js` against the actual API-010 contract (fields, error codes, `allow_passport` handling) rather than assuming compatibility | RKOI/COORD | BL-MEMOS-062 | verification note recorded in the PR; mismatches filed as their own risk | planned |

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
| BL-MEMOS-087 | TASK-MEMOS-001 | Owner confirms or amends DEC-MEMOS-01..16; ADR status → accepted; amendments re-reviewed | OWNER/RKOI | BL-MEMOS-014 | ADR updated | planned |
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
| BL-MEMOS-106 | TASK-MEMOS-005 | zuri-ai's API-009 port sends `access_context` on `msp_memory_*` calls (design v0.2.3b §5.1) — required before a principal vault is usable in production | zuri-ai owner | BL-MEMOS-063 | zuri-ai PR; `api-009-conformance.test.mjs` case exercised against a real zuri-ai payload | deferred |
| BL-MEMOS-107 | TASK-MEMOS-005 | **Narrowed to stage-2 flags only** (`assertParticipants` is already shipped in stage 1 and needs no zuri-ai change — see BL-MEMOS-023): zuri-ai's signer starts sending `agentId`, `workspaceId` and a `nonce` on the grant, and sets `assertAgents` where design §8 requires it, once stage 2 exists (ADR `RSK-MEMOS-01`) | zuri-ai owner | BL-MEMOS-090 | zuri-ai PR; cross-repo acceptance test | deferred |

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
| DEC-MEMOS-07 | Migration order | **Corrected 2026-09-14 (DEC-MEMOS-14 supersedes the original wording):** `0008` is thread memory, stage 1 only. Migration numbers after `0008` are assigned in merge order, not pre-bound — the stage-2 multi-agent migration and the principal-vaults migration each get whatever number the runner assigns when they land, expected in that order per the phase plan but not guaranteed | BL-MEMOS-020, BL-MEMOS-041, BL-MEMOS-060 |
| DEC-MEMOS-08 | Thread memory vs vaults | Thread-scoped memory stays in thread tables; CONFIRMED items consolidate into principal vaults under the owner's context | BL-MEMOS-070 |
| DEC-MEMOS-09 | Caller `now` | Test-only (`MSP_TEST_CLOCK=1`) | BL-MEMOS-026 |
| DEC-MEMOS-10 | Extractive fallback | Not built; `coverageGap` is the mechanism | PH-MEMOS-6 |
| DEC-MEMOS-11 | Relink | A `DIRECT` thread whose person changes is closed; the channel binding mints a new thread for the new principal; binding uniqueness is `ACTIVE`-scoped only; the new principal inherits no history | BL-MEMOS-022, BL-MEMOS-050 |
| DEC-MEMOS-12 | First membership | The first `HUMAN` membership is created by a `HUMAN` append whose `speaker_id === grant.principalId`; `resolve` carries no `participants` field; every other participant change requires `assertParticipants` | BL-MEMOS-023 |
| DEC-MEMOS-13 | Package placement | The thread store stays in `msp-core`; no separate `msp-thread-memory` package | BL-MEMOS-025 |
| DEC-MEMOS-14 | Agent timing | Stage 1 (`0008`) has no `thread_agents`, no required `agentId`, no record `agent_id`/`visibility`, no `grant_nonces`; stage 2 adds them in its own later migration | BL-MEMOS-040, BL-MEMOS-041, BL-MEMOS-048 |
| DEC-MEMOS-15 | Assurance self-upgrade needs no claim | A later append's `PENDING → VERIFIED` is accepted with no `assertParticipants` only when `speaker_id === grant.principalId`, `speaker_kind === HUMAN`, `person_id ∈ {null, grant.principalId}` for both the value sent and the stored participant row, and the row is that principal's own current membership; the upgrade closes the old row (`left_at`) and inserts the new VERIFIED row in one transaction, because the append-only trigger allows only `left_at` to change; `VERIFIED → PENDING` is silently ignored, not stored and not refused; every other change still needs `assertParticipants`; MSP's row stays VERIFIED after zuri-ai de-verifies someone, so until the lifecycle tool exists revocation relies on zuri-ai no longer setting `readPrivate` | BL-MEMOS-023 |
| DEC-MEMOS-16 | `channel_type` mismatch on resolve | **New (RKOI stage-1 code review round 2 on code commit `95629e2`).** A `msp_thread_resolve` whose `channel_type` differs from the `channel_type` already stored on the existing `ACTIVE` thread for the same tenant, account and room hash is refused with the typed `conflict` error — it never returns the other channel's thread, and never mints a second thread for the same `(tenant_id, channel_account_id, external_room_ref_hmac)` triple either. Replaces the design's earlier claim (§6.2) that the same tenant/account/room-hash triple "names the same room regardless of which transport label a given call happens to carry" — that claim was wrong on its own terms. The room hash stays three segments (no `channel_type` added to it); `channel_type` remains a pinned column on `threads` (`trg_threads_pin_identity`) | BL-MEMOS-021, GATE-MEMOS-2 |

Two earlier open design questions carry over and are tracked as risks rather than defaults, because no recommendation was agreed: tombstone retention horizon (design v0.2.3b §19.7) and identity key presence at startup (§19.8). A third, new one: whether `grant_nonces` should move into `0008` instead of stage 2, closing the stage-1 nonce gap RKOI's ruling 3 and DEC-MEMOS-14 leave open together (design §19).

## 7. Risks

| ID | Risk | Likelihood / impact | Mitigation | Owner |
|---|---|---|---|---|
| RSK-MEMOS-01 | Multi-agent and the corrected design require several zuri-ai wire changes before any activation: (1) `agentId` and `workspaceId` become **required** grant fields in stage 2; (2) a `nonce` is required on every mutating call except append once `grant_nonces` exists; (3) `assertAgents` must be set to join a thread the caller's agent did not create; (4) **a caller for `close_for_relink` — still a real, open cross-repo change**, zuri-owned, on the activation gate (RKOI round two, reaffirmed round three). **The mechanism, stated directly here (RKOI round four — previously only pointed at from the ADR and design §19 without actually being recorded in this row): a zuri-ai account merge into an existing Person changes that Person's `personId`. The next append from the merged account passes DEC-MEMOS-12's first-membership check (§7 rule 2), but the thread's *lifetime* single-`HUMAN` trigger (§6.3) still refuses a second distinct `HUMAN` speaker on that `DIRECT` thread. Every later append from the merged account then fails closed until `BL-MEMOS-092`'s relink caller exists — and the merged Person never inherits the old thread's history in the meantime, by design (DEC-MEMOS-11).** (5) **the assurance-upgrade caller — corrected (RKOI round three): resolved MSP-side by DEC-MEMOS-15, no zuri-ai change needed for the normal case.** `assertParticipants` itself is already shipped in stage 1 for the cases DEC-MEMOS-12/15 cover; **the blanket sentence previously here claiming it "needs no zuri-ai change" is removed**, because it read as contradicting items 4 and 5 above — items 4 and 5 are about *separate* callers (relink, and the pre-DEC-MEMOS-15 upgrade path), not about `assertParticipants` itself. None of these renames or reshapes a field zuri-ai already sends on the six frozen calls. | certain / medium | Full list also recorded in `docs/ADR-MSP-MEMORY-OS-MULTI-USER-MULTI-AGENT.md`'s "Cross-repo changes stage 2 requires of zuri-ai"; tracked as BL-MEMOS-046 (agentId), BL-MEMOS-048 (nonce), BL-MEMOS-107 (agentId/workspaceId/nonce/assertAgents, one zuri-ai PR), BL-MEMOS-092 (item 4, the relink/merge caller zuri-ai owns); item 5 needs no BL id — DEC-MEMOS-15 closes it; no activation until then (PH-MEMOS-8 deferred) | COORD |
| RSK-MEMOS-02 | Adopted defaults overturned by the owner after implementation | low–medium / high for DEC-MEMOS-01, -02, -07, -12, -15 | Confirmation requested early (BL-MEMOS-014); nothing merged past PH-MEMOS-2 changes a shipped migration without review | COORD/OWNER |
| RSK-MEMOS-03 | **Still open after round four's docs approval — an approved design is not the same as a verified implementation.** Design v0.3.0b and the stage-1 code diverged (RKOI's round-one review, 3 criticals). Design v0.3.1b was rebuilt from RKOI's prose description of the branch's shapes but still did not match the shipped code on several wire values (round-two review, commit `92cb591`). Design v0.3.2b read `feat/memos-002-thread-memory` directly — and round three (commit `6d1a801`) *still* found one wrong value (the delivery grant's real claim set), because v0.3.2b's fix reasoned about what a delivery grant would plausibly need rather than reading zuri-ai's actual signer directly. Design v0.3.3b/v0.3.4b read zuri-ai's real signer code directly for that claim, and round four (commit `1c4a62f`) approved the docs with 0 critical — but a cross-room scope gap with no backlog row at all (`BL-MEMOS-111`) still surfaced in the same round, on the code side. **This risk stays open, not closed, until `BL-MEMOS-033`'s own code review closes it** — repeated rounds of prose/inference-vs-code drift is exactly the failure mode this risk names, and a docs approval does not retire it. **Stage-1 code review round 2 (commit `445bd90`) proves the point again**: the docs-approved room-hash comparison (`BL-MEMOS-111`, folded into v0.3.4b/v0.1.4b) turned out to be insufficient on the shipped code itself — comparing the hash when present is not the same as requiring it be present at all — found only by reading `thread-guard.mjs` directly, not by re-reading the design. | medium / medium | Design v0.3.5b reads the shipped code directly (`thread-guard.mjs`), not an inference about it; `BL-MEMOS-033` (now also running `BL-MEMOS-110`'s cross-repo contract test against a real `origin/main` extract, and depending on `BL-MEMOS-111`) is the actual closing event, not a design revision | RKOI |
| RSK-MEMOS-04 | Migration 0008 lands and is later found wrong; checksum-locked lineage needs a corrective migration | low / high | Real-graph fresh and populated tests (BL-MEMOS-032); RKOI gate before merge; nothing past 0007 has shipped yet | JANUS |
| RSK-MEMOS-05 | A single all-tenant `MSP_THREAD_SERVICE_KEY`; capability flags are unverified Tier-1 claims | certain / high if transport widens | Trust boundary stays stdio-only (design §13.1); any network transport re-opens the design | RKOI |
| RSK-MEMOS-06 | Tombstoned rows kept indefinitely may not satisfy a tenant's PDPA position | unknown / medium | Owner question carried from design §19.7; resolve before GATE-MEMOS-7 | OWNER |
| RSK-MEMOS-07 | Identity key absent at startup leaves the thread and vault surfaces dark without a loud signal | medium / medium | Design §6.2 default (startup diagnostic, `msp_ping` report, opt-in fail-closed boot); resolve before GATE-MEMOS-7 | OWNER |
| RSK-MEMOS-08 | zuri-ai roadmap ids and revisions move fast (#379, #381, #382 each collided with PR #380) | high / low | Fetch and rebase immediately before any zuri-ai push; TASK-MEMOS family kept separate from TASK-ZAI | COORD |
| RSK-MEMOS-09 | **New (RKOI stage-1 code review round 2 on code commit `95629e2`).** A delivery record naming a foreign tenant's `thread_pending_deliveries.receipt_id` answers differently from one naming an unused `receipt_id` — a cross-tenant existence oracle. Low severity (it leaks only that some `receipt_id` exists somewhere, not its content), but real, and left open pending KIN's own fix on the code side | low / low | Named here and in design §15 rather than silently accepted; random rather than sequential `receipt_id`s are the stated mitigation until KIN closes it — if KIN reports it closed, ATHER updates this row and design §15 to match | KIN |
| RSK-MEMOS-10 | **New (RKOI stage-1 code review round 2 on code commit `95629e2`).** API-011's `outputSchema` (`API-011.tools.json`) is enforced by a contract test only, never at runtime — a handler bug producing a malformed response is not caught server-side, only by the test suite | low / low | Named here and in design §15; contract-test coverage is the current mitigation; runtime `outputSchema` validation is not scheduled against any gate yet | RKOI |

## 8. Traceability

| Epic (zuri-ai roadmap) | Phases | Backlog items |
|---|---|---|
| TASK-MEMOS-001 | PH-MEMOS-1, PH-MEMOS-7 | BL-MEMOS-010..014, BL-MEMOS-087 |
| TASK-MEMOS-002 | PH-MEMOS-2, PH-MEMOS-3 | BL-MEMOS-020..033, BL-MEMOS-040..049, BL-MEMOS-100 (cancelled), BL-MEMOS-102..104, BL-MEMOS-108..111 |
| TASK-MEMOS-003 | PH-MEMOS-4, PH-MEMOS-8 | BL-MEMOS-050..052, BL-MEMOS-057, BL-MEMOS-092 |
| TASK-MEMOS-004 | PH-MEMOS-4, PH-MEMOS-8 | BL-MEMOS-053..057, BL-MEMOS-093 |
| TASK-MEMOS-005 | PH-MEMOS-8 | BL-MEMOS-090, BL-MEMOS-091, BL-MEMOS-106, BL-MEMOS-107 |
| TASK-MEMOS-006 | PH-MEMOS-8 | BL-MEMOS-094 |
| TASK-MEMOS-007 | PH-MEMOS-8 | BL-MEMOS-095 |
| TASK-MEMOS-008 | PH-MEMOS-5 | BL-MEMOS-060..068, BL-MEMOS-105 |
| TASK-MEMOS-009 | PH-MEMOS-6 | BL-MEMOS-070..075 |
| TASK-MEMOS-010 | PH-MEMOS-0, PH-MEMOS-7 | BL-MEMOS-002..005, BL-MEMOS-080..086, BL-MEMOS-088, BL-MEMOS-101 |

The zuri-ai roadmap orders the epics for the LINE agent: 001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010. This plan re-sequences them for an MSP-only build. Vaults (008) come before consolidation (009). Erasure is split: thread tables in PH-MEMOS-4, and vault extension in PH-MEMOS-6. The channel epics 005–007 are deferred. The epic ids and their meaning are unchanged.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.5b | 2026-09-15 | proposed | Folds RKOI's stage-1 code review round 2 (commit `445bd90`, spec items against the docs, not a docs re-review). **Widened `BL-MEMOS-111`, CRITICAL on the code, KIN fixing it**: the shipped guard's room-hash comparison only runs `if (grant.externalRoomRef)`, so a grant with no room claim at all currently skips the check and passes on tenant/business/account alone; fixed to require the claim outright (`thread_scope_denied` when absent) on all eight thread-bound tools plus `sweep`; added the "no room claim" case to `GATE-MEMOS-2`'s bullet list and `BL-MEMOS-111`'s acceptance column. Added **DEC-MEMOS-16** (a `channel_type` mismatch against an existing `ACTIVE` thread's stored value, same tenant/account/room hash, is refused `conflict`, replacing the design's "regardless of transport label" claim) to the decisions table, `GATE-MEMOS-2`, `BL-MEMOS-014`'s checklist and `BL-MEMOS-010`; updated every live `DEC-MEMOS-01..15` reference to `01..16`. Extended **`BL-MEMOS-102`** with six more schema items KIN is adding to `0008` directly: an `exchange_id`-leading index, typed errors with no foreign-tenant existence oracle on the `exchange_id`/`reply_to` triggers, `thread_summary_invalidations` fully immutable, an injection's `exchange_id`-belongs-to-its-thread check, `threads` not deletable, and delivery receipts referencing `OUTBOUND` messages only. Corrected §9.2's `msp_session_sweep` claim from "stays tenant-scoped" to room-scoped (confirmed against `thread-guard.mjs:274-280`, which overwrites `channel_account_id`/`external_room_ref` from the grant same as `tenant_id`/`business_id`) and added sweep's own "no room claim" refusal case to `GATE-MEMOS-2`. Replaced the wrong "`BL-MEMOS-033` confirms zuri-ai's worker grant carries `audienceKind`" claim with the fact that zuri-ai has no `msp_session_*` caller at all (confirmed against `origin/main@1ddccb70`) — the only worker is MSP's own `thread-summary-worker.mjs`. Added **RSK-MEMOS-09** (foreign-tenant `receipt_id` existence oracle on `thread_pending_deliveries`, low severity, KIN may close it) and **RSK-MEMOS-10** (`outputSchema` enforced by a contract test only, never at runtime) as named stage-1 gaps, tracked rather than silently accepted. Updated `BL-MEMOS-012`'s round-tracking row, `RSK-MEMOS-03` (the room-claim gap is exactly the prose/inference-vs-code drift this risk names, found only by reading `thread-guard.mjs` directly), and every stale `v0.3.4b`/`v0.1.4b` "current version" pointer in this plan to `v0.3.5b`/`v0.1.5b`, while leaving historical CHANGELOG and round-tracking text describing what earlier rounds actually said unchanged. No id renumbered or reused. | working-tree | ATHER |
| 0.1.4b | 2026-09-15 | proposed | Folds RKOI's nine round-four warnings (docs **APPROVED, 0 critical**, commit `1c4a62f`) ahead of merge. Added **`BL-MEMOS-111`**: the room-hash check must run on every thread-bound call including `claim`/`commit`/`retry` via the job's own thread — a cross-room gap with no prior backlog row, since `msp_session_compaction_claim` had no scope check of any kind. Made it a `BL-MEMOS-033` dependency and added a `GATE-MEMOS-2` bullet. Corrected `BL-MEMOS-102`'s `thread_summary_invalidations` diagnosis (the old `DEFAULT ''` refused the mismatched insert via the trigger, it did not succeed silently; the real bug is `INSERT OR IGNORE` swallowing a `NOT NULL` violation once the column is `NOT NULL`, fixed by `ON CONFLICT(summary_id) DO NOTHING` and an `IS NOT` comparison) and added the "at most one `OPEN` session per thread" invariant (never a claim about `CLOSING`, conditional on `BL-MEMOS-033` proving every flow preserves it). Rewrote `BL-MEMOS-021` (no `thread_bindings` table to restore — contradicted `BL-MEMOS-100`'s own cancellation) and `BL-MEMOS-023` (assurance upgrade per DEC-MEMOS-15, not "only via the lifecycle tool"); scanned `BL-MEMOS-020..033` as a block and fixed stale `v0.3.1b`/`v0.3.2b` version pins. Changed `BL-MEMOS-109`'s audience rule from "check only when present" to **`audienceKind` required on every thread tool except `msp_thread_delivery_record`**, per owner direction; added the `docs/API-011-THREAD-MEMORY-CONTRACT.md:54,196` and cross-test-header update to its scope. Reworded `BL-MEMOS-110`: the script and the test already exist, this item is about making `test:cross-zuri` pass and gating `GATE-MEMOS-2` on it. Stated the `personId`-change lock-up mechanism directly in `RSK-MEMOS-01`'s own row (previously only pointed at from elsewhere without actually being recorded there). Named suite files on `GATE-MEMOS-4/5/6`. Removed every citation of RKOI's session-scratch probe scripts as evidence, replacing each with the finding itself or the backlog item whose acceptance test proves it. No id renumbered or reused. | working-tree | ATHER |
| 0.1.3b | 2026-09-14 | proposed | Answers RKOI's round-three NEEDS REVISION on commit `6d1a801` (1 critical). Added **DEC-MEMOS-15** (assurance self-upgrade needs no `assertParticipants` under four conditions; a downgrade is silently ignored) to the decisions table. Widened **BL-MEMOS-109** to cover both the audience-check skip and the removal of the `channelType` grant requirement, with an acceptance test using zuri-ai's exact delivery claims on both the inbound-already-seen and inbound-not-yet-seen paths, plus `npm run test:cross-zuri`. Added **BL-MEMOS-110** (the `tests/cross/zuri-thread-contract.test.mjs` cross-repo harness itself, reading a real `origin/main` extract via `MSP_TEST_ZURI_ROOT`) and made it a dependency of `BL-MEMOS-033` and `BL-MEMOS-109`. Extended **BL-MEMOS-102** with the additional consistency-trigger gaps RKOI's probes found (`thread_summary_invalidations.tenant_id` NOT NULL with no default, not a `DEFAULT ''`; `session_compaction_jobs`/`session_summaries`/`protected_memory_records` session-belongs-to-thread checks; a `thread_participants` tenant trigger that never existed; a delivery-reconcile-after-session-close acceptance case) and **BL-MEMOS-108** (the injection trigger must also pin `injection_id` itself, not only the other columns). Rewrote **RSK-MEMOS-01**: removed the sentence claiming `assertParticipants` "needs no zuri-ai change" (it contradicted items 4 and 5); item 5 (assurance-upgrade caller) is now stated as resolved MSP-side by DEC-MEMOS-15 with no BL id needed; item 4 (relink/merge caller) is unchanged and mapped to the existing zuri-owned `BL-MEMOS-092`. Kept **RSK-MEMOS-03** open — three rounds of prose/inference-vs-code drift, not two. Fixed `GATE-MEMOS-1`'s stale "design v0.3.0b" reference and `GATE-MEMOS-7`'s stale "`DEC-MEMOS-01..10`"; named concrete suite files (`thread-memory-scoping.security.mjs`, `thread-agent-scoping.security.mjs`) on `GATE-MEMOS-2`/`GATE-MEMOS-3`. No id was renumbered or reused; `BL-MEMOS-100` remains cancelled. | working-tree | ATHER |
| 0.1.2b | 2026-09-14 | proposed | Answers RKOI's round-two NEEDS REVISION on commit `92cb591` (1 critical, plus checks and warnings). Read the shipped stage-1 code (`feat/memos-002-thread-memory`) directly. **Cancelled BL-MEMOS-100** (`thread_bindings` restoration) — the shipped `0008` never had a separate binding table to restore; binding columns already live on `threads`, and identity-key rotation is an accepted stage-1 gap (design v0.3.2b §6.2), not something BL-MEMOS-100 could have fixed. Corrected BL-MEMOS-102's table list (it wrongly named `thread_bindings`/`exchanges`, neither of which exists) to the real gaps: `thread_summary_invalidations`'s missing `tenant_id`, `chat_sessions`'s missing UPDATE-pin trigger, and `thread_messages`'s missing cross-table consistency checks. Marked BL-MEMOS-103 `done` (already shipped) and moved BL-MEMOS-101 (`msp_ping`) out of GATE-MEMOS-2 into PH-MEMOS-7, confirmed against the code that stage 1's `msp_ping` does not report `identity_surface`. Added BL-MEMOS-108 (injection state-machine trigger) and BL-MEMOS-109 (delivery audience-check exemption — a real refusal bug in the shipped guard) as newly confirmed code gaps. Narrowed BL-MEMOS-107 to stage-2 flags only, since `assertParticipants` is already shipped. **Reopened RSK-MEMOS-03**, since this is the second round in which a design revision did not match the shipped code — closed only when `BL-MEMOS-033`'s own code review closes it, not by a design revision. Extended RSK-MEMOS-01's tracked list with the relink and assurance-upgrade callers RKOI asked be added. Pointed `participant-lifecycle-relink.security.mjs` at BL-MEMOS-052 explicitly, consolidating relink cases into one suite file rather than splitting them. | working-tree | ATHER |
| 0.1.1b | 2026-09-14 | proposed | Answers RKOI's NEEDS REVISION on commit `2f4d584` (3 critical findings, all in the ADR/design pair, plus warnings and new decisions touching this plan directly). Added DEC-MEMOS-11..14 to the decisions table and corrected DEC-MEMOS-07's migration-order wording (numbers assigned at merge, not pre-bound to `0009`, per DEC-MEMOS-14). Rewrote RSK-MEMOS-01 with the full cross-repo change list (`agentId`/`workspaceId` required, `nonce`, `assertAgents`, `assertParticipants`) and closed RSK-MEMOS-03 as resolved (the design/code divergence it warned about is exactly what RKOI's review caught). Added BL-MEMOS-012 as an explicit dependency of BL-MEMOS-021..024, 029 and 030, and updated those items' descriptions to match the corrected design. Added BL-MEMOS-100..107 (numbering convention extended to 100+ where a phase's block was already full, per the amended §2): `thread_bindings`/rotation, `msp_ping` identity-surface diagnostic, tenant-consistency triggers, the contracts no-SQL structural test, opportunistic nonce pruning, cross-repo verification of zuri-ai's `msp-vault-resolver.js` against API-010, and the two zuri-ai-side cross-repo changes (API-009 `access_context`, and the full grant-shape/nonce/assertion changes). Reconciled BL-MEMOS-051's agent-detach wording with design §8/§13. Updated the traceability table for all of the above. | working-tree | ATHER |
| 0.1.0b | 2026-09-14 | proposed | Initial implementation plan PLAN-MSP-MEMOS: identifier scheme; nine phases PH-MEMOS-0..8 with gates GATE-MEMOS-0..8; sprints SPR-MEMOS-00..09+; backlog BL-MEMOS-001..096 (including BL-MEMOS-048 grant nonces and BL-MEMOS-049 per-tenant keyring from the ADR) mapped to epics TASK-MEMOS-001..010; decisions DEC-MEMOS-01..10 as adopted defaults pending confirmation; risks RSK-MEMOS-01..08; channel activation deferred by owner direction. | working-tree | Claude Opus 5 |

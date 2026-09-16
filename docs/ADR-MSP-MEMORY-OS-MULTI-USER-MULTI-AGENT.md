---
version: "0.1.17b"
created_at: "2026-09-14T10:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-16T09:00:00+07:00,ATHER"
status: "proposed"
superseded_by: null
attributes:
  domain: "mission-state-protocol"
  doc_type: "architecture-decision"
  scope: "reconciling the unmerged codex/msp-thread-memory branch with the session/episodic design into one multi-user, multi-agent API-011 memory surface"
---

# ADR-MSP-MEMORY-OS-MULTI-USER-MULTI-AGENT

## Status

Proposed. Nothing here is merged and no code changes. This ADR records ten
reconciliation decisions between two pieces of prior work that did not know
about each other, adopts RKOI's recommended default for each, and specifies
the multi-user/multi-agent model neither piece of prior work fully covered.
**The owner confirmed decisions 1–21 (DEC-MEMOS-01..21) on 2026-09-14** (see the
checklist below). RKOI's four rulings on the judgement calls were confirmed by
the owner on 2026-09-14 as well. **`DEC-MEMOS-22..35`, added in the PH-MEMOS-4
(participant lifecycle, erasure, retention, export) revision (`34`/`35` added
in the RKOI-review-response round), were confirmed by the owner on
2026-09-15** ("ยืนยัน"), the same way `17..21` were confirmed on 2026-09-14.
**All thirty-five of those decisions are confirmed by the owner.**
**`DEC-MEMOS-36..48`, added in this revision (PH-MEMOS-5 scoping,
2026-09-16), are new adopted defaults and are NOT yet confirmed** — the
owner-confirmation checklist below marks them unchecked. This ADR
authorizes design work, not a merge — merge still waits on the owner's own
explicit instruction to proceed.

## Revision note — RKOI NEEDS REVISION (2026-09-14)

RKOI reviewed commit `2f4d584` and returned **NEEDS REVISION with 3
critical findings** against the first version of this ADR and its
companion design. All three were about the design's DDL and wire shapes,
not this ADR's decision list directly, and are fixed in
`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.3.1b §0.1: (1) migration
0008 did not apply (a `CHECK` used a forbidden subquery); (2) the design's
tool shapes broke this ADR's own decision 2 by inventing camelCase,
nested-grant, renamed fields instead of using the branch's actual frozen
shapes; (3) any agent could attach itself to any thread via resolve. This
ADR is amended to: correct the C-2 citation (below), record RKOI's rulings
on the four judgement calls this ADR previously raised on its own
authority, add four new adopted defaults (DEC-MEMOS-11..14), and list the
cross-repo wire changes stage 2 will require of zuri-ai.

## Revision note — RKOI round two, NEEDS REVISION (2026-09-14)

RKOI reviewed commit `92cb591` and returned **NEEDS REVISION, 1 critical**:
this document and its companion design still described wire values
(`operation`, `expiresAt`, `direction`) that never matched what KIN's
now-existing stage-1 code (`feat/memos-002-thread-memory`) actually
implements, and an incomplete injection-receipt state machine. The design
is corrected against the shipped code directly
(`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.3.2b §0.1); this ADR is
corrected in two places RKOI named specifically: ruling 1's wording below
(new required grant fields are a **cross-repo change to negotiate**, not
"out of bounds" as if MSP could simply refuse them), and the cross-repo
change list, which gains the assurance-upgrade and relink callers RKOI
asked be recorded next to `agentId`/`workspaceId`/`nonce`.

## Revision note — RKOI round three, NEEDS REVISION (2026-09-14)

RKOI reviewed commit `6d1a801` and returned **NEEDS REVISION, 1 critical**:
zuri-ai's real `msp_thread_delivery_record` grant
(`msp-thread-memory-port.js:420-422`, `origin/main`) carries neither
`channelType` nor `audienceKind` — its exact claim set is `{ tenantId,
businessId, channelAccountId, externalRoomRef, principalId,
policyRevision, deliveryWriter }`. The design's previous fix invented a
`channelType` claim that never existed on either side of the wire. Owner
direction is option (a): drop `channel_type` from the room HMAC entirely
and stop requiring `channelType` on any grant — corrected in
`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.3.3b §0.1, §6.1, §6.3,
§9.2 and §13. This ADR adds **DEC-MEMOS-15** (the assurance self-upgrade
rule) below, and corrects the cross-repo change list: the
`assertParticipants`-needs-no-zuri-ai-change sentence is removed because
it read as contradicting the relink and assurance-upgrade items on the
same list; the assurance-upgrade item is now stated as resolved MSP-side
by DEC-MEMOS-15 (no zuri-ai change needed for the normal case), and the
relink item is unchanged — it still needs a zuri-ai-side caller and stays
on the activation gate.

## Revision note — RKOI round four, APPROVED with 9 warnings (2026-09-15)

RKOI reviewed the docs at commit `1c4a62f` and **approved them with 0
critical findings**, asking that nine warnings be folded in before merge —
the first round that is not a rejection. The warning most relevant to this
ADR: **DEC-MEMOS-15 needed tightening** (design §7 rule 2 corrected to
check the *stored* participant row's `person_id`, not only the incoming
value, and to state plainly that the self-upgrade closes the old row and
inserts a new one in one transaction — not an implementation choice, since
the append-only trigger permits nothing else). This ADR's decision 15 and
owner checklist item 15 are updated to match. Also folded in: the
`RSK-MEMOS-01` cross-repo list now states the `personId`-change lock-up
mechanism directly in the risk row itself (previously only pointed at from
here without actually being recorded there); every citation of RKOI's
session-scratch probe scripts is removed from the evidence map, since
those files were never part of this repository. A cross-room authorization
gap with no prior backlog row (`BL-MEMOS-111`, design §6.3/§12.1/§15) was
also found in this round, on the code side rather than this ADR's own
content.

## Revision note — RKOI stage-1 code review round 2 (2026-09-15)

RKOI's second round of reviewing the stage-1 code itself (not the docs)
produced spec items feeding back into these documents at commit `445bd90`.
Most directly relevant to this ADR: **decision 16, `channel_type`
mismatch, is new** (below) — a resolve whose `channel_type` disagrees with
an existing `ACTIVE` thread's stored value, for the same tenant/account/
room hash, is refused `conflict` rather than silently treated as the same
room. This corrects the design's own earlier, wrong claim (§6.2) that the
tenant/account/room-hash triple alone made two calls "the same room
regardless of transport label." Also confirmed: `msp_session_sweep` is
room-scoped, not tenant-scoped (the shipped guard overwrites its room
claims from the grant just as it does tenant/business); zuri-ai has no
`msp_session_*` caller at all — the only worker signing these grants is
MSP's own `thread-summary-worker.mjs`. Every `DEC-MEMOS-01..15` reference
in this ADR is updated to `01..16`.

## Revision note — PH-MEMOS-3 stage-2 (multi-agent) spec (2026-09-15)

Owner direction, 2026-09-14: proceed with the next planned work. This
revision scopes stage 2 (multi-agent, `TASK-MEMOS-002` stage 2) in full
for the first time, so KIN can implement `BL-MEMOS-040..046`, `048` and
`049` against a single specification and RKOI can review it — most of
the actual DDL/grant/tool-surface detail lives in the design
(`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.4.0b §6.1.1, §8, §9.4,
§12.2), per this ADR's own "what this ADR does not decide" boundary; this
ADR adds only the two new decisions that boundary still requires an
owner-facing record of. **`DEC-MEMOS-17`, new**: stage 2 has no zuri-ai
compatibility flag — zuri-ai's current grant fails closed the moment
stage-2 verification ships, since channel activation is already gated
behind `BL-MEMOS-090`. **`DEC-MEMOS-18`, new**: the worker signs as the
thread's own agent for `claim`/`commit`/`retry` (agent-currency on the
job's thread required), not a dedicated gate-exempt role; `sweep` alone
is exempt from "current" but still requires `agentId`/`workspaceId`
present. **`DEC-MEMOS-01` through `DEC-MEMOS-16` were confirmed by the
owner on 2026-09-14** ("ยืนยัน", commit `214a7d2`) — every citation of
them in this revision's new text describes a confirmed decision;
`DEC-MEMOS-17`/`18` remain adopted defaults pending owner confirmation,
exactly as `01..16` were before that date. Checklist gains items 17–18;
the cross-repo change list gains `DEC-MEMOS-17`'s "no compatibility
flag" note directly on the `agentId`/`workspaceId`/`nonce` items it
qualifies.

## Revision note — RKOI stage-2 review round 1, NEEDS REVISION 2 critical (2026-09-15)

RKOI reviewed the stage-2 spec at commit `f74ad0d`: **NEEDS REVISION, 2
critical**; §12.2's schema itself passed as written (applies fresh and
populated, no table rebuilt, every `0008` trigger kept). **`DEC-MEMOS-18`
revised**: the worker attaches via `assertAgents` rather than being
exempt from the agent gate outright, never mints a thread from a
worker-only grant (`not_found` if the room has none), and — correcting
a wrong claim in the prior revision — its access is **not** revoked by
"ending its `thread_agents` row" (detach is self-only and reversible);
real revocation is Tier 1 withholding grants or a key rotation. **Two
new decisions promoted from unnumbered design prose**: `DEC-MEMOS-19`
(default record `visibility` is `THREAD`) and `DEC-MEMOS-20` (nonce:
≥128 random bits, ≤128 chars, keyed `(tenant_id, nonce)`, 200-row
bounded prune). The cross-repo change list gains the 128-random-bit
nonce requirement directly on its own item, and a new item: zuri-ai's
outbound append's `agentId` must match the `speakerId: 'zuri-line-agent'`
it already sends, under design §8.2's `AGENT`-speaker rule. The two
criticals themselves (delivery's pending path bypassing the agent gate;
`AGENT`-visibility records leaking through dedup and supersession) are
entirely design-level fixes with no ADR-level decision attached — see
`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.4.1b §8.2, §9.4, §12.2,
§15.

## Revision note — RKOI stage-2 review round 2, APPROVED 0 critical (2026-09-15)

RKOI **APPROVED** the stage-2 spec at commit `72e593f`, with warnings to
fold before KIN implements. **Supersession answer unified**: round 1's
own `thread_scope_denied` fix for the cross-agent case was itself found
to be a third, distinguishable oracle value; the owner-direction ruling
collapses all three cases (unknown id, another agent's `AGENT`-visibility
record, and the pre-existing stage-1 ownership/status failure) into one
identical `validation_failed` answer with a single fixed message —
including the stage-1 `conflict` case, which stage 2 now also answers
this way. **New decision**: `DEC-MEMOS-21` (`agentId`/`workspaceId`
bounded at 128 characters, no further charset constraint), promoted
from unnumbered design prose. Every other finding this round (pending
delivery's stored agent now immutable via a second drop+recreate
trigger; the drain re-check's correct target thread; both delivery
paths' real `speaker_id`; the nonce recorded on every resolve outcome;
two wording corrections; `msp_session_sweep`'s new `thread_kind`/
`channel_type` response fields; the `GATE-MEMOS-2`/`3` cross-zuri flip)
is entirely design/plan-level, with no further ADR decision attached —
see `DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.4.2b §8.2, §8.3,
§9.2, §9.4, §12.2, §13, §14, §15.

## Revision note — PH-MEMOS-4 (participant lifecycle, erasure, retention,
export) spec, fully scoped (2026-09-15)

Mirrors how PH-MEMOS-3 (multi-agent) was scoped: design §7 rule 7 and §11
previously only sketched `msp_thread_participant_lifecycle` (`leave`,
`close_for_relink`) and thread-table erasure/retention/export as
"forward-looking; no tool exists yet." This revision specifies both in
full — new design §7.1 (lifecycle tool), §8.6 (`msp_thread_agent_detach`),
§11.2 (erasure/retention/export), §12.3 (the `erasure_receipts` DDL), §13
and §15 — so KIN can implement `BL-MEMOS-050..056` against one
specification and RKOI can review it, per this ADR's own "what this ADR
does not decide" boundary (most DDL/grant/tool-surface detail stays in
the design, not here).

**`DEC-MEMOS-22`, new**: `msp_thread_participant_lifecycle`'s `leave`
action always requires `assertParticipants`, whether it names the
caller's own `speaker_id` or another current `HUMAN` participant's — no
narrower self-service exception, since this is an explicit administrative
call Tier 1 chooses to make, not the frozen resolve→append flow's own
default path. `leave` never closes the thread itself (only `status`
transitions do that); a `DIRECT` thread's last `HUMAN` leaving is an
accepted, permanent consequence of the existing single-`HUMAN`-for-life
trigger, not something `leave` tries to fix.

**`DEC-MEMOS-23`, new**: `close_for_relink` is `DIRECT`-only, gated by
`assertParticipants` **plus** a distinct new boolean grant claim,
`assertRelink` — never `operator`. Both claims together close the current
`HUMAN` participant row and transition `threads.status` `ACTIVE →
CLOSED` in one transaction, reusing the already-shipped
`trg_threads_status_close_only`/`trg_thread_participants_append_only`
triggers with no schema change. The relink claim carries no new
principal id — DEC-MEMOS-11's existing mechanism (a fresh `thread_id`
minted for the new principal on its own later `resolve`) is unchanged.

**`DEC-MEMOS-24`, new**: `msp_thread_agent_detach` needs no grant claim
beyond the universal `agentId`/`workspaceId` — the existing generic
thread-bound agent-currency gate (design §8.2) already guarantees the
call is self-scoped and already answers "not attached" with
`agent_not_current` before the handler ever runs, so there is no
third-party-detach case to gate and no separate "not attached" case to
handle in the tool itself.

**`DEC-MEMOS-25`, new — resolves this ADR's own open "`data_subject_admin`:
role or flag?" question (see "What this ADR does not decide," corrected
below).** Cross-principal erasure/export authority is **two new grant
capability flags, not a Membership role**: `dataSubjectAccess` (base
capability required on every self-service call to
`msp_thread_principal_erase`/`msp_thread_principal_export`) and
`dataSubjectAdmin` (additive, required only when the request names a
`principal_id` other than `grant.principalId`) — mirroring the
`assertParticipants`+`assertRelink` double-gate precedent decision 23
sets.

**`DEC-MEMOS-26`, new**: tool names are `msp_thread_principal_erase`,
`msp_thread_principal_export` and `msp_thread_retention_tick`. Retention
reuses the existing `operator` capability exactly like the `msp_session_*`
worker tools already do, via an explicit name check in the guard rather
than a prefix match, since its name does not share their `msp_session_`
prefix (it operates on thread tables, not compaction jobs).

**`DEC-MEMOS-27`..`33`, new — erasure/retention/export mechanics**: a
caller-supplied idempotency key (1–128 chars, scoped `(tenant_id,
idempotency_key)`, mirroring `nonce`'s own bound) makes a same-principal
replay return the stored receipt unchanged and a different-principal
replay under the same key `conflict`; `erasure_receipts` stores the raw
`principal_id` like every other content table (W5 pseudonymization stays
scoped to the journal entry, not this table); retention for this phase is
one deployment-wide `MSP_THREAD_RETENTION_DAYS` horizon (no per-tenant
policy table yet), `dry_run`-capable, reusing erasure's own tombstone
mechanism but age-based and principal-agnostic, bounded to 200 rows per
table per call (reusing `DEC-MEMOS-20`'s existing bound); export excludes
every tombstoned row, including the exporting principal's own erased
content, so erasure's guarantee is not undermined by a parallel read
path; export is always principal-scoped regardless of `visibility`/agent,
since `visibility` governs agent-to-agent confidentiality, not the data
subject's own access right; erasure/export's per-table selection
operationalizes design §11.1 exactly (own `speaker_id` for messages,
asserter-or-subject for records, and — corrected, `DEC-MEMOS-34`,
CRITICAL 2/3 — sole-ever-`HUMAN`-participant-scoped, not merely
"current-participant-at-call-time," for session summaries;
`thread_delivery_receipts` follows the same `DEC-MEMOS-34` test, and
`thread_pending_deliveries` is out of erasure's scope entirely,
CRITICAL 4 item 2); and naming a `principal_id` that has
never appeared in the tenant's data succeeds trivially with a zero-count
receipt or empty export, never `not_found`, so as not to add a new
cross-principal existence oracle alongside the already-accepted
`RSK-MEMOS-09` family. Full detail: design §11.2, §12.3.

**No new error codes.** Every refusal above reuses stage 1/2's existing
vocabulary — `thread_scope_denied` for every missing claim,
`not_found` for a `leave` target with no open row, `thread_scope_denied`
for `close_for_relink` on a non-`DIRECT` thread, `conflict` for a
mismatched-principal idempotency replay — design §14.

**No new `RSK-MEMOS` id.** Every risk this revision's mechanisms touch is
already tracked: `RSK-MEMOS-01` (updated below with the relink caller's
exact claim shape), `RSK-MEMOS-05` (capability-flag trust boundary,
already general enough to cover the two new flags), `RSK-MEMOS-06`
(tombstone retention horizon — `BL-MEMOS-054` is a partial, uniform-horizon
mitigation, not a full close; its mitigation note is updated, not
duplicated) and `RSK-MEMOS-09` (existence-oracle family — decision 33 is
designed to avoid adding to it, not to create a new one).

## Revision note — RKOI PH-MEMOS-4 review, NEEDS REVISION 4 critical
(2026-09-15)

RKOI reviewed the PH-MEMOS-4 spec above and returned **NEEDS REVISION,
4 critical.** Full detail for each lives in the design's own
correspondingly-updated sections (§7 rule 2, §11.1, §11.2, §12.3, §15,
§19); this note records only the decision-level consequences, per this
ADR's own "what this ADR does not decide" boundary.

- **CRITICAL 1 — `leave` did not stick.** The shipped stage-1
  `thread-guard.mjs` decides its claim-free "first membership" branch by
  asking whether a *current* (`left_at IS NULL`) participant row exists,
  which is also true immediately after `leave` closes one — so a
  departed principal's very next `HUMAN` append silently re-created
  membership through the same claim-free path `DEC-MEMOS-12` exists for,
  no `assertParticipants` needed. **`DEC-MEMOS-12` is restated, not
  replaced**: the claim-free path applies only to a genuine first-ever
  join (no `thread_participants` row for this thread+speaker at all,
  current or departed) — a rejoin is an ordinary participant change and
  needs `assertParticipants` like any other. This is a fix to
  already-shipped `main` code, tracked as new **`BL-MEMOS-058`**, not a
  new decision requiring the owner's confirmation on its own — it
  corrects the implementation to match what `DEC-MEMOS-12`'s own text
  already said ("the first `HUMAN` membership").
- **CRITICAL 2/3 — erasure and export leaked or destroyed other
  principals' content on `GROUP`/`ROOM` threads.** Both bugs shared one
  root cause: `session_summaries`/`thread_delivery_receipts`
  disposition used a thread-level "current-or-departed participant of
  the thread" test, not a principal-level one, so a shared group record
  was scooped in or excluded based on one member's request regardless of
  who actually authored it. **New `DEC-MEMOS-34`** (below) restricts both
  tools' summary/delivery-table disposition to threads where the calling
  principal is the thread's sole-ever `HUMAN` participant — a
  conservative default that under-erases a group-shared summary rather
  than risk destroying or leaking another principal's content.
- **CRITICAL 4 — erasure both over-claimed and under-delivered, plus
  unstated ordering.** (a) `protected_memory_records.scope_json` was
  never blanked by `0009`'s shipped tombstone trigger, though it can
  carry personal content same as `body_json` — fixed by a trigger
  replacement in the new migration (below), not by editing `0009` (it is
  merged and checksum-locked). (b) `thread_pending_deliveries` has no
  `thread_id` column and holds `AGENT`-authored reply text, not the
  principal's own, with no reliable attribution key at all — removed
  from erasure's scope entirely, correcting design §11.1's disposition
  table and plan `BL-MEMOS-053`'s row to match. (c) The departed-principal
  disposition criterion is restated as "ever a `HUMAN` participant of a
  `DEC-MEMOS-34`-qualifying thread," not "current at erasure time." (d)
  The transaction order is now specified exactly: resolve every matching
  row set first, then tombstone, then close `thread_participants` rows
  last, all in one transaction. **Corrected in round 2 below (WARNING
  1): the `DEC-MEMOS-34` query as actually specified has no `left_at`
  filter, so this ordering does not change today's result — it is kept
  as defense in depth for a future `left_at`-filtered query, not because
  today's disposition depends on it.**

**New decisions this round — `DEC-MEMOS-34`/`35`, adopted defaults
pending owner confirmation, same status as `22..33`:**

- **`DEC-MEMOS-34`, new**: erasure/export summary and delivery-table
  disposition is restricted to threads where the principal is, across
  the thread's *entire* participant history, its only-ever `HUMAN`
  participant — `DIRECT` threads, and the rare `GROUP`/`ROOM` thread that
  has in fact never had a second `HUMAN`. A `GROUP`/`ROOM` thread with
  more than one distinct `HUMAN` `person_id`/`speaker_id` ever is left
  untouched by erasure and excluded entirely from export for those two
  tables — not filtered, not redacted, just not touched or returned.
  Stated plainly as a conservative default: it under-erases a
  group-shared summary rather than risk destroying or leaking another
  principal's content; scrubbing one person's contribution out of a
  shared summary is out of scope for this phase — design §11.1, §11.2.
  **Revised, round 2 below (CRITICAL 2, WARNING 4): gains a second,
  independent ANDed condition (no disqualifying `UNKNOWN`/`OPERATOR`
  message anywhere on the thread), and the `HUMAN`-participant condition
  is now two separate counts (`speaker_id`, and separately non-null
  `person_id`), either of which disqualifies.**
- **`DEC-MEMOS-35`, new**: `msp_thread_retention_tick`'s `dry_run: true`
  is fully read-only — it consumes no nonce; `dry_run: false`
  is unchanged (consumes a nonce, journals normally) — design §11.2.
  **Revised, round 2 below (WARNING 6): `dry_run: true` now also writes a
  journal entry, like `dry_run: false` does — only the nonce exemption
  remains dry-run-specific.**

**New backlog item, code fix — `BL-MEMOS-058`** (not a `DEC-MEMOS` id;
this is an implementation correction, not an owner-facing decision):
`thread-guard.mjs`'s first-membership query changes from "no current
row" to "no row at all" for this thread+speaker — plan §5, PH-MEMOS-4.
**Revised, round 2 below (CRITICAL 1 still open): re-specified as an
explicit three-way branch, not a modified condition on the existing
two.**

**New migration, not a `0009` edit — `migrations/0010_erasure_receipts.sql`
(provisional name, `DEC-MEMOS-14`'s merge-order rule)**: since `0008`
and `0009` are merged to `main` and checksum-locked, CRITICAL 4 item (a)'s
fix (dropping and recreating `trg_protected_memory_records_update_guard`
to also permit `scope_json → '{}'` on the tombstone branch) ships as a
new, additive migration alongside the already-planned `erasure_receipts`
table — an additive trigger replacement, not a table rebuild. KIN may
need to renumber this file if another migration merges first — design
§12.3. **This migration requires `0009`, not merely `0008` (round 2,
WARNING 7) — its trigger body references `agent_id`/`visibility`, which
`0009` adds; the migration's own header comment now states this
dependency explicitly.**

**Cross-repo change list, owner-confirmation checklist, and
`GATE-MEMOS-4` are all updated to match** — see below and the plan's own
revision.

## Revision note — RKOI PH-MEMOS-4 review round 2, NEEDS REVISION 2
critical (2026-09-15)

RKOI reviewed the round-1 response above and returned **NEEDS REVISION,
2 critical — both subtler than round 1.** Full detail lives in the
design's own correspondingly-updated sections (§7 rule 2, §11.1, §11.2,
§14, §15, §19); this note records only the decision-level consequences.

- **CRITICAL 1, still open — round 1's fix was under-specified.** "The
  first-branch decision changes from 'no current row' to 'no row at all'"
  reads as a one-line condition swap, and RKOI implemented it both
  literal ways: a bare swap dereferences `current.personId` on a `null`
  `current` and throws; a null-hardened swap instead falls into
  `DEC-MEMOS-15`'s self-upgrade exception, whose only gate
  (`storedPerson !== null && ...`) a departed rejoin trivially satisfies
  (`storedPerson === null`), silently re-admitting the rejoin with **no
  claim at all** — the exact bug this correction exists to close. **The
  real fix is a third, distinct branch, not a modified condition on the
  existing two.** `thread-guard.mjs`'s logic now has three cases: (1)
  never participated (unchanged fast path); (2) participated before, none
  current — a rejoin, which **unconditionally** requires
  `assertParticipants` and **never** reads `current` at all, since
  `current` is `null` by this case's own definition, and **never** falls
  through to `DEC-MEMOS-15`; (3) a current row exists — today's existing
  logic, unchanged. `BL-MEMOS-058`'s own description and its four
  required test cases are restated against this exact branch structure.
- **CRITICAL 2, new — `DEC-MEMOS-34` leaked through `UNKNOWN`/`OPERATOR`
  messages.** The sole-ever-`HUMAN` qualifying query reads
  `thread_participants` only, but `HUMAN` is the only `speaker_kind` that
  ever gets a participant row at all — `OPERATOR`/`UNKNOWN` speakers post
  messages with none (confirmed against `API-011.tools.json`, which
  accepts `speaker_kind: 'UNKNOWN'` on append, and the guard's
  participant-creation logic, which runs only for `speaker_kind ===
  'HUMAN'`). A `GROUP` thread with exactly one sole-ever `HUMAN`
  participant, but also a message from an unresolved second person tagged
  `UNKNOWN`, therefore qualified and leaked that speaker's content into
  both erasure-exemption and export — RKOI's probe reproduced this
  directly, and it is the normal state for an unresolved LINE group
  member, not an edge case. **`DEC-MEMOS-34` gains a second, independent,
  ANDed disqualifying condition** (design §11.2's own `EXCEPT`-based SQL):
  no `thread_messages` row with `speaker_kind NOT IN ('HUMAN', 'AGENT')`
  anywhere on the thread. `AGENT` stays excluded (the assistant's own
  generated reply, not another principal's content); `UNKNOWN`/`OPERATOR`
  do not, since either could represent an unresolved real person.

**Warnings folded in**: the ordering rationale (round 1's CRITICAL 4 item
d, above) was factually wrong for the query as actually specified — no
`left_at` filter means both orderings produce an identical result, which
RKOI's probe confirmed directly; rewritten as defense in depth for a
future `left_at`-filtered query, and the acceptance test replaced with a
property test of both orderings rather than the withdrawn false claim.
The `dry_run` acceptance criterion ("row counts unchanged") could not
distinguish a dry run from a live pass, since both use `UPDATE`, never
`DELETE` — replaced with a `redaction_state`-count and content-column
assertion. The `close_for_relink`/in-flight-append race's remaining raw
`SQLITE_BUSY_SNAPSHOT` interleaving is now explicitly re-mapped to a typed
`conflict` by the store's write path (design §14). The `speaker_id`/
`person_id` disqualifying check is now two separate counts, either of
which disqualifies, not one `speaker_id`-only count as the prior
revision's SQL actually implemented despite its own prose. `RSK-MEMOS-06`
gains a stated consequence, not a new id: once a sole-ever-`HUMAN` thread
later gains a second `HUMAN`, that principal's own solo-era content
becomes permanently non-erasable/non-exportable by this phase's tools —
a real limitation, not merely a scope note. `DEC-MEMOS-35`'s no-journal
half is withdrawn — `dry_run: true` still consumes no nonce, but now also
writes a journal entry, since `msp_thread_context`'s no-journal precedent
does not transfer to a tenant-wide, unbounded-without-a-nonce read.
`migrations/0010`'s header now states its dependency on `0009` explicitly.

**No new `DEC-MEMOS`/`BL-MEMOS`/`RSK-MEMOS` id this round** — every
change above revises `DEC-MEMOS-34`/`35`, `BL-MEMOS-058`/`059` and
`RSK-MEMOS-06` in place; consistency re-checked, no duplicates.

## Revision note — RKOI PH-MEMOS-4 review round 3, NEEDS REVISION 1
critical (2026-09-15)

RKOI reviewed the round-2 response and returned **NEEDS REVISION, 1
critical, plus 5 narrow warnings.** The critical was specifically against
this ADR's own decision-record paragraphs, not the design: decisions 34
and 35's paragraphs above (in "the thirty-five decisions") still carried
text withdrawn two rounds ago, even though the owner-confirmation
checklist and this document's own round-2 revision-note summary were
already correct. Both paragraphs are now rewritten to match the design's
current §11.1/§11.2/§19 text exactly.

- **CRITICAL, decisions 34 and 35's own paragraphs were stale.**
  Decision 34's paragraph stated only the single sole-ever-`HUMAN`
  condition, missing the second, ANDed `speaker_kind` condition
  `DEC-MEMOS-34` gained in round 2 (CRITICAL 2) — rewritten above to state
  both conditions explicitly. Decision 35's paragraph still carried the
  no-journal claim round 2's WARNING 6 withdrew — rewritten above to state
  that both `dry_run` arms write a journal entry, and only the nonce
  exemption remains dry-run-specific.

**Warnings folded in (design-level; no further ADR decision text
attached, per this document's own "what this ADR does not decide"
boundary)**: (1) named, in the design's §7 rule 2/§7.1 and §15, that the
three-way branch's rejoin case (case 2) is keyed on `speakerId` alone, so
a caller with `assertParticipants` can re-attach a *different*, departed
third party to a `GROUP`/`ROOM` thread — an intended, defensible
consequence of the branch, confined to `GROUP`/`ROOM` since `DIRECT`
already refuses a second `HUMAN` by schema, added as `BL-MEMOS-052`'s
fifth required case; (2) narrowed the `close_for_relink` race's error
mapping (design §7.1, §14, §15) from any `SQLITE_BUSY`-prefixed code to
exactly `SQLITE_BUSY_SNAPSHOT`, the only code this race raises — a plain
`SQLITE_BUSY` from an unrelated lock timeout is not remapped by this rule
and propagates as an untyped driver error; (3) named the `dry_run: true`
journal write's own accepted tradeoff (design §11.2, §19): with no nonce,
that write is itself unbounded, an operator-gated but real consequence,
and the second stated exception to RKOI ruling 3's "nonce on every
mutating tool except append" pattern (append's `source_event_id`
idempotency was the first); (4) added the missing "first-**ever**"
qualifier to §13's `msp_thread_message_append` row, matching §7 rule 2's
three-way branch; (5) bumped the plan's stale `design v0.5.1b` citation on
`BL-MEMOS-050` to the current version, and expanded `BL-MEMOS-052`'s test
list to name all five required branch cases plus the raw-SQLite-error
assertion.

**No new `DEC-MEMOS`/`BL-MEMOS`/`RSK-MEMOS` id this round** — this round
corrects prose to match already-adopted decisions; it adopts nothing new.

## Revision note — PH-MEMOS-5 (principal vaults, API-010, API-009 `access_context` amendment) spec (2026-09-16)

This revision scopes PH-MEMOS-5 (`TASK-MEMOS-008`, `BL-MEMOS-060..068`/
`105`) in full for the first time — a design pass only, no code, and not
yet reviewed by RKOI. It adds **`DEC-MEMOS-36..48`** below (thirteen new
adopted defaults, **pending owner confirmation** — unlike decisions
22–35, nothing in this range has been confirmed as of this revision) and
the corresponding checklist rows, all unchecked. Full technical
specification lives in
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.6.0b §5–§5.5,
§12.4–§12.4.1; this ADR records only the decision paragraphs and the
cross-repo change list, per its own "what this ADR does not decide"
boundary (below).

The single most load-bearing piece of this revision is `BL-MEMOS-105`'s
cross-repo read: zuri-ai already ships a real `msp_vault_resolve` caller
(`msp-vault-resolver.js`, `origin/main@4ca28c1d`), and it does **not**
match a "clean" extension of API-011's own signed-grant model — it sends
no `grant`/`signature` at all, has no `allow_passport` concept, and
requires a `project_id` field with no principal-vault meaning. Every one
of these is resolved **additively** in `DEC-MEMOS-40`/`41`/`42` below,
never by silently designing something the shipped caller cannot call —
the full verification table is design §5.3.1. One genuine gap remains and
is filed as its own item rather than assumed away: `BL-MEMOS-113`
(`DEC-MEMOS-48`), zuri-ai's own `validateVaultSet` must be updated before
the new response fields are actually usable — deferred to `PH-MEMOS-8`
alongside `BL-MEMOS-106`/`092`/`093`, consistent with the owner's
2026-09-14 direction that channel activation stays parked.

Also corrected in this revision: the owner-confirmation checklist's item
7 named a placeholder migration number (`0009`) for principal vaults,
written before `0009`/`0010` actually merged as `thread_agents`/
`erasure_receipts`. The underlying decision (`DEC-MEMOS-07`/`14`:
migration numbers are assigned in merge order, never pre-bound) is
**not** reopened — only the stale example number in the checklist's own
prose is corrected to the concrete number this revision actually assigns
(`0011`, `DEC-MEMOS-37`), the same way `BL-MEMOS-060`'s own row in the
plan has always phrased it.

## Context

Two independent efforts exist for MSP's thread/session/memory surface, and
neither was written with the other in view:

1. **`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`** (v0.2.3b on `main`,
   RKOI-approved with zero criticals as of its own three review rounds) is a
   from-scratch design: MSP-minted thread ids, instance leases, one open
   session per thread, MSP-assigned event ordering, LLM-summarized episodes
   with an extractive fallback, and consolidation into `principal_private` /
   `principal_passport` vaults. It shipped **zero code** — every table,
   tool and invariant in it is, by its own §20, "a proposal until its work
   packet lands with the suite that proves it."
2. **The unmerged branch `origin/codex/msp-thread-memory`** (commits
   `50859fb`, `e4303cb`) independently **built** a thread/session/memory
   surface, labelled `API-010` on the branch (colliding with the name
   zuri-ai's ADR-022 already reserves for `msp_vault_resolve`). It ships ten
   tools — six calls zuri-ai is expected to make
   (`msp_thread_resolve`, `msp_thread_message_append`,
   `msp_thread_memory_record`, `msp_thread_context`,
   `msp_thread_injection_record`, `msp_thread_delivery_record`) and four
   worker tools for asynchronous session compaction
   (`msp_session_sweep`, `msp_session_compaction_claim`,
   `msp_session_compaction_commit`, `msp_session_compaction_retry`) — behind
   a signed, capability-flagged grant (HMAC-SHA256 keyed by
   `MSP_THREAD_SERVICE_KEY`), and two migrations (branch `0008`/`0009`)
   implementing `threads`, `thread_participants`, `chat_sessions`,
   `thread_messages`, `protected_memory_records`,
   `session_compaction_jobs`, `session_summaries`,
   `thread_delivery_receipts`, `thread_pending_deliveries`,
   `thread_injection_receipts` and `thread_summary_invalidations`.

RKOI's clause-by-clause comparison of the branch against the design, and a
line-by-line security review of the branch's own code, found:

- **C-1 (critical):** a second person can join a `DIRECT` thread and read
  the first person's private transcript and protected records, reachable
  four ways (any signed append creates/updates a participant row; a
  `DIRECT` thread accepts any number of humans; `speaker_kind: UNKNOWN`
  bypasses the `HUMAN` check; a `PENDING` speaker can re-append to
  self-upgrade to `VERIFIED`) — plus a `protected_memory_records` row whose
  `subject_person_id` names someone else is injected into *that other
  person's* context, reachable when a channel account is relinked to a
  different Person.
- **C-2 (critical):** the branch's authorization guard in `msp-contracts`
  runs SQL to answer "is this speaker a current verified participant" —
  the same layering violation `vault-scope-guard.mjs`
  (`packages/msp-contracts/src/contracts/vault-scope-guard.mjs:22-33`) was
  built to avoid: it takes a precomputed boolean from a DB-backed registry
  and never touches SQL itself. **Correction (RKOI, 2026-09-14):** an
  earlier version of this ADR cited a `thread-scope-guard.mjs` as if it
  already existed alongside `vault-scope-guard.mjs`; no such file exists
  in this repository. The fix is a **new** file,
  `packages/msp-contracts/src/contracts/grant-scope-guard.mjs`, to be
  created following exactly `vault-scope-guard.mjs`'s pattern (design
  §16).
- A dozen warnings: caller-supplied `now` (lease theft), independent
  (unchecked) `thread_kind`/`audience_kind`, an unbound record subject, no
  erasure path against blanket tombstone-forbidding triggers, raw
  `external_room_ref` and raw person ids in the append-only journal,
  globally- rather than tenant-scoped uniqueness (existence leak), a
  replayable grant with no nonce, one all-tenant service key with
  unverified capability flags, plain-string errors, and private memory
  living entirely outside the vault model that is otherwise MSP's whole
  product. Only one security test exists for any of it.
- Both branch migrations pass `main`'s structural foreign-key runner check
  as they stand; neither rebuilds a table anything else references.

**Owner direction (2026-09-14):** "Don't connect LINE OA yet; make MSP
complete, supporting multi user and multi agent." The owner has not yet
adjudicated the ten reconciliation questions this collision raises. This
ADR adopts RKOI's recommended default for each so design work can proceed,
and marks every one of them explicitly overturnable.

## Decision

### The thirty-five decisions

Each began as an adopted default. **The owner confirmed all sixteen on
2026-09-14.**

1. **API-010 stays `msp_vault_resolve`** (zuri-ai ADR-022's name). The
   branch's thread/session/memory surface is renamed **API-011** wherever
   it is specified or implemented. — *confirmed by the owner, 2026-09-14.*
2. **The branch's six zuri-ai-facing tool names and business wire shapes
   are canonical.** No request or response field zuri-ai sends on
   `msp_thread_resolve`, `msp_thread_message_append`,
   `msp_thread_memory_record`, `msp_thread_context`,
   `msp_thread_injection_record` or `msp_thread_delivery_record` may
   change. (The signed `access` envelope that wraps every call is MSP's own
   authorization envelope, not a zuri-ai business field, and may grow — see
   "Judgement calls" below.) — *confirmed by the owner, 2026-09-14.*
3. **Instances and the agent leg from design §7 are dropped for server
   channels.** A LINE/web/CLI worker never opens an MSP-tracked instance
   lease to reach a thread; the signed per-room grant, checked against a
   `thread_agents` relation (below), is the recorded relation between an
   agent and a thread. — *confirmed by the owner, 2026-09-14.*
4. **MSP provides a participant lifecycle tool** (leave / relink) gated by
   an explicit claim, so a relinked or merged Person cannot silently
   inherit another Person's membership (closing the scenario behind C-1's
   `subject_person_id` leak). Wiring zuri-ai or Zuri to call it is deferred
   to a later packet — the tool exists in this design; nothing calls it
   yet. — *confirmed by the owner, 2026-09-14.*
5. **Erasure must exist before any channel activation.** No LINE OA
   connection work starts until a principal's thread-scoped data
   (messages, protected records, summaries, delivery text) can be
   tombstoned end to end. — *confirmed by the owner, 2026-09-14.*
6. **External room refs are stored as HMAC at rest**, never raw, which
   makes `MSP_IDENTITY_HMAC_KEY` a hard requirement of the thread surface
   (design §6.2's existing rotation and fail-closed rules apply unchanged).
   — *confirmed by the owner, 2026-09-14.*
7. **Delivery order: thread memory first.** The branch's `0008`+`0009` are
   folded into one corrected migration, shipped as root migration **0008**,
   containing **stage 1 only** (no agent fields, no `grant_nonces` — see
   DEC-MEMOS-14). **Correction (RKOI, 2026-09-14):** the rest of this
   decision as first written — "principal vault types follow as `0009`" —
   is wrong: DEC-MEMOS-14 requires migration numbers after `0008` to be
   assigned in actual merge order, not pre-bound. Principal vault types
   ship whenever their phase merges, under whatever number the runner
   assigns then, expected (but not guaranteed) to be *after* the stage-2
   multi-agent migration given the plan's phase order. — *confirmed by the owner, 2026-09-14.*
8. **Thread-scoped memory stays in thread tables.** Protected records and
   session summaries are not vault rows. A `CONFIRMED` protected record
   later *consolidates* into the relevant principal's vault, under that
   principal's own access context only (the same authority rule as design
   §9.1, generalized) — never written directly by a thread-scoped write. —
   *confirmed by the owner, 2026-09-14.*
9. **Caller-supplied `now` is test-only on every tool** — never a
   production input — closing the lease-theft warning without removing the
   fake-clock testability the rest of the design already depends on. —
   *confirmed by the owner, 2026-09-14.*
10. **No extractive fallback.** When no summary covers a stretch of
    messages, the response carries a `coverageGap` marker; MSP never
    fabricates or truncates a stand-in summary. — *confirmed by the owner, 2026-09-14.*
11. **DEC-MEMOS-11, relink closes the thread.** A `DIRECT` thread whose
    channel account is reassigned to a different Person is **closed**; the
    channel binding then mints a **new** thread for the new principal.
    Binding uniqueness is scoped to `ACTIVE` bindings only, so the same
    external ref can be re-bound the instant the old thread closes. The
    lifetime single-`HUMAN` trigger stays; the new principal never
    inherits the old thread's history, because it is a different
    `thread_id` entirely. — *confirmed by the owner, 2026-09-14.*
12. **DEC-MEMOS-12, first membership by append.** zuri-ai's frozen flow is
    resolve, then a `HUMAN` append — `msp_thread_resolve` carries no
    `participants` field. The first `HUMAN` membership of a thread is
    created by the first `HUMAN`-kind append whose `speaker_id ===
    grant.principalId`, bound to the grant's own principal rather than
    asserted by the caller. Every other participant creation or change
    requires `grant.assertParticipants === true`. `AGENT` speakers are
    never participants. — *confirmed by the owner, 2026-09-14.*
13. **DEC-MEMOS-13, package placement.** The thread/session/protected-record
    store stays in `msp-core`, where the branch and stage 1 already put it
    — no separate `msp-thread-memory` package. An earlier draft of the
    design proposed one; it is withdrawn. — *confirmed by the owner, 2026-09-14.*
14. **DEC-MEMOS-14, agent timing and migration numbering.** Stage 1
    (`0008`) has no `thread_agents`, no required `agentId`, no record
    `agent_id`/`visibility`, and no `grant_nonces`. Stage 2 adds all of
    these in its own later migration. Migration numbers after `0008` are
    assigned in merge order — this corrects decision 7's original
    "principal vaults = `0009`" wording, which pre-bound a number this
    decision says must not be pre-bound. — *confirmed by the owner, 2026-09-14.*
15. **DEC-MEMOS-15, assurance self-upgrade needs no claim.** A later
    append's `PENDING → VERIFIED` transition is accepted with no
    `assertParticipants` only when `speaker_id === grant.principalId`,
    `speaker_kind === HUMAN`, `person_id ∈ { null, grant.principalId }` on
    the **incoming request**, **and (tightened, RKOI round four) the
    *stored* current membership row's own `person_id` is likewise `∈ {
    null, grant.principalId }`** — checking only the incoming value would
    let a row whose stored `person_id` already names someone else slip
    through on a claim-free append. The membership updated must be that
    principal's own current row, and **the transition is a mandatory
    close-old-row-plus-insert-new-row in one transaction, not an
    implementation choice** — the append-only trigger permits only
    `left_at NULL → NOT NULL`, so there is no `UPDATE` path by which
    `identity_assurance` could change in place at all. A later append's
    `VERIFIED → PENDING` is silently ignored, never stored and never
    refused — which also means MSP's own participant state does not
    implement revocation: if zuri-ai later de-verifies this person, MSP's
    row simply stays `VERIFIED`, and the only actual protection is zuri-ai
    no longer setting `readPrivate` for them. Every other assurance or
    membership change still requires `assertParticipants`. This exists
    because zuri-ai sends `identity_assurance: VERIFIED` with `person_id =
    principalId` the instant a user is verified
    (`server-line-answer.js:186-199`), on an ordinary follow-up append
    that structurally cannot carry `assertParticipants` — without this
    rule a `DIRECT` thread becomes permanently unwritable past first
    verification. **Open risk, stated directly in `RSK-MEMOS-01`'s own
    row (not only pointed at from here)**: if zuri-ai's
    `principal.personId` itself changes at verification (rather than
    staying equal to the existing `principalId`) — for example an account
    merge into an existing Person — the lifetime single-`HUMAN` trigger
    locks the thread until the relink caller (item 4 of the cross-repo
    change list below) exists. — *confirmed by the owner, 2026-09-14.*
16. **DEC-MEMOS-16, `channel_type` mismatch is a typed conflict, never a
    silent cross-channel hit.** The room hash's three segments
    (`tenant_id`, `channel_account_id`, `external_room_ref`) alone do not
    distinguish two different channels that happen to share an account id
    and room reference. **This replaces an earlier claim in the design
    (§6.2) that the same tenant/account/room-hash triple "names the same
    room regardless of transport label"** — that claim was wrong on its
    own terms. The rule: a `msp_thread_resolve` whose `channel_type`
    differs from the `channel_type` already stored on the existing
    `ACTIVE` thread for the same tenant, account and room hash is refused
    with the typed `conflict` error; it never returns the other channel's
    thread. The room hash itself is unchanged (still three segments, no
    `channel_type`), and `channel_type` remains a pinned column on
    `threads` — this decision adds an independent mismatch check at
    resolve time, not a fourth hash segment. — *confirmed by the owner, 2026-09-14.*

**Decisions 1 through 16 above were confirmed by the owner on
2026-09-14** ("ยืนยัน"), recorded on this branch at commit `214a7d2`.
Decisions 17–21 below were added during stage-2 scoping (v0.1.7b–v0.1.9b).
**DEC-MEMOS-17..21 were confirmed by the owner on 2026-09-14** in a separate, later answer ("ยืนยัน DEC 17-21").

17. **DEC-MEMOS-17, no zuri-ai compatibility flag for stage 2.** Stage
    2's grant additions (`agentId`/`workspaceId` required on all ten
    API-011 tools, design §6.1.1) make zuri-ai's *current* grant shape —
    which carries neither — fail closed the instant stage-2 grant
    verification ships, with no interim compatibility mode built to
    soften that cutover. **Adopted because channel activation is
    already gated behind `BL-MEMOS-090`** (owner direction, 2026-09-14:
    no LINE OA yet) — no deployment depends on stage-2 tools working
    against zuri-ai's pre-`agentId` grant today, so a hard cutover costs
    nothing now and avoids building (and later retiring) a compatibility
    flag no real deployment would ever exercise. `test:cross-zuri`
    gains two cases: zuri-ai's unmodified grant refused with a typed
    grant error (`grant_signature_invalid`, extending the existing
    required-claim check rather than a new code), and zuri-ai's port
    wrapped with the stage-2 fields added, proving the shapes line up
    once `BL-MEMOS-107` lands. — *confirmed by the owner, 2026-09-14.*
18. **DEC-MEMOS-18, revised (RKOI stage-2 review round 1, commit
    `f74ad0d`) — the worker acts under its own `agentId`; it never
    impersonates the serving agent.** Two shapes were considered for
    how the worker tools satisfy the new agent gate (design §8.2/§8.3):
    (a) **adopted** — the worker attaches through `msp_thread_resolve`
    with `assertAgents: true`, using the room claims its own grant
    already carries, the same self-assert path every other agent uses,
    not a worker-only shortcut. **A resolve from a grant whose
    capabilities are worker-only (`operator`, no `readPrivate`/
    `writePrivate`/`confirmMemory`/`deliveryWriter`) must never mint a
    thread** — if the room has no `ACTIVE` thread, it gets `not_found`,
    never `created: true`; a worker's grant is never the credential that
    brings a room's first thread into existence. Once attached,
    `msp_session_compaction_claim`/`commit`/`retry` require the
    worker's own `grant.agentId` to be a current agent of the job's
    resolved thread; only `msp_session_sweep` is exempt from "current,"
    since it precedes any single thread's resolution, though it still
    requires `agentId`/`workspaceId` present. (b) rejected — a dedicated
    worker role exempt from the agent gate but still room- and
    tenant-checked, which would need its own claim, its own
    authorization branch, and its own proof obligation for RKOI/GHOST,
    duplicating a mechanism this design already needs elsewhere for no
    proven benefit. **This decision widens nothing**: the worker signs
    with the tenant's own service key, which could already assert any
    claim on any grant for that tenant — a compromised worker key was
    already a compromise of the whole tenant's trust boundary
    (`RSK-MEMOS-05`), independent of anything this decision adds or
    withholds. **Revocation wording withdrawn (RKOI stage-2 review
    round 1, warning 3) — the prior text was wrong.** It said a
    worker's access "is revoked the same way any agent's is — ending
    its `thread_agents` row." `msp_thread_agent_detach` is self-only,
    and a detached agent can simply re-attach on its own grant's
    `assertAgents`, so ending a `thread_agents` row is **not** a
    revocation mechanism at all — "a departed agent is denied on its
    next call" (design §15, `GATE-MEMOS-3`) is a per-call property of
    the agent gate, not a control that keeps a specific agent out.
    **Real revocation means one of two things this design does not
    build**: Tier 1 stops issuing that agent's grants, or the tenant's
    service key (or keyring entry, design §6.1.1) is rotated, which
    invalidates every grant signed under the old key regardless of
    which agent it names. — *confirmed by the owner, 2026-09-14.*
19. **DEC-MEMOS-19, the default record `visibility` is `THREAD`.**
    Promoted from unnumbered design prose (RKOI stage-2 review round 1,
    warning 7) — a recorded fact is shared with every other current
    agent of the same thread unless the recording agent explicitly asks
    for `AGENT`-only visibility. Keeps stage-1's existing single-
    visibility behaviour intact for the common single-agent-per-thread
    case, and matches what every legacy stage-1 row backfills to
    (design §9.4). — *confirmed by the owner, 2026-09-14.*
20. **DEC-MEMOS-20, nonce rules.** Promoted from unnumbered design prose
    (RKOI stage-2 review round 1, warning 7): a signed nonce carries at
    least 128 random bits and at most 128 characters on the wire; the
    anti-replay key is `(tenant_id, nonce)`, never a global namespace;
    the opportunistic prune batch is 200 rows, bounded, run on every
    nonce-consuming insert, never dependent on a separate retention
    tick (design §6.1.1, §12.2). The random-bit floor is a signer-side
    requirement stated directly against `BL-MEMOS-107` so agents sharing
    one tenant cannot collide into a spurious `grant_replayed` refusal.
    — *confirmed by the owner, 2026-09-14.*
21. **DEC-MEMOS-21, `agentId`/`workspaceId` bound.** Promoted from
    unnumbered design prose (RKOI stage-2 review round 2, finding 8):
    both claims are non-empty strings bounded at 128 characters, with no
    further charset constraint — MSP has no agent/workspace identity
    registry of its own, mirroring `principalId`'s existing treatment as
    an opaque Tier-1-owned string MSP never validates against a
    directory; the bound exists only to cap storage and `payloadHash`
    cost (design §6.1.1). — *confirmed by the owner, 2026-09-14.*

**Decisions 22 through 33 below are new (PH-MEMOS-4 scoping,
2026-09-15).** **`DEC-MEMOS-22..35`, including `34`/`35` added in the
RKOI-review-response round below, were confirmed by the owner on
2026-09-15** ("ยืนยัน"), the same way `17..21` were confirmed on
2026-09-14.

22. **DEC-MEMOS-22, `leave` always needs `assertParticipants`, self or
    other, and never closes the thread.** `msp_thread_participant_lifecycle`'s
    `leave` action requires `assertParticipants` unconditionally, whether
    it names the caller's own `speaker_id` or another current `HUMAN`
    participant's — there is no narrower self-service exception the way
    append's first-membership/self-upgrade rules have one, because this
    is an explicit administrative call Tier 1 chooses to make, not the
    frozen resolve→append flow's own default path. `leave` only ever sets
    `left_at` on a `thread_participants` row; it never transitions
    `threads.status`. A `DIRECT` thread's last `HUMAN` leaving is an
    accepted, permanent consequence of the existing single-`HUMAN`-for-life
    trigger (design §6.3) — `leave` does not try to auto-close the thread
    to compensate. — *confirmed by the owner, 2026-09-15.* (design §7.1).
23. **DEC-MEMOS-23, `close_for_relink`'s distinct claim is `assertRelink`.**
    `DIRECT`-only; gated by `assertParticipants` **plus** the new boolean
    grant claim `assertRelink` (never `operator`); closes the thread's
    current `HUMAN` participant row and transitions `threads.status`
    `ACTIVE → CLOSED` in one transaction, reusing the already-shipped
    `trg_threads_status_close_only`/`trg_thread_participants_append_only`
    triggers with no schema change. The claim carries no new principal id
    — DEC-MEMOS-11's existing mechanism (a fresh `thread_id` minted for
    the new principal on its own later `resolve`) is unchanged. —
    *confirmed by the owner, 2026-09-15.* (design §7.1).
24. **DEC-MEMOS-24, agent detach needs no new claim.** `msp_thread_agent_detach`
    needs no grant claim beyond the universal `agentId`/`workspaceId` —
    the existing generic thread-bound agent-currency gate (design §8.2)
    already guarantees the call is self-scoped and already answers "not
    attached" with `agent_not_current` before the handler runs, so there
    is no third-party-detach case to gate. — *confirmed by the owner,
    2026-09-15.* (design §8.6).
25. **DEC-MEMOS-25, `data_subject_admin` is a grant flag pair, not a
    Membership role — resolves this ADR's own prior open question.**
    Cross-principal erasure/export authority is two new grant capability
    flags: `dataSubjectAccess` (base, required on every self-service call
    to `msp_thread_principal_erase`/`msp_thread_principal_export`) and
    `dataSubjectAdmin` (additive, required only when the request names a
    `principal_id` other than `grant.principalId`) — mirroring the
    `assertParticipants`+`assertRelink` double-gate decision 23 sets. —
    *confirmed by the owner, 2026-09-15.* (design §11.2).
26. **DEC-MEMOS-26, tool names and the retention tool's capability.**
    `msp_thread_principal_erase`, `msp_thread_principal_export`,
    `msp_thread_retention_tick`. Retention reuses the existing `operator`
    capability exactly like the `msp_session_*` worker tools, via an
    explicit name check in the guard rather than a prefix match, since it
    operates on thread tables (not compaction jobs) and so does not share
    their `msp_session_` prefix. — *confirmed by the owner,
    2026-09-15.* (design §11.2, §13).
27. **DEC-MEMOS-27, erasure idempotency.** A caller-supplied opaque key,
    1–128 characters (mirroring `nonce`'s own bound, `DEC-MEMOS-20`),
    scoped `(tenant_id, idempotency_key)`. A replay naming the *same*
    `principal_id` under the same key returns the stored receipt
    unchanged, with no new writes; a replay naming a *different*
    `principal_id` under the same key is refused `conflict`. — *confirmed
    by the owner, 2026-09-15.* (design §11.2, §12.3).
28. **DEC-MEMOS-28, `erasure_receipts` stores the raw `principal_id`.**
    Consistent with every other content table's speaker/person columns,
    none of which are HMAC'd — W5 pseudonymization stays scoped to the
    journal entry for the erasure event, not to this receipts table. —
    *confirmed by the owner, 2026-09-15.* (design §11.2, §12.3).
29. **DEC-MEMOS-29, retention scope for this phase.** One deployment-wide
    `MSP_THREAD_RETENTION_DAYS` horizon (no per-tenant policy table yet),
    operator- and tenant-bound, `dry_run`-capable, reusing erasure's own
    tombstone mechanism but age-based and principal-agnostic, bounded to
    200 rows per table per call (reusing `DEC-MEMOS-20`'s existing bound,
    not a new number); never touches `thread_participants`/`thread_agents`/
    `threads`/`grant_nonces`. A richer per-tenant policy is explicitly out
    of scope for this phase, carried forward against `RSK-MEMOS-06`. —
    *confirmed by the owner, 2026-09-15.* (design §11.2).
30. **DEC-MEMOS-30, export excludes tombstoned content, including the
    exporting principal's own.** Once erased, content is permanently
    unexportable too — otherwise export would be a parallel read path
    that undermines erasure's own guarantee. — *confirmed by the owner,
    2026-09-15.* (design §11.2).
31. **DEC-MEMOS-31, export ignores agent visibility.** Export is always
    principal-scoped regardless of `visibility`/agent — an
    `AGENT`-visibility protected record is included in its asserter's or
    subject's own export regardless of which agent recorded it or which
    agent's grant is calling, since `visibility` governs agent-to-agent
    confidentiality (design §9.4), not the data subject's own access
    right. — *confirmed by the owner, 2026-09-15.* (design §11.2).
32. **DEC-MEMOS-32, erasure/export per-table selection operationalizes
    §11.1 exactly.** Messages: the principal's own `speaker_id`. Protected
    records: asserter or subject. Session summaries and `thread_delivery_receipts`:
    **corrected by `DEC-MEMOS-34` below — sole-ever-`HUMAN`-participant of
    the thread, not merely "current at call time"** — the criterion §11.1
    was corrected to state in the RKOI PH-MEMOS-4 review response.
    `thread_pending_deliveries` is out of erasure's scope entirely
    (`DEC-MEMOS-34`'s own text, CRITICAL 4 item 2) — no longer part of
    this decision's table list. — *confirmed by the owner, 2026-09-15.*
    (design §11.2).
33. **DEC-MEMOS-33, an unknown principal is a trivial success, not
    `not_found`.** Naming a `principal_id` that has never appeared in the
    tenant's data succeeds with a zero-count receipt (erase) or an empty
    export, never a refusal — avoiding a new cross-principal existence
    oracle alongside the already-accepted `RSK-MEMOS-09` family. —
    *confirmed by the owner, 2026-09-15.* (design §11.2).

**Decisions 34 and 35 below are new (RKOI PH-MEMOS-4 review response,
2026-09-15) — confirmed by the owner on 2026-09-15, the same status as
`22..33`.**

34. **DEC-MEMOS-34, erasure/export summary and delivery-table disposition
    is sole-ever-HUMAN-participant-scoped, not thread-scoped — two
    independent conditions, both required.** For `session_summaries` and
    `thread_delivery_receipts`, both `msp_thread_principal_erase` and
    `msp_thread_principal_export` act only on threads that qualify under
    **both** of the following, computed once and reused by both tools:
    (a) across the thread's *entire* `thread_participants` history
    (current or departed rows alike), the calling/named principal is that
    thread's only-ever `HUMAN` participant — checked as **two separate
    counts, either of which disqualifies**: `COUNT(DISTINCT speaker_id)`
    and, separately, `COUNT(DISTINCT person_id) WHERE person_id IS NOT
    NULL`, both over that thread's `HUMAN` participant rows (deliberately
    the stricter of the two readings, since two different `person_id`s
    under one shared `speaker_id` are schema-legal and must not slip
    through a `speaker_id`-only count); **and (b), corrected (RKOI
    PH-MEMOS-4 review round 2, CRITICAL 2)**, the thread carries **no**
    `thread_messages` row anywhere on it with `speaker_kind NOT IN
    ('HUMAN', 'AGENT')` — a single `UNKNOWN`- or `OPERATOR`-authored
    message disqualifies the thread unconditionally, since `HUMAN` is the
    only `speaker_kind` that ever gets a `thread_participants` row at all
    (the guard's participant-creation logic runs only for `speaker_kind
    === 'HUMAN'`), so condition (a) alone is blind to an unresolved second
    person's content — the normal shape of an unresolved LINE group
    member, not an edge case. `AGENT` is excluded from this disqualifying
    set because it is the assistant's own generated reply, never another
    principal's content; `UNKNOWN`/`OPERATOR` are not excluded because
    either could represent an unresolved real person. A `GROUP`/`ROOM`
    thread failing (a) or (b) is left **untouched** by erasure and
    **excluded entirely** (not filtered, not redacted) from export, for
    those two tables. This is a conservative default, stated as such
    rather than left implicit: it under-erases a group-shared summary
    rather than risk destroying or leaking another principal's (or an
    unresolved speaker's) content — scrubbing one person's contribution
    out of a shared summary is explicitly out of scope for this phase.
    `thread_pending_deliveries` is removed from erasure's scope entirely
    by the same review round (CRITICAL 4 item 2), for an unrelated reason
    — it holds `AGENT`-authored reply text, not the principal's own, and
    carries no reliable attribution column — not by this decision. —
    *confirmed by the owner, 2026-09-15.* (design §11.1, §11.2).
35. **DEC-MEMOS-35, `msp_thread_retention_tick`'s `dry_run: true` consumes
    no nonce but does write a journal entry — only the nonce exemption is
    dry-run-specific.** A `dry_run: true` call is fully read-only with
    respect to mutation and replay, so it needs no nonce, the same way the
    genuinely low-stakes `msp_thread_context` is already exempt from the
    nonce requirement. **Corrected (RKOI PH-MEMOS-4 review round 2,
    WARNING 6) — the no-journal half of the prior revision is withdrawn.**
    `msp_thread_context`'s own no-journal precedent does not transfer
    cleanly here: it is thread-scoped and returns only the calling grant's
    own thread, while `dry_run: true` here returns **tenant-wide**
    aged-content counts, and with no nonce a caller could otherwise invoke
    it unboundedly to enumerate a tenant's content profile with zero audit
    trail. Both `dry_run: true` and `dry_run: false` therefore write a
    journal entry (aggregate per-table counts and the `dry_run` flag
    itself, no per-row content) — a `dry_run: false` call additionally
    consumes a nonce and journals normally, unchanged from before. —
    *confirmed by the owner, 2026-09-15.* (design §11.2).
36. **DEC-MEMOS-36, principal vault owner tuples and `decay_policy`
    pinning.** `principal_private` (the episodic vault) is owned by
    `tenant_id, principal_id, agent_id, workspace_id`, all `NOT NULL`
    while active, and decays on the ordinary Ebbinghaus schedule;
    `principal_passport` (the Soul Passport vault) is owned by
    `tenant_id, principal_id` alone (`agent_id`/`workspace_id` always
    `NULL`) and never decays. `decay_policy` is a new `vaults` column,
    pinned per type by a `CHECK`, not a caller-chosen setting. — *pending
    owner confirmation.* (design §5, §12.4).
37. **DEC-MEMOS-37, migration numbers.** The principal-vaults migration is
    `0011`; scoped `contexts` receipts is its own migration, `0012` —
    both provisional per `DEC-MEMOS-14`'s merge-order rule, now concrete
    because `0008`/`0009`/`0010` are confirmed already merged to `main`
    as thread memory, `thread_agents` and `erasure_receipts`. — *pending
    owner confirmation.* (design §12.4, §12.4.1).
38. **DEC-MEMOS-38, `vaults` rebuild strategy.** The migration uses the
    `-- msp-migration: foreign-keys=off` directive and the safe
    create/copy/drop/rename order (`docs/MIGRATION.md`), since `vaults`
    is a real parent table with four existing child tables
    (`vault_mounts`, `entities`, `promotions`, `links`) and SQLite cannot
    alter a `CHECK` in place. The per-type owner `CHECK`s exempt an
    erased row (`status = 'erased'`, `principal_id` blanked) in advance,
    but the erasure transition itself is out of this phase's scope
    (PH-MEMOS-6). — *pending owner confirmation.* (design §12.4).
39. **DEC-MEMOS-39, never-mountable enforcement.** Two triggers on
    `vault_mounts` (`BEFORE INSERT`/`BEFORE UPDATE`) refuse a mount
    naming a `principal_private`/`principal_passport` `vault_id` at the
    database layer; `VaultRegistry#mountVault` refuses the same case at
    the JS layer first — deliberate defense in depth, not redundant
    duplication. A separate `vaults` identity-pin `UPDATE` trigger
    permits only the pre-existing legacy `project_id` backfill and the
    (deferred) erasure transition, pinning every other column on both
    branches. — *pending owner confirmation.* (design §5.2, §12.4).
40. **DEC-MEMOS-40, `msp_vault_resolve`'s request matches zuri-ai's
    shipped, unsigned caller exactly.** No `grant`/`signature` field, no
    HMAC, no expiry — resolved in favor of matching what
    `msp-vault-resolver.js` actually sends (`origin/main@4ca28c1d`) rather
    than extending API-011's signed-grant model to a tool that would then
    be uncallable by the one real caller that exists. Accepted on the
    same stdio-only trust boundary already accepted for the entire
    API-011 surface (`RSK-MEMOS-05`) — not a new, weaker precedent. —
    *pending owner confirmation.* (design §5.3).
41. **DEC-MEMOS-41, `msp_vault_resolve`'s response is additive-only.**
    `workspacePrivateVaultId`/`globalPrivateVaultIds`/`sharedVaultIds`/
    `permissions.{read,writePrivate,writeShared,policyVersion}` keep
    their exact shape and camelCase casing; new
    `principalPrivateVaultId`/`principalPassportVaultId`/
    `permissions.allowPassport` fields use the same casing convention and
    are silently dropped by the shipped client's own `validateVaultSet`
    until it is updated (`BL-MEMOS-113`, decision 48) — confirmed safe by
    reading that function's source, not assumed. — *pending owner
    confirmation.* (design §5.3).
42. **DEC-MEMOS-42, `allow_passport` gating is safe by default.**
    zuri-ai's shipped `authorizationFacts()` does not send `allow_passport`
    at all; MSP treats its absence, or any value other than the literal
    `true`, identically to `false` — no passport vault provisioned or
    returned. The episodic (`principal_private`) vault, by contrast,
    resolves and is lazily provisioned on every well-formed call, gated
    by no flag — matching the design's own tier table ("this principal's
    turns with this agent in this workspace," every turn). — *pending
    owner confirmation.* (design §5.3, §5.5).
43. **DEC-MEMOS-43, the API-009 `access_context` shape.** One flat,
    snake_case object (`tenant_id`, `principal_id`, `agent_id`?,
    `workspace_id`?, `allow_passport`?), reusing `msp_vault_resolve`'s own
    field names so a caller can share one object across both tool
    families; mandatory only when the target vault (or, for
    `msp_memory_history`/`forget`/`links_list`/`links_create`, the vault
    the named entity resolves to) is `principal_private`/
    `principal_passport`; unaffected and ignored-if-sent for every legacy
    vault. `msp_memory_links_create` needs no independent second check
    for its two endpoints — the pre-existing WP-17 same-vault refusal
    (`migrations/0006_links.sql`) already guarantees both endpoints share
    one vault before this amendment's logic ever runs. — *pending owner
    confirmation.* (design §5.1).
44. **DEC-MEMOS-44, error-code vocabulary for the amendment.**
    `vault_scope_denied`'s existing meaning is broadened additively (same
    code, not a new one) to also cover an `access_context` mismatch. Two
    genuinely new codes: `access_context_required` (the field is absent
    on a principal-vault-type request) and `access_context_denied` (the
    field is present but wrong — tuple mismatch, or a passport target
    missing `allow_passport: true`; deliberately the same code for both
    sub-cases, so a caller cannot learn "wrong principal" from "right
    principal, no passport grant," mirroring `DEC-MEMOS-33`'s no-new-
    oracle reasoning). — *pending owner confirmation.* (design §5.1).
45. **DEC-MEMOS-45, `msp_memory_decay_tick`'s `pinned` field.** The
    response gains `pinned: boolean`, read from the target vault's own
    `decay_policy` column — `true` only for `principal_passport`. When
    `true`, `evaluated`/`transitioned` are always `0`/`[]` regardless of
    `dry_run`, a distinct statement from `dry_run`'s own
    computed-but-not-persisted contract, never conflated with it. —
    *pending owner confirmation.* (design §5.1).
46. **DEC-MEMOS-46, scoped `contexts` receipts.** `tenant_id`/
    `principal_id`, both nullable, added by a plain `ALTER TABLE` (no
    rebuild — `contexts` is not FK-referenced by any other table);
    both-or-neither is enforced at the contracts layer
    (`context-scope-guard.mjs`), not a database `CHECK`, mirroring
    `migrations/0006_links.sql`'s own precedent for an app-layer-only
    cross-column invariant. `include_payload` is refused for a scoped row
    unconditionally on `msp_context_diff`/`audit`/`replay`, even given a
    correctly-matching `access_context` — it is not a second read path
    around the entity-level checks decision 43 already adds. — *pending
    owner confirmation.* (design §5.4, §12.4.1).
47. **DEC-MEMOS-47, the API-009 contract file's own edit is deferred to
    implementation time.** This design pass fully specifies the
    `access_context` amendment's content (decision 43–45) but does not
    itself edit `docs/API-009-Persistent-Memory-Contract.md` — that
    version bump and Changelog row are `BL-MEMOS-063`'s own
    implementation-time deliverable, the same precedent already set for
    API-011's contract file versus its design-doc specification
    (design §6.1.1). — *pending owner confirmation.* (design §5.1).
48. **DEC-MEMOS-48, new cross-repo item `BL-MEMOS-113`.** zuri-ai's
    `msp-vault-resolver.js`/`validateVaultSet` must be extended to read
    and forward `principalPrivateVaultId`/`principalPassportVaultId`/
    `permissions.allowPassport` before a caller can actually *use* a
    principal vault `msp_vault_resolve` resolves — until then these
    fields are safely, silently dropped by the shipped client (decision
    41), not broken. Deferred to `PH-MEMOS-8`, alongside
    `BL-MEMOS-106`/`092`/`093`, since production use is itself deferred
    by owner direction (2026-09-14). — *pending owner confirmation.*
    (design §5.3.1).

### The multi-user model

The owner of private memory remains `tenant × principal × agent ×
workspace` (`principal_private`) and the permanent passport remains
`tenant × principal` (`principal_passport`, gated by `allow_passport`) —
unchanged from design §5. Threads, sessions and messages are containers and
provenance, **never** owners. A `DIRECT` thread holds exactly one `HUMAN`
participant for its lifetime, schema-enforced; `GROUP` and `ROOM` threads
hold many and never produce a private read for anyone. Participation
changes only under an explicit claim, never as a side effect of an
ordinary signed append (closing three of C-1's four entry points). A
private read requires the grant's principal to be a *current* `VERIFIED`
`HUMAN` participant — `UNKNOWN` and `PENDING` speakers never get one, and a
speaker cannot self-upgrade its own assurance level. A protected record's
`subject_person_id` must be absent or equal to the asserter — never another
person (closing C-1's fourth entry point). A relinked or merged Person goes
through the participant lifecycle tool, which closes the old membership;
the new Person never inherits it.

### The multi-agent model

The grant gains a required `agentId` and `workspaceId`. The journal's actor
is the agent; a principal ever named in a journal payload appears only as
`principal_hmac`, never raw. A new append-only `thread_agents` relation
(`thread_id, agent_id, workspace_id, joined_at, left_at`, partial unique on
the open row) is attached only under an explicit claim or by the creating
agent on resolve — never implicitly by tenant. Only a *current* agent of a
thread may append `AGENT` messages, read context, record injections or
deliveries, or claim/commit compaction for it; leaving loses reads on the
next call. Two agents serving the same person keep separate episodic
vaults (the owner tuple includes `agent_id`), share the one passport vault
only through gated reads, and see each other's protected records only when
marked `THREAD` visibility (never `AGENT`-visibility ones) and each other's
thread-level session summaries always (summaries carry no agent scoping).
The existing `global_private` agent vault remains the agent's own
cross-principal memory and is structurally unreachable from consolidation,
which only ever targets `principal_private` / `principal_passport`.

### Tenancy and trust boundary

Every uniqueness key and lookup in the folded migration is tenant-scoped;
a grant naming tenant A can never resolve, append, sweep or read anything
of tenant B. Design §13.1's trust-boundary paragraph is kept: every
`authorization`/capability flag on the grant is a Tier 1 assertion MSP
does not independently verify. The HMAC signature, payload hash and short
expiry (≤65s) strengthen transport *integrity* — a value cannot be altered
or replayed indefinitely in flight — but they do not make a capability flag
an authenticated identity claim; that remains Tier 1's job, exactly as it
does for every `authorization.*` flag on the existing API-011 sibling
surfaces. A nonce/replay rule closes the specific 60-second replay window
RKOI found (see the design's §6.1 for which mechanism was chosen and why).

## RKOI rulings on ATHER's four judgement calls (2026-09-14)

The first version of this ADR raised four judgement calls on its own
authority. RKOI has now ruled on all four; none is an open question any
longer, and **the owner confirmed all four on 2026-09-14** ("ยืนยัน RKOI rulings 1-4").

1. **Grant capability growth — accepted narrowly.** Additive optional
   flags (`assertParticipants`, already shipped; `nonce`, `assertAgents`
   if stage 2 needs them) are MSP's own concern and may be added to the
   grant without a cross-repo contract change, since an existing signer
   that does not yet know about them keeps signing correctly. **Correction
   (RKOI, round two): a new *required* grant field — `agentId` and
   `workspaceId` in stage 2 — is not "out of bounds."** It is a real
   cross-repo wire change zuri-ai's signer must adopt, exactly like every
   other item in the "Cross-repo changes stage 2 requires of zuri-ai" list
   below; this ADR does not have the authority to refuse it, only to name
   it, schedule it against `RSK-MEMOS-01`/`BL-MEMOS-090`, and gate
   activation on it landing. The grant's flat/epoch-millisecond/hex layout
   itself, signed over zuri-ai's own `JSON.stringify(grant)`, is frozen and
   is not proposed to change (design §6.1).
2. **Per-tenant keyring — accepted, with conditions.** The key is selected
   by the grant's own **unverified** `tenantId` and then the signature is
   verified against it; when a keyring is configured, **the single
   default key is disabled for every tenant, with no fallback**;
   `MSP_THREAD_SERVICE_KEYRING` is allowlisted in the client transport and
   never journaled; **per-tenant rotation is explicitly deferred**, not
   designed; the keyring is **defense in depth only while Tier 1 itself
   holds every tenant's key** — it does not protect against a compromise
   of Tier 1's own key store.
3. **Nonce split — accepted, with conditions.** A nonce is required on
   **every** mutating tool except `msp_thread_message_append`, including
   `resolve` and the lifecycle tool. The nonce insert runs in the same
   transaction as the mutation it guards. An append replay with the same
   `source_event_id` and *different* content is `conflict`, never a
   silent dedupe or overwrite. Pruning is bounded and opportunistic on
   insert, never dependent on the operator retention tick. `grant_nonces`
   is added to the design's erasure table and security suite.
   **Named tension:** `grant_nonces` itself ships in stage 2
   (DEC-MEMOS-14), so stage 1 cannot yet enforce the nonce requirement on
   `resolve`/`memory_record`/`injection_record`/`delivery_record` — an
   accepted, temporary gap (design §6.1, §19).
4. **Single `thread_kind` — accepted.** A `threads` `UPDATE` trigger pins
   kind, tenant, business id and binding state, with a `CHECK` on
   `status`; mint requires `thread_kind == audience_kind ==
   grant.audienceKind`; `ROOM` behaves as `GROUP` everywhere.

## Cross-repo changes stage 2 requires of zuri-ai (RSK-MEMOS-01)

Recorded here and in the plan's `RSK-MEMOS-01` risk entry, per RKOI's
instruction that every cross-repo change be listed in both places:

- **`agentId` and `workspaceId` become required** grant fields starting in
  stage 2 (design §6.1, §8). zuri-ai's signer does not send them today.
- **A `nonce` field** is required on every mutating call except append,
  once stage 2's `grant_nonces` exists (design §6.1). zuri-ai's signer
  must start generating and including one, **carrying at least 128
  random bits** (`DEC-MEMOS-20`) — a short or low-entropy nonce risks
  colliding with another of zuri-ai's own agents in the same tenant and
  producing a spurious `grant_replayed` refusal.
- **`assertAgents`** must be set by zuri-ai when it wants an agent to join
  a thread it did not create (design §8.1).
- **New (RKOI stage-2 review round 1, warning 6): zuri-ai's outbound
  append's `agentId` must equal the `speakerId` it sends.** zuri-ai's
  own outbound reply append uses `speakerId: 'zuri-line-agent'`
  (`server-line-answer.js`, confirmed against `thread-memory.mjs:1131`'s
  matching hard-coded value on MSP's side) — under design §8.2's rule
  that an `AGENT`-kind message's `speaker_id` must equal `grant.agentId`,
  zuri-ai's grant for that call must carry `agentId: 'zuri-line-agent'`,
  not some other internal identifier, or the append is refused.
- **`DEC-MEMOS-17`, new: there is no compatibility flag for any of the
  three items above.** zuri-ai's current, unmodified grant fails closed
  (`grant_signature_invalid` for the missing `agentId`/`workspaceId`, or
  a nonce-required refusal) the moment stage-2 verification ships —
  MSP does not build or maintain an interim mode that tolerates the old
  shape. Adopted because channel activation is already gated behind
  `BL-MEMOS-090`; nothing production-facing depends on the old shape
  continuing to work once stage 2 exists.
- **`assertParticipants`** must be set by zuri-ai for any participant
  creation or change beyond the first `HUMAN` append DEC-MEMOS-12 already
  covers implicitly, and beyond DEC-MEMOS-15's self-upgrade exception
  (design §7 rule 2) — shipped and usable today for the cases it covers.
- **Item 4 — a caller for `msp_thread_participant_lifecycle`'s
  `close_for_relink` operation** (RKOI round two, warning 6/8): zuri-ai or
  Zuri must call it on a Person relink/merge event once the tool exists
  (phase 003) — MSP only provides the tool (decision 4); nothing calls it
  today, and a relinked channel account's old thread stays open until
  something does. **The mechanism, stated directly (RKOI round four): a
  zuri-ai account merge into an existing Person changes that Person's
  `personId`. The next append from the merged account passes
  DEC-MEMOS-12's first-membership check, but the *lifetime* single-`HUMAN`
  trigger (design §6.3) still refuses a second distinct `HUMAN` speaker on
  that `DIRECT` thread — every later append then fails closed until this
  caller exists, and the merged Person never inherits the old thread's
  history in the meantime (DEC-MEMOS-11).** This is a real, still-open
  cross-repo change: it needs a zuri-owner backlog item (`BL-MEMOS-092`)
  and belongs on the channel-activation gate, not something DEC-MEMOS-15
  resolves. **Updated (PH-MEMOS-4 scoping): the caller's exact grant
  shape is now specified, not just its existence** — `BL-MEMOS-092`'s
  caller must call `msp_thread_participant_lifecycle`'s `close_for_relink`
  action with **both** `assertParticipants: true` and the new
  `assertRelink: true` claim (`DEC-MEMOS-23`) on the old thread; neither
  claim alone is sufficient, and `operator` never substitutes for either.
  **Extended (RKOI PH-MEMOS-4 review, WARNING 3) — the full caller shape,
  not just the two participant claims.** `close_for_relink` is
  thread-bound (design §7.1), so it also receives the generic thread-bound
  gate's complete, ordinary demands, every one of which `BL-MEMOS-092`'s
  caller must also satisfy: `audienceKind === 'DIRECT'` on the grant; a
  `channelAccountId`/`externalRoomRef` pair that re-hashes to the old
  thread's own stored `external_room_ref_hmac`; `agentId`/`workspaceId`
  present; a `nonce` (this tool is mutating and not exempt); and an open
  `thread_agents` row for the calling agent on the old thread (stage 2) —
  none of these are new requirements this decision invents; they are the
  same generic gate every other thread-bound tool already enforces
  (design §6.3/§8.2), listed here in full because zuri-ai's caller needs
  the complete picture, not only the two claims this decision adds on
  top of it.
- **New (PH-MEMOS-4 scoping) — a caller for `msp_thread_principal_erase`
  on zuri-ai's own PDPA erasure flow** (`BL-MEMOS-093`, deferred to
  `PH-MEMOS-8` exactly like item 4): zuri-ai's backend erasure job is
  expected to run as an administrative process rather than a live
  per-principal user grant, so its caller needs `dataSubjectAdmin: true`
  (`DEC-MEMOS-25`), not merely the base `dataSubjectAccess: true` a
  self-service call would carry.
- **Item 5 — the assurance-upgrade caller — corrected (RKOI round three):
  resolved MSP-side by DEC-MEMOS-15, no zuri-ai change needed for the
  normal case.** An earlier version of this list said the opposite (that
  zuri-ai needed to be "wired to ask for" an upgrade) and separately
  claimed `assertParticipants` itself "needs no zuri-ai change," which
  read as directly contradicting that claim — both readings are corrected
  here at once. zuri-ai's existing, unmodified append call (sending
  `identity_assurance: VERIFIED` with `person_id = principalId` once a
  user is verified) already satisfies DEC-MEMOS-15's four conditions with
  no new claim and no code change on zuri-ai's side. The only case still
  needing a caller is the **open risk** DEC-MEMOS-15 itself names: if
  `principal.personId` changes at verification instead of staying equal to
  the existing `principalId`, item 4's relink caller is what closes the
  resulting locked thread, not a new assurance-upgrade caller.
- None of the above changes any field zuri-ai already sends on the six
  frozen calls (decision 2) — they are strictly additive to the grant
  envelope or calls to tools zuri-ai does not invoke yet. No activation of
  the stage-2-only requirements happens before stage 2 merges, and no
  channel activation (PH-MEMOS-8) happens before that.

## Cross-repo changes PH-MEMOS-5 requires of zuri-ai (`BL-MEMOS-105`)

A separate list from `RSK-MEMOS-01` above — these are about the new
`msp_vault_resolve`/API-009 surface, not the API-011 grant.

- **`msp_vault_resolve` needs no zuri-ai-side change to keep working as
  it does today** (decisions 40/41) — the request/response shapes below
  are read directly from the shipped `msp-vault-resolver.js`
  (`origin/main@4ca28c1d`), not invented, and the new response fields are
  additive and silently dropped by the shipped client's own
  `validateVaultSet` until it is updated.
- **New item — `BL-MEMOS-113` (decision 48):** zuri-ai's
  `msp-vault-resolver.js`/`validateVaultSet` must be extended to read and
  forward `principalPrivateVaultId`/`principalPassportVaultId`/
  `permissions.allowPassport` before a caller can actually *use* a
  principal vault `msp_vault_resolve` resolves — today these fields are
  present on the wire but structurally unreachable through the shipped
  client. Deferred to `PH-MEMOS-8`, alongside `BL-MEMOS-106`/`092`/`093`,
  since production use is itself deferred by owner direction
  (2026-09-14).
- **New item, same deferral — `authorizationFacts()` must add
  `allow_passport` (decision 42):** without this, `msp_vault_resolve`
  always answers `principalPassportVaultId: null` for every zuri-ai call,
  which is safe (never over-grants) but also means the passport tier is
  unreachable from zuri-ai until this ships. No new `BL-MEMOS` id — this
  is the same `BL-MEMOS-113` caller-side change, not a second one.
- **`access_context` on `msp_memory_*` calls remains `BL-MEMOS-106`'s own
  item, unchanged by this ADR** — already tracked in the plan, deferred to
  `PH-MEMOS-8`.
- None of the above changes any field zuri-ai's `msp_vault_resolve`
  caller already sends — every addition is a new response field the
  shipped client does not yet read, not a request-shape change it would
  need to adopt merely to keep calling MSP.

## Consequences

- MSP gains one coherent API-011 surface instead of two incompatible ones,
  and the branch's C-1/C-2 findings are closed by construction (schema
  triggers and a DB-backed guard) rather than left as follow-up work.
- Erasure exists before LINE OA activation, so the "make MSP complete"
  direction does not create a channel with user data MSP cannot erase.
- Delivery grows by at least one migration compared to either prior
  effort alone (folded thread-memory migration, then principal vaults),
  and the branch's existing code/tests need substantial rework, not a
  straight merge.
- zuri-ai is not asked to change any field it already sends on the six
  calls, but is asked to (a) start minting an `agentId`/`workspaceId`- and
  nonce-bearing grant, and (b) eventually call the new participant
  lifecycle tool on relink/merge — neither of which is scheduled by this
  ADR.
- LINE OA connection work is now explicitly gated on: erasure (decision 5),
  the identity-key requirement for room refs (decision 6), and the folded
  migration landing (decision 7) — a longer runway than either prior effort
  implied on its own.

## What this ADR does not decide

- The exact corrected DDL for the folded migration, the stage-2
  multi-agent migration, the principal-vaults migration (`0011`) and the
  scoped-`contexts` migration (`0012`) — that is
  `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.6.0b's job, not
  this ADR's.
- The live edit to `docs/API-009-Persistent-Memory-Contract.md` itself —
  `DEC-MEMOS-47` defers that to `BL-MEMOS-063`'s own implementation-time
  commit, matching the precedent already set for API-011's contract file.
- Whether or when GoVibe or Zuri actually calls the participant lifecycle
  tool (decision 4 only says MSP must provide it).
- Ceiling → tier policy and passport promotion thresholds — these were
  already open owner decisions in design v0.2.3b §19 and carry forward
  unchanged. **Whether `data_subject_admin` is a Membership role or a new
  flag is no longer open** — `DEC-MEMOS-25` (PH-MEMOS-4 scoping) resolves
  it as a grant flag pair (`dataSubjectAccess`/`dataSubjectAdmin`), not a
  Membership role.
- Any Postgres adapter timeline.
- Ontology, canonical facts, or anything that belongs to GKS or GenesisBlockDB
  per `docs/TIER-BOUNDARY-17-STAGE.md` — this ADR is entirely inside MSP's
  Tier 2 boundary and assigns MSP no pipeline stage.

## Owner confirmation checklist

Items 1–16 were confirmed by the owner on 2026-09-14, and items 17–21 later the same day. Item 7's migration
numbering is read as corrected by DEC-MEMOS-14: later migrations are
numbered in merge order. RKOI rulings 1–4 were confirmed by the owner on 2026-09-14 in a separate answer ("ยืนยัน RKOI rulings 1-4"). **Items 22–35 (PH-MEMOS-4 scoping, 2026-09-15, `34`/`35` added in the RKOI-review-response round) were confirmed by the owner on 2026-09-15** ("ยืนยัน") **— corrected (RKOI PH-MEMOS-4 review, WARNING 1): an earlier revision's changelog claimed this checklist had already been extended with items 22–33; it had not been. The rows below are the actual extension, now checked.** **Items 36–48 (PH-MEMOS-5 scoping, 2026-09-16) are new and are NOT yet confirmed** — left unchecked below, pending the owner's own answer, exactly like items 17–21 and 22–35 each stood before their own confirmation date.

- [x] 1. API-010 = `msp_vault_resolve`; thread/session/memory surface = API-011.
- [x] 2. The branch's six `msp_thread_*` tool shapes are canonical (business fields frozen).
- [x] 3. Instances/agent-leg dropped for server channels; the signed grant + `thread_agents` is the relation.
- [x] 4. A participant lifecycle tool exists in MSP; wiring callers is deferred.
- [x] 5. Erasure ships before any channel activation.
- [x] 6. Room refs are HMAC-at-rest; `MSP_IDENTITY_HMAC_KEY` is required.
- [x] 7. Thread memory = migration 0008 (folded, corrected); principal vaults = a later migration, number assigned at merge (**corrected, PH-MEMOS-5 scoping, 2026-09-16**: `0009`/`0010` merged first as `thread_agents`/`erasure_receipts`, so principal vaults is `0011`, `DEC-MEMOS-37` — the underlying decision, numbers assigned in merge order, is unchanged and not reopened; only this row's stale placeholder number is corrected).
- [x] 8. Thread-scoped memory stays in thread tables; consolidation to principal vaults is later and owner-context-only.
- [x] 9. Caller-supplied `now` is test-only, never production.
- [x] 10. No extractive fallback; `coverageGap` is the mechanism.
- [x] 11. Relink closes the DIRECT thread and mints a new one for the new principal (DEC-MEMOS-11).
- [x] 12. First HUMAN membership is created by append, bound to the grant's own principal (DEC-MEMOS-12).
- [x] 13. The thread store lives in `msp-core`, no new package (DEC-MEMOS-13).
- [x] 14. Agent fields and `grant_nonces` ship in stage 2, not `0008`; migration numbers are assigned in merge order (DEC-MEMOS-14).
- [x] 15. A PENDING→VERIFIED self-upgrade on a later append needs no `assertParticipants` when the stated conditions hold on both the incoming request and the stored row, closing the old row and inserting a new one in one transaction; VERIFIED→PENDING is silently ignored, and MSP's own state does not implement revocation as a result (DEC-MEMOS-15).
- [x] 16. A `channel_type` mismatch against an existing ACTIVE thread's stored value is refused `conflict`, never a silent cross-channel hit, so a second channel type can never get its own thread for the same account and room ref; the room hash stays three segments (DEC-MEMOS-16).
- [x] 17. Stage 2 has no zuri-ai compatibility flag; zuri-ai's current grant fails closed the moment stage-2 verification ships, since activation is already gated behind BL-MEMOS-090 (DEC-MEMOS-17).
- [x] 18. The worker attaches via `assertAgents`, never mints from a worker-only grant (`not_found` if the room has no thread), and requires agent-currency on the job's thread for `claim`/`commit`/`retry`; `sweep` alone is exempt from "current" but still requires `agentId`/`workspaceId` present; "departed agent denied" is a per-call property, not a revocation control (DEC-MEMOS-18).
- [x] 19. The default protected-record `visibility` is `THREAD` (DEC-MEMOS-19).
- [x] 20. A nonce carries ≥128 random bits and ≤128 characters, keyed `(tenant_id, nonce)`, pruned in bounded batches of 200 on insert (DEC-MEMOS-20).
- [x] 21. `agentId`/`workspaceId` are non-empty strings bounded at 128 characters, with no further charset constraint (DEC-MEMOS-21).
- [x] RKOI ruling 1: grant capability growth is additive-only; new required/nested/re-encoded fields are cross-repo.
- [x] RKOI ruling 2: per-tenant keyring, with the stated selection/fallback/rotation/defense-in-depth conditions.
- [x] RKOI ruling 3: nonce required on every mutating tool except append, with the stated transaction/conflict/pruning conditions, and the named stage-1 gap.
- [x] RKOI ruling 4: single persisted `thread_kind`, pinned by trigger, `ROOM` behaves as `GROUP`.
- [x] 22. `leave` always requires `assertParticipants`, self or third-party, and never itself closes the thread (DEC-MEMOS-22).
- [x] 23. `close_for_relink`'s distinct claim is `assertRelink`, additive to `assertParticipants`, `DIRECT`-only, never `operator` (DEC-MEMOS-23).
- [x] 24. `msp_thread_agent_detach` needs no new grant claim — the existing agent-currency gate already makes it self-only (DEC-MEMOS-24).
- [x] 25. Cross-principal erasure/export authority is the grant flag pair `dataSubjectAccess`/`dataSubjectAdmin`, not a Membership role (DEC-MEMOS-25).
- [x] 26. Tool names `msp_thread_principal_erase`/`msp_thread_principal_export`/`msp_thread_retention_tick`; retention reuses `operator` via an explicit name check (DEC-MEMOS-26).
- [x] 27. Erasure idempotency: a caller-supplied opaque key, 1–128 chars, scoped `(tenant_id, idempotency_key)`; same-principal replay is a no-op, different-principal replay is `conflict` (DEC-MEMOS-27).
- [x] 28. `erasure_receipts` stores the raw `principal_id`; W5 pseudonymization stays scoped to the journal entry only (DEC-MEMOS-28).
- [x] 29. Retention for this phase is one deployment-wide `MSP_THREAD_RETENTION_DAYS` horizon, no per-tenant policy table yet, bounded to 200 rows/table/call (DEC-MEMOS-29).
- [x] 30. Export excludes tombstoned content, including the exporting principal's own erased rows (DEC-MEMOS-30).
- [x] 31. Export ignores agent `visibility` entirely — principal-scoped, not agent-scoped (DEC-MEMOS-31).
- [x] 32. Erasure/export per-table selection operationalizes design §11.1 exactly (DEC-MEMOS-32).
- [x] 33. An unknown principal is a trivial success on both erase and export, never `not_found` (DEC-MEMOS-33).
- [x] 34. Erasure/export summary and delivery-table disposition is restricted to threads where the principal is the thread's sole-ever `HUMAN` participant (checked as two separate counts, `speaker_id` and non-null `person_id`, either disqualifying) **and** the thread carries no `thread_messages` row with `speaker_kind NOT IN ('HUMAN', 'AGENT')` anywhere on it; a `GROUP`/`ROOM` thread failing either condition is left untouched (erasure) or excluded entirely (export), a conservative under-erasure default, stated as such (DEC-MEMOS-34).
- [x] 35. `msp_thread_retention_tick`'s `dry_run: true` consumes no nonce but does write a journal entry, the same as `dry_run: false` — only the nonce exemption is dry-run-specific (DEC-MEMOS-35).
- [ ] 36. Principal vault owner tuples: `principal_private` = `tenant_id, principal_id, agent_id, workspace_id`, ebbinghaus decay; `principal_passport` = `tenant_id, principal_id` only, pinned (no decay) (DEC-MEMOS-36).
- [ ] 37. The principal-vaults migration is `0011`; scoped `contexts` receipts is its own migration, `0012` (DEC-MEMOS-37).
- [ ] 38. `vaults` is rebuilt with the `foreign-keys=off` directive and the safe create/copy/drop/rename order; the erased-row `CHECK` exemption is added now, the erasure transition itself ships in PH-MEMOS-6 (DEC-MEMOS-38).
- [ ] 39. Never-mountable enforcement is two `vault_mounts` triggers plus a JS-layer `mountVault` refusal; a separate `vaults` identity-pin trigger permits only the legacy backfill and the future erasure transition (DEC-MEMOS-39).
- [ ] 40. `msp_vault_resolve`'s request is unsigned, matching zuri-ai's shipped `msp-vault-resolver.js` exactly — no `grant`/`signature` field — on the same stdio-only trust boundary already accepted for API-011 (DEC-MEMOS-40).
- [ ] 41. `msp_vault_resolve`'s response is additive-only; legacy fields unchanged in shape and casing, new principal-vault fields camelCase and safely dropped by the shipped, unmodified client (DEC-MEMOS-41).
- [ ] 42. `allow_passport` absent or not exactly `true` is a safe default (no passport vault provisioned or returned); the episodic vault resolves on every well-formed call with no gating flag (DEC-MEMOS-42).
- [ ] 43. API-009's `access_context` is one flat, snake_case object reusing `msp_vault_resolve`'s own field names, mandatory only for a principal-vault-type target; entity-id-only tools resolve entity → vault first, and `links_create` needs no independent second check (DEC-MEMOS-43).
- [ ] 44. `vault_scope_denied`'s meaning is broadened additively to cover an `access_context` mismatch; two new codes, `access_context_required` and `access_context_denied` (DEC-MEMOS-44).
- [ ] 45. `msp_memory_decay_tick` gains a `pinned` response field; a `principal_passport` vault always reports zero transitions regardless of `dry_run` (DEC-MEMOS-45).
- [ ] 46. Scoped `contexts` rows add nullable `tenant_id`/`principal_id` via a plain `ALTER TABLE`, both-or-neither enforced at the contracts layer; `include_payload` is refused unconditionally for a scoped row (DEC-MEMOS-46).
- [ ] 47. The live edit to `docs/API-009-Persistent-Memory-Contract.md` is deferred to `BL-MEMOS-063`'s own implementation-time commit, not part of this design pass (DEC-MEMOS-47).
- [ ] 48. New cross-repo item `BL-MEMOS-113`: zuri-ai's `validateVaultSet` must be updated to read and forward the new principal-vault response fields before they are usable in production, deferred to PH-MEMOS-8 (DEC-MEMOS-48).

Overturning any row above reopens the corresponding section of
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.6.0b named in its
mapping table (§3.1).

## Evidence and implementation map

- Prior design: [`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`](DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md) v0.6.0b (superseded in relevant part by this ADR + the design's own §0.1 review response)
- Cross-repo source read for `BL-MEMOS-105`: zuri-ai `msp-vault-resolver.js`/`msp-vault-resolver.test.js`/`msp-vault-memory-port.test.js`, `origin/main@4ca28c1d`
- Stage-1 code, the new source of truth for wire/schema shapes: `feat/memos-002-thread-memory` (worktree `agent-ab508b7a790efd268`), especially `migrations/0008_thread_memory.sql`, `packages/msp-core/src/domain/thread-memory.mjs`, `packages/msp-contracts/src/contracts/thread-access.mjs`, `apps/msp-server/src/transport/handlers/thread-guard.mjs`, and `docs/API-011-THREAD-MEMORY-CONTRACT.md`
- Unmerged branch (facts only, not read via git by this ADR's author): `origin/codex/msp-thread-memory`, commits `50859fb`, `e4303cb`
- Existing guard pattern the design's C-2 fix follows: [`packages/msp-contracts/src/contracts/vault-scope-guard.mjs`](../packages/msp-contracts/src/contracts/vault-scope-guard.mjs) (the fix itself, `grant-scope-guard.mjs`, does not exist yet — see the corrected C-2 entry above)
- Implementation plan: [`IMPLEMENTATION-PLAN-MEMORY-OS.md`](IMPLEMENTATION-PLAN-MEMORY-OS.md)
- Tier boundary this ADR stays inside: [`TIER-BOUNDARY-17-STAGE.md`](TIER-BOUNDARY-17-STAGE.md)
- Frozen legacy contract, unaffected: [`API-009-Persistent-Memory-Contract.md`](API-009-Persistent-Memory-Contract.md)

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.17b | 2026-09-16 | proposed | **PH-MEMOS-5 (principal vaults, API-010, API-009 `access_context` amendment) scoped for the first time — design pass only, not yet RKOI-reviewed.** Added a new revision-note section and **`DEC-MEMOS-36..48`** (13 new adopted defaults, pending owner confirmation) to the decision list, matching `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.6.0b §5–§5.5/§12.4–§12.4.1. Added a new "Cross-repo changes PH-MEMOS-5 requires of zuri-ai" section (`BL-MEMOS-113`, the `authorizationFacts()`/`allow_passport` gap) separate from `RSK-MEMOS-01`. Added checklist rows 36–48, unchecked. Corrected checklist item 7's stale placeholder migration number (`0009` → `0011`, `DEC-MEMOS-37`) without reopening `DEC-MEMOS-07`/`14`'s underlying merge-order rule. Extended "what this ADR does not decide" with the `0011`/`0012` DDL and the deferred API-009 contract-file edit (`DEC-MEMOS-47`). Updated the design-version citation to v0.6.0b throughout. No id renumbered or reused; new ids: `DEC-MEMOS-36..48`, cross-repo item `BL-MEMOS-113`. | working-tree | ATHER |
| 0.1.16b | 2026-09-15 | proposed | Owner confirmed DEC-MEMOS-22..35 ("ยืนยัน"); status-only change, no decision text altered. | working-tree | ATHER |
| 0.1.15b | 2026-09-15 | proposed | **Answers RKOI's PH-MEMOS-4 review round 3, NEEDS REVISION 1 critical plus 5 warnings** — new "Revision note — RKOI PH-MEMOS-4 review round 3" section. **CRITICAL**: decisions 34 and 35's own paragraphs in "the thirty-five decisions" still carried text withdrawn two rounds ago, even though the owner-confirmation checklist and the round-2 revision-note summary were already correct — decision 34's paragraph gains the second, ANDed `speaker_kind NOT IN ('HUMAN', 'AGENT')` disqualifying condition it was missing; decision 35's paragraph is rewritten to state both `dry_run` arms write a journal entry (only the nonce exemption is dry-run-specific), removing the withdrawn no-journal claim from the decision paragraph itself. **Warnings folded in (design-level)**: named the three-way branch's case 2b (a caller with `assertParticipants` can re-attach a *different*, departed third party on `GROUP`/`ROOM` threads, refused unconditionally on `DIRECT` by the existing schema constraint) in design §7 rule 2/§7.1/§15 and as `BL-MEMOS-052`'s fifth required case; narrowed the `close_for_relink` race's error mapping (design §7.1, §14, §15) to exactly `SQLITE_BUSY_SNAPSHOT`, stating that a plain `SQLITE_BUSY` propagates unmapped; named `dry_run: true`'s unbounded-journal-write tradeoff (design §11.2, §19) as the second stated exception to RKOI ruling 3's nonce pattern; added the missing "first-ever" qualifier to design §13's `msp_thread_message_append` row; bumped `BL-MEMOS-050`'s stale `design v0.5.1b` plan citation to v0.5.3b and expanded `BL-MEMOS-052`'s plan test list to all five required cases plus the raw-SQLite-error assertion. Two design-version citations in this ADR (Evidence map, checklist overturn note) pointed at v0.5.3b. Mirrored in `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.5.3b and `docs/IMPLEMENTATION-PLAN-MEMORY-OS.md` v0.1.15b. **No new `DEC-MEMOS`/`BL-MEMOS`/`RSK-MEMOS` id this round** — prose-only correction of already-adopted decisions. | working-tree | ATHER |
| 0.1.14b | 2026-09-15 | proposed | **Answers RKOI's PH-MEMOS-4 review round 2, NEEDS REVISION 2 critical (both subtler than round 1)** — new "Revision note — RKOI PH-MEMOS-4 review round 2" section records the decision-level consequences (full detail in the design's own updated §7 rule 2, §11.1, §11.2, §14, §15, §19). **CRITICAL 1, still open**: round 1's fix ("no current row" → "no row at all") was under-specified — both literal readings fail (a bare swap throws on `current.personId` for `null`; a null-hardened swap silently falls into `DEC-MEMOS-15`'s self-upgrade exception, re-admitting the rejoin with no claim). `BL-MEMOS-058` is re-specified as an explicit three-way branch (never-participated / participated-but-none-current / current-row-exists), with the rejoin case never reading `current` at all and never falling through to `DEC-MEMOS-15`. **CRITICAL 2, new**: `DEC-MEMOS-34` read `thread_participants` only, but `OPERATOR`/`UNKNOWN` speakers post messages with no participant row at all, so a sole-ever-`HUMAN` `GROUP` thread with an `UNKNOWN`-speaker message wrongly qualified and leaked that speaker's content into erasure-exemption and export (RKOI's probe reproduced it) — `DEC-MEMOS-34` gains a second, independent, ANDed disqualifying condition (no `thread_messages` row with `speaker_kind NOT IN ('HUMAN', 'AGENT')` anywhere on the thread; `AGENT` excluded, `UNKNOWN`/`OPERATOR` not). **Warnings folded in**: the ordering rationale was factually wrong for the query as specified (no `left_at` filter — both orderings identical) and is rewritten honestly as defense in depth, with the false "closing first would break the result" acceptance case replaced by a property test; the `dry_run` acceptance criterion ("row counts unchanged") was vacuous against an `UPDATE`-only mechanism and is replaced with a `redaction_state`-count/content-column assertion; the `close_for_relink` race's remaining raw `SQLITE_BUSY_SNAPSHOT` interleaving is now explicitly re-mapped to a typed `conflict`; the `speaker_id`/`person_id` disqualifying check is now two separate counts, either of which disqualifies (the prior SQL counted `speaker_id` only despite its own prose); `RSK-MEMOS-06` gains a stated permanent-erasure-gap consequence, no new id; `DEC-MEMOS-35`'s no-journal half is withdrawn — `dry_run: true` now also writes a journal entry, only the nonce exemption stays dry-run-specific; `migrations/0010`'s header now states its dependency on `0009` explicitly. **No new `DEC-MEMOS`/`BL-MEMOS`/`RSK-MEMOS` id this round** — `DEC-MEMOS-34`/`35`, `BL-MEMOS-058`/`059` and `RSK-MEMOS-06` are revised in place; consistency re-checked, no duplicates. | working-tree | ATHER |
| 0.1.13b | 2026-09-15 | proposed | **Answers RKOI's PH-MEMOS-4 review, NEEDS REVISION 4 critical** — new "Revision note — RKOI PH-MEMOS-4 review" section records the decision-level consequences of all four criticals (full detail in the design's own updated §7 rule 2, §11.1, §11.2, §12.3, §15, §19). Added **`DEC-MEMOS-34`** (erasure/export summary and delivery-table disposition restricted to threads where the principal is the thread's sole-ever `HUMAN` participant, a conservative under-erasure default stated as such — CRITICAL 2/3) and **`DEC-MEMOS-35`** (`msp_thread_retention_tick`'s `dry_run: true` is fully read-only, no nonce, no journal entry — WARNING 6), renaming the decisions section "the thirty-five decisions." Recorded **`BL-MEMOS-058`** (not a `DEC-MEMOS` id, an implementation correction) for CRITICAL 1's `thread-guard.mjs` rejoin fix, and the new **`migrations/0010_erasure_receipts.sql`** (provisional name) for CRITICAL 4 item (a)'s `scope_json` trigger fix, since `0008`/`0009` are checksum-locked and can no longer be edited in place. **Extended `close_for_relink`'s cross-repo item (WARNING 3) with the full generic thread-bound gate's caller shape** (`audienceKind`, room-hash-matching claims, `agentId`/`workspaceId`, `nonce`, an open `thread_agents` row), not only the two participant claims. **Corrected the owner confirmation checklist (WARNING 1): the 0.1.12b changelog claimed items 22–33 had been added; they had not been — this revision adds the real, unchecked items 22–35.** No id renumbered or reused; no new `RSK-MEMOS` id. New `BL-MEMOS` id: `058`. | working-tree | ATHER |
| 0.1.12b | 2026-09-15 | proposed | **PH-MEMOS-4 (participant lifecycle, erasure, retention, export) spec, fully scoped for the first time** — mirrors how PH-MEMOS-3 was scoped. Added **`DEC-MEMOS-22`** (`leave` always needs `assertParticipants`, self or other, never closes the thread), **`DEC-MEMOS-23`** (`close_for_relink`'s distinct claim is `assertRelink`, additive to `assertParticipants`, DIRECT-only), **`DEC-MEMOS-24`** (agent detach needs no new claim — the existing agent-currency gate already makes it self-only), **`DEC-MEMOS-25`** (resolves this ADR's own open "`data_subject_admin`: role or flag?" question — it is two new grant flags, `dataSubjectAccess`/`dataSubjectAdmin`, not a Membership role), **`DEC-MEMOS-26`** (tool names `msp_thread_principal_erase`/`msp_thread_principal_export`/`msp_thread_retention_tick`; retention reuses `operator` via an explicit name check), and **`DEC-MEMOS-27..33`** (erasure idempotency key shape and replay behavior; `erasure_receipts` stores the raw `principal_id`, not HMAC'd — W5 stays scoped to the journal; retention's deployment-wide `MSP_THREAD_RETENTION_DAYS` horizon, out-of-scope per-tenant policy carried against `RSK-MEMOS-06`; export excludes tombstoned content including the exporter's own erased rows; export ignores agent `visibility`; erasure/export's per-table selection operationalizes design §11.1 exactly; an unknown principal is a trivial success, never `not_found`, to avoid a new existence oracle). All twelve are adopted defaults pending owner confirmation. Updated the cross-repo change list's relink-caller item with `assertRelink`'s exact shape and added a new item for `BL-MEMOS-093`'s erasure caller (`dataSubjectAdmin`). Removed `data_subject_admin` from "What this ADR does not decide," since `DEC-MEMOS-25` now answers it. Extended the owner confirmation checklist with items 22–33. No id renumbered or reused; no new `RSK-MEMOS`/`BL-MEMOS` id (every risk is already tracked by `RSK-MEMOS-01`/`05`/`06`/`09`, and every backlog item this precision serves is already `BL-MEMOS-050..057`). | working-tree | ATHER |
| 0.1.11b | 2026-09-14 | proposed | Records the owner's confirmation of RKOI rulings 1–4 (2026-09-14): status line, the rulings section intro, and checklist rows. Every decision and ruling in this ADR is now owner-confirmed; status stays proposed until the docs merge. | working-tree | COORD |
| 0.1.10b | 2026-09-14 | proposed | Records the owner's confirmation of DEC-MEMOS-17..21 (2026-09-14): decision markers, the decisions heading and status line, and checklist items 17–21. RKOI rulings 1–4 stay pending. | working-tree | COORD |
| 0.1.9b | 2026-09-15 | proposed | **Folds RKOI's stage-2 review round 2 warnings after APPROVAL at commit `72e593f` (0 critical).** **Supersession unified**: round 1's own `thread_scope_denied` fix for the cross-agent case was itself a third oracle value; owner-direction ruling collapses unknown id / cross-agent `AGENT`-visibility / stage-1 ownership-status failure (previously `conflict`) into one identical `validation_failed` answer with a single fixed message. Added **`DEC-MEMOS-21`** (`agentId`/`workspaceId` bounded at 128 characters, no further charset constraint), promoted from unnumbered design prose. Extended the checklist with item 21 and reworded item 18's wording is unchanged from 0.1.8b (no further correction needed there this round). Every other round-2 finding (pending delivery's now-immutable stored agent; the drain re-check's corrected target thread; both delivery paths' real `speaker_id`; the nonce recorded on every resolve outcome; two wording corrections; `msp_session_sweep`'s new response fields; the `GATE-MEMOS-2`/`3` cross-zuri flip) is design/plan-level only, with no further ADR decision attached. Pointed every design-version reference at v0.4.2b. | working-tree | ATHER |
| 0.1.8b | 2026-09-15 | proposed | **Answers RKOI's stage-2 review round 1 on commit `f74ad0d` (NEEDS REVISION, 2 critical).** §12.2's schema itself passed unchanged. **`DEC-MEMOS-18` revised**: the worker attaches via `assertAgents` (never mints from a worker-only grant — `not_found` if the room has no thread) rather than being exempt from the agent gate; withdrew the wrong claim that "ending a `thread_agents` row" is revocation — detach is self-only and reversible, real revocation is Tier 1 withholding grants or a key rotation; stated plainly that the decision widens nothing (a compromised worker key already broke the whole tenant, `RSK-MEMOS-05`). Added **`DEC-MEMOS-19`** (default record `visibility` is `THREAD`) and **`DEC-MEMOS-20`** (nonce: ≥128 random bits, ≤128 chars, `(tenant_id, nonce)` key, 200-row bounded prune), both promoted from unnumbered design prose. Extended the cross-repo change list with the 128-random-bit nonce requirement on its own item and a new item: zuri-ai's outbound append's `agentId` must match the `speakerId: 'zuri-line-agent'` it already sends. Extended the owner confirmation checklist with items 19–20 and reworded item 18. Pointed every design-version reference at v0.4.1b, which carries both criticals' actual fixes (delivery's pending-path agent gate; dedup/supersession's `agent_id`/`visibility` inclusion) — this ADR records only the decision-level changes, per its own "what this ADR does not decide" boundary. | working-tree | ATHER |
| 0.1.7b | 2026-09-15 | proposed | **PH-MEMOS-3 stage-2 (multi-agent) spec** (owner direction 2026-09-14: proceed with the next planned work). Added **`DEC-MEMOS-17`** (no zuri-ai compatibility flag for stage 2 — the current grant fails closed once stage-2 verification ships, since activation is already gated behind `BL-MEMOS-090`) and **`DEC-MEMOS-18`** (the worker signs as the thread's own agent for `claim`/`commit`/`retry`, requiring agent-currency on the job's thread; `sweep` alone is exempt from "current" but still requires `agentId`/`workspaceId` present — rejecting a dedicated gate-exempt worker role as a duplicate mechanism), both adopted defaults pending owner confirmation. Extended the owner confirmation checklist with items 17–18 and the cross-repo change list with `DEC-MEMOS-17`'s note directly on the `agentId`/`workspaceId`/`nonce` items it qualifies. Pointed every design-version reference at v0.4.0b, which carries the actual grant/DDL/tool-surface/error-code specification for stage 2 (§6.1.1, §8, §9.4, §12.2, §13, §14, §15) — this ADR records only the two new owner-facing decisions, per its own "what this ADR does not decide" boundary. Every citation of `DEC-MEMOS-01..16` in this revision's new text reflects the owner's 2026-09-14 confirmation ("ยืนยัน", commit `214a7d2`), not pending status. | working-tree | ATHER |
| 0.1.6b | 2026-09-14 | proposed | Records the owner's confirmation of DEC-MEMOS-01..16 (2026-09-14): every decision marker and checklist item 1–16 now reads confirmed; item 7 is read as corrected by DEC-MEMOS-14. RKOI rulings 1–4 stay pending owner confirmation. Status stays proposed until BL-MEMOS-013 merges. | working-tree | COORD |
| 0.1.5b | 2026-09-15 | proposed | Folds RKOI's stage-1 code-review round-2 spec items (commit `445bd90`). Added **decision 16, `channel_type` mismatch** (pending owner confirmation): a resolve whose `channel_type` differs from an existing `ACTIVE` thread's stored value, for the same tenant/account/room hash, is refused `conflict`, never a silent cross-channel hit — replacing the design's earlier, wrong "same room regardless of transport label" claim; the room hash itself stays three segments. Added owner checklist item 16. Confirmed and recorded (design-side, cross-referenced here): `msp_session_sweep` is room-scoped, not tenant-scoped; zuri-ai has no `msp_session_*` caller — the only worker signing these grants is MSP's own `thread-summary-worker.mjs`. Every `DEC-MEMOS-01..15` reference updated to `01..16`; every `v0.3.4b` design-version reference updated to `v0.3.5b`. | working-tree | ATHER |
| 0.1.4b | 2026-09-15 | proposed | Folds RKOI's nine round-four warnings (docs **APPROVED, 0 critical**, commit `1c4a62f`) ahead of merge. Tightened **decision 15**: the self-upgrade check now also requires the *stored* participant row's own `person_id` (not only the incoming value), and states plainly that the transition is a mandatory close-old-row-plus-insert-new-row in one transaction, never an implementation choice — the append-only trigger permits nothing else; recorded that a silently-ignored downgrade means MSP's own state does not implement revocation. Moved the `personId`-change lock-up risk mechanism into `RSK-MEMOS-01`'s cross-repo item 4 directly, rather than only pointing at it from decision 15. Removed the evidence map's citation of RKOI's session-scratch probe scripts (never part of this repository); pointed every design version reference at v0.3.4b. Noted `BL-MEMOS-111` (a cross-room authorization gap with no prior backlog row) as a round-four finding on the code side. | working-tree | ATHER |
| 0.1.3b | 2026-09-14 | proposed | Answers RKOI's round-three NEEDS REVISION on commit `6d1a801` (1 critical): zuri-ai's real delivery grant carries neither `channelType` nor `audienceKind` (`msp-thread-memory-port.js:420-422`) — corrected the design accordingly per owner direction (a), dropping `channel_type` from the room HMAC and every `channelType` grant requirement. Added **DEC-MEMOS-15** (assurance self-upgrade needs no `assertParticipants` under four stated conditions; a downgrade is silently ignored), closing a real correctness gap in the append flow. Corrected the cross-repo change list: removed the sentence claiming `assertParticipants` "needs no zuri-ai change" (it read as contradicting items 4 and 5); restated item 5 (assurance-upgrade caller) as resolved MSP-side by DEC-MEMOS-15, needing no zuri-ai change for the normal case; kept item 4 (relink/merge caller) as a real, still-open cross-repo change on the activation gate. Extended the owner confirmation checklist with DEC-MEMOS-15 and pointed every version reference at design v0.3.3b. | working-tree | ATHER |
| 0.1.2b | 2026-09-14 | proposed | Answers RKOI's round-two NEEDS REVISION on commit `92cb591` (1 critical: wrong wire values, fixed in the design against KIN's now-shipped stage-1 code, not this ADR's decision list directly). Corrected ruling 1's wording: a new required grant field (`agentId`/`workspaceId` in stage 2) is a cross-repo change to negotiate via `RSK-MEMOS-01`/`BL-MEMOS-090`, not something this ADR can declare "out of bounds." Added two items to the cross-repo change list: a caller for `close_for_relink` (nothing calls it today) and a caller for an `identity_assurance` upgrade (nothing asks for one today) — both flagged by RKOI as missing next to the existing `agentId`/`nonce`/`assertAgents`/`assertParticipants` items. Pointed the evidence map at the actual stage-1 code as the new source of truth for wire/schema shapes. | working-tree | ATHER |
| 0.1.1b | 2026-09-14 | proposed | Answers RKOI's NEEDS REVISION on commit `2f4d584` (3 critical findings, all in the companion design's DDL/wire shapes, not this ADR's decision list directly). Corrected the C-2 citation, which wrongly named an already-existing `thread-scope-guard.mjs`; the real fix is a new `grant-scope-guard.mjs`. Recorded RKOI's rulings on all four of ATHER's prior judgement calls (narrow capability growth, conditional per-tenant keyring, conditional nonce split with a named stage-1 gap, single persisted `thread_kind`). Added four new adopted defaults: DEC-MEMOS-11 (relink closes the thread and mints a new one), DEC-MEMOS-12 (first HUMAN membership created by append, bound to the grant's own principal — zuri-ai's resolve carries no `participants` field), DEC-MEMOS-13 (no separate `msp-thread-memory` package — the store stays in `msp-core`), DEC-MEMOS-14 (agent fields and `grant_nonces` ship in stage 2, not `0008`; migration numbers assigned in merge order, correcting decision 7's pre-bound `0009`). Added the cross-repo change list stage 2 requires of zuri-ai (`agentId`/`workspaceId` required, `nonce`, `assertAgents`, `assertParticipants`), cross-referenced with the plan's `RSK-MEMOS-01`. Extended the owner confirmation checklist accordingly. | working-tree | ATHER |
| 0.1.0b | 2026-09-14 | proposed | Initial ADR: reconciled the unmerged `codex/msp-thread-memory` branch (API-010-labelled, ten tools, two migrations, C-1/C-2 critical findings) against `DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.2.3b's from-scratch, unshipped design. Adopted RKOI's ten recommended defaults as pending-confirmation decisions, renamed the branch surface to API-011, and specified the multi-user (one human per DIRECT thread, subject-bound protected records, explicit-claim-only participation changes) and multi-agent (`thread_agents` relation, per-agent episodic vaults, AGENT/THREAD record visibility, shared passport and summaries) model neither prior effort fully covered. Flagged two judgement calls (grant capability growth; optional per-tenant keyring) for owner review. | working-tree | ATHER |

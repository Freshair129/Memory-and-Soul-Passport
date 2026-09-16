---
version: "0.1.25b"
created_at: "2026-09-14T10:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-17T00:15:00+07:00,ATHER"
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
**`DEC-MEMOS-36..52`, added in this revision (PH-MEMOS-5 scoping,
2026-09-16, `36..48` original round; `49..52` added answering RKOI's
PH-MEMOS-5 review round 1, also 2026-09-16), were confirmed by the owner
on 2026-09-16** ("ตามนั้น"), the same way `22..35` were confirmed on
2026-09-15. **`DEC-MEMOS-53`, added 2026-09-16 as a PH-MEMOS-6
deliverable — not a PH-MEMOS-5 decision, and does not reopen or block
PH-MEMOS-5's own confirmation status — was confirmed by the owner in the
same 2026-09-16 answer**, checklist item 53 now checked, the same status
`36..52` carry. **All fifty-three decisions were confirmed by the owner as
of 2026-09-16's answer.** **REOPENED, same day, by RKOI's first PH-MEMOS-5
code review round and an independent Fable review of the same commit
(vault-isolation existence oracle, plus the `msp_vault_resolve`
journal-receipt leak, see both revision notes above): `DEC-MEMOS-44`,
`DEC-MEMOS-49` and `DEC-MEMOS-50` are revised and no longer stand as
owner-confirmed text — the confirmation above covered a version of all
three that these findings show was wrong — and `DEC-MEMOS-54`/`55` are
adopted defaults, not yet put to the owner. Checklist items 44, 49, 50, 54
and 55 are unchecked below pending re-confirmation; `PH-MEMOS-5`'s own
`GATE-MEMOS-5` (plan) is reopened with them, since `BL-MEMOS-060..063`/`066`
must implement the corrected vocabulary and the keyed `vault_id`
derivation, not what RKOI's round-4/5 docs review previously approved.**
The `scrypt` work factor named in decision 53 is confirmed as specified:
`BL-MEMOS-076` measures real wall-clock cost first and tunes from the
measurement, so `N=16384, r=8, p=1` is confirmed as a starting point, not
frozen as a final value. **Not covered by this confirmation, and not
written into decision 53 or any other decision as adopted: whether
domain separation and key versioning should extend to the journal's own
`principalHmac` pseudonym and to room-ref hashing** — that question was
raised alongside decision 53 with no proposal attached, and stays an open
owner question (design §19), unconfirmed. This ADR authorizes design
work, not a merge — merge still waits on the owner's own explicit
instruction to proceed.

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

## Revision note — RKOI PH-MEMOS-5 code review round 1, CRITICAL — vault-isolation existence oracle (2026-09-16)

RKOI's first code-level review round of KIN's PH-MEMOS-5 implementation
(worktree `feat/memos-008-principal-vaults`) found a gap in the **approved
spec itself**, not an implementation error: `access_context` is checked
*after* the vault/entity lookup on every one of the nine `msp_memory_*`
call sites `DEC-MEMOS-49` specifies, and `domain/vault-registry.mjs`'s
`stableId(...)`/`domain/entity-store.mjs`'s `computeEntityId(...)` are
unkeyed hashes of the owner tuple / `(vault_id, category, key)` — so a
caller who never resolves a real vault and sends no `access_context` at all
can still tell a real principal's vault or entity apart from a nonexistent
one, by the difference between `not_found` (`requireKnownVault`/
`requireEntityById`) and `access_context_required`/`access_context_denied`
(the new `assertAccessContext` call sites `DEC-MEMOS-49` added).
`RSK-MEMOS-09`'s own "accepted for stage 1: zuri-ai's ids are random and
unguessable" premise is withdrawn as a defense here and does not extend to
this case — principal vault/entity ids are neither random nor unguessable;
they are deterministic functions of `tenant_id`/`principal_id`/`agent_id`/
`workspace_id`/`category`/`key`, several of which (a LINE user id, for
instance) are often already known to an attacker.

Two structural fixes were weighed; one is adopted in place below.

**(b), a keyed `vault_id` derivation, is rejected outright, not merely
disfavored.** `DEC-MEMOS-50`'s own derive-then-probe scheme (round 3, this
same document) exists *because* the provisioning path must never read
`MSP_IDENTITY_HMAC_KEY`: three earlier mechanisms (a `principal_id`-keyed
lookup, then a `principal_hmac`-keyed lookup) already broke on erasure and
on key rotation for exactly this reason, and RKOI's own round-2/round-3
findings against this document are the record of it. A keyed `vault_id`
would need that same key available to the *provisioning* probe to find the
next epoch — reopening the identical rotation failure `DEC-MEMOS-50` was
rewritten three times to close, for a mechanism RKOI already approved and
directed not be changed. No extraordinary argument survives this: (b) is
rejected.

**(a), literally as first proposed ("an absent vault/entity answers the
same as a denied one"), is also rejected, not adopted with modification.**
Tracing it through the legacy contract shows why: `access_context` is
optional and *ignored* for a legacy vault (`DEC-MEMOS-43`), so "absent
`access_context` leaves legacy behavior unchanged" is a promise that holds
per caller, not per lookup — a legacy caller never sends `access_context`
at all and must keep getting today's `not_found` for a nonexistent id and
today's success for an existing one. The lookup runs before the target's
vault type is known, so the server cannot decide, case by case, whether a
failed lookup "would have been" legacy (must stay `not_found`) or principal
(may become `access_context_required`-shaped) — collapsing *toward* the
`access_context_required`/`access_context_denied` shape is therefore itself
a regression against the legacy promise: every legacy caller's existing
`not_found` on a bad id would start reading as `access_context_required`
some of the time, for an id that was never a principal vault at all.

**Adopted: the inversion — an existing-but-unauthorized principal vault or
entity answers exactly `not_found`, byte-for-byte the same class and
message a nonexistent one already produces for that same caller-supplied
id.** This is the only direction of the collapse the legacy-preservation
constraint permits: `not_found` is already every legacy caller's answer for
a bad id, so extending it to also cover "exists, but you may not see it"
adds no new legacy-facing behavior, where the reverse direction breaks an
existing one. Concretely: `AccessContextRequiredError`/
`AccessContextDeniedError` and the `access_context_required`/
`access_context_denied` codes `DEC-MEMOS-44`/`49` introduced are retired as
*producible* wire outcomes — no tool in this design raises them any longer.
The classes stay declared in `contracts/errors.mjs`, unused — the same
"still reserved, still not raised anywhere" posture the design's own §14
already accepts for `PrincipalErasedError` — not deleted, in case a future
surface with genuinely unguessable ids can use them without this exposure.
This finding reopens and revises `DEC-MEMOS-44` and `DEC-MEMOS-49` below
(now marked **REOPENED, pending owner re-confirmation** — they are not
among the decisions the owner's 2026-09-16 "ตามนั้น" confirmed, since that
confirmation predates this finding) and adds `DEC-MEMOS-54`, which extends
the identical fix to `msp_vault_mount` (a `principal_private`/
`principal_passport` `vault_id` is now indistinguishable from an unknown
one, not merely refused with a different code — `DEC-MEMOS-39` corrected in
place) and to `msp_context_diff`/`msp_context_audit`/`msp_context_replay`
(for consistency of the `access_context` vocabulary; `context_id` is a
random `randomUUID()`, not derivable from any identifier, so this second
application closes a structural inconsistency — an authorization failure
throwing where an unknown id silently returns a "not found"-shaped success
— rather than a comparably severe guessable-id exposure). Full
specification: `DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.4b §5.1,
§5.2, §5.4, §14, §15, §19.

**Stated plainly, what this fix does not close**: a caller co-located on
this stdio-only trust boundary can still observe a timing difference
between a `SELECT` that finds nothing and one that finds a row and compares
a tuple against it — this design does not claim constant-time comparison
anywhere, here or elsewhere, and this residual is accepted on the same
stdio-only-boundary reasoning `RSK-MEMOS-05`/`RSK-MEMOS-11` already rely on,
not eliminated by this revision. `docs/IMPLEMENTATION-PLAN-MEMORY-OS.md`'s
`RSK-MEMOS-09` is corrected in place to state explicitly that its own "ids
are random and unguessable" acceptance is scoped to the stage-1 API-011 ids
it was written about and does not, and never did, extend to the PH-MEMOS-5
principal-vault/entity ids this finding concerns; a new risk,
`RSK-MEMOS-15`, records the accepted timing residual above.

## Revision note — RKOI/Fable joint review, CRITICAL — keyed `vault_id` derivation (2026-09-16)

An independent Fable review of the same PH-MEMOS-5 commit, folded in
alongside RKOI, found one new critical and two gaps the revision note
above did not close, all three tracing to the same root cause the prior
note only partly addressed: **`vault_id` is a keyless hash, so it is not
merely an online oracle problem — the id itself encodes `principal_id`,
recoverable by anyone who obtains a real `vault_id` at all, with no server
contact needed.** This reopens the prior note's rejection of option (b).

**New CRITICAL — `msp_vault_resolve`'s journal receipt leaks the raw
principal id.** `vault-resolve-handler.mjs:145-159` HMACs the journal
`actor` correctly (`"principal_hmac:" + computePrincipalHmac(...)`) but
writes `ref: result.principalPrivateVault.vault_id` — a keyless hash whose
preimage, before this revision, was exactly `(tenant_id, principal_id,
agent_id, workspace_id, provision_epoch)` — alongside a plaintext payload
carrying three of those five fields. Proved live: a resolved
`principal_id: "line-user-000042"` recovered from `ref` on the first
dictionary match against the payload's other fields. HMAC-ing `actor`
while `ref` stays keyless over the identical tuple is self-cancelling —
this falsifies design §15's own "no raw person id appears anywhere in a
journal payload" invariant, and the receipt is reachable in-band through
`msp_context_audit` (a separate fix, KIN's).

**Confirmed, not a new finding: `msp_vault_mount` is the second existence
oracle the prior revision note's own `DEC-MEMOS-54` already closes** — a
known principal `vault_id` there answered `vault_scope_denied`, an unknown
one `not_found`; that fix stands, restated here only because Fable's
review named it independently and it must stay in step with everything
below.

**Offline derivability itself survives any wire-level fix, stated
plainly.** Because `stableId` is keyless, anyone who already knows a
tuple derives `vault_id` with no server contact at all, and anyone who
reads a receipt (before the fix above) inverts it. The not-found collapse
closes the *online* oracle (probing a computed id against a live server);
it does nothing about a caller who already has a real `vault_id` through
some other channel. This also affects the entity-id-only tools
(`msp_memory_history`/`forget`/`links_list`, and `msp_memory_links_create`
on both endpoints) exactly as already specified — they resolve the entity
before the check — and `links_create`'s own pre-existing cross-vault
refusal message discloses both real `vault_id` values
(`memory-handlers.mjs:457-458`), a second, narrower leak of the same kind.

**Re-examined on the merits: option (b), keyed `vault_id` derivation, is
now partially adopted — not the mechanism the prior revision note
correctly rejected, a narrower one that satisfies every constraint that
mechanism violated.** The prior note's rejection was accurate against
what it described: keying the *lookup* — recomputing or comparing a
hash to find an existing row — breaks under erasure (round 1) and key
rotation (round 2), which is exactly why `DEC-MEMOS-50` round 3 replaced
both with a plaintext-column lookup for active rows and an
existence-probe for minting new ones. **Neither of those two mechanisms
needs `vault_id`'s own preimage to be unkeyed — only the *lookup*
mechanism needs to be key-independent, and round 3's lookup already is,
for a reason this note did not previously separate out:**

- The "does an active vault already exist for this tuple" question is
  answered by a **plaintext** `WHERE tenant_id = ? AND principal_id = ? AND
  agent_id = ? AND workspace_id = ? AND status = 'active'` query — it never
  computes or compares a `vault_id` at all, so it cannot care whether
  `vault_id`'s own preimage is keyed.
- The "what is the next unused epoch" question is answered by probing
  candidate `vault_id`s for existence (`SELECT 1 FROM vaults WHERE
  vault_id = ?`), using the tuple **this call** already has in plaintext —
  never a stored or historical value. Recomputing that candidate with a
  keyed `principal_id` component, using whichever key is current *right
  now*, needs nothing that must survive erasure (this call's own
  `principal_id` is never read back from a blanked row) and nothing that
  must survive rotation (a re-engagement after rotation computes a
  *different* candidate than the original key would have, which cannot
  collide with the original row's `vault_id` — no epoch-increment is even
  required to avoid the collision rounds 1/2 hit).

**Adopted**: `vault-resolve-handler.mjs` (the handler, never
`domain/vault-registry.mjs`) computes `HMAC-SHA256(MSP_IDENTITY_HMAC_KEY,
"vault-id:" + principal_id)` and passes that, not raw `principal_id`, as
the `stableId(...)` preimage component `provisionPrincipalPrivateVault`/
`PassportVault` use — `VaultRegistry` itself still reads no crypto/env
dependency, receiving an opaque string, the identical pattern the journal
actor pseudonym already establishes. This closes §5.1's oracle at its
source (a caller without `MSP_IDENTITY_HMAC_KEY` cannot compute a
candidate `vault_id` for any guessed `principal_id` at all — there is no
id to probe with, online or offline) and, as a direct, verified
consequence, closes the journal-receipt leak above (`ref`'s preimage no
longer contains recoverable `principal_id`). No new column, no new
migration — `0011` is unchanged; the active-row lookup, the epoch probe,
`VaultProvisionConflictError` handling and `PROVISION_EPOCH_PROBE_LIMIT`
are all mechanically unchanged. `DEC-MEMOS-50` is revised in place a fifth
time below. The not-found collapse (`DEC-MEMOS-44`/`49`/`54`) is **retained**,
not superseded — it is what protects a caller who already possesses a real
`vault_id`/`entity_id` some other way (a leak, or their own legitimate
resolve) from learning anything more by omitting or mismatching
`access_context`. `msp_memory_links_create`'s message is corrected to stop
naming the two real `vault_id` values (`DEC-MEMOS-55`, new).

**What an attacker can still learn after both fixes, stated plainly**:
(1) a caller who compromises `MSP_IDENTITY_HMAC_KEY` can still invert a
keyed `vault_id` for its `principal_id`, the same posture `DEC-MEMOS-53`
already accepts for `erasure_receipts` — a fast HMAC, not `erasure_receipts`'s
slower `scrypt`, since `vault_id` is on the hot path of every request and
a slow KDF there is not a viable tradeoff; (2) `tenant_id`/`agent_id`/
`workspace_id` stay plaintext in `vault_id`'s preimage, unchanged — only
`principal_id` is keyed, consistent with this document's own established
distinction that it is the one person identifier these ids carry; (3) the
stdio-only timing residual `RSK-MEMOS-15` already names is unaffected;
(4) `msp_vault_resolve` provisions `workspace_private`/`shared`/
`global_private` unconditionally, before any `allow_*` flag, and
`global_private`'s own `vault_id` stays an unkeyed hash of `agent_id`
alone, fully ungated for reads/writes once known — both **stated, not
fixed, here**, pre-existing and out of PH-MEMOS-5's scope
(`RSK-MEMOS-16`, new; `RSK-MEMOS-12` corrected to name all four vault
types this unsigned call provisions, not only the two principal ones).
Full specification: `DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.5b
§5.2, §5.3, §5.5, §15, §19; `docs/IMPLEMENTATION-PLAN-MEMORY-OS.md` §3, §7.

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
    **Storage half superseded, PH-MEMOS-6, 2026-09-16 — see `DEC-MEMOS-53`
    below.** `erasure_receipts` no longer stores the raw `principal_id`;
    a keyed-then-slow-derived `principal_hmac` replaces it. This
    decision's own confirmation stands as a historical record of what was
    decided and confirmed on 2026-09-15; it is not un-confirmed by
    `DEC-MEMOS-53`. The **permanence** half of this decision — the row
    is never updated or deleted — is unchanged and is not superseded.
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
    pinned per type by a `CHECK`, not a caller-chosen setting. — *confirmed
    by the owner, 2026-09-16.* (design §5, §12.4).
37. **DEC-MEMOS-37, migration numbers.** The principal-vaults migration is
    `0011`; scoped `contexts` receipts is its own migration, `0012` —
    both provisional per `DEC-MEMOS-14`'s merge-order rule, now concrete
    because `0008`/`0009`/`0010` are confirmed already merged to `main`
    as thread memory, `thread_agents` and `erasure_receipts`. — *confirmed
    by the owner, 2026-09-16.* (design §12.4, §12.4.1).
38. **DEC-MEMOS-38, `vaults` rebuild strategy.** The migration uses the
    `-- msp-migration: foreign-keys=off` directive and the safe
    create/copy/drop/rename order (`docs/MIGRATION.md`), since `vaults`
    is a real parent table with four existing child tables
    (`vault_mounts`, `entities`, `promotions`, `links`) and SQLite cannot
    alter a `CHECK` in place. The per-type owner `CHECK`s exempt an
    erased row (`status = 'erased'`, `principal_id` blanked) in advance,
    but the erasure transition itself is out of this phase's scope
    (PH-MEMOS-6). — *confirmed by the owner, 2026-09-16.* (design §12.4).
39. **DEC-MEMOS-39, never-mountable enforcement.** Two triggers on
    `vault_mounts` (`BEFORE INSERT`/`BEFORE UPDATE`) refuse a mount
    naming a `principal_private`/`principal_passport` `vault_id` at the
    database layer; `VaultRegistry#mountVault` refuses the same case at
    the JS layer first — deliberate defense in depth, not redundant
    duplication. A separate `vaults` identity-pin `UPDATE` trigger
    permits only the pre-existing legacy `project_id` backfill and the
    (deferred) erasure transition, pinning every other column on both
    branches. — *confirmed by the owner, 2026-09-16.* (design §5.2, §12.4).
40. **DEC-MEMOS-40, `msp_vault_resolve`'s request matches zuri-ai's
    shipped, unsigned caller exactly.** No `grant`/`signature` field, no
    HMAC, no expiry — resolved in favor of matching what
    `msp-vault-resolver.js` actually sends (`origin/main@4ca28c1d`) rather
    than extending API-011's signed-grant model to a tool that would then
    be uncallable by the one real caller that exists. Accepted on the
    same stdio-only trust boundary already accepted for the entire
    API-011 surface (`RSK-MEMOS-05`) — not a new, weaker precedent. —
    *confirmed by the owner, 2026-09-16.* (design §5.3).
41. **DEC-MEMOS-41, `msp_vault_resolve`'s response is additive-only.**
    `workspacePrivateVaultId`/`globalPrivateVaultIds`/`sharedVaultIds`/
    `permissions.{read,writePrivate,writeShared,policyVersion}` keep
    their exact shape and camelCase casing; new
    `principalPrivateVaultId`/`principalPassportVaultId`/
    `permissions.allowPassport` fields use the same casing convention and
    are silently dropped by the shipped client's own `validateVaultSet`
    until it is updated (`BL-MEMOS-113`, decision 48) — confirmed safe by
    reading that function's source, not assumed. — *confirmed by the owner,
    2026-09-16.* (design §5.3).
42. **DEC-MEMOS-42, `allow_passport` gating is safe by default.**
    zuri-ai's shipped `authorizationFacts()` does not send `allow_passport`
    at all; MSP treats its absence, or any value other than the literal
    `true`, identically to `false` — no passport vault provisioned or
    returned. The episodic (`principal_private`) vault, by contrast,
    resolves and is lazily provisioned on every well-formed call, gated
    by no flag — matching the design's own tier table ("this principal's
    turns with this agent in this workspace," every turn). — *confirmed
    by the owner, 2026-09-16.* (design §5.3, §5.5).
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
    one vault before this amendment's logic ever runs. — *confirmed by the
    owner, 2026-09-16.* (design §5.1).
44. **DEC-MEMOS-44, error-code vocabulary for the amendment — corrected
    (RKOI PH-MEMOS-5 review round 1, CRITICAL 1); REOPENED and revised a
    second time (RKOI PH-MEMOS-5 code review round 1, CRITICAL,
    2026-09-16 — the vault-isolation existence oracle, see the revision
    note above), pending owner re-confirmation.** `vault_scope_denied`
    is **not** broadened by this amendment — the prior text's "broadened
    additively" claim is withdrawn, since none of the nine `msp_memory_*`
    tools ever produced `vault_scope_denied` in the first place (they
    perform no caller-ownership check on a legacy vault; confirmed by
    reading `memory-handlers.mjs`'s own header comment). **The "two
    genuinely new codes" text this paragraph previously carried
    (`access_context_required`/`access_context_denied`, both produced by
    the new `assertAccessContext` call sites) is withdrawn as an error
    vocabulary for these nine tools — it is exactly the oracle the
    revision note above closes.** A `vault_id`/`entity_id` computed
    offline (both are unkeyed hashes — `domain/ids.mjs#stableId` for
    `vault_id`, `domain/entity-store.mjs#computeEntityId` for
    `entity_id`) let a caller distinguish "this principal vault/entity
    exists" from "it does not" using only the difference between
    `not_found` and `access_context_required`/`access_context_denied`,
    with no `access_context` needed at all. **Corrected vocabulary**: an
    `access_context` outcome other than `null`/`'ok'` from
    `classifyPrincipalAccess` (§5.2) — whether the field is absent
    entirely or present but wrong — now produces exactly `not_found`, the
    identical `MemoryNotFoundError` class and message template the same
    tool already raises for that same caller-supplied `vault_id`/
    `entity_id` when it does not exist at all; the two are byte-identical
    in every observable except timing (see the revision note above).
    `AccessContextRequiredError`/`AccessContextDeniedError` and the
    `access_context_required`/`access_context_denied` codes stay declared
    in `contracts/errors.mjs` — unused, the same "still reserved, never
    raised" posture already accepted for `PrincipalErasedError` — but no
    tool in this design produces them any longer. — *pending owner
    re-confirmation, 2026-09-16.* (design §5.1, §14).
45. **DEC-MEMOS-45, `msp_memory_decay_tick`'s `pinned` field.** The
    response gains `pinned: boolean`, read from the target vault's own
    `decay_policy` column — `true` only for `principal_passport`. When
    `true`, `evaluated`/`transitioned` are always `0`/`[]` regardless of
    `dry_run`, a distinct statement from `dry_run`'s own
    computed-but-not-persisted contract, never conflated with it. —
    *confirmed by the owner, 2026-09-16.* (design §5.1).
46. **DEC-MEMOS-46, scoped `contexts` receipts — corrected (RKOI
    PH-MEMOS-5 review round 1, CRITICAL 3).** `tenant_id`/`principal_id`,
    both nullable, added by a plain `ALTER TABLE` (no rebuild —
    `contexts` is not FK-referenced by any other table); both-or-neither
    is enforced at the contracts layer (`context-scope-guard.mjs`), not a
    database `CHECK`, mirroring `migrations/0006_links.sql`'s own
    precedent for an app-layer-only cross-column invariant.
    `include_payload` — a field `msp_context_diff` alone carries — is
    refused for a scoped row unconditionally on `msp_context_diff`, even
    given a correctly-matching `access_context` — it is not a second read
    path around the entity-level checks decision 43 already adds.
    `msp_context_audit`/`msp_context_replay` need no equivalent
    suppression, since neither exposes any payload field at all (the
    prior text wrongly named all three tools). — *confirmed by the owner,
    2026-09-16.* (design §5.4, §12.4.1).
47. **DEC-MEMOS-47, the API-009 contract file's own edit is deferred to
    implementation time.** This design pass fully specifies the
    `access_context` amendment's content (decision 43–45) but does not
    itself edit `docs/API-009-Persistent-Memory-Contract.md` — that
    version bump and Changelog row are `BL-MEMOS-063`'s own
    implementation-time deliverable, the same precedent already set for
    API-011's contract file versus its design-doc specification
    (design §6.1.1). — *confirmed by the owner, 2026-09-16.* (design §5.1).
48. **DEC-MEMOS-48, new cross-repo item `BL-MEMOS-113`.** zuri-ai's
    `msp-vault-resolver.js`/`validateVaultSet` must be extended to read
    and forward `principalPrivateVaultId`/`principalPassportVaultId`/
    `permissions.allowPassport` before a caller can actually *use* a
    principal vault `msp_vault_resolve` resolves — until then these
    fields are safely, silently dropped by the shipped client (decision
    41), not broken. Deferred to `PH-MEMOS-8`, alongside
    `BL-MEMOS-106`/`092`/`093`, since production use is itself deferred
    by owner direction (2026-09-14). — *confirmed by the owner,
    2026-09-16.* (design §5.3.1).
49. **DEC-MEMOS-49, new (RKOI PH-MEMOS-5 review round 1, CRITICAL 1;
    revised in place, RKOI PH-MEMOS-5 review round 2, CRITICAL 3/WARNING
    3) — the `access_context` gate is nine new call sites, not a reuse of
    `assertVaultScope`'s existing one, and its branch logic has exactly
    one normative statement.** `domain/vault-registry.mjs` gains
    `classifyPrincipalAccess(vault, accessContext)`, returning a
    three-way outcome (`null`/`'access_context_required'`/
    `'access_context_denied'`/`'ok'`) a boolean cannot express; it is
    built on a new, private, row-taking `#isVaultRowAccessibleTo(vault,
    ctx)`, called directly with the row `classifyPrincipalAccess` already
    has (no second `SELECT` — round 1's text said it called the
    `SELECT`-performing public `isVaultAccessibleTo(vault.vault_id,
    {...})`, which would have re-fetched a row already in hand, WARNING
    3). `#isVaultRowAccessibleTo` is the single normative branch set for
    this gate — round 1's design §5.1 carried its own, looser, duplicate
    copy that never checked `vault.status`; that copy is removed, and
    `#isVaultRowAccessibleTo` now refuses `status !== 'active'` before any
    tuple comparison, folded into the existing `access_context_denied`
    answer rather than a new oracle (CRITICAL 3 — an erased principal
    vault's still-populated `tenant_id`/`agent_id`/`workspace_id` columns,
    since erasure blanks only `principal_id`, previously matched and read
    `'ok'`). The public `isVaultAccessibleTo(vaultId, ctx)` (`mountVault`'s
    sole caller) becomes a thin `SELECT`-then-delegate wrapper around the
    same private helper. `assertVaultScope`'s own signature and its one
    existing call site (`msp_memory_links_create`'s endpoint-consistency
    check) are unchanged. Neither `classifyPrincipalAccess`'s DB read nor
    the contracts-layer translation of its outcome (below) together widen
    `msp-contracts`' own "no `.prepare(`/`.exec(`/`.pragma(` anywhere"
    structural proof.

    **REOPENED and revised a third time (RKOI PH-MEMOS-5 code review
    round 1, CRITICAL, 2026-09-16 — the vault-isolation existence oracle,
    see the revision note above), pending owner re-confirmation.**
    `classifyPrincipalAccess(vault, accessContext)`'s own three-way return
    contract is unchanged by this correction — it still returns
    `null`/`'access_context_required'`/`'access_context_denied'`/`'ok'`,
    and is still called with the row the tool's own
    `requireKnownVault`/`getVaultById` lookup already has, no second
    `SELECT`. **What changes is the contracts-layer translation of that
    outcome into a wire error at all nine call sites, and at
    `msp_memory_links_create`'s tenth (case 3): `contracts/vault-scope-
    guard.mjs`'s `assertAccessContext(outcome, message)` export, and the
    two error classes it threw (`AccessContextRequiredError`/
    `AccessContextDeniedError`), are no longer called from any of these
    call sites.** A non-`null`/non-`'ok'` outcome now raises the identical
    `MemoryNotFoundError` — same class, same message text — the calling
    tool's own `requireKnownVault`/`requireEntityById` already raises for
    that same caller-supplied `vault_id`/`entity_id` when it does not
    exist; every one of these nine (ten, counting `links_create`'s own
    case 3) call sites constructs that message itself, from the same
    string template its own existing not-found path uses, rather than
    calling a generic `assertAccessContext`. `assertAccessContext` and its
    two error classes stay defined in `contracts/vault-scope-guard.mjs`/
    `contracts/errors.mjs` — unused by this design, not deleted (see
    `DEC-MEMOS-44`'s revised paragraph for why). — *pending owner
    re-confirmation, 2026-09-16.* (design §5.1, §5.2).
50. **DEC-MEMOS-50, new (RKOI PH-MEMOS-5 review round 1, CRITICAL 2;
    revised in place a second time, RKOI PH-MEMOS-5 review round 2,
    CRITICAL 1/2; revised in place a third time, RKOI PH-MEMOS-5 review
    round 3, CRITICAL 2 — the most consequential finding of that round) —
    principal-vault re-provisioning after erasure mints a genuinely new
    `vault_id` for the tuple's next generation, found by probing for the
    id's own existence, never by a lookup keyed on any stored column, and
    a genuine provisioning race is refused without any internal retry.**
    A `vaults.provision_epoch INTEGER NOT NULL DEFAULT 0` column folds
    into the deterministic `vault_id` computation (`stableId(...,
    String(epoch))`). **Round 1's own fix keyed re-provisioning's lookup
    on `principal_id`, which §12.4's own `CHECK` blanks to `NULL` on
    erasure — collided.** **Round 2's fix replaced that lookup with a new
    column, `vaults.principal_hmac TEXT`, pinned across the erasure
    transition instead of blanked — but `principal_hmac` is itself
    computed from `MSP_IDENTITY_HMAC_KEY`, so it does not survive that
    key's rotation: RKOI reproduced provisioning under one key, erasing,
    rotating the key, then re-engaging, and got the identical `PRIMARY
    KEY` collision a third time.** **Round 3 drops the stored lookup
    column entirely and finds the next epoch by probing `vault_id`'s own
    existence directly** — `stableId(..., String(epoch))` computed from
    the owner tuple this call already has in plaintext, checked against
    `vaults.vault_id` at epoch `0`, incrementing and recomputing on a hit
    — which needs nothing that must survive erasure and nothing keyed by
    `MSP_IDENTITY_HMAC_KEY`, since neither is an input to the probe at
    all. `vaults.principal_hmac` is removed from the schema; it survives
    only as `msp_vault_resolve`'s own transient, per-call journal-actor
    pseudonym (design §5.3), no longer threaded into `VaultRegistry`. Two
    other candidates were weighed and rejected on the record (design
    §5.2): keeping `principal_hmac` and accepting rotation as a gap (worse
    than the thread-binding rotation gap it would have claimed as
    precedent — this one crashes, that one only orphans); and dropping
    deterministic `vault_id`s for principal vaults in favor of random ones
    (safe, but the only non-`stableId` id in this table, and it discards
    `provision_epoch` as a meaningful value for no correctness gain over
    the probe scheme). **A genuine concurrent first-ever-provision race
    for one tuple never reaches `vault_id`'s own `PRIMARY KEY` at all**:
    probed against two real connections on one WAL database, SQLite
    serializes writers, so the loser is refused
    `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` at the transaction-locking layer
    before its own `INSERT` ever executes. The round-1 bounded-retry loop
    is removed entirely, not merely re-bounded — a retry nested inside
    `msp_vault_resolve`'s own outer transaction (§5.3) cannot observe a
    commit made after that outer transaction's snapshot was taken; the
    loser is instead refused a new typed error,
    `VaultProvisionConflictError`/`vault_provision_conflict`, **caught by
    an actual `try`/`catch` in the code block, confirmed present as of
    round 3 (CRITICAL 1) — round 2's own code block never wrote the catch
    its own prose already claimed, so the raw driver error escaped and
    this error code was unreachable** — and its own next, genuinely
    top-level call is what resolves the race. The pseudonym's own
    remaining rotation gap (cross-rotation journal-actor continuity, never
    a crash) is stated in design §6.2 and carried as `RSK-MEMOS-13`.
    **Revised in place a fourth time (RKOI PH-MEMOS-5 review round 4,
    CRITICAL): the mechanism above then unchanged and approved — but
    blanking only `principal_id` on erase leaves the derive-then-probe
    `vault_id`'s preimage with exactly one unknown component, recoverable
    by brute force at a measured, quantified cost (`RSK-MEMOS-14`, design
    §5.2); `0011`'s `trg_vaults_update_guard` branch (b) is widened to
    permit, never require, PH-MEMOS-6 also blanking `tenant_id`/`agent_id`/
    `workspace_id` on that same transition.**

    **REOPENED and revised a fifth time (RKOI/Fable joint review,
    CRITICAL, 2026-09-16 — see the revision note above), pending owner
    re-confirmation: `vault_id`'s `principal_id` component is now keyed.**
    `HMAC-SHA256(MSP_IDENTITY_HMAC_KEY, "vault-id:" + principal_id)`,
    computed in `vault-resolve-handler.mjs` (never `domain/vault-
    registry.mjs`, which still reads no crypto/env dependency), replaces
    raw `principal_id` as the `stableId(...)` preimage component. This is
    not a return to round 1/2's rejected mechanisms: the active-row lookup
    stays the plaintext `tenant_id`/`principal_id`/`agent_id`/
    `workspace_id`/`status='active'` `WHERE` clause (never recomputes or
    compares `vault_id`), and the epoch-existence probe is mechanically
    identical to round 3's own scheme — only the content fed into the
    candidate's `stableId` computation changes, using whichever key is
    current at the moment of *this* call, never a value read back from a
    stored or erased row. No new column, no new migration — `0011` is
    unaffected. Closes `RSK-MEMOS-14`'s own measured brute-force exposure
    for its actual subject (`principal_id` is the only person identifier
    the preimage carries; `tenant_id`/`agent_id`/`workspace_id` stay
    plaintext, unchanged) and, verified as a direct consequence, closes
    the `msp_vault_resolve` journal-receipt leak the joint review found
    (`DEC-MEMOS-55`, new) — the receipt's `ref` is this same `vault_id`,
    so a reader without `MSP_IDENTITY_HMAC_KEY` can no longer dictionary-
    attack it for `principal_id` even with the payload's other three
    tuple fields in hand. A with-key attacker can still invert it — the
    same posture `DEC-MEMOS-53` already accepts for `erasure_receipts`,
    deliberately a fast HMAC here rather than that decision's slower
    `scrypt`, since `vault_id` sits on the hot path of every request. —
    *pending owner re-confirmation, 2026-09-16.* (design §5.2, §5.3, §6.2,
    §12.4).
51. **DEC-MEMOS-51, new (RKOI PH-MEMOS-5 review round 1, CRITICAL 3 and
    WARNING 2) — `msp_context_resolve`'s write path, and
    `msp_vault_resolve`'s `MSP_IDENTITY_HMAC_KEY` requirement, both
    specified precisely.** (a) `msp_context_resolve` gains the optional
    `access_context` request field (`{tenant_id, principal_id}`) this
    design never actually specified before, persisting a **scoped**
    `contexts` row when present and a **legacy** row when absent — a
    self-asserted, unverified scope (no `vaults` lookup), matching
    `DEC-MEMOS-40`'s own reasoning for `msp_vault_resolve`;
    `include_payload`'s refusal narrows to `msp_context_diff` alone. (b)
    `MSP_IDENTITY_HMAC_KEY` is mandatory for `msp_vault_resolve` as a
    whole — every well-formed call resolves and journals a
    `principal_private` vault unconditionally (`DEC-MEMOS-42`), so there
    is no legacy-only call this key requirement can be scoped away
    from; a deployment lacking the key cannot serve `msp_vault_resolve`
    at all, including for a caller that only wants legacy fields. —
    *confirmed by the owner, 2026-09-16.* (design §5.3, §5.4).
52. **DEC-MEMOS-52, new (RKOI PH-MEMOS-5 review round 1, CRITICAL 4) —
    `msp_memory_promote` is explicitly excluded from decision 43's
    branch set, and the prior claim that it needs "no special-casing" is
    withdrawn as false about its actual mechanics.**
    `lifecycle-handlers.mjs`'s `runGlobalPrivatePromotion` never reads a
    source entity or vault at all — `source_memory_ref` is opaque,
    caller-supplied provenance metadata written onto a new entity in the
    caller's own `global_private` vault, never resolved against
    `entities`/`vaults` — so there was never a source-vault eligibility
    question for this design to gate. If `msp_memory_promote` is ever
    extended to actually read source-entity content, that extension must
    add an `access_context` gate at that time, using decision 49's same
    mechanism. — *confirmed by the owner, 2026-09-16.* (design §5.6).
53. **DEC-MEMOS-53, new (PH-MEMOS-6 scoping, 2026-09-16 — a new owner
    decision, scoped as its own PH-MEMOS-6 deliverable; does not touch,
    reopen or block PH-MEMOS-5, which RKOI has already approved for
    implementation) — `erasure_receipts` stops storing the raw
    `principal_id`; a keyed-then-slow-derived `principal_hmac` replaces
    it, alongside a new `identity_key_version` column, and the row stays
    permanent and immutable exactly as `DEC-MEMOS-28` already
    established.** `principal_hmac = scrypt(HMAC-SHA256(
    MSP_IDENTITY_HMAC_KEY, "erasure-receipt:" + principal_id),
    principal_hmac_salt, N=16384, r=8, p=1)` — keyed first (closes the
    case an attacker without `MSP_IDENTITY_HMAC_KEY` can do anything at
    all with this table, for any id space), slow second (raises, does
    not eliminate, the cost for an attacker who does hold the key against
    a small or guessable `principal_id` space, by roughly four to five
    orders of magnitude over a bare keyed HMAC — a measured increase, not
    a claim of infeasibility). Domain-separated from the journal's own
    `hmacPrincipal` pseudonym by a fixed prefix, so ordinary journal-read
    access cannot correlate the two directly. Two new env vars,
    `MSP_IDENTITY_HMAC_KEY_VERSION` (required whenever
    `msp_thread_principal_erase` runs) and `MSP_IDENTITY_HMAC_KEYRING`
    (optional, retains historical keys for matching a receipt only,
    mirroring `MSP_THREAD_SERVICE_KEYRING`'s own shape/validation
    exactly, never a fallback for room-ref hashing or the journal actor
    pseudonym), with an explicit, ordered rotation procedure: pruning an
    old key from the keyring makes every receipt stamped under that
    version permanently unmatchable, the row itself untouched — the same
    "orphaned, never a crash" posture already accepted for the journal
    actor pseudonym's own rotation gap (`RSK-MEMOS-13`). New migration
    `migrations/0013_erasure_receipts_pseudonymize.sql`: a
    `vaults`-shaped rebuild of `erasure_receipts` itself — `0010` is
    checksum-locked, its two immutability triggers are defined `ON
    erasure_receipts` by name and are auto-dropped by `DROP TABLE`
    (explicitly recreated, unchanged text, after the rename), and its one
    index sits on the column being removed — but, confirmed against the
    schema, no other table references `erasure_receipts` by foreign key
    or names it in a trigger body, so this migration needs no
    `foreign-keys=off` directive, unlike `0011`'s rebuild of `vaults`.
    Guarded by an explicit precondition refusing to proceed if
    `erasure_receipts` already holds a row (SQLite has no HMAC/`scrypt`
    function, so an existing raw row cannot be converted inside pure SQL;
    no real deployment holds one today, confirmed against the only
    production code path that writes one). **Closes** the zero-cost,
    unauthenticated-`SELECT` re-identification path `RSK-MEMOS-14`
    itself named as the dominant term once the `vault_id` brute-force
    cost was measured. **Does not close** `vaults.vault_id`'s own unkeyed
    exposure (`RSK-MEMOS-14`'s original subject — unchanged, revisit at
    PH-MEMOS-6, `BL-MEMOS-073`/`074`, unadopted), the journal actor
    pseudonym's own rotation gap (`RSK-MEMOS-13`, unchanged), room-ref
    hashing (unrotatable, unchanged), or any plaintext content-table
    column erasure already leaves untouched (design §11.1's disposition
    table, unchanged). Storage half of `DEC-MEMOS-28` superseded; its
    permanence half stands, unchanged. — *confirmed by the owner,
    2026-09-16, including the `scrypt` work factor above as a measured
    starting point `BL-MEMOS-076` tunes from real wall-clock cost, not a
    frozen final value; whether this decision's domain-separation-plus-
    versioning treatment should also extend to the journal's own
    `hmacPrincipal` pseudonym or to room-ref hashing was raised alongside
    this decision but not adopted here, and stays open (design §19).*
    (design §12.5).
54. **DEC-MEMOS-54, new (RKOI PH-MEMOS-5 code review round 1, CRITICAL,
    2026-09-16 — the vault-isolation existence oracle; see the revision
    note above and `DEC-MEMOS-44`/`49`'s revised paragraphs) — the
    existence-indistinguishability fix extends to every other path that
    can leak a principal vault's or a scoped context row's existence, not
    only the nine `msp_memory_*` tools.** `msp_vault_mount`
    (`apps/msp-server/src/transport/handlers/vault-handlers.mjs`): a
    `principal_private`/`principal_passport` `vault_id`, known or not, is
    now indistinguishable from an unknown one — both the handler's own
    pre-check and `VaultRegistry#mountVault`'s internal check answer the
    identical `not_found`/`MspRuntimeError` message
    (`mountVault: unknown vault_id "<id>".`) a truly nonexistent `vault_id`
    already gets, never `vault_scope_denied`. This closes a stronger,
    zero-effort version of the same oracle: `msp_vault_mount` requires no
    `access_context` at all (it is API-006-governed, not API-009), so
    before this fix any caller could learn whether a computed principal
    `vault_id` existed for the cost of one mount call naming any
    `workspace_id`/`mount_alias`. `DEC-MEMOS-39` is corrected in place:
    "never-mountable enforcement" is no longer "refused with
    `vault_scope_denied`" — it is "principal vaults are not nameable
    through this tool at all," which subsumes the never-mountable
    guarantee rather than weakening it. `vault_scope_denied` keeps its
    existing meaning, unchanged, for every legacy (mountable) vault type —
    this correction narrows what `vault_scope_denied` covers, it does not
    remove the code. `msp_context_diff`/`msp_context_audit`/
    `msp_context_replay` (`apps/msp-server/src/transport/handlers/
    context-handlers.mjs`): the identical collapse, applied for vocabulary
    consistency rather than a comparably severe exposure — `context_id` is
    a server-minted `randomUUID()`, not a deterministic function of any
    caller-known identifier, so it cannot be computed offline the way
    `vault_id`/`entity_id` can, and this path's exposure is scoped to a
    caller that has already observed a real `context_id` some other way.
    `msp_context_diff` now raises the same `not_found`
    (`Unknown base_context_id/target_context_id "<id>".`) for a
    found-but-access-context-denied row that it already raises for a
    genuinely unknown one, rather than `access_context_required`/
    `access_context_denied`. `msp_context_audit`/`msp_context_replay`
    (which never threw for an unknown `context_id` to begin with — both
    already answer with a quiet, non-throwing "not found"-shaped success,
    `replayable: false`/`hash_valid: false` for audit,
    `context_reproducible: false` with a `context_not_found` diagnostic
    for replay) now route a found-but-access-context-denied row through
    that identical no-throw path instead of throwing
    `access_context_required`/`access_context_denied` — the row is treated
    as if it had not been found for the rest of that call, never used.
    `msp_vault_resolve` and `msp_memory_promote` were checked and need no
    change: `msp_vault_resolve` performs no existence-gated authorization
    check at all (it is unsigned and self-asserted by design,
    `DEC-MEMOS-40`, and always resolves/provisions on a well-formed call —
    its own, separate, already-accepted exposure is the unbounded
    row-creation primitive `RSK-MEMOS-12` names, unaffected by this
    decision); `msp_memory_promote` reads no source vault at all
    (`DEC-MEMOS-52`), so it was never a producer of this oracle either.
    **What this decision does not close, stated plainly**: a caller
    co-located on this stdio-only trust boundary can still observe a
    timing difference between a lookup that finds nothing and one that
    finds a row and then compares a tuple against it — this codebase does
    not claim constant-time comparison anywhere, and this residual is
    accepted on the same basis `RSK-MEMOS-05`/`RSK-MEMOS-11` already rely
    on for a co-located, stdio-only caller, not eliminated by this
    decision; tracked as `RSK-MEMOS-15`. — *pending owner confirmation,
    2026-09-16.* (design §5.1, §5.2, §5.4).
55. **DEC-MEMOS-55, new (RKOI/Fable joint review, CRITICAL, 2026-09-16 —
    see the revision note above) — the `msp_vault_resolve` journal-receipt
    leak, and `msp_memory_links_create`'s vault-id-bearing refusal
    message, both corrected.** `msp_vault_resolve`'s journal entry
    (`actor: "principal_hmac:" + ...`; `ref: principalPrivateVault.vault_id`;
    plaintext `{tenant_id, agent_id, workspace_id, ...}` payload) is closed
    as a direct, verified consequence of `DEC-MEMOS-50`'s fifth revision,
    not by changing `ref`/payload shape — both stay exactly as specified,
    since a separate random receipt id or an excised payload tuple were
    considered and rejected as redundant once `vault_id` itself is keyed,
    at a real cost to an operator's ability to correlate a journal entry
    to the vault it resolved. `msp_memory_links_create`'s pre-existing
    cross-vault `assertVaultScope` refusal (unchanged mechanism, case 3 of
    `DEC-MEMOS-43`'s branch set) stops interpolating the two actual
    `vault_id` values into its message — a caller naming two `entity_id`s
    in different vaults learns only that they differ, closing a narrow
    residual for a caller who already holds one real `entity_id` and
    guesses another. — *pending owner confirmation, 2026-09-16.* (design
    §5.3, §5.1).

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
  client. **Widened (RKOI PH-MEMOS-5 review round 3, WARNING 2):** the
  same item also covers adding a retry on `vault_provision_conflict` —
  `msp-vault-resolver.js`'s `resolve()` has no retry and no error-code
  branching today, and `msp-memory-port.js`'s `recallAuthorized`/
  `rememberAuthorized` simply `await` and propagate whatever it throws, so
  a losing race is a dropped `rememberAuthorized` write, not a
  self-correcting hang, until this same item's caller update adds one.
  Deferred to `PH-MEMOS-8`, alongside `BL-MEMOS-106`/`092`/`093`, since
  production use is itself deferred by owner direction (2026-09-14).
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
- **New, deployment-side note (`DEC-MEMOS-51`, RKOI PH-MEMOS-5 review
  round 1, WARNING 2) — not a zuri-ai code change, stated here so it is
  not missed alongside the caller-side items above:** an MSP operator must
  configure `MSP_IDENTITY_HMAC_KEY` before enabling `msp_vault_resolve`
  for any caller at all, since every well-formed call resolves and
  journals a `principal_private` vault unconditionally (design §5.3). The
  shipped caller needs no change to keep working once that key is
  configured; without it, every call — including one that only reads
  `workspacePrivateVaultId`/`sharedVaultIds` — is refused
  `identity_hmac_unconfigured`.

## Revision note — RKOI PH-MEMOS-5 review round 1, NEEDS REVISION 4 critical (2026-09-16)

RKOI reviewed the PH-MEMOS-5 revision above (commit `0aaad44`, design
v0.6.0b) and returned **NEEDS REVISION with 4 critical findings plus 7
warnings**, every one proved by reading the real code on `main`, not by
paraphrase. Full technical detail lives in
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.6.1b; this ADR
records only the decision-paragraph corrections and the four new
decisions the review required (`DEC-MEMOS-49..52`, below), per this
ADR's own "what this ADR does not decide" boundary.

- **CRITICAL 1** (design §5.1, §5.2): the claim that the new
  `access_context` gate reuses `contracts/vault-scope-guard.mjs`'s
  `assertVaultScope` "at the same call site" was false —
  `domain/vault-registry.mjs`'s `isVaultAccessibleTo` has exactly one
  caller anywhere in the repository (`vault-handlers.mjs:128`,
  `msp_vault_mount`), and `memory-handlers.mjs`'s own header comment
  documents that none of the nine `msp_memory_*` tools performs a
  caller-ownership check today. Corrected to name nine new call sites (one
  per tool) and a new mechanism (`DEC-MEMOS-49`).
- **CRITICAL 2** (design §5.2, §12.4): applying migration `0011` to a real
  `0001`-`0010` database and re-provisioning an erased principal vault
  collides on `vault_id`'s own `PRIMARY KEY`, not the partial unique index
  the prior text named as the race backstop — and, without the
  `status = 'active'` filter, a naive re-`SELECT` would resurrect the
  erased row's own content. Resolved with a new `provision_epoch` column
  (`DEC-MEMOS-50`).
- **CRITICAL 3** (design §5.4): `msp_context_resolve` never actually
  received an `access_context` field, a branch set, or any way to persist
  a scoped row — its real, shipped shape (`context-handlers.mjs:71-115`)
  names no vault at all and hard-codes every `*_vault_refs` field to
  `[]`. Specified end to end (`DEC-MEMOS-51`), including a correction to
  `include_payload`'s scope (`msp_context_diff` only — `msp_context_audit`/
  `msp_context_replay` expose no payload field).
- **CRITICAL 4** (design §5.6): there are ten `msp_memory_*`-named tools,
  not nine (confirmed by `grep`); the tenth, `msp_memory_promote`, is
  correctly outside §5.1's API-009-scoped nine-tool amendment, but §15
  falsely asserted its principal-vault "eligibility... with no
  special-casing" — read directly, `lifecycle-handlers.mjs`'s
  `runGlobalPrivatePromotion` never resolves a source entity or vault at
  all. Corrected, with the exclusion stated and a forward-looking note for
  any future extension (`DEC-MEMOS-52`).

**Warnings folded in** (full text in the design's own CHANGELOG, v0.6.1b):
`assertVaultScope`'s signature stays unchanged (warning 1, answered by
`DEC-MEMOS-49`); `MSP_IDENTITY_HMAC_KEY` stated as mandatory for the whole
tool, not a principal-vault-specific subset (warning 2, `DEC-MEMOS-51`,
also added to the cross-repo list above); §12.4's "exactly like the three
legacy `provision*Vault` methods" claim withdrawn — a new
`#insertPrincipalVault` prepared statement is required (warning 3); the
unsigned-`msp_vault_resolve` authorization-not-authentication limit and
its unbounded-row-creation exposure stated plainly in design §5.3 and in
the plan's `RSK-MEMOS-12` (warning 4); `trg_vaults_update_guard`'s legacy
`project_id`-backfill branch now pins `OLD.vault_type NOT IN
('principal_private','principal_passport')` (warning 5); the plan's
changelog claim about rewriting `BL-MEMOS-060..068` in full corrected to
`060..067` (warning 6, plan-only); `BL-MEMOS-063`'s proof column now also
names `tests/contract/contract-conformance.test.mjs` (warning 7,
plan-only).

**New decisions this round, `DEC-MEMOS-49..52`, added as items 49–52 of
"### The thirty-five decisions" below, pending owner confirmation like
`36..48`.**

## Revision note — RKOI PH-MEMOS-5 review round 2, NEEDS REVISION 3 critical (2026-09-16)

RKOI reviewed the round-1 answer above (commit `38caf08`, design v0.6.1b)
and returned **NEEDS REVISION with 3 critical findings plus 7 warnings**,
every one proved by running code against the real runner or two real
`better-sqlite3` connections, not by paraphrase. Round 1's own criticals 1,
3 and 4 are confirmed closed; **round 1's critical 2 was not**, and reopens
below as this round's own CRITICAL 1. Full technical detail lives in
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.7.0b; this ADR
records only the decision-paragraph corrections, per this ADR's own "what
this ADR does not decide" boundary. No new `DEC-MEMOS` id this round —
`DEC-MEMOS-49`/`50` are revised in place a second time, since the
mechanism changed again, not merely the prose describing it.

- **CRITICAL 1** (design §5.2, §12.4, `DEC-MEMOS-50`): round 1's
  `provision_epoch` fix still keyed its `MAX(provision_epoch)` lookup on
  `principal_id` — the exact column §12.4's own `CHECK` requires blanked
  to `NULL` on erasure. Against an erased row the lookup therefore still
  returned `NULL`, the epoch still reset to `0`, and re-provisioning after
  erasure still collided on `vault_id`'s own `PRIMARY KEY`, reproduced
  directly (`re-provision after erasure THREW:
  SQLITE_CONSTRAINT_PRIMARYKEY`). Resolved with a new column,
  `vaults.principal_hmac` — computed once by the `msp_vault_resolve`
  handler, never inside `VaultRegistry`, and pinned across the erasure
  transition by `trg_vaults_update_guard`'s extended branch (b) — used in
  place of `principal_id` for the epoch lookup.
- **CRITICAL 2** (design §5.2, §5.3, `DEC-MEMOS-50`): round 1's race-
  handling text again named the wrong constraint. RKOI probed two real
  `better-sqlite3` connections against one WAL database — the only way two
  racers are reachable, since a single connection is synchronous — and
  found `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`, never `vault_id`'s own
  `PRIMARY KEY`: SQLite serializes writers, so the loser's `INSERT` never
  reaches the storage engine's constraint check at all. The round-1
  bounded-retry loop is removed, not merely re-bounded — nested inside
  `msp_vault_resolve`'s own outer transaction (§5.3's "one transaction"
  wrap), a retry cannot observe a commit made after that outer
  transaction's own snapshot was taken (`better-sqlite3` nests a
  `.transaction()` invoked from inside another as a `SAVEPOINT`, not a
  fresh `BEGIN`). Resolved by catching exactly `SQLITE_BUSY_SNAPSHOT`
  (matching §7.1's own narrowed `close_for_relink` precedent) and
  throwing a new typed error, `VaultProvisionConflictError`/
  `vault_provision_conflict` (added to design §5.3's own error table) —
  the caller's own next, genuinely top-level call is what resolves the
  race, not an internal loop.
- **CRITICAL 3** (design §5.1, §5.2, new finding against the `DEC-MEMOS-49`
  mechanism, present since round 1): neither `classifyPrincipalAccess`/
  `isVaultAccessibleTo` nor `requireKnownVault` ever checked `vault.status`
  — an `access_context` tuple matching an **erased** principal vault's
  still-populated `tenant_id`/`agent_id`/`workspace_id` columns (erasure
  blanks only `principal_id`, per §12.4's own `CHECK`) read as `'ok'`,
  reproduced directly. Resolved by unifying `isVaultAccessibleTo`/
  `classifyPrincipalAccess` into one row-taking branch set,
  `#isVaultRowAccessibleTo`, that refuses `status !== 'active'` before any
  tuple comparison — folded into the existing `access_context_denied`
  answer, not a new, distinguishing oracle — and that `classifyPrincipalAccess`
  calls directly with the row it already has (also closes WARNING 3 below:
  round 1's text would have performed a second `SELECT`). Design §5.1's
  own duplicate, looser restatement of the branch set is removed, leaving
  §5.2 as this gate's single normative source.

**Warnings folded in** (full text in the design's own CHANGELOG, v0.7.0b):
(1) design §5's owner-tuple claim — a reader's first stop, one level above
where round 1's own correction landed — rescoped to "while no erasure has
happened," matching §5.2/§12.4; (2) `MSP_IDENTITY_HMAC_KEY` named in
design §13's `msp_vault_resolve` tool row and §14's
`identity_hmac_unconfigured` meaning broadened beyond "a call that must
hash a channel reference," not only in §5.3's prose — plan's
`BL-MEMOS-062` gains a README documentation deliverable, owner JANUS,
closing the condition RKOI's round-1 acceptance of the mandatory-key
decision was conditioned on; (3) `isVaultAccessibleTo` no longer performs
a second `SELECT` when reached via `classifyPrincipalAccess` (folded into
the CRITICAL 3 fix above, `DEC-MEMOS-49`); (4) the two principal-type
branches in `#isVaultRowAccessibleTo` now sit ahead of the workspace-mount
short-circuit, removing (not merely restating) the dependency on
`vault_mounts`'s own principal-exclusion triggers; (5) design §5.1's
`AccessContext` type block now states normatively that unknown keys (e.g.
`msp_vault_resolve`'s wider `access_context` object) are accepted and
silently ignored on reuse, never `validation_failed`; (6) `msp_context_diff`'s
`include_payload` refusal is kept, its rationale reworded (design §5.4,
§15 row 31, plan) — it is defense in depth, since `msp_context_resolve`
hard-codes `*_vault_refs` to `[]` today, not a channel this revision found
open and closed; (7) plan's `BL-MEMOS-062` proof column rewritten to a
race case that can actually pass under CRITICAL 2's corrected mechanism.
**Also added, per RKOI's ruling on this design's own self-asserted
`access_context` pattern:** one paragraph in design §5.4 stating the
scoped-`contexts` control's actual strength rests on the random,
non-derivable `context_id`, not the self-asserted `tenant_id`/
`principal_id` pair.

**No new decisions this round — `DEC-MEMOS-49`/`50` revised in place a
second time (see their own paragraphs above, "the thirty-five decisions"),
`DEC-MEMOS-51`/`52` unaffected.**

## Revision note — RKOI PH-MEMOS-5 review round 3, NEEDS REVISION 3 critical (2026-09-16)

RKOI reviewed the round-2 answer above (commit `e58fe2a`, design v0.7.0b)
and returned **NEEDS REVISION with 3 critical findings plus 5 warnings**.
Migration `0011` and the erase/re-provision lifecycle were re-run end to
end against a real populated database and confirmed correct — the epoch
advances, ids do not collide, `principal_hmac` cannot be nulled or changed
on the erase transition, and is not missing on any row the epoch depended
on — and round 2's own CRITICAL 3 (the unified `#isVaultRowAccessibleTo`
gate) is confirmed closed. **Marked as history (RKOI PH-MEMOS-5 review
round 4, WARNING 3): the `principal_hmac` finding immediately above is a
record of what held for round 2's schema at the moment RKOI verified it,
not a statement about the schema as of this ADR's current version — round
3's own CRITICAL 2, two paragraphs below, removes `vaults.principal_hmac`
entirely.** Full technical detail lives in
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.8.0b; this ADR
records only the decision-paragraph corrections. No new `DEC-MEMOS` id
this round — `DEC-MEMOS-50` is revised in place a third time, since the
mechanism changed again; `DEC-MEMOS-49` needed no change (its own
paragraph already matched round 2's mechanism — only this ADR's checklist
row 50 and design §19's own `DEC-MEMOS-49`/`50` entries had gone stale,
CRITICAL 3 below).

- **CRITICAL 1** (design §5.2): the design's own prose said
  `#provisionPrincipalVault` catches `code === "SQLITE_BUSY_SNAPSHOT"` and
  re-throws `VaultProvisionConflictError` — but its code block had no
  `try`/`catch` at all, and two of its own comments explicitly said none
  belonged there. As written, the raw `SqliteError` escaped,
  `vault_provision_conflict` was never produced, and the error-table row
  for it (and `BL-MEMOS-061`'s/`062`'s own proof requirements naming it)
  were unreachable. Fixed by adding the `try`/`catch` to the code block
  and removing the two contradictory comments — round 2's removal of the
  internal *retry loop* was correct and stays; a catch that is not a retry
  is not the same claim, and was always meant to stay.
- **CRITICAL 2** (design §5.2, §5.3, §6.2, §12.4, `DEC-MEMOS-50`, revised
  in place a third time — the most consequential finding of this round):
  round 2's `vaults.principal_hmac` column made the epoch lookup survive
  *erasure*, but not `MSP_IDENTITY_HMAC_KEY` *rotation* — the column is
  itself computed from that key. RKOI proved it directly: provision under
  one key, erase, rotate the key, re-engage — the identical `PRIMARY KEY`
  collision this column was built to prevent, reproduced a third time.
  Design §5.2 weighs three candidates on the record (re-engagement
  correctness, rotation survival, resurrection/re-identification risk,
  concurrency cost, and whether `provision_epoch` stays meaningful):
  keeping `principal_hmac` and accepting rotation as a gap (rejected — a
  crash, not an orphaning, a strictly worse failure than the
  thread-binding rotation precedent it would have claimed); deriving the
  candidate `vault_id` from the tuple already in hand and probing for its
  own existence rather than looking it up by any stored column (adopted);
  dropping deterministic ids for principal vaults and minting at random
  (rejected — the only non-`stableId` id in this table, and it discards
  `provision_epoch` as a meaningful value, for no correctness gain over
  the probe scheme). `vaults.principal_hmac` is removed from the schema
  entirely — column, both per-type `CHECK`s, both indexes, the trigger pin
  — and survives only as `msp_vault_resolve`'s own transient, per-call
  journal-actor pseudonym, no longer threaded into `VaultRegistry`. That
  pseudonym's own HMAC input is canonicalized with a length prefix
  (closing WARNING 3, below, at its source, not only in the query that
  happened to have a second filter), and its own residual rotation gap —
  cross-rotation journal-actor continuity, never a crash — is stated in
  design §6.2 and carried as new `RSK-MEMOS-13`, the same "orphaned, not
  broken" posture §6.2 already gives thread-binding rotation.
- **CRITICAL 3** (design §19, this ADR's own checklist row 50, plan
  `GATE-MEMOS-5`/`BL-MEMOS-060..062`): design §19's `DEC-MEMOS-50` entry —
  the list the owner confirms from — still described round 1's fully
  withdrawn mechanism (`MAX(provision_epoch)` keyed on `principal_id`, a
  `PRIMARY KEY` race, a bounded 5-attempt retry) and never mentioned
  `principal_hmac`, round 2's entire CRITICAL 1 fix, at all; its
  `DEC-MEMOS-49` entry likewise never gained round 2's
  `#isVaultRowAccessibleTo`/status-refusal mechanism. This ADR's own
  paragraphs 49/50 (above) were already correct and needed no change here
  — only this ADR's checklist row 50, and every other document's
  statement of the withdrawn mechanism, did. Fixed by rewriting design
  §19's two entries and this ADR's checklist row 50 to match the current
  mechanism, and grepping the plan's `GATE-MEMOS-5` bullet and
  `BL-MEMOS-060..062` rows for the same stale text.

**Warnings folded in** (full text in the design's own CHANGELOG, v0.8.0b):
(1) the design's own "no code path surfaces an unmapped driver error for
this race" claim narrowed — a plain `SQLITE_BUSY` still isn't caught and
does reach the caller, only after the connection's `busy_timeout=5000`
elapses (RKOI measured 5511ms vs. 0ms for `SQLITE_BUSY_SNAPSHOT`); (2) the
design's cross-repo verification (§5.3.1) now states plainly that
zuri-ai's real caller has no retry, so a `vault_provision_conflict` is a
dropped `rememberAuthorized` write today, not a self-correcting hang —
retry tracked on `BL-MEMOS-113`, not a new id; (3) the journal actor's
HMAC input, `tenant_id + "|" + principal_id`, is ambiguous at the
delimiter (RKOI: two different tenant/principal pairs can hash
identically) — changed to a length-prefixed encoding; (4) design §14
gains a short index table pointing at `AccessContextRequiredError`/
`AccessContextDeniedError`/`VaultProvisionConflictError`, matching how
that section already forward-lists unshipped API-011 classes; (5) design
§5.2 states that `mountVault` inherits the new `status !== 'active'`
refusal for every vault type, not only the two principal types CRITICAL 3
(round 2) was about — unreachable today, since only principal types can
ever reach `status = 'erased'`, but a real behavior change to a shipped
tool, now stated.

**No new decisions this round — `DEC-MEMOS-50` revised in place a third
time (see its own paragraph above), `DEC-MEMOS-49`/`51`/`52` unaffected.
New risk id: `RSK-MEMOS-13`.**

## Revision note — RKOI PH-MEMOS-5 review round 4, NEEDS REVISION 1 critical plus 3 warnings (2026-09-16)

RKOI reviewed the round-3 answer above (commit `c84a9ee`, design v0.8.0b)
end to end — provision, idempotent re-resolve, erase, re-provision, erase
again, re-provision; the same lifecycle across a simulated
`MSP_IDENTITY_HMAC_KEY` rotation and with the key unset entirely; and a
genuine two-connection WAL race — and could not break the provisioning
mechanism itself. **That mechanism is approved and is not revised again
this round.** `0011` is self-consistent after `principal_hmac`'s removal,
the erase transition stays fully pinned, and the cross-document
consistency grep came back clean for the first time in four rounds. Full
technical detail lives in
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.0b; this ADR
records only the decision-paragraph corrections.

- **CRITICAL** (design §5.2, §11.1, §12.4, this ADR's own `DEC-MEMOS-50`
  paragraph and checklist row 50, above): blanking `principal_id` on erase
  is not a disposition. `0011`'s per-type `CHECK` exempts only
  `principal_id` — an erased `principal_private` row's `tenant_id`/
  `agent_id`/`workspace_id`/`provision_epoch` all stay plaintext — and the
  derive-then-probe `vault_id` is an unkeyed hash of the full tuple, so an
  erased row's own id has exactly one unknown component left. RKOI
  recovered the blanked `principal_id` for 3 of 3 erased test rows at
  1,095,290 candidates/sec single-threaded with no key (roughly 2.5
  core-hours for a ten-digit id space). Not a regression against round
  2/3 — round 2's `vault_id` was already derived from the raw tuple alone
  — but design §5.2's claim that this is "the same scheme every other
  vault type in this table already uses" is withdrawn: every legacy
  type's preimage is project/workspace/agent ids, which re-identify no
  one, while `principal_private`/`principal_passport` are the first two
  vault types whose id preimage names a person at all. Design §11.1's
  `vaults` disposition row is corrected to say plainly what blanking
  `principal_id` does and does not achieve, rather than implying a
  completed disposition. `0011`'s `trg_vaults_update_guard` branch (b) is
  widened — permitted, not required — to allow `tenant_id`/`agent_id`/
  `workspace_id` to also be `NULL` on the `active → erased` transition,
  checked against every reader of an erased row's tuple columns (the
  epoch probe, both partial unique indexes, `#isVaultRowAccessibleTo`)
  and confirmed none of them depends on those columns surviving erasure —
  so PH-MEMOS-6 can adopt a stronger disposition without a second
  `vaults` rebuild, though this phase does not itself adopt one. Recorded
  as new `RSK-MEMOS-14` (design §5.2, plan risk register), with one
  sentence added to this ADR's own `DEC-MEMOS-50` paragraph and checklist
  row 50 surfacing the tradeoff for the owner-confirmation list directly.
- **WARNING 1**: `vaults` carried no `*_no_delete` trigger, unlike every
  other append-only table `0008`/`0009`/`0010` added — RKOI confirmed a
  direct `DELETE` against an erased row succeeds with no trigger firing,
  which would make a future epoch mintable again and orphan erasure-
  receipt/journal/promotion provenance still naming the deleted id.
  `0011` gains `trg_vaults_no_delete` (design §12.4) plus a required
  `principal-vault-scoping.security.mjs` case (design §15).
- **WARNING 2**: `PROVISION_EPOCH_PROBE_LIMIT`'s internal `Error` had no
  code, no design §14 row, and no `BL-MEMOS-060`/`061` proof column —
  "unreachable under correct operation" is the same class of unproven
  assertion that failed in each of the last three review rounds against
  other claims in this design. It stays deliberately unmapped and
  client-invisible (now stated explicitly, design §14), but
  `BL-MEMOS-061`'s own proof column (plan) gains a required property test
  that the bound cannot bind under any real erasure count a tuple can
  accumulate through shipped tools, plus a forced-past-the-bound unit
  test on the exact thrown message.
- **WARNING 3**: design §0.1's Thai summary and this ADR's own round-3
  revision note (above) both stated, in the present tense, that
  `principal_hmac` is not blanked or changed on erase and that no row the
  epoch depends on lacks it — an accurate record of what round 3 verified
  about round 2's schema, sitting a few lines above the same entry's own
  paragraph removing that column. Both now marked explicitly as history,
  not restated as the current schema's state.

**No new decisions this round — `DEC-MEMOS-50` revised in place a fourth
time (one sentence added; the mechanism itself is unchanged and
approved), `DEC-MEMOS-49`/`51`/`52` unaffected. New risk id:
`RSK-MEMOS-14`.**

## Revision note — PH-MEMOS-6 erasure-receipt pseudonymization (2026-09-16)

**New owner decision, scoped as its own PH-MEMOS-6 deliverable — not a
PH-MEMOS-5 review round, does not touch, reopen or block PH-MEMOS-5,
which RKOI has already approved for implementation (round 5 closure,
above).** `RSK-MEMOS-14`'s round-4 finding named `erasure_receipts`
(`DEC-MEMOS-28`, PH-MEMOS-4, owner-confirmed 2026-09-15) as the
*dominant* term in `vault_id`'s own re-identification exposure — the
table already names an erased principal for free, via a direct,
unauthenticated `SELECT`, regardless of any `vault_id` brute-force cost.
The owner was told this and delegated the call: **`erasure_receipts`
stops storing the raw `principal_id`; the row stays permanent and
immutable.** Added **`DEC-MEMOS-53`** (above, pending owner
confirmation) and design §12.5 (new migration
`migrations/0013_erasure_receipts_pseudonymize.sql`, superseding only
`DEC-MEMOS-28`'s storage half — its permanence half is unchanged and not
reopened, and `DEC-MEMOS-28`'s own owner-confirmation from 2026-09-15
stands as a historical record, not un-confirmed by this revision).

Facts verified against the shipped code, not assumed: the only `SELECT`
against `erasure_receipts` anywhere in this repository is the
idempotency check (`thread-memory.mjs:1973`, scoped by `(tenant_id,
idempotency_key)`) — `idx_erasure_receipts_principal` has no reader at
all; the journal already pseudonymizes the same principal for the same
call via `hmacPrincipal` (`thread-memory.mjs:244-248`), confirming
`erasure_receipts` was always the outlier table, not the journal.

**HMAC-versus-KDF, decided on correctness, matching the owner's own
standing instruction for this class of call.** A bare keyed HMAC fully
closes the case for an attacker who does **not** hold
`MSP_IDENTITY_HMAC_KEY` — a complete closure, unlike `RSK-MEMOS-14`'s own
`vault_id` exposure, which is an unkeyed hash anyone can compute with no
secret at all — but leaves an attacker who **does** hold the key exactly
as fast against a small or guessable `principal_id` space as the unkeyed
case, since HMAC-SHA256 costs roughly the same per candidate as the
plain SHA-256 `RSK-MEMOS-14` measured. Adopted: a two-stage derivation,
keyed HMAC first (`HMAC-SHA256(MSP_IDENTITY_HMAC_KEY,
"erasure-receipt:" + principal_id)`, domain-separated from the journal's
own pseudonym so journal-read access cannot correlate the two directly),
`scrypt` second (per-row-salted, `N=16384, r=8, p=1`, Node's own
built-in, no new dependency) — raising the with-key cost by roughly
four to five orders of magnitude over a bare HMAC, a measured,
quantified increase, not a claim that a sufficiently small id space
becomes infeasible.

**Rotation, specified as an ordered procedure — the exact question three
review rounds of PH-MEMOS-5 lost time to for a different mechanism
(`vaults.principal_hmac`, since removed, RKOI PH-MEMOS-5 review rounds
2/3).** New `MSP_IDENTITY_HMAC_KEY_VERSION` (required whenever
`msp_thread_principal_erase` runs) and `MSP_IDENTITY_HMAC_KEYRING`
(optional, retains historical keys for matching a receipt only,
mirroring `MSP_THREAD_SERVICE_KEYRING`'s own shape/validation exactly,
never a fallback for any other `MSP_IDENTITY_HMAC_KEY` use): retain the
outgoing key under its own version label before switching to the new
key/version pair; a receipt stamped under a version whose key is later
pruned from the keyring becomes permanently unmatchable, the row itself
untouched — the same "orphaned, never a crash" posture already accepted
for the journal actor pseudonym's own rotation gap (`RSK-MEMOS-13`).
Neither room-ref hashing nor the journal actor pseudonym gains
versioning or rotation support by this decision.

**Migration shape, per RKOI's own warning for whoever specs this: `0010`
is checksum-locked, its two immutability triggers name
`erasure_receipts`, and its one index is on the raw column — a
`vaults`-shaped rebuild with the trigger drop/recreate hazard
`docs/MIGRATION.md` now documents.** Confirmed against the schema: no
other table references `erasure_receipts` by foreign key or names it in
a trigger body, so unlike `0011`'s rebuild of `vaults`, this migration
needs no `-- msp-migration: foreign-keys=off` directive and no `PRAGMA
legacy_alter_table` — the cross-table name-reference hazard that
directive/pragma exist for does not arise when nothing outside the
table itself names it. The hazard that does arise is the generic one
`docs/MIGRATION.md`'s safe-rebuild-order section already documents:
`DROP TABLE erasure_receipts` auto-drops the table's own two triggers
(a trigger is owned by the table it is defined `ON`), explicitly
recreated with unchanged text after the rename, the same order `0011`
already uses for its own `trg_vault_mounts_*` triggers. Guarded by an
explicit `RAISE(ABORT)` precondition if the table is non-empty at
migration time, since SQLite has no HMAC/`scrypt` function and an
existing raw row cannot be converted inside pure SQL — no real
deployment holds one today, confirmed against the only production code
path that writes one, `msp_thread_principal_erase`.

**Backlog and risk bookkeeping**: new `BL-MEMOS-076` (PH-MEMOS-6, plan),
carrying the migration, the store-layer transaction-boundary correction
(the identity-key check now gates the whole erasure transaction, not
only the post-commit journal write), and a required proof suite.
`RSK-MEMOS-14`'s plan-side mitigation column is updated to point at
`BL-MEMOS-076` and to state precisely what closes and what does not:
**closes** the zero-cost `SELECT` path `erasure_receipts` offered;
**does not close** `vaults.vault_id`'s own unkeyed exposure (unchanged,
revisit at PH-MEMOS-6, `BL-MEMOS-073`/`074`, unadopted), the journal
pseudonym's rotation gap (`RSK-MEMOS-13`, unchanged), room-ref hashing
(unchanged), or any plaintext content-table column erasure already
leaves untouched. No `RSK-MEMOS` id added or reopened this round — this
revision narrows `RSK-MEMOS-14`'s own text, in place, to state the
narrowing precisely rather than claim full closure.

**New id this round: `DEC-MEMOS-53`.** No id renumbered or reused.

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
numbered in merge order. RKOI rulings 1–4 were confirmed by the owner on 2026-09-14 in a separate answer ("ยืนยัน RKOI rulings 1-4"). **Items 22–35 (PH-MEMOS-4 scoping, 2026-09-15, `34`/`35` added in the RKOI-review-response round) were confirmed by the owner on 2026-09-15** ("ยืนยัน") **— corrected (RKOI PH-MEMOS-4 review, WARNING 1): an earlier revision's changelog claimed this checklist had already been extended with items 22–33; it had not been. The rows below are the actual extension, now checked.** **Items 36–52 (PH-MEMOS-5 scoping, 2026-09-16, `36..48` original round, `49..52` added answering RKOI's PH-MEMOS-5 review round 1) and item 53 (PH-MEMOS-6 scoping, 2026-09-16) were confirmed by the owner on 2026-09-16** ("ตามนั้น"), the same way `22..35` were confirmed on 2026-09-15 — the rows below are now checked. Two items raised alongside decision 53 were not themselves confirmed as decisions: the `scrypt` work factor is confirmed as a measured starting point only (decision 53's own paragraph), and whether domain separation/key versioning should extend to the journal's own pseudonym and to room-ref hashing stays an open owner question (design §19), not written into this checklist as adopted.

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
- [x] 36. Principal vault owner tuples: `principal_private` = `tenant_id, principal_id, agent_id, workspace_id`, ebbinghaus decay; `principal_passport` = `tenant_id, principal_id` only, pinned (no decay) (DEC-MEMOS-36).
- [x] 37. The principal-vaults migration is `0011`; scoped `contexts` receipts is its own migration, `0012` (DEC-MEMOS-37).
- [x] 38. `vaults` is rebuilt with the `foreign-keys=off` directive and the safe create/copy/drop/rename order; the erased-row `CHECK` exemption is added now, the erasure transition itself ships in PH-MEMOS-6 (DEC-MEMOS-38).
- [x] 39. Never-mountable enforcement is two `vault_mounts` triggers plus a JS-layer `mountVault` refusal; a separate `vaults` identity-pin trigger permits only the legacy backfill and the future erasure transition (DEC-MEMOS-39).
- [x] 40. `msp_vault_resolve`'s request is unsigned, matching zuri-ai's shipped `msp-vault-resolver.js` exactly — no `grant`/`signature` field — on the same stdio-only trust boundary already accepted for API-011 (DEC-MEMOS-40).
- [x] 41. `msp_vault_resolve`'s response is additive-only; legacy fields unchanged in shape and casing, new principal-vault fields camelCase and safely dropped by the shipped, unmodified client (DEC-MEMOS-41).
- [x] 42. `allow_passport` absent or not exactly `true` is a safe default (no passport vault provisioned or returned); the episodic vault resolves on every well-formed call with no gating flag (DEC-MEMOS-42).
- [x] 43. API-009's `access_context` is one flat, snake_case object reusing `msp_vault_resolve`'s own field names, mandatory only for a principal-vault-type target; entity-id-only tools resolve entity → vault first, and `links_create` needs no independent second check (DEC-MEMOS-43).
- [ ] 44. **REOPENED (RKOI PH-MEMOS-5 code review round 1, CRITICAL, 2026-09-16 — vault-isolation existence oracle), pending owner re-confirmation.** `vault_scope_denied` is **not** broadened by this amendment — none of the nine `msp_memory_*` tools ever produced it. `access_context_required`/`access_context_denied` are retired as producible codes for these tools: any non-`ok` outcome now answers `not_found`, byte-identical to a nonexistent `vault_id`/`entity_id` (DEC-MEMOS-44, revised a second time).
- [x] 45. `msp_memory_decay_tick` gains a `pinned` response field; a `principal_passport` vault always reports zero transitions regardless of `dry_run` (DEC-MEMOS-45).
- [x] 46. Scoped `contexts` rows add nullable `tenant_id`/`principal_id` via a plain `ALTER TABLE`, both-or-neither enforced at the contracts layer; `include_payload` is refused unconditionally for a scoped row on `msp_context_diff` only — `audit`/`replay` expose no payload field (DEC-MEMOS-46, corrected RKOI PH-MEMOS-5 review round 1).
- [x] 47. The live edit to `docs/API-009-Persistent-Memory-Contract.md` is deferred to `BL-MEMOS-063`'s own implementation-time commit, not part of this design pass (DEC-MEMOS-47).
- [x] 48. New cross-repo item `BL-MEMOS-113`: zuri-ai's `validateVaultSet` must be updated to read and forward the new principal-vault response fields before they are usable in production, deferred to PH-MEMOS-8 (DEC-MEMOS-48).
- [ ] 49. **REOPENED (RKOI PH-MEMOS-5 code review round 1, CRITICAL, 2026-09-16 — vault-isolation existence oracle), pending owner re-confirmation.** The `access_context` gate is nine new call sites in `memory-handlers.mjs` (plus `links_create`'s tenth) via `classifyPrincipalAccess` built on one row-taking branch set (`#isVaultRowAccessibleTo`) that refuses an erased vault's `status` before any tuple comparison, never a reuse of `assertVaultScope`'s existing call site, which stays unchanged. `classifyPrincipalAccess`'s own three-way outcome is unchanged, but its contracts-layer translation no longer calls `assertAccessContext`/throws `AccessContextRequiredError`/`AccessContextDeniedError` — a non-`ok` outcome now raises the tool's own existing `not_found` (DEC-MEMOS-49, revised a third time).
- [ ] 54. **New (RKOI PH-MEMOS-5 code review round 1, 2026-09-16), pending owner confirmation.** The same not-found collapse extends to `msp_vault_mount` (a principal `vault_id` is indistinguishable from unknown — `DEC-MEMOS-39` corrected in place) and to `msp_context_diff`/`audit`/`replay` (vocabulary consistency; `context_id` is a random UUID, not offline-guessable); the residual timing side channel is accepted, not closed, and tracked as `RSK-MEMOS-15` (DEC-MEMOS-54).
- [ ] 50. **REOPENED (RKOI/Fable joint review, CRITICAL, 2026-09-16), pending owner re-confirmation.** Principal-vault re-provisioning after erasure mints a new `provision_epoch`-derived `vault_id`, found by probing the id's own existence, never colliding with or reactivating an erased row's own PK; a genuine concurrent provisioning race is caught and refused `vault_provision_conflict` on `SQLITE_BUSY_SNAPSHOT` by an actual `try`/`catch` in code, with no internal retry — **all mechanically unchanged.** `vault_id`'s `principal_id` component is now `HMAC-SHA256(MSP_IDENTITY_HMAC_KEY, "vault-id:" + principal_id)`, computed in the handler, not `domain/vault-registry.mjs` — closing `RSK-MEMOS-14`'s measured brute-force exposure at its source (a with-key attacker can still invert it, unchanged posture from `DEC-MEMOS-53`); `tenant_id`/`agent_id`/`workspace_id` stay plaintext (DEC-MEMOS-50, revised a fifth time).
- [ ] 55. **New (RKOI/Fable joint review, CRITICAL, 2026-09-16), pending owner confirmation.** `msp_vault_resolve`'s journal receipt no longer leaks `principal_id` via its keyless `ref`, closed as a direct consequence of decision 50's revision, not by changing `ref`/payload shape; `msp_memory_links_create`'s cross-vault refusal message no longer names the two real `vault_id` values (DEC-MEMOS-55).
- [x] 51. `msp_context_resolve` gains a real, specified `access_context` write path; `MSP_IDENTITY_HMAC_KEY` is mandatory for `msp_vault_resolve` as a whole, not a principal-vault-specific subset (DEC-MEMOS-51).
- [x] 52. `msp_memory_promote` is explicitly excluded from the `access_context` branch set; the "no special-casing" claim about its eligibility is withdrawn as false about its actual mechanics (DEC-MEMOS-52).
- [x] 53. `erasure_receipts` stops storing the raw `principal_id` — a keyed-then-slow-derived `principal_hmac` plus `identity_key_version` replace it, the row stays permanent and immutable, a new migration (`0013`) rebuilds the table itself with no `foreign-keys=off` directive needed, and an explicit rotation procedure is specified for the two new `MSP_IDENTITY_HMAC_KEY_VERSION`/`MSP_IDENTITY_HMAC_KEYRING` env vars (DEC-MEMOS-53, PH-MEMOS-6 — supersedes only `DEC-MEMOS-28`'s storage half). The `scrypt` work factor is confirmed as a measured starting point, tuned by `BL-MEMOS-076`, not frozen.

Overturning any row above reopens the corresponding section of
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.5b named in its
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
| 0.1.23b | 2026-09-16 | proposed | Owner confirmed DEC-MEMOS-36..53 ("ตามนั้น"), answering a summary that listed three open questions from decision 53; status-only change, no decision text altered. Checklist rows 36–53 checked; status summary and confirmation checklist intro updated to match. Two of the three raised questions carry dispositions, recorded without altering any decision: the `scrypt` work factor is confirmed as specified — `BL-MEMOS-076` measures real wall-clock cost first and tunes from the measurement, so `N=16384, r=8, p=1` is a starting point, not a frozen final value (noted on decision 53's own paragraph and checklist row). The third — whether domain separation and key versioning should extend to the journal's own `principalHmac` pseudonym and to room-ref hashing — was raised with no proposal attached and is **not** confirmed; it stays an open owner question, recorded in `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` §19 alongside the design's other remaining owner questions, not written into any decision as adopted. Mirrored in `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.3b and `docs/IMPLEMENTATION-PLAN-MEMORY-OS.md` v0.1.25b. No id renumbered or reused. | working-tree | ATHER |
| 0.1.22b | 2026-09-16 | proposed | **New owner decision, PH-MEMOS-6 deliverable — does not touch, reopen or block PH-MEMOS-5, already RKOI-approved for implementation.** New "Revision note — PH-MEMOS-6 erasure-receipt pseudonymization" section and new **`DEC-MEMOS-53`**: `erasure_receipts` stops storing the raw `principal_id` — a keyed-then-slow-derived `principal_hmac` (`scrypt` over an `HMAC-SHA256(MSP_IDENTITY_HMAC_KEY, "erasure-receipt:" + principal_id)` input, domain-separated from the journal's own pseudonym) plus a new `identity_key_version` column replace it; the row stays permanent and immutable, superseding only the storage half of `DEC-MEMOS-28` (PH-MEMOS-4, owner-confirmed 2026-09-15 — that confirmation stands as history, not reopened; decision 28's own paragraph gains a superseded-storage-half note). HMAC-vs-KDF decided on correctness: keyed alone fully blocks an attacker without the key, for any id space; `scrypt` raises, not eliminates, the cost for an attacker who holds it, by roughly four to five orders of magnitude over a bare HMAC. Two new env vars (`MSP_IDENTITY_HMAC_KEY_VERSION`, required; `MSP_IDENTITY_HMAC_KEYRING`, optional, mirrors `MSP_THREAD_SERVICE_KEYRING`'s own shape) and an explicit, ordered rotation procedure. New migration `migrations/0013_erasure_receipts_pseudonymize.sql`: a `vaults`-shaped rebuild of `erasure_receipts` itself, needing no `foreign-keys=off` directive (confirmed no cross-table reference to this table exists), guarded by an explicit non-empty precondition since SQLite cannot compute an HMAC/`scrypt` value in pure SQL and no real deployment holds a row today. Added checklist row 53 (unchecked, same pending-confirmation status as `36..52`) and corrected the checklist-overturn design-version citation to v0.9.2b. States plainly what this decision closes (the zero-cost `SELECT` path `RSK-MEMOS-14` named dominant) and does not close (`vaults.vault_id`'s own unkeyed exposure, the journal pseudonym's rotation gap `RSK-MEMOS-13`, room-ref hashing — all unchanged). Mirrored in `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.2b, `docs/IMPLEMENTATION-PLAN-MEMORY-OS.md` v0.1.24b and `docs/MIGRATION.md` v0.1.19b. No id renumbered or reused; new id: `DEC-MEMOS-53`. | working-tree | ATHER |
| 0.1.21b | 2026-09-16 | proposed | **Answers RKOI's PH-MEMOS-5 review round 4, NEEDS REVISION 1 critical plus 3 warnings** — new "Revision note — RKOI PH-MEMOS-5 review round 4" section, against design v0.8.0b/plan v0.1.21b (commit `c84a9ee`). Provisioning mechanism confirmed approved end to end (provision/erase/re-provision cycles, simulated key rotation, key unset, genuine two-connection race) and not revised again. **CRITICAL**: blanking `principal_id` on erase is not a disposition — the erased row's `tenant_id`/`agent_id`/`workspace_id`/`provision_epoch` stay plaintext, leaving the unkeyed `vault_id` hash's preimage with one unknown, recoverable at a measured cost (3/3 test rows, 1,095,290 candidates/sec, ~2.5 core-hours for a ten-digit space); design §5.2's "same scheme every other vault type uses" precedent claim withdrawn (`principal_private`/`principal_passport` are the first vault types whose id preimage names a person); design §11.1's `vaults` row corrected to state the actual disposition; `0011`'s update-guard trigger widened (permitted, not required) to allow `tenant_id`/`agent_id`/`workspace_id` blanking too, checked safe against every reader of an erased row's columns. `DEC-MEMOS-50` revised in place a fourth time (one sentence, mechanism unchanged); checklist row 50 updated to match. New risk `RSK-MEMOS-14`. **Warnings folded in**: (1) `vaults` gains `trg_vaults_no_delete` (design §12.4), matching every other append-only table; (2) `PROVISION_EPOCH_PROBE_LIMIT`'s internal error stays deliberately unmapped, now stated explicitly (design §14), with `BL-MEMOS-061` gaining a required proof row that the bound cannot bind under real operation; (3) design §0.1's Thai summary and this ADR's own round-3 revision note marked explicitly as history where they described `principal_hmac`'s round-2 behavior in the present tense. No new `DEC-MEMOS` id — `DEC-MEMOS-50` revised in place a fourth time, `49`/`51`/`52` unaffected. New id: `RSK-MEMOS-14`. | working-tree | ATHER |
| 0.1.20b | 2026-09-16 | proposed | **Answers RKOI's PH-MEMOS-5 review round 3, NEEDS REVISION 3 critical plus 5 warnings** — new "Revision note — RKOI PH-MEMOS-5 review round 3" section, against design v0.7.0b/plan v0.1.20b (commit `e58fe2a`). Migration `0011` and the erase/re-provision lifecycle confirmed correct against a real populated database; round 2's CRITICAL 3 confirmed closed. **CRITICAL 1**: the design's own `#provisionPrincipalVault` code block had no `try`/`catch` despite its own prose claiming one — fixed there (design-level; this ADR records only that it was found and closed). **CRITICAL 2** (`DEC-MEMOS-50` revised in place a third time): round 2's `vaults.principal_hmac` column survives erasure but not `MSP_IDENTITY_HMAC_KEY` rotation — RKOI reproduced the identical `PRIMARY KEY` collision a third time after a simulated rotation. Replaced with a derive-then-probe scheme (candidate `vault_id` computed from the tuple already in hand, checked for existence directly, epoch `0` upward) that needs no stored, owner-keyed lookup column at all — `vaults.principal_hmac` is removed from the schema entirely and survives only as the journal's own transient actor pseudonym; two rejected alternatives (keep `principal_hmac`/accept rotation as a gap; drop deterministic ids for principal vaults) recorded on the same paragraph, with the reasoning for rejecting each. New risk `RSK-MEMOS-13` (the pseudonym's own residual, non-crashing rotation gap). **CRITICAL 3**: design §19's `DEC-MEMOS-49`/`50` entries — the list the owner confirms from — still described mechanisms two rounds withdrawn; this ADR's own paragraphs 49/50 were already correct, but checklist row 50 was not and is corrected. **Warnings folded in**: `BL-MEMOS-113` widened to cover a client-side retry on `vault_provision_conflict` (design §5.3.1, WARNING 2); the journal actor's HMAC input canonicalized with a length prefix (WARNING 3, design-level); the design's own busy-timeout/unmapped-error claim narrowed (WARNING 1, design-level); §14's new-classes index table and `mountVault`'s status-refusal note (WARNINGS 4/5, design-level, no ADR-level decision attached). No new `DEC-MEMOS` id — `DEC-MEMOS-50` revised in place a third time, `49`/`51`/`52` unaffected. New id: `RSK-MEMOS-13`. | working-tree | ATHER |
| 0.1.19b | 2026-09-16 | proposed | **Answers RKOI's PH-MEMOS-5 review round 2, NEEDS REVISION 3 critical plus 7 warnings** — new "Revision note — RKOI PH-MEMOS-5 review round 2" section, against design v0.6.1b/plan v0.1.19b (commit `38caf08`). Round 1's own criticals 1/3/4 confirmed closed; round 1 critical 2 was not, reopening as this round's CRITICAL 1. Revised **`DEC-MEMOS-49`** in place (the access-context gate is now one row-taking branch set, `#isVaultRowAccessibleTo`, refusing an erased vault's `status` before any tuple comparison, and `classifyPrincipalAccess` calls it directly with no second `SELECT` — CRITICAL 3/WARNING 3) and **`DEC-MEMOS-50`** in place a second time (the epoch lookup is now keyed on a new `principal_hmac` column that survives erasure, not `principal_id`, which erasure blanks — CRITICAL 1; the race backstop is `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`, not `vault_id`'s `PRIMARY KEY`, and the internal retry loop is removed in favor of a typed `vault_provision_conflict` error the caller's own next call resolves — CRITICAL 2). Corrected checklist rows 49/50 to match and the checklist-overturn design-version citation to v0.7.0b. No new decision id — `DEC-MEMOS-49`/`50` revised in place, `51`/`52` unaffected. | working-tree | ATHER |
| 0.1.18b | 2026-09-16 | proposed | **Answers RKOI's PH-MEMOS-5 review round 1, NEEDS REVISION 4 critical plus 7 warnings** — new "Revision note — RKOI PH-MEMOS-5 review round 1" section, against design v0.6.0b/plan v0.1.18b (commit `0aaad44`). Corrected decision paragraphs **44** (`vault_scope_denied` is not broadened — withdrawn, since none of the nine `msp_memory_*` tools ever produced it) and **46** (`include_payload`'s refusal narrows to `msp_context_diff` alone — `audit`/`replay` expose no payload field) in place. Added **`DEC-MEMOS-49..52`**: 49 (the `access_context` gate is nine new call sites via a new `classifyPrincipalAccess`/`assertAccessContext` mechanism, not a reuse of `assertVaultScope`'s one existing call site — CRITICAL 1), 50 (principal-vault re-provisioning after erasure mints a new `provision_epoch`-derived `vault_id`, corrected from the wrong partial-unique-index race citation — CRITICAL 2), 51 (`msp_context_resolve`'s `access_context` write path specified end to end; `MSP_IDENTITY_HMAC_KEY` stated mandatory for `msp_vault_resolve` as a whole — CRITICAL 3, WARNING 2), 52 (`msp_memory_promote` explicitly excluded from the branch set; its "no special-casing" eligibility claim withdrawn as false about its actual mechanics — CRITICAL 4). Extended the "Cross-repo changes PH-MEMOS-5 requires of zuri-ai" section with the `MSP_IDENTITY_HMAC_KEY` deployment-prerequisite note (warning 2). Added checklist rows 49–52 and corrected the text of rows 44/46, all unchecked alongside 36–48. Updated the design-version citation to v0.6.1b. No id renumbered or reused; new ids: `DEC-MEMOS-49..52`. | working-tree | ATHER |
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

---
version: "0.1.8b"
created_at: "2026-09-14T10:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-15T07:00:00+07:00,ATHER"
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
**The owner confirmed decisions 1–16 (DEC-MEMOS-01..16) on 2026-09-14** (see the
checklist below). RKOI's four rulings on the judgement calls are still pending
owner confirmation. This ADR authorizes design work, not a merge.

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

### The sixteen decisions

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
Decisions 17 and 18 immediately below are new (v0.1.7b, PH-MEMOS-3
stage-2 scoping) and remain adopted defaults pending owner confirmation
— confirming 1–16 does not pre-confirm a decision made after that date.

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
    once `BL-MEMOS-107` lands. — *adopted default, pending owner
    confirmation.*
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
    which agent it names. — *adopted default, pending owner
    confirmation.*
19. **DEC-MEMOS-19, the default record `visibility` is `THREAD`.**
    Promoted from unnumbered design prose (RKOI stage-2 review round 1,
    warning 7) — a recorded fact is shared with every other current
    agent of the same thread unless the recording agent explicitly asks
    for `AGENT`-only visibility. Keeps stage-1's existing single-
    visibility behaviour intact for the common single-agent-per-thread
    case, and matches what every legacy stage-1 row backfills to
    (design §9.4). — *adopted default, pending owner confirmation.*
20. **DEC-MEMOS-20, nonce rules.** Promoted from unnumbered design prose
    (RKOI stage-2 review round 1, warning 7): a signed nonce carries at
    least 128 random bits and at most 128 characters on the wire; the
    anti-replay key is `(tenant_id, nonce)`, never a global namespace;
    the opportunistic prune batch is 200 rows, bounded, run on every
    nonce-consuming insert, never dependent on a separate retention
    tick (design §6.1.1, §12.2). The random-bit floor is a signer-side
    requirement stated directly against `BL-MEMOS-107` so agents sharing
    one tenant cannot collide into a spurious `grant_replayed` refusal.
    — *adopted default, pending owner confirmation.*

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
longer, but each is still pending owner confirmation. The owner confirmed
the sixteen numbered decisions on 2026-09-14 and has not yet been asked
about these four rulings directly.

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
  resolves.
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

- The exact corrected DDL for the folded migration, and for the stage-2
  multi-agent migration — that is
  `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.4.1b's job, not
  this ADR's.
- Whether or when GoVibe or Zuri actually calls the participant lifecycle
  tool (decision 4 only says MSP must provide it).
- Ceiling → tier policy, passport promotion thresholds, and whether
  `data_subject_admin` is a Membership role or a new flag — these were
  already open owner decisions in design v0.2.3b §19 and carry forward
  unchanged.
- Any Postgres adapter timeline.
- Ontology, canonical facts, or anything that belongs to GKS or GenesisBlockDB
  per `docs/TIER-BOUNDARY-17-STAGE.md` — this ADR is entirely inside MSP's
  Tier 2 boundary and assigns MSP no pipeline stage.

## Owner confirmation checklist

Items 1–16 were confirmed by the owner on 2026-09-14. Item 7's migration
numbering is read as corrected by DEC-MEMOS-14: later migrations are
numbered in merge order. RKOI rulings 1–4 are still open.

- [x] 1. API-010 = `msp_vault_resolve`; thread/session/memory surface = API-011.
- [x] 2. The branch's six `msp_thread_*` tool shapes are canonical (business fields frozen).
- [x] 3. Instances/agent-leg dropped for server channels; the signed grant + `thread_agents` is the relation.
- [x] 4. A participant lifecycle tool exists in MSP; wiring callers is deferred.
- [x] 5. Erasure ships before any channel activation.
- [x] 6. Room refs are HMAC-at-rest; `MSP_IDENTITY_HMAC_KEY` is required.
- [x] 7. Thread memory = migration 0008 (folded, corrected); principal vaults = migration 0009.
- [x] 8. Thread-scoped memory stays in thread tables; consolidation to principal vaults is later and owner-context-only.
- [x] 9. Caller-supplied `now` is test-only, never production.
- [x] 10. No extractive fallback; `coverageGap` is the mechanism.
- [x] 11. Relink closes the DIRECT thread and mints a new one for the new principal (DEC-MEMOS-11).
- [x] 12. First HUMAN membership is created by append, bound to the grant's own principal (DEC-MEMOS-12).
- [x] 13. The thread store lives in `msp-core`, no new package (DEC-MEMOS-13).
- [x] 14. Agent fields and `grant_nonces` ship in stage 2, not `0008`; migration numbers are assigned in merge order (DEC-MEMOS-14).
- [x] 15. A PENDING→VERIFIED self-upgrade on a later append needs no `assertParticipants` when the stated conditions hold on both the incoming request and the stored row, closing the old row and inserting a new one in one transaction; VERIFIED→PENDING is silently ignored, and MSP's own state does not implement revocation as a result (DEC-MEMOS-15).
- [x] 16. A `channel_type` mismatch against an existing ACTIVE thread's stored value is refused `conflict`, never a silent cross-channel hit, so a second channel type can never get its own thread for the same account and room ref; the room hash stays three segments (DEC-MEMOS-16).
- [ ] 17. Stage 2 has no zuri-ai compatibility flag; zuri-ai's current grant fails closed the moment stage-2 verification ships, since activation is already gated behind BL-MEMOS-090 (DEC-MEMOS-17).
- [ ] 18. The worker attaches via `assertAgents`, never mints from a worker-only grant (`not_found` if the room has no thread), and requires agent-currency on the job's thread for `claim`/`commit`/`retry`; `sweep` alone is exempt from "current" but still requires `agentId`/`workspaceId` present; "departed agent denied" is a per-call property, not a revocation control (DEC-MEMOS-18).
- [ ] 19. The default protected-record `visibility` is `THREAD` (DEC-MEMOS-19).
- [ ] 20. A nonce carries ≥128 random bits and ≤128 characters, keyed `(tenant_id, nonce)`, pruned in bounded batches of 200 on insert (DEC-MEMOS-20).
- [ ] RKOI ruling 1: grant capability growth is additive-only; new required/nested/re-encoded fields are cross-repo.
- [ ] RKOI ruling 2: per-tenant keyring, with the stated selection/fallback/rotation/defense-in-depth conditions.
- [ ] RKOI ruling 3: nonce required on every mutating tool except append, with the stated transaction/conflict/pruning conditions, and the named stage-1 gap.
- [ ] RKOI ruling 4: single persisted `thread_kind`, pinned by trigger, `ROOM` behaves as `GROUP`.

Overturning any row above reopens the corresponding section of
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.4.1b named in its
mapping table (§3.1).

## Evidence and implementation map

- Prior design: [`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`](DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md) v0.4.1b (superseded in relevant part by this ADR + the design's own §0.1 review response)
- Stage-1 code, the new source of truth for wire/schema shapes: `feat/memos-002-thread-memory` (worktree `agent-ab508b7a790efd268`), especially `migrations/0008_thread_memory.sql`, `packages/msp-core/src/domain/thread-memory.mjs`, `packages/msp-contracts/src/contracts/thread-access.mjs`, `apps/msp-server/src/transport/handlers/thread-guard.mjs`, and `docs/API-011-THREAD-MEMORY-CONTRACT.md`
- Unmerged branch (facts only, not read via git by this ADR's author): `origin/codex/msp-thread-memory`, commits `50859fb`, `e4303cb`
- Existing guard pattern the design's C-2 fix follows: [`packages/msp-contracts/src/contracts/vault-scope-guard.mjs`](../packages/msp-contracts/src/contracts/vault-scope-guard.mjs) (the fix itself, `grant-scope-guard.mjs`, does not exist yet — see the corrected C-2 entry above)
- Implementation plan: [`IMPLEMENTATION-PLAN-MEMORY-OS.md`](IMPLEMENTATION-PLAN-MEMORY-OS.md)
- Tier boundary this ADR stays inside: [`TIER-BOUNDARY-17-STAGE.md`](TIER-BOUNDARY-17-STAGE.md)
- Frozen legacy contract, unaffected: [`API-009-Persistent-Memory-Contract.md`](API-009-Persistent-Memory-Contract.md)

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.8b | 2026-09-15 | proposed | **Answers RKOI's stage-2 review round 1 on commit `f74ad0d` (NEEDS REVISION, 2 critical).** §12.2's schema itself passed unchanged. **`DEC-MEMOS-18` revised**: the worker attaches via `assertAgents` (never mints from a worker-only grant — `not_found` if the room has no thread) rather than being exempt from the agent gate; withdrew the wrong claim that "ending a `thread_agents` row" is revocation — detach is self-only and reversible, real revocation is Tier 1 withholding grants or a key rotation; stated plainly that the decision widens nothing (a compromised worker key already broke the whole tenant, `RSK-MEMOS-05`). Added **`DEC-MEMOS-19`** (default record `visibility` is `THREAD`) and **`DEC-MEMOS-20`** (nonce: ≥128 random bits, ≤128 chars, `(tenant_id, nonce)` key, 200-row bounded prune), both promoted from unnumbered design prose. Extended the cross-repo change list with the 128-random-bit nonce requirement on its own item and a new item: zuri-ai's outbound append's `agentId` must match the `speakerId: 'zuri-line-agent'` it already sends. Extended the owner confirmation checklist with items 19–20 and reworded item 18. Pointed every design-version reference at v0.4.1b, which carries both criticals' actual fixes (delivery's pending-path agent gate; dedup/supersession's `agent_id`/`visibility` inclusion) — this ADR records only the decision-level changes, per its own "what this ADR does not decide" boundary. | working-tree | ATHER |
| 0.1.7b | 2026-09-15 | proposed | **PH-MEMOS-3 stage-2 (multi-agent) spec** (owner direction 2026-09-14: proceed with the next planned work). Added **`DEC-MEMOS-17`** (no zuri-ai compatibility flag for stage 2 — the current grant fails closed once stage-2 verification ships, since activation is already gated behind `BL-MEMOS-090`) and **`DEC-MEMOS-18`** (the worker signs as the thread's own agent for `claim`/`commit`/`retry`, requiring agent-currency on the job's thread; `sweep` alone is exempt from "current" but still requires `agentId`/`workspaceId` present — rejecting a dedicated gate-exempt worker role as a duplicate mechanism), both adopted defaults pending owner confirmation. Extended the owner confirmation checklist with items 17–18 and the cross-repo change list with `DEC-MEMOS-17`'s note directly on the `agentId`/`workspaceId`/`nonce` items it qualifies. Pointed every design-version reference at v0.4.0b, which carries the actual grant/DDL/tool-surface/error-code specification for stage 2 (§6.1.1, §8, §9.4, §12.2, §13, §14, §15) — this ADR records only the two new owner-facing decisions, per its own "what this ADR does not decide" boundary. Every citation of `DEC-MEMOS-01..16` in this revision's new text reflects the owner's 2026-09-14 confirmation ("ยืนยัน", commit `214a7d2`), not pending status. | working-tree | ATHER |
| 0.1.6b | 2026-09-14 | proposed | Records the owner's confirmation of DEC-MEMOS-01..16 (2026-09-14): every decision marker and checklist item 1–16 now reads confirmed; item 7 is read as corrected by DEC-MEMOS-14. RKOI rulings 1–4 stay pending owner confirmation. Status stays proposed until BL-MEMOS-013 merges. | working-tree | COORD |
| 0.1.5b | 2026-09-15 | proposed | Folds RKOI's stage-1 code-review round-2 spec items (commit `445bd90`). Added **decision 16, `channel_type` mismatch** (pending owner confirmation): a resolve whose `channel_type` differs from an existing `ACTIVE` thread's stored value, for the same tenant/account/room hash, is refused `conflict`, never a silent cross-channel hit — replacing the design's earlier, wrong "same room regardless of transport label" claim; the room hash itself stays three segments. Added owner checklist item 16. Confirmed and recorded (design-side, cross-referenced here): `msp_session_sweep` is room-scoped, not tenant-scoped; zuri-ai has no `msp_session_*` caller — the only worker signing these grants is MSP's own `thread-summary-worker.mjs`. Every `DEC-MEMOS-01..15` reference updated to `01..16`; every `v0.3.4b` design-version reference updated to `v0.3.5b`. | working-tree | ATHER |
| 0.1.4b | 2026-09-15 | proposed | Folds RKOI's nine round-four warnings (docs **APPROVED, 0 critical**, commit `1c4a62f`) ahead of merge. Tightened **decision 15**: the self-upgrade check now also requires the *stored* participant row's own `person_id` (not only the incoming value), and states plainly that the transition is a mandatory close-old-row-plus-insert-new-row in one transaction, never an implementation choice — the append-only trigger permits nothing else; recorded that a silently-ignored downgrade means MSP's own state does not implement revocation. Moved the `personId`-change lock-up risk mechanism into `RSK-MEMOS-01`'s cross-repo item 4 directly, rather than only pointing at it from decision 15. Removed the evidence map's citation of RKOI's session-scratch probe scripts (never part of this repository); pointed every design version reference at v0.3.4b. Noted `BL-MEMOS-111` (a cross-room authorization gap with no prior backlog row) as a round-four finding on the code side. | working-tree | ATHER |
| 0.1.3b | 2026-09-14 | proposed | Answers RKOI's round-three NEEDS REVISION on commit `6d1a801` (1 critical): zuri-ai's real delivery grant carries neither `channelType` nor `audienceKind` (`msp-thread-memory-port.js:420-422`) — corrected the design accordingly per owner direction (a), dropping `channel_type` from the room HMAC and every `channelType` grant requirement. Added **DEC-MEMOS-15** (assurance self-upgrade needs no `assertParticipants` under four stated conditions; a downgrade is silently ignored), closing a real correctness gap in the append flow. Corrected the cross-repo change list: removed the sentence claiming `assertParticipants` "needs no zuri-ai change" (it read as contradicting items 4 and 5); restated item 5 (assurance-upgrade caller) as resolved MSP-side by DEC-MEMOS-15, needing no zuri-ai change for the normal case; kept item 4 (relink/merge caller) as a real, still-open cross-repo change on the activation gate. Extended the owner confirmation checklist with DEC-MEMOS-15 and pointed every version reference at design v0.3.3b. | working-tree | ATHER |
| 0.1.2b | 2026-09-14 | proposed | Answers RKOI's round-two NEEDS REVISION on commit `92cb591` (1 critical: wrong wire values, fixed in the design against KIN's now-shipped stage-1 code, not this ADR's decision list directly). Corrected ruling 1's wording: a new required grant field (`agentId`/`workspaceId` in stage 2) is a cross-repo change to negotiate via `RSK-MEMOS-01`/`BL-MEMOS-090`, not something this ADR can declare "out of bounds." Added two items to the cross-repo change list: a caller for `close_for_relink` (nothing calls it today) and a caller for an `identity_assurance` upgrade (nothing asks for one today) — both flagged by RKOI as missing next to the existing `agentId`/`nonce`/`assertAgents`/`assertParticipants` items. Pointed the evidence map at the actual stage-1 code as the new source of truth for wire/schema shapes. | working-tree | ATHER |
| 0.1.1b | 2026-09-14 | proposed | Answers RKOI's NEEDS REVISION on commit `2f4d584` (3 critical findings, all in the companion design's DDL/wire shapes, not this ADR's decision list directly). Corrected the C-2 citation, which wrongly named an already-existing `thread-scope-guard.mjs`; the real fix is a new `grant-scope-guard.mjs`. Recorded RKOI's rulings on all four of ATHER's prior judgement calls (narrow capability growth, conditional per-tenant keyring, conditional nonce split with a named stage-1 gap, single persisted `thread_kind`). Added four new adopted defaults: DEC-MEMOS-11 (relink closes the thread and mints a new one), DEC-MEMOS-12 (first HUMAN membership created by append, bound to the grant's own principal — zuri-ai's resolve carries no `participants` field), DEC-MEMOS-13 (no separate `msp-thread-memory` package — the store stays in `msp-core`), DEC-MEMOS-14 (agent fields and `grant_nonces` ship in stage 2, not `0008`; migration numbers assigned in merge order, correcting decision 7's pre-bound `0009`). Added the cross-repo change list stage 2 requires of zuri-ai (`agentId`/`workspaceId` required, `nonce`, `assertAgents`, `assertParticipants`), cross-referenced with the plan's `RSK-MEMOS-01`. Extended the owner confirmation checklist accordingly. | working-tree | ATHER |
| 0.1.0b | 2026-09-14 | proposed | Initial ADR: reconciled the unmerged `codex/msp-thread-memory` branch (API-010-labelled, ten tools, two migrations, C-1/C-2 critical findings) against `DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.2.3b's from-scratch, unshipped design. Adopted RKOI's ten recommended defaults as pending-confirmation decisions, renamed the branch surface to API-011, and specified the multi-user (one human per DIRECT thread, subject-bound protected records, explicit-claim-only participation changes) and multi-agent (`thread_agents` relation, per-agent episodic vaults, AGENT/THREAD record visibility, shared passport and summaries) model neither prior effort fully covered. Flagged two judgement calls (grant capability growth; optional per-tenant keyring) for owner review. | working-tree | ATHER |

---
version: "0.1.1b"
created_at: "2026-09-14T10:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-14T14:00:00+07:00,ATHER"
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
Every adopted default is explicitly **pending owner confirmation** (see the
checklist below) — this ADR authorizes design work, not a merge.

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

### The ten adopted defaults

Each is recorded as **adopted default, pending owner confirmation** — none
of these is a final owner ruling.

1. **API-010 stays `msp_vault_resolve`** (zuri-ai ADR-022's name). The
   branch's thread/session/memory surface is renamed **API-011** wherever
   it is specified or implemented. — *adopted default, pending owner
   confirmation.*
2. **The branch's six zuri-ai-facing tool names and business wire shapes
   are canonical.** No request or response field zuri-ai sends on
   `msp_thread_resolve`, `msp_thread_message_append`,
   `msp_thread_memory_record`, `msp_thread_context`,
   `msp_thread_injection_record` or `msp_thread_delivery_record` may
   change. (The signed `access` envelope that wraps every call is MSP's own
   authorization envelope, not a zuri-ai business field, and may grow — see
   "Judgement calls" below.) — *adopted default, pending owner
   confirmation.*
3. **Instances and the agent leg from design §7 are dropped for server
   channels.** A LINE/web/CLI worker never opens an MSP-tracked instance
   lease to reach a thread; the signed per-room grant, checked against a
   `thread_agents` relation (below), is the recorded relation between an
   agent and a thread. — *adopted default, pending owner confirmation.*
4. **MSP provides a participant lifecycle tool** (leave / relink) gated by
   an explicit claim, so a relinked or merged Person cannot silently
   inherit another Person's membership (closing the scenario behind C-1's
   `subject_person_id` leak). Wiring zuri-ai or Zuri to call it is deferred
   to a later packet — the tool exists in this design; nothing calls it
   yet. — *adopted default, pending owner confirmation.*
5. **Erasure must exist before any channel activation.** No LINE OA
   connection work starts until a principal's thread-scoped data
   (messages, protected records, summaries, delivery text) can be
   tombstoned end to end. — *adopted default, pending owner confirmation.*
6. **External room refs are stored as HMAC at rest**, never raw, which
   makes `MSP_IDENTITY_HMAC_KEY` a hard requirement of the thread surface
   (design §6.2's existing rotation and fail-closed rules apply unchanged).
   — *adopted default, pending owner confirmation.*
7. **Delivery order: thread memory first.** The branch's `0008`+`0009` are
   folded into one corrected migration, shipped as root migration **0008**,
   containing **stage 1 only** (no agent fields, no `grant_nonces` — see
   DEC-MEMOS-14). **Correction (RKOI, 2026-09-14):** the rest of this
   decision as first written — "principal vault types follow as `0009`" —
   is wrong: DEC-MEMOS-14 requires migration numbers after `0008` to be
   assigned in actual merge order, not pre-bound. Principal vault types
   ship whenever their phase merges, under whatever number the runner
   assigns then, expected (but not guaranteed) to be *after* the stage-2
   multi-agent migration given the plan's phase order. — *adopted default,
   pending owner confirmation.*
8. **Thread-scoped memory stays in thread tables.** Protected records and
   session summaries are not vault rows. A `CONFIRMED` protected record
   later *consolidates* into the relevant principal's vault, under that
   principal's own access context only (the same authority rule as design
   §9.1, generalized) — never written directly by a thread-scoped write. —
   *adopted default, pending owner confirmation.*
9. **Caller-supplied `now` is test-only on every tool** — never a
   production input — closing the lease-theft warning without removing the
   fake-clock testability the rest of the design already depends on. —
   *adopted default, pending owner confirmation.*
10. **No extractive fallback.** When no summary covers a stretch of
    messages, the response carries a `coverageGap` marker; MSP never
    fabricates or truncates a stand-in summary. — *adopted default, pending
    owner confirmation.*
11. **DEC-MEMOS-11, relink closes the thread.** A `DIRECT` thread whose
    channel account is reassigned to a different Person is **closed**; the
    channel binding then mints a **new** thread for the new principal.
    Binding uniqueness is scoped to `ACTIVE` bindings only, so the same
    external ref can be re-bound the instant the old thread closes. The
    lifetime single-`HUMAN` trigger stays; the new principal never
    inherits the old thread's history, because it is a different
    `thread_id` entirely. — *adopted default, pending owner confirmation.*
12. **DEC-MEMOS-12, first membership by append.** zuri-ai's frozen flow is
    resolve, then a `HUMAN` append — `msp_thread_resolve` carries no
    `participants` field. The first `HUMAN` membership of a thread is
    created by the first `HUMAN`-kind append whose `speaker_id ===
    grant.principalId`, bound to the grant's own principal rather than
    asserted by the caller. Every other participant creation or change
    requires `grant.assertParticipants === true`. `AGENT` speakers are
    never participants. — *adopted default, pending owner confirmation.*
13. **DEC-MEMOS-13, package placement.** The thread/session/protected-record
    store stays in `msp-core`, where the branch and stage 1 already put it
    — no separate `msp-thread-memory` package. An earlier draft of the
    design proposed one; it is withdrawn. — *adopted default, pending
    owner confirmation.*
14. **DEC-MEMOS-14, agent timing and migration numbering.** Stage 1
    (`0008`) has no `thread_agents`, no required `agentId`, no record
    `agent_id`/`visibility`, and no `grant_nonces`. Stage 2 adds all of
    these in its own later migration. Migration numbers after `0008` are
    assigned in merge order — this corrects decision 7's original
    "principal vaults = `0009`" wording, which pre-bound a number this
    decision says must not be pre-bound. — *adopted default, pending owner
    confirmation.*

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
longer, though each still carries the same "pending owner confirmation"
status as the ten numbered defaults, since the owner has not been asked
directly.

1. **Grant capability growth — accepted narrowly.** Additive optional
   flags (`agentId`, `workspaceId`, `nonce`, `assertAgents`,
   `assertParticipants`) are MSP's own concern and may be added to the
   grant without a cross-repo contract change. **New required fields,
   nesting, or an encoding change are cross-repo and out of bounds** — the
   grant's flat/epoch/hex layout, signed over zuri-ai's own
   `JSON.stringify(grant)`, is frozen (design §6.1).
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
  must start generating and including one.
- **`assertAgents`** must be set by zuri-ai when it wants an agent to join
  a thread it did not create (design §8 rule 2).
- **`assertParticipants`** must be set by zuri-ai for any participant
  creation or change beyond the first `HUMAN` append DEC-MEMOS-12 already
  covers implicitly (design §7 rule 1).
- None of the above changes any field zuri-ai already sends on the six
  frozen calls (decision 2) — they are strictly additive to the grant
  envelope. No activation of these requirements happens before stage 2
  merges, and no channel activation (PH-MEMOS-8) happens before that.

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

- The exact corrected DDL for the folded migration — that is
  `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.3.1b's job, not
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

- [ ] 1. API-010 = `msp_vault_resolve`; thread/session/memory surface = API-011.
- [ ] 2. The branch's six `msp_thread_*` tool shapes are canonical (business fields frozen).
- [ ] 3. Instances/agent-leg dropped for server channels; the signed grant + `thread_agents` is the relation.
- [ ] 4. A participant lifecycle tool exists in MSP; wiring callers is deferred.
- [ ] 5. Erasure ships before any channel activation.
- [ ] 6. Room refs are HMAC-at-rest; `MSP_IDENTITY_HMAC_KEY` is required.
- [ ] 7. Thread memory = migration 0008 (folded, corrected); principal vaults = migration 0009.
- [ ] 8. Thread-scoped memory stays in thread tables; consolidation to principal vaults is later and owner-context-only.
- [ ] 9. Caller-supplied `now` is test-only, never production.
- [ ] 10. No extractive fallback; `coverageGap` is the mechanism.
- [ ] 11. Relink closes the DIRECT thread and mints a new one for the new principal (DEC-MEMOS-11).
- [ ] 12. First HUMAN membership is created by append, bound to the grant's own principal (DEC-MEMOS-12).
- [ ] 13. The thread store lives in `msp-core`, no new package (DEC-MEMOS-13).
- [ ] 14. Agent fields and `grant_nonces` ship in stage 2, not `0008`; migration numbers are assigned in merge order (DEC-MEMOS-14).
- [ ] RKOI ruling 1: grant capability growth is additive-only; new required/nested/re-encoded fields are cross-repo.
- [ ] RKOI ruling 2: per-tenant keyring, with the stated selection/fallback/rotation/defense-in-depth conditions.
- [ ] RKOI ruling 3: nonce required on every mutating tool except append, with the stated transaction/conflict/pruning conditions, and the named stage-1 gap.
- [ ] RKOI ruling 4: single persisted `thread_kind`, pinned by trigger, `ROOM` behaves as `GROUP`.

Overturning any row above reopens the corresponding section of
`docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.3.1b named in its
mapping table (§3.1).

## Evidence and implementation map

- Prior design: [`DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`](DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md) v0.3.1b (superseded in relevant part by this ADR + the design's own §0.1 review response)
- Unmerged branch (facts only, not read via git by this ADR's author): `origin/codex/msp-thread-memory`, commits `50859fb`, `e4303cb`
- Existing guard pattern the design's C-2 fix follows: [`packages/msp-contracts/src/contracts/vault-scope-guard.mjs`](../packages/msp-contracts/src/contracts/vault-scope-guard.mjs) (the fix itself, `grant-scope-guard.mjs`, does not exist yet — see the corrected C-2 entry above)
- Implementation plan: [`IMPLEMENTATION-PLAN-MEMORY-OS.md`](IMPLEMENTATION-PLAN-MEMORY-OS.md)
- Tier boundary this ADR stays inside: [`TIER-BOUNDARY-17-STAGE.md`](TIER-BOUNDARY-17-STAGE.md)
- Frozen legacy contract, unaffected: [`API-009-Persistent-Memory-Contract.md`](API-009-Persistent-Memory-Contract.md)

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-09-14 | proposed | Answers RKOI's NEEDS REVISION on commit `2f4d584` (3 critical findings, all in the companion design's DDL/wire shapes, not this ADR's decision list directly). Corrected the C-2 citation, which wrongly named an already-existing `thread-scope-guard.mjs`; the real fix is a new `grant-scope-guard.mjs`. Recorded RKOI's rulings on all four of ATHER's prior judgement calls (narrow capability growth, conditional per-tenant keyring, conditional nonce split with a named stage-1 gap, single persisted `thread_kind`). Added four new adopted defaults: DEC-MEMOS-11 (relink closes the thread and mints a new one), DEC-MEMOS-12 (first HUMAN membership created by append, bound to the grant's own principal — zuri-ai's resolve carries no `participants` field), DEC-MEMOS-13 (no separate `msp-thread-memory` package — the store stays in `msp-core`), DEC-MEMOS-14 (agent fields and `grant_nonces` ship in stage 2, not `0008`; migration numbers assigned in merge order, correcting decision 7's pre-bound `0009`). Added the cross-repo change list stage 2 requires of zuri-ai (`agentId`/`workspaceId` required, `nonce`, `assertAgents`, `assertParticipants`), cross-referenced with the plan's `RSK-MEMOS-01`. Extended the owner confirmation checklist accordingly. | working-tree | ATHER |
| 0.1.0b | 2026-09-14 | proposed | Initial ADR: reconciled the unmerged `codex/msp-thread-memory` branch (API-010-labelled, ten tools, two migrations, C-1/C-2 critical findings) against `DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.2.3b's from-scratch, unshipped design. Adopted RKOI's ten recommended defaults as pending-confirmation decisions, renamed the branch surface to API-011, and specified the multi-user (one human per DIRECT thread, subject-bound protected records, explicit-claim-only participation changes) and multi-agent (`thread_agents` relation, per-agent episodic vaults, AGENT/THREAD record visibility, shared passport and summaries) model neither prior effort fully covered. Flagged two judgement calls (grant capability growth; optional per-tenant keyring) for owner review. | working-tree | ATHER |

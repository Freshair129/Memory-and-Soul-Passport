---
doc_id: "API-011-THREAD-MEMORY-CONTRACT"
version: "0.4.0b"
status: "beta"
created_at: "2026-09-08T00:25:00+07:00,RWANG"
last_update: "2026-09-15T00:00:00+07:00,KIN"
---

# API-011 Thread, Speaker, Session and Compaction Contract

This contract is MSP's first owned persistence slice for Zuri's unified
thread memory. Zuri supplies the tenant, business, channel and identity
references. MSP stores the thread lifecycle and memory provenance; it does
not resolve a provider ID or grant access.

This document was previously drafted as API-010; API-010 is reserved for
`msp_vault_resolve`. TASK-MEMOS-002 stage 1 folds the unmerged
`origin/codex/msp-thread-memory` design into current `main`, fixes its two
CRITICAL findings (C-1: a second person could read a DIRECT thread; C-2: the
guard read the database directly from `msp-contracts`) and eight warnings
(W1, W5, W6, W7, W10, plus the client-env-allowlist and key-passthrough
items). The multi-agent extensions (`agentId` in the grant, `thread_agents`,
per-agent record visibility) are stage 2 and wait for a separate ADR.

## Identity and scope

`thread_id` identifies a conversation room. `speaker_id` identifies the actor
who authored one message. `person_id` is an optional Zuri identity reference;
it is not inferred from a speaker's text. `session_id` identifies one bounded
period of activity inside a thread. A session can close while its thread
stays active. `exchange_id` groups the inbound message and the reply that
belong to one turn.

Every durable message carries the thread, session, exchange, speaker, speaker
kind, identity assurance, direction, source event and monotonic thread
sequence. `source_event_id` is **required** on `msp_thread_message_append`
(zuri-ai always sends one); a replayed identical append returns
`deduplicated: true` with the original ids rather than being accepted twice
or rejected. Messages are append-only, and immutable except a one-way
`redaction_state` transition (`none` -> `tombstoned`) that blanks the message
text and touches nothing else — erasure itself is a later, separately
reviewed packet.

Thread bindings are unique **per tenant**: `UNIQUE (tenant_id,
channel_account_id, external_room_ref_hmac)`. A binding can never be silently
moved to another tenant, business or thread kind, and a channel/room
combination in tenant A can never collide with, or leak the existence of,
tenant B's binding.

### Identity hashing

The external room reference is never stored raw. `threads.external_room_ref_hmac`
is `HMAC-SHA256` under `MSP_IDENTITY_HMAC_KEY` (at least 32 characters, the
same bar as `MSP_THREAD_SERVICE_KEY`), computed over the literal string
`"<tenant_id>|<channel_account_id>|<external_room_ref>"`. `channel_type` is
deliberately **not** part of this hash (RKOI review: zuri-ai's own
`msp_thread_delivery_record` grant never carries a `channelType` claim, so
requiring one to compute this hash made every delivery receipt
unreachable). A tool that must compute this hash with no
`MSP_IDENTITY_HMAC_KEY` configured answers `identity_hmac_unconfigured` and
writes nothing — the check happens before any row is inserted or updated.
The same key HMACs every journal `actor` field (the raw speaker id, never
written to the journal in the clear) — see "Errors and journaling" below.

The guard also uses this same hash to confirm that a grant's OWN room
(`tenantId`/`channelAccountId`/`externalRoomRef`) matches the SPECIFIC
thread a request names, for every thread-bound tool (including compaction
claim/commit/retry, resolved via the job's thread) — `channel_account_id`
equality alone is not enough, since many threads can share one channel
account.

### Thread kind and audience kind

zuri-ai always sends `thread_kind` and `audience_kind` equal to each other.
`msp_thread_resolve` accepts both fields but requires them to be equal
(`validation_failed` otherwise); `audience_kind` is not an independently
stored column — every response mirrors `thread.audienceKind` from
`thread.threadKind`.

## Participants (C-1)

`thread_participants` is an append-only membership ledger, not a
point-in-time table: a row's identity, thread, speaker and join time never
change once written, and the only permitted `UPDATE` closes it (`left_at`
`NULL` -> not `NULL`). Re-establishing membership, or upgrading
`identity_assurance`/`person_id`, always inserts a NEW row.

Only a **HUMAN** speaker is ever recorded as a participant. AGENT, OPERATOR
and UNKNOWN speakers live only in `thread_messages` rows — they are never
readable participants and can never satisfy the private-read predicate below,
regardless of what `speaker_kind` a caller claims (a PENDING speaker can
never silently become the readable participant either: an assurance upgrade
to VERIFIED is a participant *change*, gated the same way a new join is).

A DIRECT thread may have **at most one HUMAN participant for its entire
lifetime** — enforced unconditionally by a database trigger, independent of
every other check in this contract, so even a defect elsewhere in the
authorization path cannot let a second person read or become eligible to
read a DIRECT thread's transcript.

Creating or changing a HUMAN participant (a first join, a `person_id` link,
or an `identity_assurance` upgrade) requires the signed grant to carry an
explicit `assertParticipants: true` claim, checked against the database's
current participant row before the append is applied — with one exception
(**DEC-MEMOS-15**): the grant principal upgrading their OWN participant row
(`speaker_id === principalId`) needs no such claim, PROVIDED the request's
`person_id` and the participant row's ALREADY-STORED `person_id` are both
either absent or equal to that same principal. zuri-ai sends exactly this
shape — `identity_assurance: VERIFIED`, `person_id = principalId` — once a
LINE user verifies, with no `assertParticipants` claim at all; requiring one
would lock the DIRECT thread up permanently the first time its user
verifies. A downgrade (`VERIFIED` → `PENDING`) on a later append is likewise
never gated, and is never stored as a change (the assurance in force stays
the highest one ever recorded). Every other case — a different `speaker_id`,
a `person_id` naming anyone but the principal, or a stored `person_id`
already linking that speaker to a DIFFERENT identity — answers
`thread_scope_denied`. A HUMAN append's `speaker_id` must always equal the
grant's `principalId` unless `assertParticipants` is set; a caller can never
mint or act as a different person's speaker id without it, and `person_id`
itself may never name anyone but the grant's own principal, even under
`assertParticipants`.

**PH-MEMOS-4 correction (`BL-MEMOS-058`): a departed principal cannot
silently rejoin by appending again.** The guard distinguishes three cases
for a `HUMAN` append's `speaker_id`, not two: (1) no row has ever existed
for `(thread_id, speaker_id)` — the claim-free first-membership path above,
unchanged; (2) a row existed before (current or departed) but none is
open now — a **rejoin**, which **unconditionally** requires
`assertParticipants`, never reads the departed row's own fields, and never
falls through to the `DEC-MEMOS-15` self-upgrade exception; (3) a current
row exists — today's existing third-party/self-upgrade logic, unchanged.
Case 2 is keyed on `speaker_id` alone, not `speaker_id === principalId`, so
a Tier-1 caller carrying `assertParticipants` can also re-attach a
*different* departed third party to a `GROUP`/`ROOM` thread — an intended
consequence of this shape, refused unconditionally on `DIRECT` by the
single-`HUMAN`-for-life trigger above.

### Participant and agent lifecycle, relink, erasure, retention and export (PH-MEMOS-4)

Five more tools, none thread-scoped in quite the way the ten above are.

**`msp_thread_participant_lifecycle`** supports two actions on an existing
thread. `leave` (`thread_id`, `action: 'leave'`, `speaker_id`) closes the
named `HUMAN` participant's open row (`left_at NULL -> NOT NULL`, the same
transition the append-only trigger already permits) and **always** requires
`assertParticipants: true`, self or third-party, with no self-service
exception — and never itself transitions `threads.status`. Naming a
`speaker_id` with no open row is `not_found`. `close_for_relink`
(`thread_id`, `action: 'close_for_relink'`) closes the thread's current
`HUMAN` row (if any) and transitions `threads.status` `ACTIVE -> CLOSED`
in one transaction; it is `DIRECT`-only (refused `thread_scope_denied` on
`GROUP`/`ROOM`) and requires **both** `assertParticipants: true` and a new
claim, `assertRelink: true` — neither substitutes for the other, and
`operator` never substitutes for either. The `threads` `UPDATE` is
`WHERE thread_id = ? AND status = 'ACTIVE'`; a concurrent close_for_relink
racing an in-flight append is refused via the store's own
transaction-internal re-check (not merely the guard's earlier read) with a
typed `conflict`, never a raw driver error. Closing a thread never deletes
its history and never reassigns the channel binding by itself — the same
binding's very next `msp_thread_resolve` mints a genuinely new `thread_id`
that inherits none of it (`DEC-MEMOS-11`, unchanged).

**`msp_thread_agent_detach`** (`thread_id`) is self-only, with no third-party
case and no new grant claim: it closes the calling agent's own
`thread_agents` row, the direct analogue of `leave` for agents. The generic
agent-currency gate every thread-bound tool already has guarantees the row
exists before the handler runs, so a second call from the same (now
non-current) agent is refused `agent_not_current` at the guard, before the
tool's own logic runs at all — the agent re-attaches via its own
`assertAgents` exactly as any other non-current agent would.

**`msp_thread_principal_erase`** (`idempotency_key`, optional `principal_id`
defaulting to the grant's own principal) is **not thread-bound** — it spans
every thread the principal has ever touched in the calling grant's own
`tenantId`. Self-erasure requires `dataSubjectAccess: true`; naming a
*different* `principal_id` additionally requires `dataSubjectAdmin: true`
— neither claim is `operator`. Idempotent by `(tenant_id, idempotency_key)`:
a replay with the same `principal_id` returns the stored receipt with no
further writes; the same key with a different `principal_id` is `conflict`.
An unknown `principal_id` is a trivial zero-count success, never `not_found`
(avoiding a cross-principal existence oracle). One transaction, three
stages, always in order: resolve every affected row set, tombstone every
content table, then close the principal's open `thread_participants` rows
last. Tombstones the principal's own authored `thread_messages` and every
`protected_memory_records` row where they are asserter or subject
(blanking **both** `body_json` and `scope_json`); `session_summaries` and
`thread_delivery_receipts` are tombstoned only for a thread where the
principal is, across its **entire** participant history, the thread's
only-ever `HUMAN` participant **and** the thread carries no
`thread_messages` row with `speaker_kind NOT IN ('HUMAN', 'AGENT')` — a
`GROUP`/`ROOM` thread failing either condition is left completely untouched,
a conservative under-erasure default. `thread_pending_deliveries` is out of
scope entirely (it holds `AGENT`-authored reply text, not the principal's
own, with no reliable principal-attribution column). The response's
`erasureReceiptId` is journaled with a pseudonym (`principalHmac`) only; the
new `erasure_receipts` table itself stores the raw `principal_id`, like
every other content table's speaker/person columns.

**`msp_thread_retention_tick`** (optional `dry_run`, default `false`) is
**not thread-bound**, `operator`-gated via an explicit tool-name check (not
the `msp_session_` prefix match), and deliberately sweeps the calling
grant's **whole tenant**, never merely its own room, even under a
room-claimed operator grant — a stated ruling, not a gap. Age-based and
principal-agnostic: a single deployment-wide `MSP_THREAD_RETENTION_DAYS`
environment variable (absent or `0` is a documented, always-callable no-op
that mutates nothing). `dry_run: true` runs the identical candidate
`SELECT`s the live pass would `UPDATE` from, issuing no `UPDATE` at all, and
consumes no nonce — but still writes a journal entry, exactly like
`dry_run: false`; only the nonce exemption is dry-run-specific. Bounded to
200 rows per table per call, reusing the nonce-pruning bound. This is the
only one of the fifteen tools whose schema accepts `now`: a synthetic
clock here moves a tenant-wide mutation horizon (`cutoff = now - days`),
which is why it carries the same `MSP_TEST_CLOCK`/`allowTestClock`
test-clock gate every other tool's `now` already has ("Test clock (W1)",
below) — never honored outside a test composition root, and already
excluded from `@freshair129/msp-client-js`'s environment allowlist.

**`msp_thread_principal_export`** (optional `principal_id`, defaulting to
the grant's own principal) is a read, **not thread-bound**, gated by the
same `dataSubjectAccess`/`dataSubjectAdmin` pair as erasure. Contains only
the principal's own authored `thread_messages` and own asserted/subject
`protected_memory_records`, always; `session_summaries` only for the
identical qualifying-thread set erasure computes. Excludes every
tombstoned row, including the exporting principal's own previously-erased
content — once erased, content is permanently unexportable too. Ignores
agent `visibility` entirely (this tool is principal-scoped, not
agent-scoped, by construction). An unknown principal is an empty export,
never `not_found`.

### Audience and room scope, per tool

`audienceKind` is a **required** grant claim on every thread tool except
`msp_thread_delivery_record` — zuri-ai's own port sends it on the other five
(`msp_thread_resolve`, `msp_thread_message_append`, `msp_thread_context`,
`msp_thread_memory_record`, `msp_thread_injection_record`) and never on a
delivery grant (verified against zuri-ai `origin/main`'s
`createMspThreadMemoryPort#recordDelivery`). A tool that requires it and
does not receive one, or receives one that disagrees with the named
thread's own `thread_kind`, answers `thread_audience_mismatch` — this
applies on mint (`msp_thread_resolve`) and on every later call against an
existing thread. A delivery grant that DOES carry `audienceKind` is still
checked; delivery's scope otherwise comes from the inbound message's own
thread plus the room-hash check below.

Independently of the audience check, every thread-bound tool (including
`msp_session_compaction_claim`/`commit`/`retry`, resolved via the job's own
thread) also verifies that the grant's own room —
`HMAC(tenantId|channelAccountId|externalRoomRef)` — matches the SPECIFIC
thread's stored hash. `channel_account_id` equality alone is not enough:
many rooms can share one channel account, so a grant scoped to one room can
never claim, read or write a different room's thread or compaction job even
under the same tenant and channel account.

## Private context and protected memory (C-1)

`msp_thread_context` returns the most recent six exchanges by default. In a
group, each exchange contains every message and its `speaker_id`; it is
never flattened to one generic "customer" actor. The response also contains
active protected records and committed session summaries. A summary reports
whether its covered range overlaps the recent window so the context adapter
can avoid injecting duplicate content.

A **private** read (protected records included) is granted only when ALL of
the following hold:

- the thread's `thread_kind` is `DIRECT`;
- the grant's `principalId` is that thread's current (`left_at IS NULL`)
  **VERIFIED HUMAN** participant;
- the grant carries `readPrivate: true`.

GROUP and ROOM threads never produce a private read, regardless of any other
claim.

Protected records are explicit `CONSTRAINT`, `INSTRUCTION`, `CORRECTION` or
`PREFERENCE` entries. They require source message references authored by the
asserting speaker. `subject_person_id` must be absent or equal to
`asserted_by_speaker_id` — a protected record can never name anyone but its
own asserter as its subject — and `asserted_by_speaker_id` must equal the
grant's `principalId`. A record with no subject is visible only to its own
asserter, never to "every participant" of the thread. A summary cannot erase
one of these records; supersession is explicit and versioned.

## Session router and compaction

The runtime opens a session on the first message and refreshes its idle
deadline only for an inbound human message. The default idle timeout is 30
minutes. A deterministic `msp_session_sweep` moves due sessions to `CLOSING`
and creates an idempotent compaction job. The job is durable, so a process
restart does not lose the deadline or the work item.

An external summarizer submits a structured summary to
`msp_session_compaction_commit` only after its model invocation is terminal.
The summary must include topics, decisions, open questions, pending actions,
corrections, outcomes and participants. The source sequence range and
SHA-256 digest are stored with the summary — immutable except the same
one-way tombstone transition described above, which blanks `summary_json`.
The watermark advances only after the summary and job commit succeed
together; failed work stays retryable and the source messages remain
available.

The deployment may set `MSP_THREAD_IDLE_TIMEOUT_MINUTES` and
`MSP_THREAD_RECENT_EXCHANGES`. They default to 30 minutes and six exchanges;
per-request values may reduce those ceilings but cannot increase them.

## Tools

| Tool | Purpose |
|---|---|
| `msp_thread_resolve` | create or resolve a stable thread from an opaque channel binding |
| `msp_thread_message_append` | append an idempotent, speaker-labelled message and open/continue a session |
| `msp_thread_memory_record` | persist a source-backed protected constraint/instruction/correction/preference |
| `msp_thread_context` | return participants, recent six exchanges, summaries and protected records |
| `msp_session_sweep` | close idle sessions and enqueue compaction jobs |
| `msp_session_compaction_commit` | commit a validated summary and advance the session watermark |
| `msp_session_compaction_claim` | lease a scoped source snapshot and return its digest |
| `msp_thread_delivery_record` | reconcile accepted text, durably queue missing inbound, or amend an invalidated summary |
| `msp_thread_injection_record` | record packet hash and model invocation state without storing the prompt |
| `msp_session_compaction_retry` | mark a non-terminal compaction job retryable without losing its source range |
| `msp_thread_participant_lifecycle` | close a HUMAN participant's membership (`leave`), or close a DIRECT thread outright for a relink (`close_for_relink`) |
| `msp_thread_agent_detach` | close the calling agent's own attachment to a thread |
| `msp_thread_principal_erase` | tombstone a principal's own content across every thread they have touched in the tenant, idempotently |
| `msp_thread_retention_tick` | age-based, tenant-wide tombstone sweep past a deployment-wide horizon |
| `msp_thread_principal_export` | return a principal's own authored content, own protected records and qualifying summaries |

All identifiers in this surface are references returned by MSP or opaque
values provided by Zuri. There is no filesystem path, raw provider
credential or password field in the contract.

## Runtime contract, grants and errors (0.3.0b)

`packages/msp-contracts/schemas/API-011.tools.json` is compiled by the
external API guard (`packages/msp-contracts/src/contracts/thread-schema.mjs`,
using `ajv`/`ajv-formats`, third-party dependencies of `msp-contracts`).
Requests carry `access.grant` plus an HMAC-SHA256 signature over the exact
grant JSON. The grant includes a SHA-256 hash of the unsigned request, tool
operation, resource scope, principal, policy revision and expiry (60
seconds). `packages/msp-contracts/src/contracts/thread-access.mjs` stays a
pure shaping/validation layer, mirroring
`contracts/vault-scope-guard.mjs`: `verifyThreadGrant` checks the HMAC,
payload hash, expiry and required claims with **no database access**, and
`assertThreadScope(condition, message)` throws the typed, fail-closed
`ThreadScopeDeniedError` (code `thread_scope_denied`). Every DB-backed lookup
(which thread a `thread_id`/`session_id`/`job_id`/`inbound_message_id`
belongs to, and the current participant row) lives in msp-core's
`ThreadRegistry` (`packages/msp-core/src/domain/thread-memory.mjs`), read
only — never a scope decision — and is orchestrated by
`apps/msp-server/src/transport/handlers/thread-guard.mjs`, the one module
that composes both. Read and protected-write grants are separate;
group/unknown audiences cannot read private context. A service signer is
trusted to supply current Zuri authorization; raw IDs are never grants.

One additional grant claim, additive and backward compatible with every
claim zuri-ai already sends: `assertParticipants` (boolean; see
"Participants" above). An earlier draft of this stage also added a
`channelType` claim for `msp_thread_delivery_record`; that claim was removed
once the room hash stopped needing `channel_type` at all (see "Identity
hashing" above) — zuri-ai's real delivery grant never sent one, so requiring
it made every delivery receipt unreachable (RKOI review, 2nd round,
CRITICAL 1).

### Multi-agent (stage 2, BL-MEMOS-040..048/112, DEC-MEMOS-17..21)

**A hard cutover, no compatibility mode (DEC-MEMOS-17).** Every one of the
ten tools above now requires two more grant claims: `agentId` and
`workspaceId` (non-empty strings, ≤128 characters, unconstrained charset —
opaque Tier-1-owned identifiers, exactly like `principalId`). Their
absence is `grant_signature_invalid`, the same "missing required claim"
bucket `tenantId`/`principalId`/`policyRevision` already occupy — not a
new code. A caller still signing zuri-ai's pre-stage-2 grant shape is
refused outright; there is no fallback and no feature flag.

**`nonce`** (a caller-generated random string, ≥128 bits, ≤128 characters
— `signThreadRequest` auto-generates a compliant one unless the caller
supplies its own) is required on every mutating tool **except**
`msp_thread_message_append` (its own `source_event_id` already gives it
replay protection) and `msp_thread_context` (read-only). A tool in that
set called with no `nonce` claim at all is `grant_nonce_required`; reusing
a `(tenantId, nonce)` pair already recorded for that tenant is
`grant_replayed`. Nonces are consumed inside the store method's own
transaction, alongside its write, so a replay rolls back the whole
mutation, never a partial apply.

**Agent attachment (`thread_agents`, structurally identical to
`thread_participants`'s `left_at IS NULL` shape).** An agent is "current"
on a thread exactly when an open `thread_agents` row exists for
`(thread_id, agentId, workspaceId)`. `msp_thread_resolve` decides
attachment: minting a brand-new thread auto-attaches the minting agent
unconditionally (no claim needed, mirroring the first-HUMAN-membership
rule); resolving an existing thread requires the calling agent already be
current, or the grant to carry `assertAgents: true` (self-assert attach);
neither applies, the call is `agent_not_current`. A worker-only grant
(`operator`, with none of `readPrivate`/`writePrivate`/`confirmMemory`/
`deliveryWriter`) can never mint a room's first thread — such a resolve
against a room with no `ACTIVE` thread is refused `not_found`, never
`created: true`. `msp_thread_resolve`'s response gains
`agentAttached: boolean` — true exactly when this call caused a new
`thread_agents` row.

**The agent gate.** Every other thread-bound tool
(`msp_thread_message_append`, `msp_thread_context`,
`msp_thread_memory_record`, `msp_thread_injection_record`,
`msp_thread_delivery_record`'s resolved path, and
`msp_session_compaction_claim`/`_commit`/`_retry` via their job's own
thread) requires the calling agent be current on that thread, refused
`agent_not_current` otherwise — independent of, and in addition to, every
existing HUMAN-participant/capability check. An `AGENT`-kind
`msp_thread_message_append` requires `speaker_id === grant.agentId`.
`msp_session_sweep` is exempt from the currency check (it precedes any
single thread's resolution) but still requires `agentId`/`workspaceId`
present, and its per-job metadata gains `thread_kind`/`channel_type` so a
worker can construct its own subsequent resolve for that job's room.

**Delivery (`msp_thread_delivery_record`, CRITICAL 1).** Both its paths
are agent-gated. The resolved path (an inbound message already exists)
uses the same agent gate as every other thread-bound tool, through that
message's own thread. The pending path (no thread to check yet) resolves
the room's own `ACTIVE` thread directly and requires the calling agent be
current on it — `not_found` if the room has no `ACTIVE` thread at all.
`thread_pending_deliveries` now stores `agent_id`/`workspace_id`. At drain
time, the **stored** pair is re-checked for currency on the **inbound
message's own thread** (never a freshly re-derived room `ACTIVE` thread);
a departed or legacy `NULL` stored agent leaves the row unreconciled
(`reconcile_state` stays `pending`), recorded through the already-shipped
`msp_thread_message_append.reconcile_skipped` journal entry with
`error_code: 'agent_not_current'`. The resolved path's internal reply
speaks as `grant.agentId`; a drained reply speaks as the row's own stored
`agent_id` — neither path ever writes a fixed label.

**Protected records (`msp_thread_memory_record`, DEC-MEMOS-19).** A new
optional request field, `visibility` (`AGENT`|`THREAD`, default
`THREAD`), and two new response fields, `agentId` and `visibility`.
`THREAD` (the default) is shared among the thread's current agents,
matching stage-1 behaviour for the common single-agent case; `AGENT`
restricts a record to the agent that recorded it, filtered into
`msp_thread_context`'s `protectedRecords` on top of the existing
HUMAN-private-read filter, never in place of it. An absent
`requesterAgentId` sees `THREAD` records only. `agentId`/`visibility` join
`record_id`'s content hash, so two different agents asserting identical
content get two distinct records, never one shared row. Superseding an
unknown id, another agent's `AGENT`-visibility record, or a record failing
the pre-existing stage-1 ownership/status check are now the **one
identical** `validation_failed` answer ("supersedes_record_id does not
name a record this caller can supersede") — not three distinguishable
codes. `THREAD`-visibility and legacy (`agent_id IS NULL`) records stay
supersedable by any agent under the stage-1 rules alone. Summaries need no
equivalent filter: an agent that is current sees every summary the thread
has, and a departed agent's very next `msp_thread_context` call is already
refused `agent_not_current` before any summary is ever read.

### New grant claims (PH-MEMOS-4)

Three more optional boolean claims, additive to every claim above, each
read by its own tool's per-tool guard logic (not part of `verifyThreadGrant`
itself, exactly like `assertParticipants`/`assertAgents`):

| Claim | Required on | Absent/false → |
|---|---|---|
| `assertRelink` | `msp_thread_participant_lifecycle`'s `close_for_relink` action only, additive to `assertParticipants` | `thread_scope_denied` |
| `dataSubjectAccess` | `msp_thread_principal_erase`/`msp_thread_principal_export`, every call (self or cross-principal) | `thread_scope_denied` |
| `dataSubjectAdmin` | Same two tools, additive to `dataSubjectAccess`, only when `principal_id` names someone other than the grant's own principal | `thread_scope_denied` |

### Errors

Every thread tool answers one of a fixed, typed vocabulary, matching the
repo's existing convention (`vault_scope_denied`, `gks_provider_unconfigured`):
`validation_failed`, `not_found`, `thread_scope_denied`, `conflict`,
`identity_hmac_unconfigured`, `payload_too_large`, `thread_audience_mismatch`,
`record_subject_mismatch`, `compaction_lease_conflict`, `principal_erased`
(reserved, not raised in this phase either — erasure removes existing
content, it does not ban the principal from MSP going forward), and four
grant-verification-specific codes raised by `verifyThreadGrant` before any
scope decision is even evaluated: `grant_unconfigured` (no key resolves for
the grant's tenant), `grant_signature_invalid`, `grant_expired`,
`grant_payload_mismatch`. No error message embeds a raw `external_room_ref`
or person id.

Stage 2 adds three more codes (see "Multi-agent" above):
`agent_not_current` (the grant's `agentId` is not current on the resolved
thread, or `assertAgents` was needed and absent), `grant_nonce_required`
(a nonce-required tool's grant carries no `nonce` claim at all), and
`grant_replayed` (that `(tenantId, nonce)` pair was already consumed).
`thread_keyring_config_invalid` (BL-MEMOS-049, above) is a startup-time
failure, never returned from a tool call.

**PH-MEMOS-4 introduces no new error codes at all.** Every refusal in the
five new tools reuses the vocabulary above: `thread_scope_denied` for every
missing claim (`assertParticipants`, `assertRelink`, `dataSubjectAccess`,
`dataSubjectAdmin`) and for `close_for_relink` on a non-`DIRECT` thread;
`not_found` for `leave` naming a non-participant `speaker_id`;
`agent_not_current` for `msp_thread_agent_detach`'s second call; `conflict`
for an erasure idempotency-key replay naming a different `principal_id`,
and for the `close_for_relink`/in-flight-append status race (narrowed to
the store's own transaction-internal re-check, never a raw driver error);
`grant_nonce_required`/`grant_replayed` for the universal nonce gate on all
five new tools (`msp_thread_retention_tick`'s `dry_run: true` call is the
one exemption — it consumes no nonce, though it still journals).

Beneath all of the above, every thread tool -- like every other tool in
this runtime -- is also subject to the transport-level escaped-object-key
refusal (RKOI ruling, merge-blocking): `apps/msp-server/src/transport/
stdio-jsonrpc-server.mjs` refuses, before the real `JSON.parse` ever runs,
any inbound line whose object keys (at any nesting depth) contain a
backslash escape sequence, defending against a real V8 `JSON.parse` engine
bug (see `docs/API-009-Persistent-Memory-Contract.md` §6 and
`docs/NOTES.md` for the full finding). This is a transport-boundary check,
not a thread-scope decision, and answers a JSON-RPC `invalid_request`
error with `id: null`, never the `grant_*`/`thread_*` vocabulary above.

### Journaling (W5)

A HUMAN-attributable journal entry's `actor` field is the HMAC of the raw
speaker id under `MSP_IDENTITY_HMAC_KEY` — never the raw id itself. Stage 2
changes this for AGENT-attributable entries only (`msp_thread_message_append`
when the message's own `speaker_kind` is `AGENT`, and
`msp_session_compaction_commit`): `actor` becomes `grant.agentId` (for
commit, the claiming/committing worker's own agent id) directly, in plain
text — not a W5 regression, since `agentId`/`workspaceId` are Tier-1-owned
workspace/process identifiers, not personal data, the same category of
decision as already logging `toolName`/`ref`/`policyDecision` in plain
text. `msp_session_sweep` and delivery-drain keep their fixed,
non-identity system labels (`msp:session-router`, `msp:delivery-drain`) —
sweep spans many threads/agents at once, and drain has no live caller at
all.

### Test clock (W1)

`args.now` on any thread tool is honored **only** when the composition root
was started with `MSP_TEST_CLOCK=1` (`apps/msp-server/src/server.mjs` reads
this once, at startup, and injects the decision into
`createThreadHandlers`) — otherwise it is always ignored and the server's
real clock is used. A caller can never extend or backdate a lease, an idle
deadline or a grant's expiry by lying about the time.

The service secret is `MSP_THREAD_SERVICE_KEY`; `MSP_IDENTITY_HMAC_KEY` is
the identity-hashing key described above. Both are in
`MSP_RUNTIME_ENV_NAMES` (`packages/msp-client-js/src/msp-stdio-transport.mjs`)
so a client-spawned MSP child receives them; missing keys fail closed and
neither key is ever journaled or echoed back to a caller.
`MSP_THREAD_IDLE_TIMEOUT_MINUTES` and `MSP_THREAD_RECENT_EXCHANGES` are
ceilings.

### Per-tenant service key keyring (BL-MEMOS-049, stage 2)

`MSP_THREAD_SERVICE_KEYRING` is an **optional** replacement for the single
`MSP_THREAD_SERVICE_KEY`, resolved and validated once, synchronously, at
server start (`apps/msp-server/src/config/thread-service-keyring.mjs`,
wired in `apps/msp-server/src/server.mjs` — before `open(dbPath)` /
`runMigrations`, so a malformed keyring never creates or migrates a
database file, and never leaves an in-process caller holding an open,
uncloseable DB handle).

**Opt-in, no fallback.** Unset (or an empty string), `keyFor(tenantId)`
resolves every tenant to `MSP_THREAD_SERVICE_KEY`, byte-for-byte the
stage-1 behavior. Once `MSP_THREAD_SERVICE_KEYRING` is set to anything
else, `MSP_THREAD_SERVICE_KEY` is never consulted again, for **any**
tenant — including one present in the environment but absent from the
keyring, and including a grant signed with the old single key.

**Format.** A JSON object, `{"<tenantId>": "<key>"}`. `verifyThreadGrant`
(`packages/msp-contracts/src/contracts/thread-access.mjs`) already resolves
its HMAC key through an injected `keyFor(claimedTenantId)` function — the
keyring only supplies a smarter one; no change to grant verification, the
signature check, or `thread-guard.mjs` was needed. Selection uses the
grant's own **unverified** `tenantId` claim to pick a candidate key, and
that same key must then make the HMAC signature verify — a grant claiming
tenant B is only ever checked against tenant B's key, so a grant signed
under tenant A's key but claiming tenant B fails signature verification
(`grant_signature_invalid`), never reaching a per-tool authorization
decision. A tenant absent from a configured keyring resolves to no key at
all, which raises the **existing** `grant_unconfigured` — the same code a
caller already gets today when `MSP_THREAD_SERVICE_KEY` itself is
unresolvable. No new error code exists for "tenant not in the keyring".

**Refused outright, fail-closed at server start**, with the typed
`thread_keyring_config_invalid` configuration error (a class distinct from
the per-request grant vocabulary above — a deployment defect, not a
decision about any one caller's grant):
- invalid JSON;
- a non-object (JSON array, string, number, or `null`);
- an **empty** object (`{}`) — a keyring, once configured, must name at
  least one tenant, since naming none makes every grant unconditionally
  refused;
- a **duplicate** tenant id among the raw JSON's own top-level keys,
  including one that only differs from another by JSON escaping (e.g. a
  literal `-` versus its `\u002d` escape) — detected by scanning the raw
  source's own key tokens, since JSON.parse (and any reviver run over its
  result) silently keeps only the *last* occurrence of a repeated key
  before either ever sees the object;
- a tenant id that is empty, or that differs from its own trimmed form
  (leading/trailing whitespace never silently trimmed, never treated as a
  distinct tenant from its trimmed spelling);
- a key that is not a string, is under 32 characters (the same floor as
  `MSP_THREAD_SERVICE_KEY`/`MSP_IDENTITY_HMAC_KEY`), is blank, or has
  leading/trailing whitespace.

**Secrecy.** No error raised while parsing or validating the keyring ever
includes any text read out of the keyring itself — a caller-authored map of
`{tenantId: key}` can be written reversed (`{key: tenantId}`), at which
point there is no way, from inside the parser, to tell "this is a tenant
id" from "this is a secret key" by position alone. Every rejection instead
names the offending entry only by its 1-based position among the keyring's
top-level entries (e.g. "entry 2"), never by quoting anything drawn from
the map, in the message, a `cause`, or anywhere else the error object
exposes text. This matters beyond an operator's own log:
`apps/msp-server/bin/msp-server.mjs` lets a malformed-keyring exception
reach the process's default uncaught-exception handler (stderr), and
`packages/msp-client-js/src/msp-stdio-transport.mjs` folds a crashed
child's stderr tail into the error it raises to the **calling
application** — so a leak here would have reached the very caller the
keyring's tenant boundary exists to protect. The parsed keyring is also
built with `Object.create(null)` and looked up with `Object.hasOwn`, so an
entry literally named `__proto__` (a genuine, JSON.parse-produced own
property, not a prototype override) is stored and resolved as an ordinary
tenant, while `keyFor("constructor")`, `keyFor("toString")` and similar
`Object.prototype` member names resolve to `undefined` outright when not
actually configured — never by incidentally falling through to
`verifyThreadGrant`'s own `typeof key !== "string"` check.

**Secrecy (env forwarding).** `MSP_THREAD_SERVICE_KEYRING` is in
`MSP_RUNTIME_ENV_NAMES` alongside `MSP_THREAD_SERVICE_KEY` and
`MSP_IDENTITY_HMAC_KEY`; it is never journaled or echoed back to a caller.

**Rotation** (more than one live key per tenant) is explicitly deferred —
the flat `{tenantId: key}` format has no room for it, and none is designed
here. A host invokes the exported worker functions
(`apps/msp-server/src/thread-summary-worker.mjs`) with a scoped, pre-signed
authorized `call`, `workerId`, policy/summarizer versions and injected
`summarize({sources, protectedRecords, signal, instructions})`. It must
return `{invocationState: "TERMINAL", summary}`. The writer cannot certify
semantic truth or independently attest the provider; it validates the
trusted worker's terminal receipt, lease and evidence.

Leases default to 120 seconds, maximum 300. A worker waits for active answer
injection receipts or a pending reply grace of 120 seconds; expired active
invocations become UNKNOWN. Claims/commits use database transactions and
compare the current token/range. Sweep rediscovers retries and expired
leases within the exact signed business/account/room, computing that room's
hash once from the grant's own `tenantId`/`channelAccountId`/
`externalRoomRef` and binding it directly into its query — the hash no
longer depends on `channel_type`, so it is the same for every thread the
sweep might touch. The production scheduler/model adapter is supplied by
the host and is not activated in this repository change.

Delivery receipts name the internal `inbound_message_id` and
`${inbound_message_id}:assistant` source event. A trusted receipt creates a
missing outbound fallback, or remains in `thread_pending_deliveries` (its own
text also tombstone-protected) until its scoped inbound arrives. Late
delivery preserves original transcript and summary rows, adds
`thread_summary_invalidations`, and queues a new amendment. Only active,
non-invalidated summaries enter context. Context returns actual
`coveredSequences`; bounding sequence ranges alone do not prove coverage when
sessions interleave.

`thread_injection_receipts` stores RESOLVED -> SUBMITTED ->
COMPLETED/FAILED/UNKNOWN, packet SHA-256, exchange, policy revision and
provider/model reference. SUBMITTED means the model adapter was invoked, not
provider acceptance; COMPLETED means that adapter returned an OK result.
LINE acceptance is a separate receipt and is not a user read receipt.
Pending intake and leased job state are operational data, not confirmed
memory.

## Version history

### PH-MEMOS-4, BL-MEMOS-050..056/058/059, 2026-09-15

Participant lifecycle, relink, agent detach, and thread-scoped erasure/
retention/export, per docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md
v0.5.4b (RKOI-approved spec, four review rounds) and DEC-MEMOS-22..35.
Five new tools: `msp_thread_participant_lifecycle`, `msp_thread_agent_detach`,
`msp_thread_principal_erase`, `msp_thread_retention_tick`,
`msp_thread_principal_export` -- see "Participant and agent lifecycle,
relink, erasure, retention and export" above for the full shape. Corrects
already-shipped stage-1 code (`BL-MEMOS-058`, CRITICAL 1 from the design's
own review): a departed principal's very next plain `HUMAN` append no
longer silently re-creates membership through the claim-free
first-membership path -- the guard now distinguishes never-participated,
participated-but-none-current (a rejoin, unconditionally gated) and
current-row-exists as three distinct cases, not two. New migration
`migrations/0010_erasure_receipts.sql` (an additive trigger replacement on
`protected_memory_records` plus the new `erasure_receipts` table). New
`tests/security/participant-lifecycle-relink.security.mjs` and
`tests/security/thread-erasure.security.mjs`.

### TASK-MEMOS-002 stage 2, BL-MEMOS-040..048/112, 2026-09-15

Multi-agent, per docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md v0.4.3b
(RKOI-approved spec) and DEC-MEMOS-17..21: `agentId`/`workspaceId`/`nonce`
required grant claims, `thread_agents` attachment and the agent gate,
delivery's own agent scoping (CRITICAL 1), per-agent protected-record
visibility (CRITICAL 2), and replay-nonce bookkeeping. See "Multi-agent
(stage 2)" above for the full shape. `tests/cross/zuri-thread-contract.test.mjs`
now asserts zuri-ai's own unmodified grant is refused
`grant_signature_invalid` (DEC-MEMOS-17's hard cutover), alongside a
second, shape-only case wrapping zuri's port with the new stage-2 fields
added.

### TASK-MEMOS-002 stage 2, BL-MEMOS-049, 2026-09-15

Added the optional per-tenant `MSP_THREAD_SERVICE_KEYRING` described in
"Per-tenant service key keyring" above -- the one stage-2 item the ADR
specified fully ahead of the rest of stage 2 (multi-agent: `thread_agents`,
the agent gate, `agentId`/`nonce`/`assertAgents`, record visibility, worker
identity), which waits on its own spec review. RKOI's code review round 1
found and closed a CRITICAL (an inverted `{key: tenantId}` map could echo
the key itself through the startup error, reaching both the server's
stderr and, via `msp-stdio-transport.mjs`'s crashed-child-stderr-in-error
behavior, the calling application) before this landed -- every rejection
now names an offending entry by position only, never by quoting anything
read out of the keyring.

### TASK-MEMOS-002 stage 1, 2026-09-13

Folded the unmerged `origin/codex/msp-thread-memory` design (branch commits
`50859fb`, `e4303cb`) onto current `main`, fixed its C-1 (second-participant
read of a DIRECT thread) and C-2 (`msp-contracts` reading the database
directly) findings, and closed W1/W5/W6/W7/W10 plus the client
env-allowlist/key-passthrough items. Folded the branch's two migrations
(`0008`, `0009`) into one `migrations/0008_thread_memory.sql`, since nothing
past `0007` had shipped. Renamed from API-010 (now reserved for
`msp_vault_resolve`) to API-011. The multi-agent extensions (`agentId`,
`thread_agents`, per-agent record visibility) are stage 2, pending a
separate ADR.

### Approved refinement, 2026-09-08

The owner authorized documentation and implementation following the
independent Astra review. The Zuri plan revision 0.3.0b governs this paired
change. The 0.1 prototype is not a complete LINE memory implementation.

- Canonical context output uses `threadSummaries`, `protectedRecords`, `recentExchanges`, `participants`, and `coverageGap` (object or null). Protected writes return the record directly.
- Recent context includes six completed exchanges and the explicitly requested pending exchange. Completion requires an ACCEPTED/DELIVERED outbound or receipt; QUEUED/FAILED/UNKNOWN remain incomplete. Outbound must name its exchange and source reply.
- Thread tools require a signed, expiring operation/resource grant verified by the server against stored tenant/business/channel/thread scope. Raw thread IDs and actor strings confer no permission. Private context is DIRECT-only until verified group-audience policy is implemented.
- Protected records must cite messages actually authored by the asserting speaker; supersession preserves speaker and subject ownership. Retries are idempotent and insert/supersede is transactional.
- Summary commit recomputes source digests and requires explicit terminal state; the leased worker is injected with a summarizer, never embedded in the storage writer. Source ranges and protected references remain authoritative, not generated narrative.
- Partial summary overlap must never discard the uncovered prefix. Missing source coverage remains a structured gap. Read-side inspection shares the same authorization and expiry checks.

Operational task status, leases and errors are not canonical memory.
User-reported corrections are candidate evidence until verified. The old EVA
GKS-as-DNA meaning is not imported into Zuri's GKS knowledge authority.

| Version | Date | Status | Summary | Agent |
|---|---|---|---|---|
| 0.3.3b | 2026-09-15 | beta | RKOI ruling (merge-blocking, TASK-MEMOS-002 stage 2): documented the transport-level escaped-object-key refusal that now applies to every thread tool (a real V8 `JSON.parse` engine bug -- see `docs/API-009-Persistent-Memory-Contract.md` §6 and `docs/NOTES.md`); this is a transport-boundary `invalid_request` refusal, distinct from the `grant_*`/`thread_*` error vocabulary above. | KIN |
| 0.3.2b | 2026-09-15 | beta | TASK-MEMOS-002 stage 2, BL-MEMOS-049: optional per-tenant `MSP_THREAD_SERVICE_KEYRING` (opt-in, no fallback once configured, parsed/validated once at server start before the database is even opened); RKOI code review round 1 CRITICAL closed -- no rejection ever quotes anything read out of the keyring, only an entry's 1-based position, closing a path where an inverted `{key: tenantId}` map could echo the key through the startup crash into both the server's stderr and the calling application's own error | KIN |
| 0.3.1b | 2026-09-14 | beta | RKOI review revision (2 CRITICALs, multiple WARNINGs, 4 rounds against zuri-ai `origin/main`): dropped `channel_type` from the room hash and removed `channelType` from the delivery grant (CRITICAL 1, zuri-ai's real delivery grant never sent one); added DEC-MEMOS-15's self-upgrade exception plus its stored-`person_id` tightening (CRITICAL 2); added the per-tool audience requirement (required on every tool except delivery) and the room-hash cross-check on every thread-bound tool including compaction claim/commit/retry; `person_id` constrained to `{null, principalId}` unconditionally; tenant-scoped uniqueness extended to `thread_injection_receipts`/`thread_summary_invalidations`/cross-references between messages, jobs, summaries and their sessions; `chat_sessions` uniqueness narrowed to "at most one OPEN" only (a schema-level "one CLOSING" constraint was tried and dropped -- late-delivery reconciliation legitimately produces two); tombstone-then-INSERT and `IS NOT`-safe tenant triggers; `ON CONFLICT DO NOTHING` replacing `INSERT OR IGNORE` where it could swallow a NOT NULL violation; output-contract validation removed (ran only after commit); typed grant-verification errors (`grant_unconfigured`/`grant_signature_invalid`/`grant_expired`/`grant_payload_mismatch`) | KIN |
| 0.3.0b | 2026-09-13 | beta | TASK-MEMOS-002 stage 1: renamed API-010 -> API-011, tenant-scoped uniqueness, HMAC room refs, append-only participants with the one-human-per-DIRECT-thread invariant, `msp-contracts` decoupled from storage, required `source_event_id`, typed errors, test-only clock | KIN |
| 0.2.0b | 2026-09-08 | beta | Approved cross-repository contract, scope, exchange, coverage and summary refinement; verify implementation per acceptance matrix | RWANG |
| 0.1.0b | 2026-09-08 | candidate | Initial thread, speaker, session, protected memory and compaction contract | RWANG |

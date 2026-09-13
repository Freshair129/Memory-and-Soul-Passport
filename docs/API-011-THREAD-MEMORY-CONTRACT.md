---
doc_id: "API-011-THREAD-MEMORY-CONTRACT"
version: "0.3.0b"
status: "beta"
created_at: "2026-09-08T00:25:00+07:00,RWANG"
last_update: "2026-09-13T00:00:00+07:00,KIN"
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
is `HMAC-SHA256` under `MSP_IDENTITY_HMAC_KEY`, computed over the literal
string `"<tenant_id>|<channel_type>|<channel_account_id>|<external_room_ref>"`.
A tool that must compute this hash with no `MSP_IDENTITY_HMAC_KEY` configured
answers `identity_hmac_unconfigured` and writes nothing — the check happens
before any row is inserted or updated. The same key HMACs every journal
`actor` field (the raw speaker id, never written to the journal in the
clear) — see "Errors and journaling" below.

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
current participant row before the append is applied. A normal inbound
append by the grant principal, on a thread where that principal is already
the current human participant and nothing about their state changes, needs
no such claim — there is nothing to create or change. Every other case
answers `thread_scope_denied`. A HUMAN append's `speaker_id` must always
equal the grant's `principalId`; a caller can never mint or act as a
different person's speaker id.

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

Two additional grant claims, additive and backward compatible with every
claim zuri-ai already sends: `assertParticipants` (boolean; see
"Participants" above) and `channelType` (string; carried on a
`msp_thread_delivery_record` grant only, so a delivery received before its
inbound message arrives can still be identity-hashed against the room it
names, without guessing a channel type from a thread row that does not exist
yet).

### Errors

Every thread tool answers one of a fixed, typed vocabulary, matching the
repo's existing convention (`vault_scope_denied`, `gks_provider_unconfigured`):
`validation_failed`, `not_found`, `thread_scope_denied`, `conflict`,
`identity_hmac_unconfigured`, `payload_too_large`. No error message embeds a
raw `external_room_ref` or person id.

### Journaling (W5)

Every journal entry's `actor` field is the HMAC of the raw speaker id under
`MSP_IDENTITY_HMAC_KEY` — never the raw id itself — until stage 2 introduces
a first-class `agentId`/per-agent actor model. Worker-driven entries (sweep,
compaction commit) use a fixed, non-identity system label
(`msp:session-router`, `msp:compaction-worker`) instead.

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
ceilings. A host invokes the exported worker functions
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
leases within the exact signed business/account/room — re-deriving each
candidate thread's own room hash from ITS OWN `channel_type`, since a sweep
can span threads whose `channel_type` differs even under the same
`channel_account_id`. The production scheduler/model adapter is supplied by
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
| 0.3.0b | 2026-09-13 | beta | TASK-MEMOS-002 stage 1: renamed API-010 -> API-011, tenant-scoped uniqueness, HMAC room refs, append-only participants with the one-human-per-DIRECT-thread invariant, `msp-contracts` decoupled from storage, required `source_event_id`, typed errors, test-only clock | KIN |
| 0.2.0b | 2026-09-08 | beta | Approved cross-repository contract, scope, exchange, coverage and summary refinement; verify implementation per acceptance matrix | RWANG |
| 0.1.0b | 2026-09-08 | candidate | Initial thread, speaker, session, protected memory and compaction contract | RWANG |

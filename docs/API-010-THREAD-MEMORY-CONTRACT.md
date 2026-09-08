---
doc_id: "API-010-THREAD-MEMORY-CONTRACT"
version: "0.2.0b"
status: "beta"
created_at: "2026-09-08T00:25:00+07:00,RWANG"
last_update: "2026-09-08T11:50:20+07:00,RWANG"
---

# API-010 Thread, Speaker, Session and Compaction Contract

This contract is the first MSP-owned persistence slice for Zuri's unified
thread memory. Zuri supplies the tenant, business, channel and identity
references. MSP stores the thread lifecycle and memory provenance; it does not
resolve a provider ID or grant access.

## Identity and scope

`thread_id` identifies a conversation room. `speaker_id` identifies the actor
who authored one message. `person_id` is an optional Zuri identity reference;
it is not inferred from a speaker's text. `session_id` identifies one bounded
period of activity inside a thread. A session can close while its thread stays
active. `exchange_id` groups the inbound message and the reply that belong to
one turn.

Every durable message carries the thread, session, exchange, speaker, speaker
kind, identity assurance, direction, source event and monotonic thread
sequence. A duplicate `source_event_id` is idempotent. Messages are append-only.

Thread bindings are unique by `(channel_account_id, external_room_ref)` and
cannot be silently moved to another tenant, business or audience. The external
room reference is opaque to MSP and must not be used as an authorization key.

## Recent context and protected memory

`msp_thread_context` returns the most recent six exchanges by default. In a
group, each exchange contains every message and its `speaker_id`; it is never
flattened to one generic “customer” actor. The response also contains active
protected records and committed session summaries. A summary reports whether
its covered range overlaps the recent window so the context adapter can avoid
injecting duplicate content.

Protected records are explicit `CONSTRAINT`, `INSTRUCTION`, `CORRECTION` or
`PREFERENCE` entries. They require source message references and the asserting
speaker. A summary cannot erase one of these records. Supersession is explicit
and versioned.

## Session router and compaction

The runtime opens a session on the first message and refreshes its idle deadline
only for an inbound human message. The default idle timeout is 30 minutes. A
deterministic `msp_session_sweep` moves due sessions to `CLOSING` and creates an
idempotent compaction job. The job is durable, so a process restart does not
lose the deadline or the work item.

An external summarizer submits a structured summary to
`msp_session_compaction_commit` only after its model invocation is terminal.
The summary must include topics, decisions, open questions, pending actions,
corrections, outcomes and participants. The source sequence range and SHA-256
digest are stored with the summary. The watermark advances only after the
summary and job commit succeed together; failed work stays retryable and the
source messages remain available.

The initial implementation stores the durable state and validates the summary
contract. It does not run an LLM inside MSP. The injected `runThreadSummarySweep` / `runThreadSummaryJob` worker is responsible for selecting an authorized transcript range and calling
the summarizer.

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

All identifiers in this surface are references returned by MSP or opaque values
provided by Zuri. There is no filesystem path, raw provider credential or
password field in the contract.

## Runtime contract and receipts (0.2.0b)

`packages/msp-contracts/schemas/API-010.tools.json` is compiled by the external API guard. Requests carry `access.grant` plus HMAC-SHA256 signature over the exact grant JSON. The grant includes an SHA-256 hash of the unsigned request, tool operation, resource scope, actor, policy revision and expiry (60 seconds). Read and protected-write grants are separate; group/unknown audiences cannot read private context. A service signer is trusted to supply current Zuri authorization; raw IDs are never grants. The writer recomputes source hashes, including actual delivery evidence, and validates each summary bullet's `text`, `speakerId` and nonempty `sourceMessageRefs`; all generated bullets remain CANDIDATE.

The service secret is `MSP_THREAD_SERVICE_KEY` paired with `ZURI_MSP_THREAD_SERVICE_KEY`; missing keys fail closed. `MSP_THREAD_IDLE_TIMEOUT_MINUTES` and `MSP_THREAD_RECENT_EXCHANGES` are ceilings. A host invokes the exported worker functions with a scoped authorized `call`, `workerId`, policy/summarizer versions and injected `summarize({sources, protectedRecords, signal, instructions})`. It must return `{invocationState: "TERMINAL", summary}`. The writer cannot certify semantic truth or independently attest the provider; it validates the trusted worker's terminal receipt, lease and evidence.

Leases default to 120 seconds, maximum 300. A worker waits for active answer injection receipts or a pending reply grace of 120 seconds; expired active invocations become UNKNOWN. Claims/commits use database transactions and compare the current token/range. Sweep rediscovers retries and expired leases within the exact signed business/account/room. The production scheduler/model adapter is supplied by the host and is not activated in this repository change.

Delivery receipts name the internal `inbound_message_id` and `${inbound_message_id}:assistant` source event. A trusted receipt creates a missing outbound fallback, or remains in `thread_pending_deliveries` until its scoped inbound arrives. Late delivery preserves original transcript and summary rows, adds `thread_summary_invalidations`, and queues a new amendment. Only active non-invalidated summaries enter context. Context returns actual `coveredSequences`; bounding sequence ranges alone do not prove coverage when sessions interleave.

`thread_injection_receipts` stores RESOLVED -> SUBMITTED -> COMPLETED/FAILED/UNKNOWN, packet SHA-256, exchange, policy revision and provider/model reference. SUBMITTED means the model adapter was invoked, not provider acceptance; COMPLETED means that adapter returned an OK result. LINE acceptance is a separate receipt and is not a user read receipt. Pending intake and leased job state are operational data, not confirmed memory.

## Version history

### Approved refinement, 2026-09-08

The owner authorized documentation and implementation following the independent Astra review. The Zuri plan revision 0.3.0b governs this paired change. The 0.1 prototype is not a complete LINE memory implementation.

- Canonical context output uses `threadSummaries`, `protectedRecords`, `recentExchanges`, `participants`, and `coverageGap` (object or null). Protected writes return the record directly.
- Recent context includes six completed exchanges and the explicitly requested pending exchange. Completion requires an ACCEPTED/DELIVERED outbound or receipt; QUEUED/FAILED/UNKNOWN remain incomplete. Outbound must name its exchange and source reply.
- Thread tools require a signed, expiring operation/resource grant verified by the server against stored tenant/business/channel/thread scope. Raw thread IDs and actor strings confer no permission. Private context is DIRECT-only until verified group-audience policy is implemented.
- Protected records must cite messages actually authored by the asserting speaker; supersession preserves speaker and subject ownership. Retries are idempotent and insert/supersede is transactional.
- Summary commit recomputes source digests and requires explicit terminal state; the leased worker is injected with a summarizer, never embedded in the storage writer. Source ranges and protected references remain authoritative, not generated narrative.
- Partial summary overlap must never discard the uncovered prefix. Missing source coverage remains a structured gap. Read-side inspection shares the same authorization and expiry checks.

Operational task status, leases and errors are not canonical memory. User-reported corrections are candidate evidence until verified. The old EVA GKS-as-DNA meaning is not imported into Zuri's GKS knowledge authority.

| Version | Date | Status | Summary | Agent |
|---|---|---|---|---|
| 0.2.0b | 2026-09-08 | beta | Approved cross-repository contract, scope, exchange, coverage and summary refinement; verify implementation per acceptance matrix | RWANG |
| 0.1.0b | 2026-09-08 | candidate | Initial thread, speaker, session, protected memory and compaction contract | RWANG |

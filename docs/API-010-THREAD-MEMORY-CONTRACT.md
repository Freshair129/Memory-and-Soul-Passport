---
doc_id: "API-010-THREAD-MEMORY-CONTRACT"
version: "0.1.0b"
status: "candidate"
created_at: "2026-09-08T00:25:00+07:00,RWANG"
last_update: "2026-09-08T00:25:00+07:00,RWANG"
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
contract. It does not run an LLM inside MSP. The Zuri adapter or a future MSP
worker is responsible for selecting an authorized transcript range and calling
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
| `msp_session_compaction_retry` | mark a non-terminal compaction job retryable without losing its source range |

All identifiers in this surface are references returned by MSP or opaque values
provided by Zuri. There is no filesystem path, raw provider credential or
password field in the contract.

## Version history

| Version | Date | Status | Summary | Agent |
|---|---|---|---|---|
| 0.1.0b | 2026-09-08 | candidate | Initial thread, speaker, session, protected memory and compaction contract | RWANG |

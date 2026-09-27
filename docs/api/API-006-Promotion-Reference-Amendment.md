---
title: "API-006 Amendment: Promotion Proof References"
doc_id: "API-006-PROMOTION-REFERENCE-AMENDMENT"
status: "beta"
version: "0.1.0b"
updated: "2026-09-27"
owner: "Boss (CEO)"
source_of_truth: true
related_docs:
  - "docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md"
  - "docs/ADR-MSP-MEMORY-OS-MULTI-USER-MULTI-AGENT.md"
  - "docs/API-009-Persistent-Memory-Contract.md"
---

# API-006 Amendment: Promotion Proof References

This is a focused amendment to the legacy API-006 lifecycle surface. It
defines proof-reference behavior for `msp_evidence_record`,
`msp_knowledge_promote`, and `msp_memory_promote`; it does not restate the
other API-006 context or vault tools.

## Contract

1. `msp_evidence_record` requires a non-empty `workspace_id`. An accepted call
   creates an `msp:proof/...` receipt in MSP's append-only journal, stored with
   that request's workspace value.
2. `msp_knowledge_promote` requires a non-empty `workspace_id` and a
   `provenance_ref` that exactly identifies an allowed journal receipt created
   by `msp_evidence_record` in that same workspace.
3. `msp_memory_promote` requires each member of its non-empty `evidence_refs`
   array to exactly identify an allowed `msp_evidence_record` journal receipt
   in the request's `workspace_id`.
4. An absent, malformed, denied, or cross-workspace proof reference fails
   with the same `invalid_request` response. This avoids distinguishing an
   unknown receipt from one recorded in another workspace.
5. `source_memory_ref` remains opaque caller-supplied metadata. MSP does not
   resolve it to an entity or vault and does not read source content. This
   preserves DEC-MEMOS-52.
6. A proof receipt is evidence that MSP accepted a proof-registration call;
   it is not an MSP-verified evidence body. The current journal stores only
   registration metadata and does not persist `source_snapshot_hash` or the
   submitted proof body.
7. This amendment compares the `workspace_id` values supplied on registration
   and promotion calls; it does not authenticate that the caller controls the
   named workspace.

## Compatibility

Callers must register evidence in its workspace before using the returned
proof ref in either promotion tool. `workspace_id` is now required on
`msp_evidence_record` and `msp_knowledge_promote`; `msp_memory_promote` already
requires it. Calls using arbitrary strings, fabricated proof refs, or refs
from another workspace are refused. No database migration is required.

## CHANGELOG

| Version | Date | Status | Summary |
|---|---|---|---|
| 0.1.0b | 2026-09-27 | beta | Define same-workspace receipt resolution for promotion proof refs, preserve opaque source_memory_ref, and state that workspace equality does not authenticate the caller. |

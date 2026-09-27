# Promotion proof-reference validation gap — RCA and contract proposal

**Status:** Implemented; local verification complete
**Risk:** HIGH — promotion references gain same-workspace validation and two legacy calls now require `workspace_id`
**Scope:** `msp_memory_promote.evidence_refs`, `msp_knowledge_promote.provenance_ref`; preserve `source_memory_ref` opacity

## Symptom

`msp_memory_promote` accepts any non-`gks:` string in `evidence_refs`, including
`"trust me"`, then stores those values on the promoted entity. A fabricated
`msp:proof/...` reference also passes because this path does not check either
its shape or whether a proof-registration receipt exists.

`msp_knowledge_promote` already requires `provenance_ref` to start with
`msp:proof/` on both the server and JavaScript client. It does not check that
the reference names a locally recorded proof receipt. `source_memory_ref` is a
separate field: it remains caller-supplied opaque metadata under owner-confirmed
DEC-MEMOS-52 and is never resolved to an entity or vault.

## Evidence

- `apps/msp-server/src/transport/handlers/lifecycle-handlers.mjs` validates
  `provenance_ref` with an `msp:proof/` prefix at lines 147–157, while the
  `msp_memory_promote` handler at lines 321–338 only requires a non-empty
  `evidence_refs` array and calls `requireNoGksRefs` for evidence/source refs.
- `msp_evidence_record` derives a proof ref and appends an allowed journal row
  at `lifecycle-handlers.mjs:239–258`. The journal stores selected metadata
  (`idempotency_key`, `run_id`, `stage`, `verdict`), not the submitted evidence
  body or `source_snapshot_hash`; it exposes no dedicated proof-resolution
  method.
- `packages/msp-contracts/src/contracts/namespace-guard.mjs` implements a
  denylist for `gks:` values; it does not validate an MSP proof-reference type.
- `packages/msp-client-js/src/msp-client.mjs:38–45` already enforces the
  `msp:proof/` prefix for knowledge provenance. The focused server tests cover
  rejecting GKS refs and happy-path MSP refs, but do not cover arbitrary or
  nonexistent proof refs.
- `DEC-MEMOS-52` in the ADR and design confirms `source_memory_ref` is opaque
  metadata and that promotion does not read its source entity or vault.
- `docs/API-009-Persistent-Memory-Contract.md` says this surface is governed
  by `docs/api/API-006-Vault-Context-and-Replay-Contracts.md`, but that API-006
  file is absent from the current checkout. `docs/NOTES.md` also currently
  overstates the gap by saying `msp_knowledge_promote.provenance_ref` gets only
  GKS-prefix screening; the current code already enforces `msp:proof/` shape.

## Root Cause

The server reuses `requireNoGksRefs`, a foreign-namespace denylist, where the
memory-promotion request needs an explicit contract for proof-reference
semantics. The knowledge-promotion path separately enforces a namespace
prefix, but neither path establishes that the cited ref corresponds to a
recorded proof event. The referenced API-006 contract is missing, so the
promotion surfaces have no available normative document that reconciles these
different checks.

## Why the issue escaped detection

Tests used well-shaped `msp:proof/...` values for successful requests and
checked that `gks:` refs are rejected. They did not assert that arbitrary
strings or fabricated-but-namespaced refs fail. The notes grouped the two
promotion tools together and became stale after the knowledge handler gained
its prefix check. API-009 explicitly excludes these tools, and its referenced
API-006 contract is not present in this checkout.

## Approved Contract — DEC-MEMOS-75

1. Preserve `source_memory_ref` as opaque caller-supplied metadata. Do not
   require an MSP namespace and do not resolve or read an entity/vault from it;
   this preserves DEC-MEMOS-52.
2. Define `evidence_refs` and `provenance_ref` as `msp:proof/` references.
   `msp_evidence_record` and `msp_knowledge_promote` require `workspace_id`.
3. Both promotion paths require each proof ref to exactly match an allowed
   journal receipt created by `msp_evidence_record` in the same workspace.
   Missing, denied, malformed, and cross-workspace refs receive one generic
   `invalid_request` response. The check compares caller-supplied
   `workspace_id` values; it does not authenticate workspace control.
4. Proof receipt resolution confirms only that MSP accepted a prior proof
   registration. It does not authenticate or persist an evidence body or
   `source_snapshot_hash`.

This contract was selected by the owner on 2026-09-27. Its normative details
are in `docs/api/API-006-Promotion-Reference-Amendment.md` and design §5.0.10.

## Acceptance Criteria

- The contract explicitly distinguishes `source_memory_ref` from proof refs
  and does not reopen DEC-MEMOS-52.
- Proof refs resolve to allowed journal receipts in the same workspace on
  both promotion tools, with identical failure behavior for absent and
  cross-workspace receipts.
- API-006 documentation and `docs/NOTES.md` agree with server and client
  behavior.
- Tests cover arbitrary strings, malformed namespaces, fabricated namespaced
  refs, valid recorded refs, and cross-workspace cases when applicable.

## Prevention

Use a typed proof-reference validator and one indexed journal lookup for
proof fields instead of relying on a GKS-only denylist. Keep opaque source
metadata on a separate validation path. Cover malformed, unregistered,
denied, valid same-workspace, and cross-workspace references.

## Implementation and Verification

The server now requires `workspace_id` on proof registration and knowledge
promotion. Proof resolution checks the exact ref, supplied workspace value,
`msp_evidence_record` tool name, and `allow` decision in one prepared journal
query. Both promotion handlers return the same generic invalid request for
missing, malformed, denied, absent, and cross-workspace proof refs. The JS
client also requires `workspace_id`; `source_memory_ref` remains unread under
DEC-MEMOS-52. No migration was needed; the existing journal ref index serves
the lookup. Workspace comparison uses caller-supplied values and does not
authenticate workspace control.

Local verification on 2026-09-27:

- `npm run test:contract` — 22 files passed; 183 passed, 1 skipped.
- Focused promotion integrations — 3 files passed; 11 tests passed.
- `npm run test:security` — 203 tests passed, 0 failed.
- `node --test --test-concurrency=1 tests/security/promotion-proof-reference.security.mjs` — 1 test passed after adding the empty-workspace case.
- `git diff --check` — passed.

These are local results. They do not establish a hosted GKS canary, release,
or production activation.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.1b | 2026-09-27 | beta | Implement DEC-MEMOS-75 same-workspace proof-receipt checks, unify invalid-ref responses, preserve DEC-MEMOS-52 source opacity, clarify caller-supplied workspace equality, and record local contract/integration/security results. | working-tree | RWANG |
| 0.2.0b | 2026-09-27 | beta | Record owner-approved DEC-MEMOS-75: resolve proof refs to successful same-workspace journal receipts; preserve DEC-MEMOS-52 source ref opacity. | working-tree | RWANG |
| 0.1.0b | 2026-09-27 | candidate | Record RCA, correct the code/doc discrepancy, and propose proof-reference contract choices; no runtime changes pending approval. | working-tree | RWANG |

# Legacy context read ownership gap — RCA and remediation record

**Status:** Implemented and verified locally<br>
**Risk:** MEDIUM — existing read behavior changes; no schema change or data migration<br>
**Owner decision:** Fail closed for rows without a stored tenant/principal owner

**Traceability:** `DEC-MEMOS-74` (owner-confirmed 2026-09-25) and
`BL-MEMOS-117`.

## Symptom

`msp_context_diff`, `msp_context_audit`, and `msp_context_replay` can return
data for a context row whose `tenant_id` and `principal_id` are both `NULL`,
even when the request includes a missing, invalid, or mismatched grant. Such a
row has no persisted owner tuple against which MSP can authorize the read.

## Evidence

- `packages/msp-contracts/src/contracts/context-scope-guard.mjs` classifies a
  row with both owner columns `NULL` as legacy; `canReadContext` returns `true`
  for that row before it verifies any grant.
- `apps/msp-server/src/transport/handlers/context-handlers.mjs` routes all
  three read tools through `canReadContext`. Audit can then query the journal;
  diff can return changed references and, for a legacy row, its payload;
  replay marks the stored context reproducible.
- `tests/security/context-tools-ownership.security.mjs` explicitly asserts
  that audit/replay of a legacy row succeeds without a grant, that diff can
  compare a scoped row with a legacy row, and that legacy diff may return its
  payload.
- `docs/NOTES.md` and the current design's §5.0.7 describe this as retained
  legacy behavior. The design specifies grant checks for scoped rows only.

## Root Cause

The legacy compatibility branch treats the absence of owner columns as
permission to read. Since `actor` is caller-supplied audit text and neither
owner column exists, the runtime has no trustworthy identity to compare with
the row. The early return therefore bypasses authorization rather than
failing closed.

## Why the issue escaped detection

The compatibility rule was intentional and the security suite encoded it as
a passing expectation. Scoped-row authorization tests therefore passed while
the unscoped branch remained outside the grant check. No trusted owner mapping
exists for historical rows, so a migration cannot safely infer their owner.

## Approved Contract Amendment

The owner selected the fail-closed behavior for rows without a stored
`tenant_id`/`principal_id` tuple:

1. A row with both columns `NULL` is unowned and cannot be read through
   `msp_context_diff`, `msp_context_audit`, or `msp_context_replay`.
2. A valid grant does not authorize an unowned row. Missing or invalid grants
   do not change the result.
3. Each tool follows its existing unknown-row response path: `diff` returns
   `not_found`; `audit` returns its existing empty, non-replayable result (or
   its existing identifier-mismatch error when an unrelated cache/injection
   id is supplied); `replay` reports `context_reproducible: false` with its
   existing `context_not_found` diagnostic. Audit must not search the journal
   for an unowned context id.
4. Do not backfill either owner column, delete rows, or infer ownership from
   `actor`, `workspace_id`, or `agent_id`. Existing unowned rows remain stored
   but are unreadable through these receipt tools.
5. Keep the `msp_context_resolve` write shape unchanged in this amendment.
   A call without `access_context` may still create an unowned row; subsequent
   diff/audit/replay reads of that row follow the fail-closed rule. Requiring
   ownership at write time is a separate contract change.
6. Keep the current scoped-row grant checks and scoped `include_payload`
   restriction unchanged.

This amendment is recorded in the parent design's §5.0.7 and the ADR's
DEC-MEMOS-74 confirmation. Same-level notes and the implementation plan are
updated. The code guard and security/contract coverage now enforce it.

## Acceptance Criteria

- An unowned row is indistinguishable from an unknown row through each of the
  three receipt-read tools, including when a valid grant is supplied.
- No diff payload or changed-reference list is returned for an unowned row.
- Audit does not call `journal.read` for an unowned row; its output contains
  no findings and is non-replayable.
- Replay does not claim reproducibility for an unowned row.
- Existing scoped-row grant, error-shape, and payload-refusal behavior remains
  unchanged.
- No ownership backfill, row deletion, schema migration, deployment, or
  unrelated change is performed.

## Prevention

Use one fail-closed context-read predicate for scoped, unscoped, and malformed
rows. Keep the unknown-row branch before any payload, journal, cache, or
injection lookup. Replace the existing legacy-success security cases with
unowned-row denial cases and retain explicit scoped-row regression coverage.

## Implementation and Verification

- `canReadContext` now denies a row whose stored tenant/principal tuple is
  absent, before any grant verification. Scoped-row grant handling is
  unchanged.
- Security cases now prove diff denial, quiet audit and non-reproducible
  replay for unowned rows with no grant, an invalid grant, or a valid grant.
  Existing scoped grant, audit-identifier, and payload-refusal cases remain
  covered.
- `node --test --test-concurrency=1 tests/security/context-tools-ownership.security.mjs` — **PASS, 17/17**.
- `npm run test:contract` — **PASS, 22/22 files; 183 passed, 1 skipped**.
- No schema migration, data backfill, deletion, deployment, or production
  verification was performed.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-25 | implemented | Implement and locally verify owner-confirmed fail-closed reads for unowned context rows; preserve unscoped writes and record focused security/contract results. | working-tree | RWANG |
| 0.1.0b | 2026-09-25 | candidate | Record RCA and owner-selected fail-closed contract proposal for context receipt reads on rows without a tenant/principal owner; reserve DEC-MEMOS-74 and BL-MEMOS-117 pending review. | working-tree | RWANG |

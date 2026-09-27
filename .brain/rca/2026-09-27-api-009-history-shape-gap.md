# API-009 history entry shape — RCA and resolution

**Status:** Resolved by user-approved documentation correction<br>
**Risk:** MEDIUM — public API contract mismatch; this correction aligns documentation and adds a response-shape regression assertion without changing runtime behavior<br>
**Complexity:** C-2 — documentation-driven contract correction<br>
**Scope:** `MemoryEntityHistoryEntry` and `msp_memory_history` response shape

## Symptom

Before correction, API-009 defined `MemoryEntityHistoryEntry` as
`MemoryEntity & { version }`,
which promises `current_version`, `lifecycle_state`, `decay_score`, and
`access_count` on every historical entry. The current handler intentionally
omits those four values because the historical table does not store them per
version. The endpoint's actual entry also includes `change_reason` and
`actor`, which are not in `MemoryEntity`.

## Evidence

- Before correction, `docs/API-009-Persistent-Memory-Contract.md` defined
  the full `MemoryEntity` and aliased history entries to that complete type
  plus `version`.
- `apps/msp-server/src/transport/handlers/memory-handlers.mjs` constructs the
  exact response: stable entity identity fields, the historical snapshot
  fields, `change_reason`, and `actor`; it omits the four current-state-only
  fields.
- `migrations/0001_init.sql:45-60` defines `entity_history` without
  `current_version`, `lifecycle_state`, `decay_score`, or `access_count`.
- Before correction, `tests/integration/memory-crud.test.mjs` checked
  ascending order and historical body values but not the response field set;
  it now asserts the exact entry keys too.
- Before correction, `docs/NOTES.md` recorded that extraction preserved the
  runtime response rather than fabricating historical values or changing the
  schema.
- The linked API-009 SDD/SRS files are absent from this checkout. The available
  top-level `docs/ARCHITECTURE.md` records the entity-history relationship but
  does not define the history entry fields.

## Root Cause

The API type reuses the current-state `MemoryEntity` shape for a historical
snapshot. Those models have different fields: a history row contains versioned
content and provenance, while lifecycle, decay, access count, and current
version are stored only on the live `entities` row. The transport preserves
the source runtime's existing response, so the human-readable API contract is
broader than the executable contract.

## Why the issue escaped detection

Before correction, history tests asserted ordering and body snapshots but not
exact response keys. The implementation comment and NOTES disclosed the
mismatch, but API-009's type alias and response example were not reconciled
with that evidence.

## Chosen Resolution

The user approved the recommended documentation correction: API-009 now defines
the exact `msp_memory_history` entry shape and states that the four
current-state-only fields are unavailable per historical version. Runtime and
schema are preserved. NOTES records the resolution, and the handler comment
points to the corrected contract.

The broader alternative of changing storage/runtime to capture those fields
for every historical version was left out of scope. It requires a separate
decision about whether decay, access-count updates, and lifecycle transitions
create history versions, plus a migration and writes at each relevant
mutation point.

## Acceptance Criteria for the Documentation Correction

- API-009's history type and §4.4 match the fields returned by the handler.
- The history integration test asserts the exact entry field set and retains
  its ordering/body assertions.
- Runtime and database schema remain unchanged.
- NOTES and the handler comment no longer describe the contract mismatch as
  open.

## Proposed Prevention

Keep API response types distinct from current-state entity types. Conformance
tests for public response contracts should assert exact field sets where the
contract promises a concrete object shape.

## Implementation and Verification

Implemented in API-009 v0.3.4+draft and NOTES v0.4.1b. Static review confirmed
the documented keys match the response object in `msp_memory_history` and the
per-version columns in `migrations/0001_init.sql`. No runtime or schema changes
were made. `tests/integration/memory-crud.test.mjs` passed: 1 file, 9 tests.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1 | 2026-09-27 | resolved | Apply the approved documentation correction; align API-009, NOTES, and the handler comment with the stored history response, and assert exact history keys. | working-tree | RWANG |
| 0.1.0b | 2026-09-27 | candidate | Record the API-009 history response mismatch, supporting evidence, and documentation-versus-storage resolution options. | working-tree | RWANG |

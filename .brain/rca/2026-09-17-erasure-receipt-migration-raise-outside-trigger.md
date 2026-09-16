---
version: "0.1.0b"
created_at: "2026-09-17T00:00:00+07:00,RWANG"
last_update: "2026-09-17T00:00:00+07:00,RWANG"
status: "candidate"
attributes:
  domain: "migration-runtime"
  doc_type: "rca"
  scope: "BL-MEMOS-076-erasure-receipt-pseudonymization"
---

# RCA: SQLite migration precondition cannot call `RAISE()` at top level

## Symptom

The first draft of `0014_erasure_receipts_pseudonymize.sql` used a top-level
`SELECT CASE ... THEN RAISE(ABORT, ...) END` as the non-empty-table guard
specified by design §12.5. SQLite accepts `RAISE()` only inside a trigger
program, so this form would fail before the intended precondition could be
evaluated, including on the approved empty-table path.

## Evidence

The migration runner executes each SQL file through `db.exec(file.sql)` inside
its migration transaction (`packages/msp-storage/src/db/migrate.mjs`). The
draft migration's first executable statement was the top-level `SELECT CASE`
shown above, while the design's own §12.5 SQL block repeats that same form.
The repository contains no SQLite user-defined function that could provide an
alternate top-level abort primitive. The parent review identified the SQLite
grammar restriction before the migration was run against a database.

## Root Cause

The normative migration shape specified the intended fail-closed behavior but
used the trigger-only `RAISE(ABORT, ...)` expression as though it were a
general top-level SQL function. The implementation copied that invalid
mechanical form instead of adapting the approved behavior to SQLite's actual
execution context.

## Why the issue escaped detection

The migration was drafted before dependencies were installed in the isolated
worktree, and the first test draft had not yet reached `runMigrations`. A
syntax-level review of the SQL statement did not exercise SQLite's trigger
context rule.

## Proposed prevention

Keep the design's exact fail-closed message and transaction semantics, but
realize the guard with a transient guard table and `BEFORE INSERT` trigger:
the trigger evaluates `EXISTS (SELECT 1 FROM erasure_receipts)` and raises the
same abort message; the migration inserts one probe row and then drops the
transient trigger and table on the empty path. The outer migration transaction
rolls the transient objects back together with all rebuild statements on a
non-empty failure. Add integration cases for both an empty success and a
non-empty rollback, including proof that no guard object remains.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | candidate | Documented the trigger-context root cause and the transactional guard-table correction for BL-MEMOS-076. | working-tree | RWANG |

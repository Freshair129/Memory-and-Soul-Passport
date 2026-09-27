# API-009 machine contract version drift — RCA and resolution

**Status:** Resolved<br>
**Risk:** LOW — contract metadata and test coverage only; runtime behavior is unchanged<br>
**Complexity:** C-1 — direct metadata correction with focused validation<br>
**Scope:** API-009 source-document and machine-readable contract version parity

## Symptom

The human-readable API-009 contract had advanced to `0.3.5+draft`, while its
exported machine-readable copy still declared `0.3.0+draft`.

## Evidence

- `docs/API-009-Persistent-Memory-Contract.md` frontmatter declared
  `0.3.5+draft`.
- `packages/msp-contracts/schemas/API-009.tools.json` declared
  `0.3.0+draft` and is exported by `packages/msp-contracts/package.json` as
  `./api-009`.
- `tests/contract/api-009-conformance.test.mjs` expected the same stale
  `0.3.0+draft` value, so it did not compare the machine copy to its source.
- `docs/NOTES.md` identifies the JSON schema as a machine-readable copy that
  is not wired into runtime dispatch.

## Root Cause

The source document and machine-readable copy store the contract version
separately. When the source document advanced, its version was not propagated
to the JSON metadata. The conformance test duplicated the old value instead
of checking source-document parity.

## Why the issue escaped detection

The test checked that the schema matched a hard-coded version, but that value
was stale in the same way as the schema. Since runtime dispatch does not load
the machine-readable copy, real-stdio behavior could not expose the metadata
mismatch either.

## Proposed Prevention

Have the conformance test read the API-009 frontmatter version and compare it
to `contract.version` in the JSON schema. Keep runtime schema validation out
of scope; the machine copy's dispatch status is documented separately.

## Resolution and Verification

Updated the machine-readable contract to `0.3.5+draft` and changed the
conformance test to compare its version with the source document. Tool names,
input schemas, and runtime dispatch are unchanged.

Verification: `tests/contract/api-009-conformance.test.mjs` passed after the
change; `git diff --check` passed.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0 | 2026-09-27 | resolved | Synchronize API-009 machine-contract version metadata and add direct conformance coverage against the source document. | working-tree | RWANG |

---
version: "0.1.1b"
created_at: "2026-08-12T08:25:00+07:00,ATHER,394a176"
last_update: "2026-08-12T08:37:19+07:00,ATHER"
status: "beta"
attributes:
  domain: "test-infrastructure"
  doc_type: "rca"
  scope: "standalone-vitest-runner"
---

# RCA: missing standalone Vitest timeout configuration

## Symptom

Two integration cases timed out at exactly 5,000 ms while the remaining 133 integration assertions passed.

## Evidence

The copied source tests allow the default vector backend to degrade without failing durable writes. The source package also contains `vitest.config.mjs` with 30,000 ms test and hook timeouts. That runner configuration was absent from the standalone root, so Vitest used its 5,000 ms default.

## Root Cause

The extraction inventory mapped runtime source and test files but omitted the package-local Vitest runner configuration. Moving tests to the repository root changed the effective timeout even though test and runtime logic were unchanged.

## Why the issue escaped detection

The runner configuration was listed in the source file inventory but was not included in the initial source-to-package mapping table.

## Proposed prevention

Carry runner metadata that changes test semantics, adapt only its root/include paths, and compare effective test settings during extraction inventories.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial RCA and prevention. | 394a176 | ATHER |

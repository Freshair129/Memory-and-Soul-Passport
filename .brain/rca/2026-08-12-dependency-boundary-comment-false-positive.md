---
version: "0.1.1b"
created_at: "2026-08-12T08:23:30+07:00,ATHER,394a176"
last_update: "2026-08-12T08:37:19+07:00,ATHER"
status: "beta"
attributes:
  domain: "test-infrastructure"
  doc_type: "rca"
  scope: "dependency-boundary-contract-test"
---

# RCA: dependency-boundary comment false positive

## Symptom

`npm run test:contract` failed the assertion that `msp-contracts` must remain decoupled from the vault registry implementation.

## Evidence

The failure matched `domain/vault-registry.mjs` inside explanatory comments in `vault-scope-guard.mjs`. The file's only import is `./errors.mjs`; no vault-registry implementation is imported.

## Root Cause

The new standalone boundary assertion searched the full source text with a broad regular expression instead of evaluating parsed import specifiers. Existing comments intentionally name the forbidden dependency while explaining why it must not be imported.

## Why the issue escaped detection

The assertion was newly adapted for the workspace split and had not yet been run against the copied source comments.

## Proposed prevention

Reuse the test's `importSpecifiers()` helper and assert against actual import declarations only. Keep comments outside dependency-graph evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial RCA and prevention. | 394a176 | ATHER |

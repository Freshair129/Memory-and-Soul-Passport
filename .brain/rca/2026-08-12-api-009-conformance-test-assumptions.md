---
version: "0.1.1b"
created_at: "2026-08-12T08:27:20+07:00,ATHER,394a176"
last_update: "2026-08-12T08:37:19+07:00,ATHER"
status: "beta"
attributes:
  domain: "contract-testing"
  doc_type: "rca"
  scope: "api-009-conformance"
---

# RCA: API-009 conformance test assumptions

## Symptom

The new API-009 contract suite failed its search-mode assertion and then encountered a Windows `EPERM` while deleting the temporary database directory.

## Evidence

The search query exactly matched the entity key, so the runtime correctly returned `searchMode: exact`. The process-backed client `close()` sends a child kill without waiting for the OS exit/file-handle event; immediate recursive deletion raced the SQLite handle release.

## Root Cause

The test assumed every explicit FTS request reports `fts_only` even when the existing exact-match short circuit wins, and assumed process termination/file release is synchronous on Windows.

## Why the issue escaped detection

This was new conformance coverage. Existing source tests separately cover exact mode and use best-effort cleanup, but those details were not carried into the first draft.

## Proposed prevention

Assert the actual frozen precedence (`exact` before FTS) and make process-backed test cleanup wait briefly and retry Windows deletion.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial RCA and prevention. | 394a176 | ATHER |

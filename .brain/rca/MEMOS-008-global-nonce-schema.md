---
version: "0.1.0b"
created_at: "2026-09-17T01:51:07+07:00,RWANG,bfe7c9d"
last_update: "2026-09-17T01:51:07+07:00,RWANG"
status: candidate
attributes:
  domain: mission-state-protocol
  doc_type: root-cause-analysis
---

# MEMOS-008 global nonce schema mismatch

## Symptom

Design v0.9.9b section 5.0.9 requires global-private grant nonces in the
`(NULL, nonce)` partition of the existing `grant_nonces` table. That insert
cannot succeed with the shipped schema. Merely allowing NULL would still
fail to enforce replay protection.

## Evidence

- `migrations/0009_thread_agents.sql:69-74` declares `tenant_id TEXT NOT NULL`
  and `PRIMARY KEY (tenant_id, nonce)`.
- No later migration in the inspected baseline changes this table.
- A local Node 24.19.0 `node:sqlite` in-memory reproduction with nullable
  `tenant_id` and that composite primary key inserted `(NULL, 'nonce')`
  twice successfully; `COUNT(*)` returned 2. This was synthetic local proof,
  not an observation from a deployed database.
- `ThreadRegistry#consumeNonce` currently relies on the database uniqueness
  failure to detect replay. Removing that guarantee would invalidate it.

## Root cause

The new design assumed both that the existing tenant key was nullable and
that a nullable composite primary key supplied uniqueness for NULL rows.
Neither assumption holds for this SQLite rowid table.

## Why the issue escaped detection

Existing thread grants always supply a real tenant. Their tests exercise
non-NULL primary-key conflicts; the proposed global partition was not
implemented or tested against the shipped migration graph.

## Proposed prevention

Approve the companion `docs/MEMOS-008-NONCE-SCHEMA-AMENDMENT.md`, then test
fresh and populated migration graphs plus null-tenant duplicate rejection,
cross-partition separation, expiry pruning, and mutation/nonce rollback.
Preserve checksums of already-shipped migrations 0001-0010.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | candidate | Record reproduced nonce schema mismatch and proposed prevention | bfe7c9d | RWANG |

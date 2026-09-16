---
doc_id: "BL-MEMOS-076-EVIDENCE"
version: "0.1.0b"
created_at: "2026-09-17T00:00:00+07:00,RWANG"
last_update: "2026-09-17T00:00:00+07:00,RWANG"
status: "candidate"
attributes:
  domain: "mission-state-protocol"
  doc_type: "verification-evidence"
  scope: "BL-MEMOS-076-erasure-receipt-pseudonymization"
---

# BL-MEMOS-076 verification evidence

This note records local worktree evidence for the §12.5 erasure-receipt
pseudonymization slice. It is engineering evidence, not production readiness
or a hosted CI result.

## Cost and rotation evidence

The implementation uses the specified domain-separated HMAC stage followed by
`scryptSync(stage1, rowSalt, 32, { N: 16384, r: 8, p: 1 })` with a 16-byte
per-receipt salt. A direct Node benchmark on this host ran 20 derivations:

~~~text
{"n":20,"scrypt":{"N":16384,"r":8,"p":1,"dkLen":32,"saltBytes":16},"elapsedMs":397.98,"perDerivationMs":19.9}
~~~

The result is a measurement of this host and runtime only; it is not an
infeasibility claim. Rotation behavior is covered by
`tests/security/thread-erasure.security.mjs`: the active `identity-v1` row
replays after rotation to `identity-v2` when `identity-v1` remains in the
retired keyring; when that optional keyring entry is omitted, the same row
returns the distinct “identity-key version is unavailable” conflict. A wrong
principal with an available key returns the distinct mismatch conflict. A
configured empty `{}` keyring is rejected at startup, matching the shipped
thread-service keyring convention; the pruning case therefore models removal
by omitting the optional environment variable.

## Reproducible local checks

| Check | Result |
|---|---|
| `npx vitest run tests/contract/identity-hmac-keyring.test.mjs tests/integration/erasure-receipts-pseudonymize.test.mjs` | 2 files, 12/12 passed |
| `npm run test:vitest` | 42 files, 467 passed, 1 skipped |
| `node --test --test-concurrency=1 tests/security/thread-erasure.security.mjs` | 26/26 passed |
| `npm run test:security` | 184/184 passed |
| `npm --cache .tmp/npm-cache run pack:client` | passed; client dry-run package `@freshair129/msp-client-js@0.2.6` |
| `node --check` on changed JavaScript modules | passed |

Migration `0014_erasure_receipts_pseudonymize.sql` is intentionally numbered
after the parent integration's reserved `0013` nonce amendment. The migration
has direct empty-table success and non-empty-table rollback coverage, and its
fail-closed precondition uses a transient trigger because SQLite permits
`RAISE(ABORT)` only inside a trigger program.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | candidate | Recorded local scrypt cost, key rotation/pruning behavior, and BL076 test evidence. | working-tree | RWANG |

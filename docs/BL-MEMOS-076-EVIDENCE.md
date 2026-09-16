---
doc_id: "BL-MEMOS-076-EVIDENCE"
version: "0.1.1b"
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

Root repeated the benchmark on Node 24.19.0 / Intel Core i7-14700KF:
100,000 SHA-256 candidates averaged 0.001015 ms, 100,000 HMAC-SHA256
candidates averaged 0.002054 ms, and 20 scrypt derivations averaged
20.988920 ms. All inputs were synthetic. This shows a measured per-candidate
cost increase on this host; a small identifier space is still enumerable.

The rotation procedure follows design §12.5:

1. Choose a new, previously unused key-version label and generate a new key.
2. Keep the previous label/key in the protected `MSP_IDENTITY_HMAC_KEYRING`
   configuration if old receipts must remain matchable.
3. Replace the active `MSP_IDENTITY_HMAC_KEY` and its `_VERSION` together,
   then restart the service. New receipts use only this active pair.
4. Verify a nonce-fresh idempotent retry against an older receipt while its
   retired key remains configured. No receipt row is rewritten.
5. Removing a retired key makes its receipts unmatchable; it does not prove
   a different principal and does not delete those permanent receipts.

This keyring is only for receipts. Existing room hashes and journal actors
continue using the active identity key; their pre-existing rotation limits
remain unchanged. No production rotation was performed for this task.

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
| 0.1.1b | 2026-09-17 | candidate | Record SHA/HMAC comparison and the existing specified rotation procedure. | working-tree | RWANG |
| 0.1.0b | 2026-09-17 | candidate | Recorded local scrypt cost, key rotation/pruning behavior, and BL076 test evidence. | working-tree | RWANG |

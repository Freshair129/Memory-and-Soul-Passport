---
version: "0.1.0b"
created_at: "2026-08-12T08:33:00+07:00,ATHER"
last_update: "2026-08-12T08:33:00+07:00,ATHER"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "verification-report"
  scope: "gate-a"
---

# Gate A verification report

Verified on Windows from `D:\msp` on 2026-08-12. A checkbox is marked only where the cited command exercised the behavior.

| Gate | Result | Evidence |
|---|---|---|
| MSP server boots standalone with no GoVibe path | PASS | `tests/contract/transport-fixture-parity.test.mjs` spawns `apps/msp-server/bin/msp-server.mjs`; root `npm test` passed. |
| `msp-client-js` connects from a separate external process | PASS | `npm pack` tarball installed in an isolated temp npm project; smoke output reported `ping:true`. |
| Memory CRUD (upsert/search/history) | PASS | Packed-client smoke reported `created:true`, `search_hits:1`, `history_versions:1`; API-009 conformance suite passed all nine tools. |
| FTS search without extra infrastructure | PASS | API-009 contract and degradation suites run with a closed Ollama endpoint and pass exact/FTS fallback behavior. |
| Vault isolation | PASS | `npm run test:security`: 30/30, including cross-vault search/read/mutation/link/decay/promotion checks. |
| Context resolve, lineage, and replay | PASS | Contract/context replay suites are included in the 23 passing Vitest files; GoVibe context/runtime consumer tests also passed. |
| Decay lifecycle | PASS | Unit, integration, dry-run, journal, and cross-vault decay tests passed. |
| Contract, security, and integration suites | PASS | Root `npm test`: 23 Vitest files / 176 tests and 30 Node security tests, all passed. |
| GKS promotion remains fail-closed without provider | PASS | Security proof covers `msp_knowledge_promote` and shared `msp_memory_promote`, both returning `gks_provider_unconfigured`. |
| GoVibe uses extracted client unchanged in behavior | PASS | Temporary two-line re-export repoint: targeted 7 files / 32 tests; full GoVibe 616 passed / 1 skipped; security 65/65. Repoint was then cleanly reverted. |

## Packaging evidence

`npm pack --workspace @freshair129/msp-client-js --dry-run` produced a five-file package with no runtime dependencies:

- `package.json`
- `src/authority-enforcement.mjs`
- `src/index.mjs`
- `src/msp-client.mjs`
- `src/msp-stdio-transport.mjs`

The packed tarball was installed with `npm install --ignore-scripts` into an isolated npm project before the external-process smoke test.

## Migration integrity

All seven root migration files matched the SHA-256 of the corresponding GoVibe source migration immediately after copy. Runtime migration tests also passed checksum-drift, downgrade, ordering, and idempotency checks.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-12 | beta | Initial evidence-backed Gate A report. | pending | ATHER |

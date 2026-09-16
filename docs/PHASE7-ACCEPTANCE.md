---
version: "0.1.1b"
created_at: "2026-09-17T00:00:00+07:00,LUNA"
last_update: "2026-09-17T00:00:00+07:00,LUNA"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "verification-report"
  scope: "phase-7-acceptance"
---

# Phase 7 acceptance harness

`tests/e2e/phase7-acceptance.mjs` is the executable BL-MEMOS-083 harness. It
starts the real stdio server and exercises the approved API-010/API-011 wire
shapes. The run prints a JSON report with `PASS`, `FAIL` and `NOT_RUN` rows. A
required `FAIL` or `NOT_RUN` sets exit code `2`; the report must remain visible
to reviewers instead of being treated as a green release result.

Run it with:

```text
npm run test:phase7
```

The matrix has 2 tenants × 3 principals × 2 agents × 2 thread audiences = 24
legs. The real process cases cover thread resolve, inbound and outbound append,
private context and confirmed protected-memory records on `DIRECT` threads,
the expected private-read and record refusals on `GROUP` threads, and summary
creation through sweep → claim → commit. Four directed negative cases then
reuse a real `DIRECT` thread to prove cross-tenant, cross-principal,
cross-agent, and cross-workspace refusals. Each matrix leg uses a signed grant;
the harness does not replace the service guard with an in-process mock.

Summary timing is deterministic within the dedicated acceptance child. The
child bootstraps `MSP_TEST_CLOCK=1` at module load and uses a one-minute idle
timeout with timestamps five minutes in the past, so the sweep runs without a
wall-clock sleep. The production client environment allowlist remains
unchanged; `MSP_TEST_CLOCK` is intentionally not forwarded by that allowlist.

The legacy vault case runs in a separate real process without
`MSP_IDENTITY_HMAC_KEY` or `MSP_THREAD_SERVICE_KEY`. The latest phase-5
contract requires that unsigned legacy resolution still returns the legacy
fields, returns `null` principal-vault fields, and creates no
`principal_private` or `principal_passport` row. The harness checks the response
and the database directly. A baseline that still applies the earlier
phase-5 behavior is reported as `FAIL` with that contract gap.

## Dependency and evidence table

| Backlog | Harness evidence | Current status | Dependency or blocker |
|---|---|---|---|
| BL080 | `docs/MIGRATION.md` shadow-table policy | PASS in this branch | None; documentation-only hardening |
| BL081 | `tests/integration/migrate.test.mjs` visible rtree skip | PASS in this branch | None; runner test is explicit when rtree is unavailable |
| BL082 | `docs/MIGRATION.md` exact line-1 short circuit and integration test | PASS in this branch | None |
| BL083 thread surface | 24 real-process matrix legs, four directed boundary refusals, plus real summary commit | Executable | Run result is recorded in the command output; the unsigned legacy vault row remains a separate phase-5 blocker on this baseline |
| BL083 consolidation | No approved callable tool/schema exists in the baseline; no name is guessed | NOT_RUN | BL070/BL071/BL072 must publish the Phase 6 contract and implementation |
| BL083 vault erasure | Thread erase and Phase 6 vault erase are separate surfaces | NOT_RUN | BL073/BL074 and the Phase 6 erasure suite |
| BL084 | Gate A re-baseline | NOT_RUN | Requires complete BL083, including Phase 6 rows |
| BL085 | Client package/version/env allowlist review | NOT_RUN | Requires BL083 and the Phase 5/6 environment contract; Phase 5 owns `MSP_GLOBAL_PRIVATE_GRANT_REQUIRED` |
| BL086 | README/architecture/NOTES closure | NOT_RUN | Requires the complete acceptance result |
| BL087 | Existing decision confirmation record | DONE upstream | No Phase 7 code change is needed here |
| BL088 | Release review and tag | NOT_RUN | Requires BL083–087; this harness never tags or publishes |

The consolidation row stays `NOT_RUN` until the Phase 6 agent provides the
approved tool name, request/response schema, provenance fields, and failure
cases. The vault-erasure row stays separate because a green thread-erasure call
cannot prove entity/history/embedding/FTS/vault-row disposition. This table is
the handoff to Phase 6 and does not close BL083–088.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-09-17 | beta | Added deterministic summary timing and directed cross-tenant, cross-principal, cross-agent, and cross-workspace denial cases; the Phase 6 dependency rows remain NOT_RUN until their approved contract exists. | working-tree | LUNA |
| 0.1.0b | 2026-09-17 | beta | Added the real-process Phase 7 acceptance harness, explicit 24-leg matrix, latest phase-5 unsigned legacy vault proof, and dependency evidence table that keeps Phase 6 consolidation/vault-erasure cases as NOT_RUN until their approved contract exists. | working-tree | LUNA |

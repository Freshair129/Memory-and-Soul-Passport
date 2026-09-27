---
version: "0.3.0b"
created_at: "2026-09-17T00:00:00+07:00,LUNA"
last_update: "2026-09-25T21:43:44+07:00,RWANG"
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
| BL083 thread surface | 24 real-process matrix legs, four directed boundary refusals, plus eight real summary commits | PASS locally | Combined runtime run: 33 PASS, 0 FAIL |
| BL083 consolidation | Signed source consolidation and pre-erasure digest for all 12 DIRECT tenant/principal/agent legs | PASS locally | Protected-record contract; summary-item ingestion remains outside this API |
| BL083 vault erasure | Six tenant/principal erasures; direct DB owner tuple/content/history/provenance/FTS assertions | PASS locally | Additional named security suite proves embeddings, bounds, replay and rollback |
| BL084 | Gate A re-baseline | Local document updated | Not executed by the runtime harness; see GATE-A.md |
| BL085 | Client 0.2.7 candidate, CHANGELOG and pack dry-run | PASS locally; GitHub prerelease published | Not executed by the runtime harness; npm publication remains deferred |
| BL086 | README/architecture/NOTES closure | Local documents updated | Unowned context reads fail closed while optional unscoped writes remain; summary-ingestion boundaries remain explicit |
| BL087 | Existing decision confirmation record | DONE upstream | No Phase 7 code change is needed here |
| BL088 | Release review and tag | PASS for GitHub prerelease | `v0.2.7` targets merge `6b99f402`; npm publication remains deferred |

The integrated run is recorded in `.tmp/phase6-final-phase7.log`: 33 PASS,
0 FAIL, four external NOT_RUN rows, exit 2. The runtime harness does not
execute document review, npm packaging or release actions, so its external
rows are not replaced with fabricated runtime passes. The manual document
and actual pack results above are separate evidence. BL075 merge and the GitHub
prerelease portion of BL088 are complete. The harness still reports its release
row as `NOT_RUN` by design; npm publication remains deferred. See
`../.brain/reviews/PHASE6-REVIEW.md` for full local test and independent review
evidence.

## Current checkout boundary (2026-09-25)

The approved Phase 7 closure above is recorded against PR #32 / commit
`6b99f402` and the `v0.2.7` GitHub prerelease. The local `v0.2.8` Git tag
points to `68e6169` (`chore(client): prepare 0.2.8 release`). This checkout's
`main` has since advanced to `a65914d` with the explicit GKS HTTP provider.

The local tag and current branch do not establish npm publication or remote
release status. The `33 PASS, 0 FAIL, four external NOT_RUN` acceptance result
remains evidence for the reviewed Phase 7 baseline; no `test:phase7` result for
`a65914d` is recorded here. A local HTTP canary did run on 2026-09-25 with MSP
at `a65914d` and the existing GKS checkout at `88b6894`, using Node
`v24.18.0`, synthetic credentials, and fresh temporary SQLite files. GKS
`/healthz` returned `ok`; MSP's `msp_knowledge_evidence_export` returned an
empty page (`rows: []`, `next_cursor: 0`); a bad bearer credential received
HTTP 401. The temporary files were removed and the GKS checkout was not
modified. This verifies the local HTTP provider hop and authentication against
a fresh database; it does not establish production routing, durable deployment
configuration, or production cutover. Operational prerequisites remain
governed by
[`ADR-GKS-HTTP-MSP-CONSUMER.md`](ADR-GKS-HTTP-MSP-CONSUMER.md#verification-and-rollout-gates).

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-09-25 | beta | Align the Phase 7 document-closure row with DEC-MEMOS-74's fail-closed unowned context reads and retained optional unscoped writes. | working-tree | RWANG |
| 0.2.1b | 2026-09-25 | beta | Record the local MSP-to-GKS HTTP canary evidence at current main and preserve the unverified current-head acceptance and production cutover boundaries. | working-tree | RWANG |
| 0.2.0b | 2026-09-25 | beta | Separate the approved v0.2.7 Phase 7 baseline from the local v0.2.8 tag and later current-main GKS HTTP addition; record that current-head acceptance and HTTP cutover remain unverified. | working-tree | RWANG |
| 0.1.4b | 2026-09-17 | beta | Record owner-approved Phase 7 closure: PR #32 merged, hosted CI passed, and GitHub prerelease `v0.2.7` created; retain honest harness `NOT_RUN` and npm-deferred boundaries. | 6b99f402 | RWANG |
| 0.1.3b | 2026-09-17 | beta | Record real Phase 6 matrix consolidation/erasure and separate runtime results from document/package/release gates. | working-tree | RWANG |
| 0.1.2b | 2026-09-17 | beta | Record the combined 31-pass result and preserve six Phase 6/release dependencies. | working-tree | RWANG |
| 0.1.1b | 2026-09-17 | beta | Added deterministic summary timing and directed cross-tenant, cross-principal, cross-agent, and cross-workspace denial cases; the Phase 6 dependency rows remain NOT_RUN until their approved contract exists. | working-tree | LUNA |
| 0.1.0b | 2026-09-17 | beta | Added the real-process Phase 7 acceptance harness, explicit 24-leg matrix, latest phase-5 unsigned legacy vault proof, and dependency evidence table that keeps Phase 6 consolidation/vault-erasure cases as NOT_RUN until their approved contract exists. | working-tree | LUNA |

---
version: "0.1.0b"
created_at: "2026-09-17T03:45:00+07:00,RWANG,e349b90"
last_update: "2026-09-17T03:45:00+07:00,RWANG"
status: beta
attributes:
  domain: mission-state-protocol
  scope: approved-phase6-v0.3.0b
---

# Approved Phase 6 implementation review

The owner approved contract v0.3.0b with `approve` on 2026-09-17. This review
covers its protected-record consolidation, passport promotion, digest and
vault erasure package. Complexity C-3, risk HIGH. Source-summary ingestion
mentioned in the broader BL070 backlog is outside this concrete API.

## Implemented behavior

- Three explicitly guarded tools; signature, operation, payload, expiry and
  target ownership are checked before content is read. Principal grant/nonce
  failures use the inherited indistinguishable `not_found` envelope.
- ACTIVE, CONFIRMED, subject-owned DIRECT sources; episodic reads require
  the source thread's current agent/workspace attachment. AGENT sources also
  require the matching source agent. Passport target/read remains agent-agnostic.
- Logical entity merge, immutable per-source provenance and `phase6-v1`
  policy. Confidence is producer-stored, finite [0,1], default 0; promotion
  requires >=0.90 and two distinct confirmed sessions. Duplicate records
  cannot increase the session count.
- Immediate mutation/nonce/provenance/result transactions. Fresh-nonce retries
  use canonical request hashes and operation-scoped idempotency. Replay never
  resurrects revoked, redacted or erased source authority.
- Reference-only digest, deterministic pagination, HMAC-authenticated cursor
  bound to caller scope, query and limit. GROUP/ROOM are excluded.
- Migration 0015: source confidence, provenance, immutable history redaction,
  and forgotten-entity FTS removal. Prior migrations 0001–0014 are unchanged.
- `erase_vault:true`: preflight <=200 affected rows per table; source/entity/
  history/provenance tombstones, deleted embeddings/FTS, cleared owner tuples,
  nonce, pseudonymized receipt and journal share one immediate transaction.
  Response omits raw principal/tenant fields. Legacy false-mode shape stays
  compatible; changed erase mode under an existing idempotency key conflicts.

## Review corrections and evidence

Independent Luna/max review plus executable reproductions found and closed
live-source replay, missing THREAD attachment, cursor integrity and promotion
content-before-owner ordering defects. Root also reproduced raw principal
response disclosure and unmapped SQLite lock failure; the erasure worker
corrected both and made its journal atomic. The late journal failure test
proves all ten sampled tables and the grant nonce roll back together.
See `.brain/rca/2026-09-17-phase6-live-source-review.md`.

- Vitest: 52 files, 487 PASS, 1 conditional engine-canary skip.
- Full security regression: 198/198 PASS, zero failed/skipped, 290.88 seconds.
- Four named Phase 6 real-stdio security suites: 13/13 PASS, including two
  independent server processes, writer-lock conflicts, exact refusal paths,
  threshold/session gates, tampered cursors and erasure rollback.
- Migration/erasure integration: 4/4 PASS, fresh/populated upgrade and direct
  SQL trigger checks. New machine contract: 3/3 PASS.
- Cross-repository consumer compatibility: 4/4 PASS against the same immutable
  zuri-ai extract documented in MEMOS-008-REVIEW.md; no consumer edits.
- Phase 7 runtime acceptance: 33 PASS, 0 FAIL. Covers 24 matrix legs,
  12 DIRECT consolidations, six principal erasures and eight real summary
  commits. Four external release/document/package rows remain NOT_RUN in the
  runtime harness, which deliberately exits 2 instead of claiming a release.
- Client 0.2.7 package dry-run PASS: eight files, 17.4 kB packed, 53.0 kB
  unpacked. No publication or release tag.
- Local engineering DB upgraded from schema 14 to 15: integrity ok,
  zero FK violations, zero entities; `.tmp/phase6-local-db-audit.json`.

Two independent Luna/max reviewers found no remaining P0/P1 blocker in their
bounded source review. Root retained final integration ownership. This is
source/local evidence, not an approval to merge, tag, publish or activate a
consumer. Hosted CI must be assessed against the final pushed SHA separately.

## Remaining boundaries

Unknown/unauthorized changed idempotency targets intentionally return
`not_found` before conflict, preserving the non-oracle boundary. Corrupted
source-reference JSON on an already-authorized source can still produce a
parse error; current producer writes valid JSON and the trigger pins it.
This is a low-priority historical-data diagnostic limitation, not an access
bypass. Legacy unscoped context behavior remains as documented in NOTES.
BL075 merge and BL088 release gates remain open; broader summary-item
ingestion is not silently represented as implemented.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | beta | Record approved Phase 6 implementation, independent findings, local evidence and release boundaries | working-tree | RWANG |

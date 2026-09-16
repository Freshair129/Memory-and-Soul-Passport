---
version: "0.1.0b"
created_at: "2026-09-17T02:09:12+07:00,RWANG,bfe7c9d"
last_update: "2026-09-17T02:09:12+07:00,RWANG"
status: under review
attributes:
  domain: mission-state-protocol
  doc_type: implementation-review
  scope: PH-MEMOS-5
---

# MEMOS-008 implementation review

Verdict: IN PROGRESS. No PR, release, or deployment gate is claimed passed.
Complexity C-3; risk HIGH (authorization, replay protection, schema changes).

## Authority and integration baseline

The owner's 2026-09-17 request authorizes implementation alignment with the
latest spec, testing and review before PR, and parallel Luna/max work on
Phases 6 and 7. The sole phase 5 normative source is design v0.9.9b section
5.0, read with the parent ADR and peer API contracts. Historical sections
5.1-5.6 and 12.4 are not independent implementation authority.

`codex/memos-008-alignment` starts from the retained implementation branch
`ecf94ed`, then merges `origin/main@49fe7de` and the latest specification
`0bc75c8`; the resulting integration baseline is `bfe7c9d`.
Original branches and worktrees are retained. The primary main checkout was
not edited or switched.

The additional nonce schema amendment is CANDIDATE, awaiting owner approval:
`docs/MEMOS-008-NONCE-SCHEMA-AMENDMENT.md`. No implementation or completion
claim may rely on that amendment being approved until the answer is recorded.

## Review checklist

| Normative area | Required evidence | Current state |
|---|---|---|
| 5.0.1-3 principal vaults | Random opaque IDs, idempotent active lookup, immediate race, forced collision/retry, erasure/re-provision isolation | PENDING |
| 5.0.4 mount ID | Control-character collision rejected without changing legacy stable IDs | PENDING |
| 5.0.5 grants | Shared verifier, exact operation/body/tuple binding, claim types, keyring, signed resolution; unsigned legacy compatibility | PENDING |
| 5.0.6 memory | All nine tools, private/passport ownership, exact not-found collapse, endpoint ordering, pinned decay, legacy grant ignored | PENDING |
| 5.0.7 contexts | Unsigned scoped write, signed scoped read, unknown-row equivalence before cache/injection checks, sequential diff authorization, no scoped payload | 17/17 real-stdio tests PASS; final combined re-run pending |
| 5.0.8 nonces | Shared table, bounded pruning, no read nonce, atomic write/nonce rollback, cross-surface replay protection | PENDING; global schema amendment awaits approval |
| 5.0.9-10 global private | Three surfaces, default-off flag, present mismatch refusal independent of mounts, unconfigured GKS fail-closed | PENDING |
| 5.0.11 entity IDs | Uniform category-space refusal, key spaces preserved, data audit | PENDING local audit; deployed audit not applicable per owner |
| 5.0.12 migrations | Fresh/populated graph, immutable 0001-0010, principal table constraints, contexts scope columns | PENDING |
| 5.0.13-15 contracts/deployment | Error shapes, client env propagation, trust boundary and caller compatibility stated accurately | PENDING |
| 5.0.16-17 closure | Full relevant suites, independent review, exact code revision and scoped diff | PENDING |

## Evidence recorded so far

- Node 24.19.0; dependencies installed by `npm ci --no-audit --no-fund` in
  the isolated worktree, with workspace packages resolving locally.
- Before tracked implementation edits, baseline Vitest: 40 files, 455 pass,
  1 skipped, 23.08 seconds. Baseline security execution was stopped when
  concurrent implementation edits began; it is NOT a full-suite baseline.
- New consumer regression initially failed 2/2 with
  `identity_hmac_unconfigured`, reproducing the unsigned legacy resolution
  defect against the actual zuri-ai caller.
- Dependency boundaries: 12/12 passed during implementation. Re-run required
  against the final combined diff.
- Direct context-handler probe used the real SQLite migration graph,
  `Journal`, and shared verifier: unsigned scoped write succeeds; an unsigned
  read is hidden; a correct signed read succeeds; denied cache route throws
  `context_identifier_mismatch`. This does not substitute for stdio tests.
- Context real-stdio suite subsequently passed 17/17. The client wrapper
  exposes the server's validation message rather than its typed error code;
  half-scope fixtures assert the exact missing-field message. An expired
  fixture uses a fixed past timestamp, avoiding cross-process millisecond
  boundary assumptions. A separate deterministic clock contract test passes
  expiry-1, expiry, expiry+1 and the 65-second window boundary (1/1 test).
- Cross-repository suite passed 4/4 against the immutable consumer extract:
  unsigned legacy vault reads/writes and API-011 caller compatibility.
  These results were obtained during implementation; final combined checks
  remain required.

## Findings during implementation

1. The first shared nonce helper draft introduced a second global nonce table
   and unbounded expiry deletion. Both contradict section 5.0.8 (one table,
   existing bounded prune). Corrected source now uses `grant_nonces` and
   a 200-row deletion bound; combined regression evidence remains pending.
2. A live helper-level probe signed a global `msp_vault_status` grant using
   only a synthetic tenant-A key, distinct from the synthetic default key.
   Adding `tenantId: 'tenant-A'` made the first verifier draft accept it via
   `keyFor(grant.tenantId)`. Global grants are tenantless in section 5.0.9;
   their key selection must not be redirected by an irrelevant tuple claim.
   Source now pins global verification to the default key; its regression
   test remains pending. This is a
   finding in newly edited local code, not a deployed incident.
3. Principal mutation replay must collapse to `not_found`, while the nonce
   domain helper emits `grant_replayed`. Requested transport-level collapse
   and regression coverage for all four mutation paths.
4. Global nonce partition selection must derive from the stored vault type,
   not an ignored tenant claim on the grant. Requested correction and test.
5. Category validation must inspect the raw input for literal spaces before
   trimming, so leading/trailing spaces cannot evade the uniform rule.

## Cross-repository provenance

The consumer source is a read-only extract of local zuri-ai `origin/main`
commit `c07cfaba8eedb53f677e313977a1e2344fb5c8c5`. It is not described as a
live production deployment. Extracted bytes match their original Git blobs:

- `msp-vault-resolver.js`: `2486ccca0ee8474b0b4d007a04a5fd03cc384d86`
- `msp-thread-memory-port.js`: `355c17c961dde0f40ddef851e47893b8b226fec4`

`MSP_TEST_ZURI_ROOT` points at `.tmp/zuri-authority` for cross-repo execution.
No zuri-ai source or caller configuration was changed.

## Local database scope

The owner confirmed no deployed MSP database exists and requested a local
database. Target: `C:/Users/pc/workspace/Memory-and-Soul-Passport/.local/msp.db`.
The target did not exist when inspected. Initialization and integrity/category
audit are pending the reviewed migration graph. An empty local database is
not evidence of a deployed data audit or production activation.

## Parallel phase boundaries

- Phase 6: BL076 has an existing detailed spec. BL070-075 require a concrete
  additional contract/policy proposal and owner approval before code.
- Phase 7: independent BL080-082 can proceed. Full BL083 acceptance and
  BL084-088 release closure depend on Phase 6; no tag or package publication
  is authorized by a partial local test result.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | under review | Record authority, reproducible baseline, acceptance checklist and pending gates | bfe7c9d | RWANG |

---
version: "0.2.1b"
created_at: "2026-09-17T02:09:12+07:00,RWANG,bfe7c9d"
last_update: "2026-09-17T03:49:00+07:00,RWANG"
status: under review
attributes:
  domain: mission-state-protocol
  doc_type: implementation-review
  scope: PH-MEMOS-5
---

# MEMOS-008 implementation review

Verdict: approved-scope implementation reviewed; final local suites PASS.
The later approved Phase 6 implementation is reviewed in PHASE6-REVIEW.md.
Release remains OPEN. No production deployment is claimed.
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

The owner approved nonce amendment v0.1.1b on 2026-09-17 with "ลุย".
Migration 0013 and the consistent global refusal rule implement it.
The owner subsequently approved Phase 6 v0.3.0b with `approve`. Its concrete
protected-record contract is implemented and reviewed in PHASE6-REVIEW.md;
the evidence below records the preceding MEMOS-008 baseline.

## Review checklist

| Normative area | Required evidence | Current state |
|---|---|---|
| 5.0.1-3 principal vaults | Random opaque IDs, idempotent active lookup, immediate race, forced collision/retry, erasure/re-provision isolation | PASS locally; see evidence below |
| 5.0.4 mount ID | Control-character collision rejected without changing legacy stable IDs | PASS locally; see evidence below |
| 5.0.5 grants | Shared verifier, exact operation/body/tuple binding, claim types, keyring, signed resolution; unsigned legacy compatibility | PASS locally; see evidence below |
| 5.0.6 memory | All nine tools, private/passport ownership, exact not-found collapse, endpoint ordering, pinned decay, legacy grant ignored | PASS locally; see evidence below |
| 5.0.7 contexts | Unsigned scoped write, signed scoped read, unknown-row equivalence before cache/injection checks, sequential diff authorization, no scoped payload | 17/17 real-stdio tests PASS; included in combined security run |
| 5.0.8 nonces | Shared table, bounded pruning, no read nonce, atomic write/nonce rollback, cross-surface replay protection | PASS locally; see evidence below |
| 5.0.9-10 global private | Three surfaces, default-off flag, present mismatch refusal independent of mounts, unconfigured GKS fail-closed | PASS locally; see evidence below |
| 5.0.11 entity IDs | Uniform category-space refusal, key spaces preserved, data audit | PASS locally; see evidence below |
| 5.0.12 migrations | Fresh/populated graph, immutable 0001-0010, principal table constraints, contexts scope columns | PASS locally; see evidence below |
| 5.0.13-15 contracts/deployment | Error shapes, client env propagation, trust boundary and caller compatibility stated accurately | PASS locally; see evidence below |
| 5.0.16-17 closure | Full relevant suites, independent review, exact code revision and scoped diff | Local suites PASS; independent review limits stated below |

## Evidence recorded so far

- Node 24.19.0; dependencies installed by `npm ci --no-audit --no-fund` in
  the isolated worktree, with workspace packages resolving locally.
- Before tracked implementation edits, baseline Vitest: 40 files, 455 pass,
  1 skipped, 23.08 seconds. Baseline security execution was stopped when
  concurrent implementation edits began; it is NOT a full-suite baseline.
- New consumer regression initially failed 2/2 with
  `identity_hmac_unconfigured`, reproducing the unsigned legacy resolution
  defect against the actual zuri-ai caller.
- Dependency boundaries: 12/12 PASS in the final combined Vitest suite.
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
  The final combined cross-repository run also passed 4/4.

## Findings during implementation

1. The first shared nonce helper draft introduced a second global nonce table
   and unbounded expiry deletion. Both contradict section 5.0.8 (one table,
   existing bounded prune). Corrected source now uses `grant_nonces` and
   a 200-row deletion bound; the migration/pruning regression passes.
2. A live helper-level probe signed a global `msp_vault_status` grant using
   only a synthetic tenant-A key, distinct from the synthetic default key.
   Adding `tenantId: 'tenant-A'` made the first verifier draft accept it via
   `keyFor(grant.tenantId)`. Global grants are tenantless in section 5.0.9;
   their key selection must not be redirected by an irrelevant tuple claim.
   Source now pins global verification to the default key; both key-selection
   regression tests pass. This is a
   finding in newly edited local code, not a deployed incident.
3. Principal mutation replay must collapse to `not_found`, while the nonce
   domain helper emits `grant_replayed`. Transport-level collapse is implemented
   and all four mutation paths pass the replay regression.
4. Global nonce partition selection must derive from the stored vault type,
   not an ignored tenant claim on the grant. Corrected and regression-tested.
5. Category validation must inspect the raw input for literal spaces before
   trimming, so leading/trailing spaces cannot evade the uniform rule.
6. New mount/category/resolver validation inherited the legacy default error
   code `invalid_request`. Explicit `validation_failed` codes now match the
   spec; exact-code tests pass without changing legacy validation defaults.
7. The first combined security run passed 184/185: the shared-promotion
   fixture still provisioned a principal entity without a signed grant.
   Correcting only that setup preserved its no-source-read assertion. The
   complete rerun passed 185/185.

## Final combined evidence and review limits

- Baseline integration: bfe7c9d; principal/context implementation: 2ceb79f,
  bb57420 and 1c3e340; Phase 7 hardening: 0bcb15d; BL076 integration: ddfdb4a.
- Vitest: 49 files, 480 passed, 1 conditional engine-canary skip. The two
  migration-version fixture arrays include migrations 0013 and 0014.
- Security: 185/185 PASS, 0 skipped, 285.53 seconds, using the complete
  `tests/security/*.security.mjs` set with `--test-concurrency=4`. The package
  script remains serial; hosted CI is separate and has not run yet.
- Cross-repo: 4/4 PASS against the immutable consumer extract below.
- Client package dry-run PASS; no npm publication or version release.
- Phase 7 harness: 31 PASS, 0 FAIL, 6 NOT_RUN, expected exit 2. The missing
  rows cover full Phase 6 consolidation/vault erasure and dependent release
  gates. Eight of eight real thread summaries were committed in the matrix.
- Client environment probe PASS for the global flag and receipt keyring/
  version; an unrelated synthetic credential and test clock were excluded.
- New migration test proves tenant nonce preservation, NULL uniqueness,
  separate tenant/global partitions, 200-row bounded prune and rollback.
- New principal boundary test proves all nine refusal paths, all four write
  replays, unchanged entity rows after replay, and real API-011 nonce reuse
  refusal from a principal write. Entity-only denials no longer disclose the
  underlying vault ID. The link error no longer embeds either real vault ID.
- Two real child processes and connections pass private/passport races over
  three rounds each; collision and five-retry exhaustion tests pass as well.
- Migrations 0001-0010 are byte-identical to origin/main. Fresh schema 14 is
  applied locally; BL076 also has a populated raw-receipt refusal/rollback
  test, so it never silently drops existing receipt data.
- Independent Luna/max review found the cross-vault link identifier leak;
  root corrected it and added an exact non-disclosure regression. Root
  reviewed the final integrations. Two fleet workers subsequently hit the
  account usage limit; no second independent final-SHA approval is claimed.
- Global grants select a tenantless/default key. In tenant-keyring-only mode
  that selection has no configured key and fails closed; an ignored tenant
  claim cannot select a tenant key for global access. No key fallback was
  added to the shipped tenant keyring policy.

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
The target did not exist when inspected. Initialization completed at 02:52 ICT
on 2026-09-17: schema 14, integrity ok, foreign-key violations 0, entities 0,
categories containing literal spaces 0. Audit: `.tmp/local-db-audit.json`.
An empty local database is
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
| 0.2.1b | 2026-09-17 | under review | Link the subsequent approved Phase 6 implementation review while preserving MEMOS-008 baseline evidence. | working-tree | RWANG |
| 0.2.0b | 2026-09-17 | under review | Record approved nonce correction, integrated evidence, local database audit and release limits | working-tree | RWANG |
| 0.1.0b | 2026-09-17 | under review | Record authority, reproducible baseline, acceptance checklist and pending gates | bfe7c9d | RWANG |

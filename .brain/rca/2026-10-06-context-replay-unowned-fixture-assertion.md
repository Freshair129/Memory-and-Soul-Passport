# Context replay integration assertion contradicts DEC-MEMOS-74

**Status:** Resolved by a test-only correction; runtime behavior unchanged

**Risk:** LOW — one isolated integration assertion and its diagnostic check

**Complexity:** C-1 — the owner-confirmed contract already decides the result

## Symptom

`npm test` fails on both Node 22 and 24 at `tests/integration/context-replay.test.mjs:102`: the test expects `contextReproducible` to be `true`, but the runtime returns `false`. The same failure occurs on MSP `main` and on the signed API-010 Draft PR #38.

## Evidence

- Local `origin/main` (`4928e71d`) focused run before correction: 1 failed and 3 passed in `context-replay.test.mjs`, with the same assertion as hosted `main` run `36288715754` and PR #38 run `37390780832`.
- The test's `msp_context_resolve` request supplies workspace and agent identifiers but no `access_context`; the persisted row therefore has no tenant/principal owner. Re-resolving it and supplying its matching `source_hash` does not add an owner.
- Owner-confirmed DEC-MEMOS-74 in `docs/IMPLEMENTATION-PLAN-MEMORY-OS.md` and `docs/NOTES.md` says `msp_context_replay` must treat a row with no stored owner as unknown, even when a grant is supplied. It forbids inferring ownership from `actor`, workspace or agent IDs.
- `canReadContext()` returns false for an unowned row before comparing a source hash. The replay handler then returns `context_reproducible: false` and a `context_not_found` diagnostic. The peer contract and security tests already assert this denial.

## Root Cause

The integration test retained its pre-DEC-MEMOS-74 expectation that a matching hash makes an unowned context reproducible. A hash confirms content identity only after an authorized row lookup; it does not establish ownership.

## Why the issue escaped detection

The DEC-MEMOS-74 change updated the runtime guard, security tests and peer contract test, but did not update this older integration test. The contradictory assertion left MSP `main` CI red and was inherited unchanged by PR #38.

## Proposed prevention

Make the matching-hash integration case assert the approved unknown-row result and its non-disclosing `context_not_found` diagnostic. Keep scoped, signed-grant success in the existing security suite. Run the focused integration test and full MSP test gate; do not loosen the runtime guard or treat a hash as authorization.

## Resolution and verification

The test-only correction changes no production behavior. On Node 24.16.0,
`npx vitest run tests/integration/context-replay.test.mjs` passed 4/4.
`npm test` passed all 54 Vitest files (502 passed, 1 skipped) and all 203
security tests. `git diff --check` passed. Hosted CI and Node 22 remain to be
verified on the Draft PR.

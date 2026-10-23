---
version: "0.1.0"
status: "implemented-document-review-pending"
created_at: "2026-10-24T02:00:00+07:00,Codex"
attributes:
  doc_type: "implementation-plan"
  scope: "MSP consumer compatibility, production pin alignment and GenesisRAG17 acceptance"
---

# MSP / GenesisRAG17 Alignment Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute task-by-task. Checkbox completion requires recorded evidence. Independent review is required before merge; delegation follows the active repository instructions.

**Goal:** Close the observed MSP production compatibility gaps and demonstrate authenticated GenesisRAG17 operation on the current production machine.

**Architecture:** Retain four repositories and the current stdio transport. Zuri calls MSP; MSP authenticates and scopes requests before relaying to GKS or the worker. Upgrade the embedded MSP artifact to a reviewed signed-grant revision, then validate the complete release tuple in isolation before production rollout.

**Tech stack:** Node >=22, better-sqlite3 13.x, Vitest, Node test runner, Docker Compose, PostgreSQL and existing RustFS storage.

**Spec:** [API-010](API-010-Vault-Resolve-Contract.md), [API-011](API-011-THREAD-MEMORY-CONTRACT.md), [relay contract](GENESISRAG17-RELAY.md), [Tier boundary](TIER-BOUNDARY-17-STAGE.md), and Zuri's [GenesisRAG17 contract](https://github.com/Freshair129/zuri.ai/blob/64e23f31e76128bdb7a6392fda4bf51344e67b97/docs/plans/GENESISRAG17-CONTRACT.md) and [deployment design](https://github.com/Freshair129/zuri.ai/blob/64e23f31e76128bdb7a6392fda4bf51344e67b97/docs/plans/GENESISRAG17-EDGE-DEPLOYMENT.md). This plan schedules work under those contracts; it creates no new product requirements or ownership authority.

## 1. Baseline and acceptance boundary

The 2026-10-24 gap assessment observed:

| Component | Observed revision / state |
|---|---|
| Production Zuri | `bf48f2ff69dad33371ec3812ee45c29f44825ad6` |
| Production embedded MSP | `68e6169dbb371dac2f0debf0bf731b553f7dc26d` |
| MSP main | `800ee64bf28d8bbc36093ee74502f3844adac8ba` |
| MSP signed legacy-grant fix | `fd6c24b0d6d6f2e51b67cd39c775d962057eba0c`, included in MSP main |
| MSP PR #40 | Draft at `4ad49d944c30ba01d12431fae82ad29af723ff25`; cross-consumer tests and RCA |
| Zuri PR #634 merge | `ec6138d57015464cebbe60a24339ce7aa46db0f1`; signed caller |
| Production GKS / GenesisBlock | `ecf1e4de269e949406a6a5f791f9ff8fe30c9578` / `5156f412da73905a23d74775a82cc14d1f6d04d0` |
| Runtime | Web, worker and Postgres healthy; MSP child present; RustFS restarting |

The deployed MSP API-010 handler does not verify `legacy_access`; its schema requires only `access_context` and `authorization`. The deployed Zuri revision includes the newer caller. This is the highest-priority compatibility/security gap. Pipeline relay credentials already exist in the deployed MSP/GKS source; their absence is not a finding.

Prior local results: cross-Zuri 8/8 against the PR #634 merge source, focused API/relay contracts 18/18, pipeline vault security 13/13. These results used the newer local MSP branch, not the deployed MSP pin. Historical broad-suite timeouts remain separate evidence. No new runtime acceptance is claimed by this document.

## 2. Global constraints and responsibility

- The solo developer is the accountable release decision maker. Zuri remains the product integration boundary; an external service cannot approve its own product release. This plan does not appoint a named person or replace existing domain ownership.
- MSP owns authenticated Tier-2 relay and memory policy; it owns zero pipeline stages. Preserve vault isolation and fail-closed behavior.
- Keep stdio. HTTP migration and new memory features are outside this change.
- Preserve the four-repository arrangement, current GKS/worker pins unless compatibility evidence requires an explicit separately reviewed change, and Node/native-addon constraints.
- Use isolated branches/worktrees and disposable test databases. Preserve existing dirty MSP and Zuri changes. Never use dev/UAT credentials or databases for production.
- Production authority is the current machine only. Use production-specific configuration and the existing release/migration gates; never recreate production with empty volumes to obtain a green result.
- Keep secrets outside tracked files and reports. Backups remain local per the owner's decision; record the resulting single-machine recovery limitation.
- The owner approved execution on 2026-10-24. This plan records scope; each runtime change, merge and deployment still follows its evidence gates. Recheck all moving heads and production state at execution start.

## 3. Review focus

| Failure condition | Required outcome | Task |
|---|---|---|
| Missing, expired, tampered or replayed legacy grant | Typed refusal; no unauthorized vault creation; atomic nonce handling | 1 |
| Tenant/workspace/project or source/worker role mismatch | No cross-scope access or unauthorized relay | 1, 3 |
| Candidate artifact differs from tested source | Release blocked until exact pins/digests match | 2, 5 |
| RustFS restart or database restore mismatch | Diagnose and prove object/database recovery together | 4 |
| Health green but no publication or published query | Acceptance remains open | 3, 5 |

## 4. Implementation tasks

### Task 1 — Prove signed caller compatibility and finish PR #40

**Repository/files:** MSP `tests/cross/zuri-vault-resolver.test.mjs`, `tests/cross/zuri-thread-contract.test.mjs`, `tests/contract/api-010-conformance.test.mjs`, `tests/security/pipeline-vault-scoping.security.mjs`, `.brain/rca/2026-10-06-api010-cross-zuri-fixture-drift.md`. Inspect runtime `apps/msp-server/src/transport/handlers/vault-resolve-handler.mjs` and API-010 schema; do not reimplement the merged fix without a failing case.

**Interface:** `msp_vault_resolve` requires `legacy_access` for `msp_vault_resolve_legacy`; optional principal `access` remains separate. Both bind the normalized body defined by API-010. Claims must match authenticated scope.

- [x] Capture clean source revisions for MSP candidate, actual deployed Zuri and intended release Zuri. Use immutable checkouts, not the dirty primary tree.
- [x] Map existing tests to valid legacy-only and principal requests; missing/bad/expired grants; replay; payload and scope tampering. Add only missing cases, first demonstrate their failure, then implement any required fix. Assert no unauthorized vault writes and the contract's nonce/journal behavior.
- [x] Run `npm run test:cross-zuri` with `MSP_TEST_ZURI_ROOT` pointing separately at deployed Zuri `bf48f2ff...` and the intended release checkout. Record full SHAs, Node version and nonzero test counts. Keep the earlier PR #634 merge run as historical evidence.
- [x] Run `npm exec vitest run tests/contract/api-010-conformance.test.mjs tests/contract/api-011-output-schema.test.mjs tests/contract/pipeline-relay.test.mjs`, then `node --test --test-concurrency=1 tests/security/pipeline-vault-scoping.security.mjs` from MSP. Security `.security.mjs` files require the Node runner.
- [x] Run MSP `npm test` and `npm run pack:client`. Any timeout/failure remains open until explained and resolved; targeted reruns cannot relabel a failed aggregate run as passed.
- [x] Review the RCA diff, update PR #40's stale consumer-merge hold with current evidence, obtain independent patch review and required exact-head hosted checks, then merge through normal controls when authorized. Record the resulting merge SHA.

**Exit:** Reviewed MSP source supports both tested Zuri revisions with signed positive/negative cases; PR/check status and any remaining failures are explicit. Task 2 consumes this immutable MSP revision.

### Task 2 — Align the production build manifest

**Repository/files:** Zuri `apps/server/deploy/ki17/pins.json`; inspect its build-context preparation and Docker/Compose consumers before changing them. `docs/plans/GENESISRAG17-EDGE-DEPLOYMENT.md` records release rationale. Read Zuri's applicable instructions and verification policy before editing.

**Interface:** Keep manifest version/profile and repository entries compatible with existing builders. `repositories.msp.commit` becomes the reviewed full SHA from Task 1. `resolved.json` and `.ki17-pin` must attest that same SHA.

- [x] Review the entire 68e6169d-to-candidate MSP delta, including storage migrations and dependency changes. Identify backup and rollback constraints before selecting the pin.
- [x] In an isolated Zuri branch, update the MSP commit and stale explanatory manifest notes. Reconcile the recorded Zuri release revision using the existing pin tooling; do not invent the future merge SHA or hand-edit generated attestations.
- [x] Build the stdio release using existing scripts and isolated contexts. Capture host source SHAs, image digests, embedded `resolved.json` and `.ki17-pin`; reject any mismatch or dirty build input.
- [x] Run the checks selected by Zuri's verification policy for deployment/pin changes, required hosted CI, and independent review. If source docs change, run their required governance serially.

**Exit:** Immutable candidate images and a reviewed release tuple are available. A build alone does not authorize promotion or prove relay behavior.

### Task 3 — Exercise the exact tuple in an isolated canary

**Files/interfaces:** Existing MSP contract/security/cross tests; Zuri `apps/server/scripts/ki17-smoke.mjs`; existing GenesisRAG17 acceptance/runbook commands. Use the Task 2 images with a separate Compose project, database, volumes and synthetic identities.

- [x] Inspect release migrations; restore a production backup into an isolated recovery database when schema compatibility needs realistic validation. Keep restored data private and use synthetic records for acceptance.
- [x] Run the signed API-010 cases against the candidate MSP runtime from the built image, including unsigned refusal without vault creation. Record the exact image and caller revisions; local source tests alone do not satisfy this step.
- [x] Exercise all ten relay operations through existing conformance coverage: submit, claim, graph_receipt, write_receipt, gate, publication_receipt, stage_failure, evidence, query, product_query. Verify denied source/worker role swaps, scope mismatches, missing/bad relay credentials, and downstream unavailable/malformed responses.
- [x] Run the existing relay smoke in the canary web container: `node scripts/ki17-smoke.mjs`. Require both hops. Its empty-result success proves connectivity, not publication or retrieval quality.
- [x] Submit one scoped synthetic source through Zuri and verify all 17 stages, gate decision, physical receipts, publication receipt, active generation and a query retrieving that source with provenance. Check that another Business cannot retrieve it.
- [x] Restart canary web/MSP/worker and confirm persisted publication and query behavior without duplicate publication. Record stage/receipt identifiers and outcome codes without payloads or secrets.

**Exit:** Exact-image compatibility, relay isolation, persistence and ingest-to-published-query evidence pass. Failed/refused tests must match the contract, not merely return any error.

### Task 4 — Repair RustFS and prove local recovery

**Scope:** Current-machine production RustFS Compose/configuration and its existing local backup/restore scripts/runbook. Resolve actual paths from Docker Compose labels/mounts before edits; no guessed path is a deletion or recreation target. This task can be prepared alongside Tasks 1–3 but gates production promotion.

- [x] Inspect restart cause using logs, exit code, image identity, mounts, permissions, resource limits and gateway configuration. Record the cause and a minimal repair; preserve object data and existing backups.
- [ ] **Sequence exception recorded in section 6:** Apply the repair first to an isolated storage instance using equivalent configuration. Prove authenticated put/get, checksum equality and persistence after restart; redact credentials.
- [x] Execute the existing runbook recovery action on production (Vault unseal; no configuration patch was needed). Observe health and unchanged restart count for at least 10 minutes and through one controlled restart; verify the application's configured bucket/path.
- [x] Produce a fresh local backup covering production database, MSP SQLite using a SQLite-consistent method, object storage and required recovery configuration. Record file hashes and encryption/key-recovery location without key values.
- [x] Restore to separate paths/project/database with no production endpoint references. Verify database relationships, object checksums and one restored published query. State which components were recovered and measured restore time.

**Exit:** Storage is stable and an independently restored local recovery copy works. Off-machine backup remains deferred, not marked complete.

### Task 5 — Release and reconcile documentation

**Files:** MSP `docs/TIER-BOUNDARY-17-STAGE.md`, `docs/GENESISRAG17-RELAY.md`, `docs/API-010-Vault-Resolve-Contract.md`, `docs/RUNBOOK-GENESISRAG17-LOCAL.md`, `README.md`; Zuri deployment design/runbook and release record as applicable.

- [x] Correct nine-versus-ten operation wording. Update current consumer compatibility prose to cite Task 1 evidence, preserving historical limitations with dates. Replace moving integration-branch authority links with reviewed commit links; make local runbook paths explicit parameters. Preserve contract semantics and historical acceptance artifacts.
- [ ] Review the final patch and exact-head CI in each changed repository (runtime/pin PRs passed; this final documentation PR is pending). Capture Tasks 1–4 evidence, migration decision and rollback procedure before promotion. If MSP schema changes make downgrade unsafe, restore a compatible backup or roll forward; never start the old binary against an unverified newer schema.
- [x] Release candidate images on the current production machine using existing release gates, production-specific configuration and preserved volumes. Record image digests and embedded pins after start.
- [x] Run production `node scripts/ki17-smoke.mjs` in web, then one scoped synthetic ingestion/publication/query acceptance with the designated test identity. Acknowledge that smoke may append count-only journal entries. Verify unrelated production/dev/UAT/LOS health without altering those stacks.
- [x] Retain the production test record/evidence or remove it only through an authorized scoped application deletion flow. Record health after restart, storage stability and rollback readiness. A red gate stops promotion or triggers the documented compatible recovery path.

**Exit:** Deployed pins equal tested pins; signed-grant refusal and positive compatibility are proven; both relay hops and full publication/query succeed; storage/recovery pass; documents state actual evidence and remaining limitations.

## 5. Delivery order and evidence

Task 1 → Task 2 → Task 3 → Task 5. Task 4 must pass before Task 5 promotion. Documentation corrections can be drafted earlier and finalized against actual release results. Do not make an HTTP canary a stdio release prerequisite.

For each task record: repository/full SHA, image digest when applicable, command and environment, executed test count, result, evidence location, unresolved gaps and reviewer decision. Keep this plan's checkboxes pending until those records exist. Release records belong in the existing repository evidence/runbook workflow; no DDC ledger or replacement admission mechanism is introduced.

Definition of done requires every exit condition above. A healthy container, successful local suite, or successful relay response individually cannot close this plan.

## 6. Execution evidence — 2026-10-24

- Task 1 completed: MSP PR [#40](https://github.com/Freshair129/Memory-and-Soul-Passport/pull/40), reviewed head `d42d2fe54c0708c7d45bcebbb8ac5cf043b1a7b2`, merged as `d0d48c1a8e833478525d9a6ce5ee16af2c85444d` with identical tree. Node 22/24 PR CI and merge CI passed. Real Zuri signed tests: 15/15 separately with app `bf48f2ff69dad33371ec3812ee45c29f44825ad6` and `64e23f31e76128bdb7a6392fda4bf51344e67b97`; postmerge 15/15. Old MSP pin negative control ran seven refusal/replay cases: seven expected failures, eight skipped. Local baseline started on `4ad49d9` (default runtime/test inputs unchanged by follow-up cross-test/docs commits): Vitest 502 pass / 1 skip and security 208/208; focused contracts 18/18, pipeline security 13/13, client pack passed. This is composed evidence, not a newly run full suite at every commit.
- Task 2 completed: Zuri PR [#733](https://github.com/Freshair129/zuri.ai/pull/733), exact reviewed head `574338bd56145af6f31fd9d9ecf24dfeb164e95b`, merged as `7d6a80e059a3b1b5e1e8beb4675fed6814952933` with identical tree. Required PR CI passed. The MSP-only recipe retains the original app `bf48f2ff`; configuration source `5cc188cde1b939936a1c497081f1c1456a311ddf` has the same owned build inputs as the reviewed head. GKS/GenesisBlock/runtime/model remain at their existing pins. Recipe regressions 35/35, governance passed after regenerating an initially stale tracked feature view. Local image provenance is operator-attested via immutable local IDs, base rootfs prefix, clean source/context hashes and donor inventories; it is not an in-build cryptographic source proof.
- Task 3 completed: actual composed acceptance image `sha256:6a21147e2adbdd596924918fd7223b817ce95cf61878ac7f7104f5abe7624a39`: real stdio signed caller 7/7 and native G3 42/42 passed. Isolated restored canary with the selected web/worker pair published run `bce9ecbb-b263-43b4-8cef-a2cb0ab2e3aa`: 17 distinct stages succeeded, zero errors/quarantine, one publication receipt. Query/citation, anonymous and foreign-Business denial passed before and after recreating web/worker. No duplicate admission was submitted during persistence verification.
- Task 4 recovery exit condition met; one original sequencing step was not performed as written (left unchecked): production Vault was sealed, causing RustFS AppRole login HTTP 503. Existing Vault was unsealed using the existing recovery helper; no data/config reinitialization occurred. Repair was an operational unseal, not a new configuration patch. Equivalent isolated restore subsequently passed. Production storage remained stable over 27 minutes before a controlled restart; object decryption/checksum passed before/after. Fresh encrypted snapshot `e600f6a48b4615e57b6e04a7c759313dcb617476b3d58a28b0a44e7e18f77a3c` covers stopped-writer DB, SQLite/storage volumes and recovery config; full restic read-data checked 109 packs. Restored 26 entries / 1.926 GiB in 52 seconds, then verified hashes, database parity, storage and query in a separate project. Backup is local only; losing the host and backup disk together is not covered.
- Task 5 production release completed; final document patch review/CI pending. Selected web `sha256:325eea24ca5b677c885fb0d6e27b9f2d3542d8337a9321e662e86a657dc823c0`, worker `sha256:9bee2c31dc0efee6f2564eab273f9c815961a1635c08a29805849524974163e7` retain app bf48 and configuration source 5cc188cd. Both running images, embedded full pins and shared namespace were verified. The protected production configuration changed only the two image references and their mirrored web environment values; preflight initially stopped on the mirrored values, then structural comparison proved all other fields unchanged. Fresh production run `4a69d6bf-423e-4a04-8e78-d6b7346f756d` succeeded with 17/17 stage evidence, zero errors/quarantine and one publication receipt. Both relay hops, query/citation and anonymous/foreign-Business denial passed. Recreating web/worker preserved publication and query; 23 other containers retained their IDs and states. Synthetic test records remain; no unrelated cleanup, schema migration, new memory-feature activation or off-host backup was performed. Old images, protected config backup and the verified preupgrade snapshot remain available. The old/new MSP delta adds no storage migration; rollback still follows compatible DB/image recovery, not blind downgrade assumptions.

Local evidence is retained under the operator workspace `.runtime/msp-alignment-20261024` and the isolated Zuri worktree `.local/msp-alignment`. These are private local artifacts, not links available to public readers. PR bodies and CI contain the public source/check references. Historical acceptance documents remain unchanged.

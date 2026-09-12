---
version: "0.1.6b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-12T12:00:00+07:00,Claude Opus 5"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "inventory"
  scope: "standalone-repository"
---

# MSP extraction notes

## Scope and invariants

This repository is a packaging extraction of `G:\govibe\packages\msp-runtime` and the GoVibe MSP client. It is not a runtime rewrite. The wire protocol, tool names, SQLite migrations, vault semantics, GKS provider behavior, and public client behavior remain frozen.

The source checkout `G:\govibe` is read-only during extraction. Its pre-extraction baseline passed on 2026-08-12:

- `npm test` from `G:\govibe\packages\msp-runtime`
- Vitest: 22 files, 166 tests passed
- Node security suite: 30 tests passed

No `.env` file was read. Only environment-variable names present in source code are part of this inventory.

## Source-to-package mapping

| GoVibe source | Standalone target | Notes |
|---|---|---|
| `packages/msp-runtime/src/domain/*` | `packages/msp-core/src/domain/*` | Logic copied unchanged; package import paths only. |
| `packages/msp-runtime/src/contracts/*` | `packages/msp-contracts/src/contracts/*` | Depends on `msp-core` only for the existing ID/error vocabulary. |
| `docs/api/API-009-Persistent-Memory-Contract.md` | `docs/API-009-Persistent-Memory-Contract.md` | Frozen human-readable contract copy. |
| API-009 request contracts | `packages/msp-contracts/schemas/API-009.tools.json` | Machine-readable copy; not wired into runtime dispatch, so it cannot change behavior. |
| `packages/msp-runtime/src/db/connection.mjs` | `packages/msp-storage/src/db/connection.mjs` | Owns `better-sqlite3`. |
| `packages/msp-runtime/src/db/migrate.mjs` | `packages/msp-storage/src/db/migrate.mjs` | Migration runner copied unchanged except package path use. |
| `packages/msp-runtime/src/db/migrations/*.sql` | `migrations/*.sql` | Root repository owns the ordered migration set; SQL bytes remain unchanged. |
| `packages/msp-runtime/src/retrieval/*` | `packages/msp-retrieval/src/retrieval/*` | FTS/vector/fusion behavior copied unchanged. |
| `packages/msp-runtime/src/transport/*` | `apps/msp-server/src/transport/*` | NDJSON JSON-RPC/MCP-shaped stdio boundary. |
| `packages/msp-runtime/src/providers/*` | `apps/msp-server/src/providers/*` | MSP-owned GKS bridge; absence of configuration remains fail-closed. |
| `packages/msp-runtime/src/server.mjs` | `apps/msp-server/src/server.mjs` | Composition root; only package imports and migration location change. |
| `packages/msp-runtime/bin/msp-runtime.mjs` | `apps/msp-server/bin/msp-server.mjs` | Keeps the required `MSP_DB_PATH` fail-closed startup rule. |
| `packages/msp-runtime/vitest.config.mjs` | `vitest.config.mjs` | Preserves the source package's 30-second test/hook timeouts; include paths follow the new test layout. |
| `packages/govibe-core/src/msp-stdio-transport.mjs` | `packages/msp-client-js/src/msp-stdio-transport.mjs` | External process transport; Node built-ins only. |
| `packages/govibe-core/src/msp-client.mjs` | `packages/msp-client-js/src/msp-client.mjs` | Public external client. |
| `packages/govibe-core/src/authority-enforcement.mjs` | `packages/msp-client-js/src/authority-enforcement.mjs` | Required local dependency of `msp-client.mjs`; copied to keep the published client standalone. |
| `packages/govibe-core/src/gks-client.mjs` | Not extracted | GoVibe still imports this disabled compatibility shim, but it is not an MSP client dependency and remains owned by `govibe-core`. |

## Test mapping

| Target suite | Source tests |
|---|---|
| `tests/contract/` | `contract-conformance`, `dependency-boundaries`, `temporal-engine.parity`, `transport-fixture-parity`, `transport-framing-boundary` |
| `tests/security/` | Every `*.security.mjs` test plus vault ownership/scoping coverage |
| `tests/integration/` | Database migrations, entity CRUD/history, retrieval, vector degradation, links, context/replay, decay, promotion idempotency, GKS provider bridge, and role-column coverage |

Imports in copied tests may change only to address the new workspace package boundaries. Assertions and fixtures remain unchanged unless an API-009 tool has no existing conformance coverage; any added assertion must describe the frozen behavior rather than introduce a new behavior.

## Known source facts and gaps

- API-009 version `0.1.1+draft` documents nine `msp_memory_*` tools. The runtime also exposes the pre-existing context/vault/promotion surface governed by API-006. The standalone server preserves both surfaces plus diagnostic `msp_ping`.
- API-009 retains an historical amendment describing missing vault scoping, but the current source contains migrations and tests for WP-14. The extraction gate follows current executable evidence: the baseline security suite passed 30/30.
- `msp-client.mjs` is not actually a two-file island: it imports `buildBoundedGraphQuery` from `authority-enforcement.mjs`. That file is therefore copied into `msp-client-js` and recorded here rather than inlining or rewriting it.
- The configured GKS bridge permits `msp_knowledge_promote`; without a provider it fails closed with `gks_provider_unconfigured`. Shared `msp_memory_promote` remains fail-closed. Both behaviors must be tested separately.
- `Freshair129/msp` currently resolves through GitHub CLI to `Freshair129/cognitive_system`. No remote will be attached until repository identity is resolved without overwriting or repurposing that repository.

## Bugs found during extraction

### API-009 history entry shape is incomplete in the source runtime

API-009 defines `MemoryEntityHistoryEntry` as the complete `MemoryEntity` plus `version`. The current runtime's `msp_memory_history` response deliberately omits `lifecycle_state`, `decay_score`, `access_count`, and `current_version` because the `entity_history` schema does not store per-version values for those fields. The source handler already labels this as a documented gap. The extraction preserves that response exactly rather than fabricating values or changing the schema.

### Vector retrieval has no separate enable flag

The source runtime always constructs the optional bge-m3 client. Calls degrade to FTS when Ollama is unavailable, and callers opt into vector participation through search `mode`, but there is no distinct `MSP_VECTOR_ENABLED` feature flag. Adding one during extraction would change behavior, so this remains a recorded separation gap rather than an extraction-time fix.

### GitHub repository slug redirect was resolved during publish

Before publish, `gh repo view Freshair129/msp` resolved to `Freshair129/cognitive_system`, indicating a GitHub rename redirect. The exact `Freshair129/msp` repository was then created without changing or overwriting `cognitive_system`; `main` and `agent/extract-msp-runtime` were pushed and draft PR #1 was opened for review.

## Known gaps from the 2026-08-30 QA audit (design changes required, not test-only fixes)

The 2026-08-30 QA (GHOST) audit surfaced five findings. Three were closed the same day as test-only work (commit `3767738`: the GKS-bridge unconfigured case, a real `msp_memory_forget` attack case, an `msp_memory_links_list` proof, and the `msp_memory_upsert` attacker direction). The remaining two cannot be closed by adding tests, because the behavior they describe is what the current wire contract actually specifies — closing them changes the contract. They are recorded here so they stay visible until a design decision addresses them.

### Context tools perform no caller-ownership check

`msp_context_diff`, `msp_context_audit`, and `msp_context_replay` resolve any `context_id` by primary key and answer with that context's data regardless of who asks. The `actor` string on the request is journaled, never authorized against the stored context's `workspace_id`/`agent_id`.

Evidence:

- `apps/msp-server/src/transport/handlers/context-handlers.mjs:149` (`msp_context_diff`) — resolves `base_context_id`/`target_context_id` via `selectContext.get(...)` and returns `changed_refs` for any caller; with `include_payload: true` it returns both contexts' full `refs_json` payloads.
- `apps/msp-server/src/transport/handlers/context-handlers.mjs:191` (`msp_context_audit`) — returns journal findings and the hash-validity verdict for any `context_id`.
- `apps/msp-server/src/transport/handlers/context-handlers.mjs:247` (`msp_context_replay`) — replays any stored context by id.

A caller holding (or enumerating) another workspace's `context_id` can therefore read that workspace's resolved-context refs and journal trail. Contexts are keyed by `contextRef(randomUUID())` (`context-handlers.mjs:77`), so ids are unguessable in practice — the gap is the absence of an ownership rule, not a live enumeration path. Fixing it requires deciding what ownership means for these three tools' wire shapes (they carry `actor` but API-006/API-009 define no ownership semantics for it), which is a contract change, not a test.

### Evidence refs accept arbitrary un-namespaced strings

`msp_memory_promote` requires `evidence_refs` to be a non-empty array and rejects `gks:`-prefixed entries, but accepts any other string — `"trust me"` is valid evidence on the wire. The same applies to `source_memory_ref`, and to `msp_knowledge_promote`'s `provenance_ref`.

Evidence:

- `apps/msp-server/src/transport/handlers/lifecycle-handlers.mjs:204-214` — the only validation on `evidence_refs`/`source_memory_ref` is non-emptiness plus `requireNoGksRefs` (which rejects only the `gks:` namespace; see `packages/msp-contracts/src/contracts/namespace-guard.mjs:42`). No `msp:` namespace requirement, no check that a ref resolves to any stored record.
- `apps/msp-server/src/transport/handlers/lifecycle-handlers.mjs:56` — `msp_knowledge_promote`'s `provenance_ref` gets the same gks-only screening.

Promotion receipts can therefore be minted whose evidence chain points at nothing. Requiring namespaced (`msp:`-resolvable) evidence refs would reject requests today's contract documents as valid, so this too is a design decision, recorded rather than patched.

## better-sqlite3 13 on Node 24: two failure modes, and what each one was

Recorded 2026-09-12 on Windows 11, Node v24.19.0, npm 11.17.0. Both modes were
reproduced in a sibling worktree before anything was changed.

### Mode 1 — the pinned 11.10.0 aborts the runtime (exit 134)

`better-sqlite3` 11.10.0 publishes no `node-v137` prebuild, so `npm ci` compiles
it from source against the running Node's headers. Node 24.19.0 backported the
`node::ObjectWrap` cleanup hooks into the header-only `node_object_wrap.h`
without the global hook registry that makes removal safe with no live
`Environment`, so `~ObjectWrap()` calls
`RemoveEnvironmentCleanupHook(Isolate::GetCurrent())` and aborts whenever a
wrapped object is collected with no entered context
([nodejs/node#65446](https://github.com/nodejs/node/issues/65446); the v24
backport of the registry is open in
[nodejs/node#65943](https://github.com/nodejs/node/pull/65943), and 24.20/24.21
are unchanged). Any `Statement` finalization can therefore kill the MSP process:

```
node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr
  Statement::`scalar deleting destructor'
```

Observed as `MSP process exited with code 134` — nondeterministically, in
different tests on each run. This is upstream and not fixable in MSP; it is the
same finding, and the same remedy, as
[Genesis-Knowledge-System#9](https://github.com/Freshair129/Genesis-Knowledge-System/pull/9).

### Mode 2 — 12.x/13.x raise `SQLITE_IOERR_TRUNCATE`, and why that was MSP's bug

Upgrading removed the abort and exposed a race MSP's tests had always had.
Every failure landed on the same line — `open()` in
`packages/msp-storage/src/db/connection.mjs`, from the *test* process — with
`SqliteError: disk I/O error`, extended code `SQLITE_IOERR_TRUNCATE`.

The trigger is not the journal mode, the busy timeout, or any open option. An
isolated matrix (spawn a runtime that opens the database in WAL and writes,
then try to open it from a second process) isolates it to one window:

| When the second connection opens | 11.10.0 (SQLite 3.49.2) | 12.11.1 (3.53.2) | 13.0.3 (3.53.4) |
|---|---|---|---|
| while the runtime is alive | pass | pass | pass |
| after `child.kill()`, same synchronous turn | pass | **49/60 fail** | **42/60 fail** |
| after the child's `exit` event | pass | 0/60 fail | 0/60 fail |

`child.kill()` only asks the OS to terminate the process. Until the kernel has
finished tearing it down, the dying process still has the WAL index
(`<db>-shm`) memory-mapped. A connection opened inside that window takes the
WAL dead-man-switch lock, concludes it is the first connection, and truncates
`-shm` to zero to force a WAL-index rebuild — which Windows refuses while a
user-mapped section is open. A direct `ftruncate` on the same file from Node in
that window fails the same way (`UNKNOWN`, errno `-4094`, i.e.
`ERROR_USER_MAPPED_FILE`) while `<db>-wal` truncates fine, which is how the
`-shm` was identified as the file involved. SQLite 3.53.x surfaces that refusal;
3.49.2 did not, so the suite had been resting on the older library tolerating a
race that was always present.

The same window is what the tests' `try { rmSync(...) } catch {}` blocks —
commented "best-effort cleanup (Windows file-lock race on child process exit)"
— had been swallowing, and what
`tests/contract/api-009-conformance.test.mjs`'s `setTimeout(100)` plus
`maxRetries: 5` had been sleeping through.

### What was changed, and what deliberately was not

- `createMspStdioCaller`'s `close()` now returns a promise that resolves on the
  child's real `exit`. It is backward compatible: callers that ignore the
  return value behave exactly as before.
- Every test that reads a vault database from the test process, or deletes the
  directory holding it, awaits that promise. The two hand-rolled JSON-RPC
  harnesses (`canonical-candidate-rejection`, `shared-scope-fail-closed`) and
  `transport-framing-boundary` await their own `child.kill()` the same way.
- The best-effort `rmSync` swallows and the sleep-and-retry were removed rather
  than kept. With the exit awaited, cleanup must succeed on the first try, so
  those blocks now fail loudly if this contract ever regresses — which is how
  the two hand-rolled harnesses were found.
- `tests/contract/transport-close-lifecycle.test.mjs` pins the contract:
  reopening the same WAL database immediately after an awaited `close()`, ten
  times, with no retry and no sleep. Reverting `close()` to fire-and-forget
  fails all three of its cases.
- **`packages/msp-storage/src/db/connection.mjs` is unchanged.** `journal_mode
  = WAL`, `foreign_keys = ON` and `busy_timeout = 5000` all stay as they were.
  A retry around `open()` was considered and rejected: SQLite's busy handler
  does not cover `SQLITE_IOERR`, so a retry there would have to swallow a real
  error class to hide a race that is only reachable inside one synchronous turn
  after killing the process that owns the database. A restart by a supervisor
  cannot reach it — spawning a replacement process costs many event-loop turns —
  which is why `tests/integration/gks-provider-bridge.test.mjs`'s
  close-then-restart case passed throughout.

### Result on this machine

| Suite | 11.10.0 (before) | 13.0.3, no code change | 13.0.3 + this change |
|---|---|---|---|
| `vitest` contract + integration | 7 failed / 173 passed (180), 4 files | 6 failed / 174 passed (180), 2 files | **183 passed (183), 24 files** |
| `node --test` security | 2 failed / 31 passed (33) | 13 failed / 20 passed (33) | **33 passed (33)** |

The 11.10.0 numbers vary run to run — the abort is nondeterministic; the run
recorded here is one sample. The full suite was run five consecutive times on
the final tree, green every time.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.6b | 2026-09-12 | beta | Recorded both Node 24.19 SQLite failure modes: the upstream `ObjectWrap` abort on `better-sqlite3` 11.x, and the `SQLITE_IOERR_TRUNCATE` WAL-index race that 12.x/13.x expose in tests that open a vault database while a killed runtime is still tearing down. Fixed by making `close()` await the child's real exit; storage pragmas unchanged. | working-tree | Claude Opus 5 |
| 0.1.5b | 2026-09-07 | beta | Added `msp_knowledge_evidence_export`, the relay of GKS's `gks_stage_evidence_export` for zuri-ai's evidence pull (`docs/TIER-BOUNDARY-17-STAGE.md` 0.2.0b): provider method, validated page, journal, fail-closed without a provider; reference fixture and bridge cases. The two 2026-08-30 QA design gaps above are unchanged. | working-tree | Claude Fable 5.1 |
| 0.1.4b | 2026-08-30 | beta | Recorded QA-audit known gaps (context-tool caller ownership, evidence-ref namespacing) alongside the same audit's test-only closures. | 3767738 | KIN |
| 0.1.3b | 2026-08-12 | beta | Recorded successful exact-slug repository creation and draft review publication. | 04f48f6 | ATHER |
| 0.1.2b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Added source gaps, publish identity risk, and preserved test-runner mapping. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial inventory, mapping, invariants, and baseline evidence. | 394a176 | ATHER |

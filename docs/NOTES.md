---
version: "0.1.4b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-08-30T01:58:00+07:00,KIN"
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

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.4b | 2026-08-30 | beta | Recorded QA-audit known gaps (context-tool caller ownership, evidence-ref namespacing) alongside the same audit's test-only closures. | 3767738 | KIN |
| 0.1.3b | 2026-08-12 | beta | Recorded successful exact-slug repository creation and draft review publication. | 04f48f6 | ATHER |
| 0.1.2b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Added source gaps, publish identity risk, and preserved test-runner mapping. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial inventory, mapping, invariants, and baseline evidence. | 394a176 | ATHER |

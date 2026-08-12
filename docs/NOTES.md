---
version: "0.1.1b"
created_at: "2026-08-12T08:14:50+07:00,ATHER"
last_update: "2026-08-12T08:33:00+07:00,ATHER"
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

### GitHub repository slug currently redirects

Before publish, `gh repo view Freshair129/msp` resolved to `Freshair129/cognitive_system`, indicating a GitHub rename redirect rather than a confirmed standalone MSP repository. Publishing must create or resolve the exact `Freshair129/msp` identity without overwriting `cognitive_system`.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-08-12 | beta | Added source gaps, publish identity risk, and preserved test-runner mapping. | pending | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial inventory, mapping, invariants, and baseline evidence. | pending | ATHER |

# MSP vector enable flag — RCA and change proposal

**Status:** Resolved; approved default-on flag contract implemented<br>
**Risk:** MEDIUM — changes runtime integration behavior behind a new deployment setting<br>
**Complexity:** C-2 — documentation-driven implementation with integration tests<br>
**Scope:** `MSP_VECTOR_ENABLED`, vector embeddings on write, and vector search

## Symptom

The runtime has no separate deployment switch for vector features. Search
`mode` controls whether a query uses the vector leg, but changed memory writes
still attempt to create embeddings. Deployments cannot disable the Ollama
integration for both writes and searches while keeping FTS available.

## Evidence

- `apps/msp-server/src/server.mjs` always constructs `createVectorClient()`
  without an enable setting.
- `packages/msp-retrieval/src/retrieval/vector.mjs` has no `enabled` option;
  `embed()` can send requests to `OLLAMA_BASE_URL`.
- `apps/msp-server/src/transport/handlers/memory-handlers.mjs` calls
  `vectorClient.embed()` for changed upserts, regardless of search mode.
- `packages/msp-retrieval/src/retrieval/retrieval-service.mjs` uses search
  mode only to skip the query-time vector leg for `mode: "fts"`.
- `packages/msp-client-js/src/msp-stdio-transport.mjs` explicitly allowlists
  MSP child environment variables and currently includes `OLLAMA_BASE_URL`
  but not `MSP_VECTOR_ENABLED`; the client README lists the same runtime
  settings.
- `tests/integration/retrieval-service.test.mjs` covers mode-based behavior
  and unhealthy-backend fallback, but not a deployment-level disable flag.
- `docs/NOTES.md` records this as a deferred separation gap. API-009 already
  documents FTS fallback when vector retrieval is unavailable.

## Root Cause

The extracted composition root has no vector-enable configuration. Query-time
mode selection is the only vector control and does not cover embedding-on-write.
The MSP child's explicit environment allowlist also needs an entry before a new
deployment setting can reach a spawned server.

## Why the issue escaped detection

The extraction deliberately preserved the source runtime's always-constructed
optional vector client. Existing tests validate explicit `fts` mode and
graceful degradation when Ollama is unhealthy, but not disabling the
integration through deployment configuration.

## Approved Contract and Resolution

The user approved the default-preserving contract: `MSP_VECTOR_ENABLED` accepts
`1` or `0`, defaults to `1`, and refuses any other value before opening the
database. With `0`, writes skip embedding requests and vector search returns
unavailable without making a network or database call. FTS and writes continue;
stored embeddings are retained. A non-exact hybrid/vector query falls back to
FTS and reports `vector_available: false` and `searchMode: "fts_only"`. Exact
matches keep their existing short-circuit behavior and report
`searchMode: "exact"`. The client forwards the setting through its explicit
environment allowlist. No schema migration is introduced.

## Acceptance Criteria

- Unset `MSP_VECTOR_ENABLED` preserves existing embedding and search behavior.
- With `MSP_VECTOR_ENABLED=0`, writes make no embedding call and search does
  not execute the vector leg; FTS remains available.
- Hybrid/vector fallback response fields remain truthful and match API-009.
- Client-spawned MSP processes receive the setting through the existing
  allowlist, and the client README documents it.
- Focused tests cover default compatibility, disabled writes, disabled
  searches, and environment forwarding.
- NOTES records the gap as resolved; no schema migration is introduced.

## Proposed Prevention

For deployment flags, test both the server's direct composition path and the
client's child-process environment allowlist so a documented setting cannot
silently disappear at either boundary.

## Implementation and Verification

Implemented in the MSP server composition root, retrieval vector client, and
the msp-client-js environment allowlist. API-009 v0.3.5+draft and the client
README document the setting; msp-client-js is version 0.2.9. NOTES records the
gap as resolved.

Verification completed:

- Focused Vitest run: 7 files passed, 62 tests passed, covering the enable
  setting, disabled writes/search, retrieval behavior, client forwarding, and
  API-009 conformance.
- `tests/security/memory-search-vault-scoping.security.mjs`: 5 passed, 0
  failed.
- No schema migration was added.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1 | 2026-09-27 | resolved | Implement the approved default-on vector enable flag, fail fast on invalid values, retain FTS and stored embeddings when disabled, forward the setting to client-spawned runtimes, and verify the focused integration/security coverage. | working-tree | RWANG |
| 0.1.0b | 2026-09-27 | candidate | Record the missing vector enable flag, root cause, impact, proposed default-preserving contract, and acceptance criteria. | working-tree | RWANG |

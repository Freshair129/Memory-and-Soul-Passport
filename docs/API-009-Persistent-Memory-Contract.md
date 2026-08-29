---
title: "API Contract: Persistent-Memory MSP Runtime (msp_memory_*)"
doc_id: "API-009-PERSISTENT-MEMORY-CONTRACT"
status: "draft"
version: "0.1.1+draft"
updated: "2026-08-05"
owner: "Boss (CEO)"
source_of_truth: true
prd_system: "SYSTEM-05::Agent-Team-Management-System"
related_docs:
  - "docs/adr/ADR-027-In-Repo-MSP-Runtime-Package-Boundary.md"
  - "docs/adr/ADR-026-MSP-External-Runtime-Deployment.md"
  - "docs/srs/SRS-Persistent-Memory-MSP-Runtime.md"
  - "docs/architecture/SDD-Persistent-Memory-MSP-Runtime.md"
  - "docs/api/API-006-Vault-Context-and-Replay-Contracts.md"
  - "docs/lld/LLD-GoVibe-MCP-Tools.md"
---

# API Contract: Persistent-Memory MSP Runtime (msp_memory_*)

## 1. Purpose

Define the wire contract for the new `msp_memory_*` tool family exposed by
`packages/msp-runtime` over its newline-delimited JSON-RPC 2.0 stdio
transport, and the `govibe.memory.*` MCP tools GoVibe exposes on top of them
via `scripts/mcp/memory-surface.mjs`. Callers are GoVibe's MCP server acting
as the JSON-RPC client (never a GoVibe agent connecting directly), and,
transitively, agents and Mission Control through `govibe.memory.*`. This
contract does not redefine the existing frozen `msp_*` context/vault/promotion
surface (`msp_workspace_register`, `msp_context_resolve`,
`msp_context_injection_record`, `msp_context_replay`, `msp_context_diff`,
`msp_context_audit`, `msp_vault_status`, `msp_vault_mount`,
`msp_evidence_record`, `msp_knowledge_promote`, `msp_memory_promote`), which
remains governed by `docs/api/API-006-Vault-Context-and-Replay-Contracts.md`;
it only records that this runtime is the implementation those tools now run
against, and that their behavior (including the fail-closed
`gks_provider_unconfigured` denial and the hard-coded-false replay-execution
fields) is unchanged by adding memory tools alongside them.

## 2. Endpoint / Tool / Command

```text
msp_memory_upsert(input)
msp_memory_get(input)
msp_memory_list(input)
msp_memory_history(input)
msp_memory_forget(input)
msp_memory_search(input)
msp_memory_decay_tick(input)
msp_memory_links_list(input)
msp_memory_links_create(input)

govibe.memory.search(input)   # Mission Control / agent-facing, delegates to msp_memory_search
govibe.memory.select(input)   # Mission Control-facing, records a UI selection, no MSP call
govibe.memory.forget(input)   # delegates to msp_memory_forget
govibe.memory.decay.run(input) # delegates to msp_memory_decay_tick
govibe.memory.promote(input)  # reused, not duplicated — see API-006 msp_memory_promote
```

Transport: one JSON-RPC 2.0 request object per line, newline-delimited, over
the child process's stdin/stdout, per
`docs/architecture/SDD-Persistent-Memory-MSP-Runtime.md` §2. `method` is the
tool name; `params` is the request body defined per tool below; `result` is
the response body; `error` follows JSON-RPC 2.0 error object shape with a
`data.code` field carrying the typed error code from §5.

## 3. Common Types

```ts
type VaultScope = {
  vault_id: string;
  vault_type: "shared" | "workspace_private" | "global_private";
};

type EpistemicState = "hypothesis" | "confirmed" | "contested" | "deprecated";
type LifecycleState = "active" | "decayed" | "archived" | "forgotten";

type MemoryEntity = {
  entity_id: string;          // msp:-namespaced, sha256-based, see domain/ids
  vault_id: string;
  category: string;
  key: string;
  body_json: Record<string, unknown>;
  epistemic_state: EpistemicState;
  confidence: number;         // 0.0 - 1.0
  current_version: number;
  valid_from: string;         // ISO-8601
  valid_to: string | null;    // ISO-8601 or null (open-ended)
  recorded_at: string;        // ISO-8601
  superseded_at: string | null;
  lifecycle_state: LifecycleState;
  decay_score: number;
  access_count: number;
  source_hash: string;        // sha256
};

type MemoryEntityHistoryEntry = MemoryEntity & { version: number };

type SearchHit = {
  entity: MemoryEntity;
  score: number;
  matched_by: Array<"exact" | "fts" | "vector">;
};
```

## 4. Tool Contracts

### 4.1 `msp_memory_upsert`

Request:

```json
{
  "vault": { "vault_id": "string", "vault_type": "workspace_private" },
  "category": "string",
  "key": "string",
  "body_json": {},
  "epistemic_state": "hypothesis",
  "confidence": 0.6,
  "valid_from": "2026-08-04T00:00:00Z",
  "valid_to": null
}
```

Response:

```json
{ "entity": { "...": "MemoryEntity" }, "created": true, "changed": true }
```

`created` is `true` on first insert for the `(vault_id, category, key)` key,
`false` on every subsequent call. `changed` is a separate field: on a
subsequent call, if `source_hash` (derived from `body_json`,
`epistemic_state`, and `confidence`) is unchanged and the entity is not
`forgotten`, the call is a deliberate no-op — no `entity_history` row is
written and `current_version` does not increment — and the response is
`created: false, changed: false`, returning the existing entity unchanged.
This is an idempotent-retry safety property, not an oversight: it prevents
unbounded `entity_history` growth from repeated no-op calls. Only an actual
content change (a different `source_hash`), or reviving a `forgotten` entity,
writes a new `entity_history` row and increments `current_version` — in that
case the response is `created: false, changed: true` (or `created: true,
changed: true` on the very first insert, where a history row is always
written). Callers that need to know "did this call write history" must read
`changed`, not `created`.

### 4.2 `msp_memory_get`

Request:

```json
{
  "vault_id": "string",
  "category": "string",
  "key": "string",
  "as_of_valid_at": null,
  "as_of_recorded_at": null
}
```

`as_of_valid_at` and `as_of_recorded_at` are optional ISO-8601 timestamps for
a bi-temporal point read. Omitting both returns the current state.

Response:

```json
{ "entity": { "...": "MemoryEntity" }, "point_in_time": false }
```

`entity` is `null` and the tool returns a `not_found` error (§5) if no entity
matches, or if a point-in-time read finds no version valid at the requested
timestamp.

### 4.3 `msp_memory_list`

Request:

```json
{
  "vault_id": "string",
  "category": null,
  "lifecycle_state": "active",
  "page_size": 50,
  "page_token": null
}
```

`page_size` is bounded server-side (default and maximum defined by the
runtime; a request above the maximum is clamped, not rejected). Response:

```json
{ "entities": [ "MemoryEntity" ], "next_page_token": "string|null" }
```

### 4.4 `msp_memory_history`

Request:

```json
{ "entity_id": "string" }
```

Response:

```json
{ "history": [ "MemoryEntityHistoryEntry" ] }
```

`history` is returned in ascending `version` order and includes every
recorded version, including superseded and forgotten states; it is never
filtered or truncated.

### 4.5 `msp_memory_forget`

Request:

```json
{ "entity_id": "string", "reason": "string" }
```

Response:

```json
{ "entity": { "...": "MemoryEntity", "lifecycle_state": "forgotten" } }
```

This is a soft delete only: `lifecycle_state` transitions to `forgotten` and
a corresponding `entity_history` row is written. No `DELETE` statement is
ever issued against `entities` or `entity_history` by this tool.

### 4.6 `msp_memory_search`

Request:

```json
{
  "vault_id": "string",
  "query": "string",
  "mode": "hybrid",
  "limit": 20
}
```

`mode` is one of `hybrid` (default), `fts`, or `vector`. `fts` is the
explicit fallback mode referenced by
`docs/srs/SRS-Persistent-Memory-MSP-Runtime.md` FR-010/FR-011.

Response:

```json
{
  "hits": [ "SearchHit" ],
  "layers_used": ["exact", "fts"],
  "vector_available": false,
  "searchMode": "fts_only"
}
```

`searchMode` reports the mode the runtime actually used, which may differ
from the requested `mode` when `vector` or `hybrid` was requested but the
embedding backend was unhealthy — in that case `searchMode` is `fts_only` and
`vector_available` is `false`. This substitution is always reported in the
response body; it is never silent.

### 4.7 `msp_memory_decay_tick`

Request:

```json
{ "vault_id": "string", "dry_run": false }
```

Response:

```json
{
  "evaluated": 120,
  "transitioned": [
    { "entity_id": "string", "from": "active", "to": "decayed" }
  ],
  "dry_run": false
}
```

This tool is caller/cron-triggered only; the runtime has no internal
scheduler. `dry_run: true` computes and returns the transitions that would
occur without persisting them.

### 4.8 `msp_memory_links_list`

Request:

```json
{ "entity_id": "string", "direction": "both" }
```

`direction` is one of `outgoing`, `incoming`, or `both`. Response:

```json
{
  "links": [
    { "from_entity_id": "string", "to_entity_id": "string", "link_type": "string" }
  ]
}
```

No traversal, depth, or path parameter exists on this tool; v1 is a flat,
single-hop listing only.

### 4.9 `msp_memory_links_create`

Request:

```json
{ "from_entity_id": "string", "to_entity_id": "string", "link_type": "string" }
```

Response:

```json
{ "link": { "from_entity_id": "string", "to_entity_id": "string", "link_type": "string" } }
```

## 5. Errors

| Code | Meaning | Recovery |
|---|---|---|
| `validation_failed` | Request failed `contracts/` schema or namespace validation | Fix the request shape; the runtime rejects before touching `domain/` |
| `not_found` | No entity/link matches the request | Confirm `vault_id`/`category`/`key`/`entity_id` |
| `vault_scope_denied` | Caller's mounted vault does not include the requested `vault_id` | Mount the vault via `msp_vault_mount` first, or use an authorized vault |
| `conflict` | A concurrent write raced this request under the same `(vault_id, category, key)` | Retry with the latest `current_version` |
| `gks_provider_unconfigured` | Shared-scope knowledge/memory promotion was requested | Not recoverable in v1; shared promotion is an explicit, documented exclusion until a GKS provider exists |
| `db_unavailable` | SQLite connection or migration state is invalid | Operator action required; see `docs/operations/runbooks/RUNBOOK-Persistent-Memory-Runtime.md` |

## 6. Security

- RBAC: not introduced beyond the fixed allow/deny/shadow policy function
  documented in `docs/architecture/SDD-Persistent-Memory-MSP-Runtime.md` §7.
- ABAC: every request is vault-scoped; `contracts/` rejects a request whose
  `vault_id` is not mounted for the caller before it reaches `domain/`.
- Audit: every mutating call (`upsert`, `forget`, `decay_tick` with
  `dry_run: false`, `links_create`) is recorded in the append-only `journal`
  table, retrievable through the existing `msp_context_audit` tool.
- No tool in this contract accepts a filesystem-path argument.

**Amendment (v0.1.1+draft, 2026-08-05) — vault-scope enforcement is not yet
implemented.** The requirement above is not withdrawn — it remains the
contract this API mandates — but as of `packages/msp-runtime`'s current
implementation (through WP-13), it is not met: the `entities` schema has no
`vault_id` column (`entity_id` is derived from `category`/`key` alone,
`UNIQUE(category, key)`), no code path in `contracts/` or
`transport/handlers/*.mjs` rejects an unmounted `vault_id`, and the
`vault_scope_denied` error code in §5 is not returned by anything in the
current codebase. A related gap: `promotions.idempotency_key` is currently a
globally `UNIQUE` column rather than scoped per vault/agent, so two different
agents reusing the same `idempotency_key` collide and the second receives the
first agent's `promotion_ref` — a cross-agent Global-Private disclosure.
Implementing vault-scope enforcement and `vault_scope_denied`, adding
`entities.vault_id`, and re-keying `promotions` to
`UNIQUE(vault_id, idempotency_key)` are mandated by blocking work packet
`WP-14-Vault-Scoping-Msp-Runtime-Entities`, which **must land and be
independently verified before any real multi-agent use of
`msp_memory_promote`** or any other tool in this contract.

## 7. Compatibility

- Versioning: this contract is `0.1.0+draft`; breaking changes to any request
  or response shape require a version bump and a Changelog row, following
  `docs/STD-Document-Versioning-Governance.md`.
- Deprecation: none yet — this is the initial contract. When Phase 5 wires
  `scripts/mcp/runtime/memory-service.mjs`, any GoVibe-side field mapping
  differences discovered during implementation are recorded here as
  amendments, not silently absorbed.
- The existing `msp_*` surface governed by API-006 is unaffected; this
  contract only adds new tool names, it does not rename or reshape any
  existing tool.

## 8. Tests

- Phase 2 (future work packet): contract-conformance tests for the frozen
  `msp_*` surface, run against the real process.
- Phase 3 (future work packet): `msp_memory_search` tests for `hybrid`,
  `fts`, and `vector` modes, plus the graceful-degradation test asserting
  `searchMode` flips to `fts_only` when Ollama is stopped mid-test.
- Phase 4 (future work packet): `msp_memory_decay_tick` deterministic
  transition test under an injected clock, including `dry_run` non-
  persistence assertion.
- Phase 5 (future work packet): `govibe.memory.*` MCP surface tests in
  `scripts/mcp/memory-surface.mjs`'s own test file, confirming
  `govibe.memory.promote` is not a duplicate tool definition.

## Changelog

| Version | Date | Summary |
|---|---|---|
| 0.1.1+draft | 2026-08-05 | Owner-approved corrections against the actual `packages/msp-runtime` implementation. §4.1: corrected the no-op-on-unchanged-content behavior (an unchanged-`source_hash` upsert on a non-`forgotten` entity writes no `entity_history` row and does not increment `current_version`, returning `created: false, changed: false`) and documented the `changed: boolean` response field the code already returns; this was previously misdocumented as writing history and incrementing version on every call. §6: added an explicit amendment note that vault-scope enforcement and the `vault_scope_denied` error are NOT implemented in v1 (the schema lacks `entities.vault_id`, and `promotions.idempotency_key` is globally unique rather than vault-scoped, risking cross-agent Global-Private disclosure); implementation is mandated by blocking work packet WP-14 before any real multi-agent use. |
| 0.1.0+draft | 2026-08-04 | Initial wire contract for the nine new `msp_memory_*` tools and their `govibe.memory.*` GoVibe-side exposure; documented request/response shapes, the bi-temporal point-read parameters, the soft-delete-only `msp_memory_forget` contract, the hybrid search degradation-reporting contract, and the fail-closed error table. |

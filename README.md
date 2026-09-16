---
version: "0.3.1b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-17T02:54:00+07:00,RWANG"
status: "beta"
attributes:
  domain: "msp"
  doc_type: "repository-readme"
  scope: "standalone-repository"
---

# Mission State Protocol (MSP)

Standalone ESM workspace for the MSP memory/context runtime extracted from GoVibe without changing its wire protocol, storage schema, or public behavior.

## Workspace

- `apps/msp-server` — runnable NDJSON JSON-RPC stdio process and optional GKS provider bridge, including the authenticated GenesisRAG17 relay
- `packages/msp-core` — vault, entity, temporal, lineage, journal, and decay domain logic
- `packages/msp-contracts` — runtime guards, reference vocabulary, and API-009 machine contract
- `packages/msp-client-js` — publishable Node client for external consumers
- `packages/msp-retrieval` — exact/FTS/vector retrieval and fusion
- `packages/msp-storage` — SQLite connection and ordered migration runner
- `migrations` — canonical schema ownership
- `tests` — contract, security, and end-to-end integration proof

## Local verification

```powershell
npm ci
npm test
npm run pack:client
```

### Toolchain

Node `>=22` for this workspace — the floor of `better-sqlite3` 13, which runs
on N-API and ships prebuilt binaries, so nothing is rebuilt against the headers
of the running Node. `packages/msp-client-js` keeps its own `>=20` floor on
purpose: it is published standalone and has no native dependency, so raising it
would narrow the client's supported range for a reason that does not apply to
it. Do not pin `better-sqlite3` back to 11.x or 12.x:

- **11.x is a `node::ObjectWrap` addon with no Node 24 prebuild**, so it is
  compiled from source against local headers. A copy built against Node 24.19.0
  or later 24.x aborts the process with exit code 134 whenever the collector
  frees a prepared statement:
  `node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`
  ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446); the v24
  backport of the hook registry is still open in
  [nodejs/node#65943](https://github.com/nodejs/node/pull/65943)). Same root
  cause, and the same remedy, as
  [Genesis-Knowledge-System#9](https://github.com/Freshair129/Genesis-Knowledge-System/pull/9).
- **12.x is superseded**: it is the N-API rewrite that fixes the abort, but 13.x
  is the supported line and carries the same bundled SQLite.

`better-sqlite3` 12 and 13 bundle SQLite 3.53.x, which reports a WAL-index
rebuild that Windows refuses rather than tolerating it the way 3.49.2 did. Any
caller that opens an MSP database from a second process must therefore wait for
the owning runtime to actually exit first — `createMspStdioCaller`'s `close()`
returns a promise for exactly that. See
[`docs/NOTES.md`](docs/NOTES.md#better-sqlite3-13-on-node-24-two-failure-modes-and-what-each-one-was).

Booting the server requires an explicit absolute database path:

```powershell
$env:MSP_DB_PATH = (Join-Path $env:TEMP 'msp.sqlite')
npm start
```

The server uses JSON-RPC 2.0 messages separated by newlines on stdin/stdout. It implements `initialize`, `notifications/initialized`, and `tools/call`; tool discovery is intentionally static and there is no `tools/list`.

### Signed principal memory and local setup

MEMOS-008 uses signed `access: { grant, signature }` for principal vault
resolution, all nine principal memory tools, and scoped context reads.
Unsigned `msp_vault_resolve` still returns legacy vault fields, null
principal IDs, and requires neither a service nor an identity key.
Signed principal resolution needs `MSP_THREAD_SERVICE_KEY` (or its tenant
keyring) and `MSP_IDENTITY_HMAC_KEY` for the receipt actor. API-011 thread
identity paths also require the identity key. Principal vault IDs are random
UUIDs, independent of those keys and the owner tuple.

`MSP_GLOBAL_PRIVATE_GRANT_REQUIRED=1` requires a matching agent grant for
global memory and promotion. Status omits the global vault when no grant is
present. The flag defaults off; a present invalid or wrong-agent grant is
refused regardless of the flag. Mounts do not bypass that check.

Erasure receipts require `MSP_IDENTITY_HMAC_KEY_VERSION` alongside the active
identity key. Optional `MSP_IDENTITY_HMAC_KEYRING` retains older receipt keys
for matching after rotation; it does not authorize thread grants. See
[receipt evidence and rotation](docs/BL-MEMOS-076-EVIDENCE.md).

The requested local database is initialized at `.local/msp.db` with schema
14. From an integration checkout, set `MSP_DB_PATH` to its absolute path
before `npm start`. The runtime is a stdio service. No credentials or
external service activation are implied by creating the empty database.
Migration 0013 adds the global nonce partition; 0014 pseudonymizes erasure
receipts and refuses an existing non-empty raw receipt table.

Full Phase 6 consolidation/passport and Phase 7 release remain gated by
[the candidate contract](docs/PHASE6-CONSOLIDATION-PASSPORT.md) and complete
acceptance evidence. Local test passes do not close those gates.

## GenesisRAG17 relay

MSP is Tier 2 in the isolated `genesisrag17.v1` pipeline. It owns runtime
grants, exact scope and role checks, authenticated relay transport, downstream
response validation, count-only journaling, and the explicit Tier 4 query hop.
It owns no stage, source payload store, cursor, canonical decision, gate
verdict, graph/vector write, or publication pointer. Source and worker grants
are separate: source may submit/evidence/query; worker may claim, send physical
receipts, request the gate, report worker-stage failure, acknowledge downstream
publication with its receipt, and query.

Read [GENESISRAG17-RELAY](docs/GENESISRAG17-RELAY.md) for the nine operations
and exact request/response boundary, [ADR-MSP-GENESISRAG17-RELAY](docs/ADR-MSP-GENESISRAG17-RELAY.md)
for the decision record, and [the isolated local runbook](docs/RUNBOOK-GENESISRAG17-LOCAL.md)
for synthetic credentials and explicit disposable paths. The machine schema is
[`packages/msp-contracts/schemas/GENESISRAG17.tools.json`](packages/msp-contracts/schemas/GENESISRAG17.tools.json).

The cross-repository wire authority is zuri-ai's [GenesisRAG17 contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md).
The current isolated execution and publication decision is zuri-ai's [ADR-073 — GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md).
The raw-to-publication acceptance is pinned to [commit `b64b46df`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257).

## Compatibility status

See [docs/NOTES.md](docs/NOTES.md) for extraction evidence and known gaps, and [docs/MIGRATION.md](docs/MIGRATION.md) for consumer cutover. Gate A is not considered passed until the standalone server, external packaged client, all behavior/security suites, and GoVibe compatibility proof are verified. The GenesisRAG17 relay has its own contract, scope and cross-repository acceptance evidence; a successful relay response alone is not pipeline completion evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.1b | 2026-09-17 | beta | Align signed grants, unsigned legacy compatibility, global gate, receipt key versioning and local schema setup; retain Phase 6/release gates. | working-tree | RWANG |
| 0.3.0b | 2026-09-16 | beta | PH-MEMOS-5: principal vaults (`principal_private`/`principal_passport`, `migrations/0011`), API-010 `msp_vault_resolve`, the API-009 `access_context` amendment on all nine `msp_memory_*` tools, scoped `contexts` receipts (`migrations/0012`), and the multi-agent vault rules. `MSP_IDENTITY_HMAC_KEY` is now a hard deployment prerequisite for `msp_vault_resolve`. | working-tree | KIN |
| 0.2.2b | 2026-09-12 | beta | Toolchain section: Node `>=22` for `better-sqlite3` 13 (N-API), why 11.x/12.x must not return, and the second-process rule that `close()` now enforces. | working-tree | Claude Opus 5 |
| 0.2.0b | 2026-09-08 | beta | Added the authenticated GenesisRAG17 relay boundary, nine-tool ownership summary, pinned zuri-ai acceptance pointer, ADR and isolated local runbook. | working-tree | ATHER |
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial standalone workspace documentation. | 394a176 | ATHER |

## Reference version diff — 2026-09-08

"0.2.0b → 0.2.1b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.

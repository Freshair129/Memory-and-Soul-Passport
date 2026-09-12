---
version: "0.1.4b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-12T12:00:00+07:00,Claude Opus 5"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "migration-guide"
  scope: "consumer-cutover"
---

# Consumer migration guide

## Standalone server

Install workspace dependencies from the repository root, choose an absolute temporary SQLite path, and run:

```powershell
$MspRoot = (Resolve-Path '.').Path
$env:MSP_DB_PATH = (Join-Path $env:TEMP 'msp-smoke.sqlite')
if (-not [IO.Path]::IsPathRooted($env:MSP_DB_PATH)) { throw 'MSP_DB_PATH must be absolute' }
node .\apps\msp-server\bin\msp-server.mjs
```

The process communicates only through newline-delimited JSON-RPC on stdin/stdout. Absence of `MSP_DB_PATH` is a startup error.

## Package consumer

For a durable local dependency, resolve the MSP checkout explicitly and install
the client from that path:

```powershell
$MspRoot = (Resolve-Path 'C:\path\to\msp-ki17').Path
if (-not [IO.Path]::IsPathRooted($MspRoot)) { throw 'MSP checkout path must be absolute' }
npm install --save "$MspRoot\packages\msp-client-js"
```

The GoVibe MSP exports then re-export the client symbols from `@freshair129/msp-client-js`. The deprecated local `gks-client.mjs` shim remains in GoVibe because it is a separate fail-closed compatibility surface.

### `close()` now returns a promise

Shipped in `@freshair129/msp-client-js` 0.1.1.

`createMspStdioCaller(...).close()` used to return `undefined` after sending the
kill request; it now returns a promise that resolves once the runtime process
has actually exited. Existing callers need no change — ignoring the return value
behaves exactly as before.

Await it if you then touch the runtime's SQLite database, or delete the
directory holding it, from your own process. The killed runtime keeps the WAL
index (`<db>-shm`) memory-mapped until the OS finishes tearing it down, and
inside that window Windows refuses both a fresh connection (as
`SqliteError: disk I/O error`, `SQLITE_IOERR_TRUNCATE`) and the directory's
removal (`EPERM`). See
[`NOTES.md`](NOTES.md#better-sqlite3-13-on-node-24-two-failure-modes-and-what-each-one-was).

```js
await call.close();
// the database file and its -wal/-shm sidecars are free from here
```

Exact `packages/govibe-core/src/index.mjs` diff:

```diff
-export { createMspClientFromEnvironment, createUnavailableMspClient, inspectMspConfiguration, MspClient, MspConfigurationError, MspUnavailableError } from "./msp-client.mjs";
-export { createMspStdioCaller } from "./msp-stdio-transport.mjs";
+export { createMspClientFromEnvironment, createUnavailableMspClient, inspectMspConfiguration, MspClient, MspConfigurationError, MspUnavailableError } from "@freshair129/msp-client-js";
+export { createMspStdioCaller } from "@freshair129/msp-client-js";
```

## Verified compatibility proof

On 2026-08-12, the package was linked at `G:\govibe\node_modules\@freshair129\msp-client-js` using a temporary Windows junction and the exact two-line export diff above was applied. While that repoint was active, these commands passed:

```powershell
npx vitest run packages/govibe-core/src/msp-client.test.mjs packages/govibe-core/src/msp-stdio-transport.test.mjs packages/govibe-core/src/msp-evidence.test.mjs packages/govibe-core/test/msp-live-contract.test.mjs scripts/mcp/msp-memory-contracts.test.mjs scripts/mcp/runtime-core.test.mjs packages/msp-runtime/test/context-replay.test.mjs
npm test
```

Evidence summary:

- Targeted MSP/runtime consumer proof: 7 files, 32 tests passed.
- Full GoVibe Vitest: 74 files, 616 passed, 1 skipped out of 617.
- Full GoVibe security suite: 65 tests passed.

The temporary junction and export diff were removed after verification. `packages/govibe-core/src/index.mjs` was verified byte-identical to the current GoVibe HEAD, and no extraction change remains in the GoVibe worktree.

## GenesisRAG17 relay handoff

GenesisRAG17 is an additional authenticated relay surface and does not replace
the frozen `msp_memory_*` or legacy `msp_*` tools. MSP owns runtime grants,
scope/role checks, downstream response validation, count-only journaling and the
Tier 4 query hop. It owns no stage, source payload, pipeline cursor, canonical
decision, worker result, gate verdict or publication pointer.

The source role may call `msp_pipeline_submit`, `msp_pipeline_evidence` and
`msp_pipeline_query`. The worker role may call `msp_pipeline_claim`,
`msp_pipeline_graph_receipt`, `msp_pipeline_write_receipt`,
`msp_pipeline_gate`, `msp_pipeline_publication_receipt`,
`msp_pipeline_stage_failure` and `msp_pipeline_query`. Both roles are bound by
`MSP_PIPELINE_PRINCIPALS` to an exact six-field private scope. Caller `actor`
and caller-supplied credentials never select authority.

Use [GENESISRAG17-RELAY](GENESISRAG17-RELAY.md),
[ADR-MSP-GENESISRAG17-RELAY](ADR-MSP-GENESISRAG17-RELAY.md), and the
[isolated relay runbook](RUNBOOK-GENESISRAG17-LOCAL.md) for the contract,
extension rules and explicit synthetic environment. The machine schema is
[`packages/msp-contracts/schemas/GENESISRAG17.tools.json`](../packages/msp-contracts/schemas/GENESISRAG17.tools.json).
The cross-repository wire authority is the [zuri-ai contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md),
and raw-to-publication acceptance is pinned to [commit `b64b46df`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257).

There is no additional MSP pipeline migration: the relay does not persist
source, decision or worker payloads. zuri-ai owns raw/parsed/chunk lineage,
GKS owns canonical pipeline records, and GenesisBlock owns physical candidate
and publication state. A new field or operation is a coordinated contract
change across those repositories; it cannot be smuggled through the legacy
memory tools or an unvalidated caller field.

## Rollback

Revert the single dependency/re-export change and reinstall GoVibe dependencies. The original `packages/govibe-core/src/msp-client.mjs` and `msp-stdio-transport.mjs` remain available until the consumer cutover is independently accepted.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.4b | 2026-09-12 | beta | Documented `close()` returning a promise (client 0.1.1), and when a consumer must await it before touching the runtime's database file. | working-tree | Claude Opus 5 |
| 0.1.3b | 2026-09-08 | beta | Replaced the retired hard-coded local path with an explicit checkout variable and documented the GenesisRAG17 relay handoff, role split, no-migration boundary and pinned contract. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Added exact consumer diff, verified commands/results, and cleanup evidence. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial local consumer cutover and rollback procedure. | 394a176 | ATHER |

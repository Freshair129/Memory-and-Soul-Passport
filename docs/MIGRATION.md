---
version: "0.1.5b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-13T23:00:00+07:00,JANUS"
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

Shipped in `@freshair129/msp-client-js` 0.2.1 (additive on top of 0.2.0's environment allowlist).

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

## Database schema migration runner

### Foreign-keys=off mode (WP-E0)

`packages/msp-storage/src/db/migrate.mjs` applies every `migrations/NNNN_*.sql` file inside `db.transaction(() => db.exec(file.sql))`, and `connection.mjs` always opens the database with `PRAGMA foreign_keys = ON`. Under those two facts, rebuilding a table that other tables reference by foreign key -- the standard `CREATE ..._new`, `INSERT ... SELECT`, `DROP`, `RENAME` sequence, run inside that transaction -- fails the moment the database has ever held a row on either side of the relationship: `DROP TABLE` on a referenced parent performs an implicit delete of every row, which the still-enabled foreign keys refuse, and `PRAGMA foreign_keys` cannot be changed while a transaction is open.

A migration file whose **first line is exactly** `-- msp-migration: foreign-keys=off` opts into the standard SQLite 12-step procedure instead:

1. `PRAGMA foreign_keys` is read and remembered.
2. `PRAGMA foreign_keys = OFF` runs outside any transaction. SQLite ignores that pragma inside one, and better-sqlite3 does not raise an error if you try anyway, so getting the ordering right is the whole point.
3. Inside the same `db.transaction(...)` every migration already runs in: the migration's SQL executes, then `PRAGMA foreign_key_check` must return zero rows.
4. If it returns any rows, the runner throws the existing `SchemaVersionError` (`code = "db_unavailable"`; no new error code is introduced) with a message prefixed `migration_foreign_key_check_failed:` naming the migration file and the first violating table. Throwing inside the transaction rolls back the migration's SQL, so the database is left exactly as it was and the migration is never recorded in `schema_migrations`.
5. Otherwise the `schema_migrations` row is inserted and `PRAGMA user_version` is bumped -- exactly as the plain path does today -- and the transaction commits.
6. In a `finally`, `PRAGMA foreign_keys` is restored to the value read in step 1 -- in practice `ON`, since `connection.mjs` always enables it.

A migration author must use this directive on any migration that rebuilds a table other tables reference by foreign key, once the database can already hold rows on either side of that relationship that the rebuild would orphan. A plain `ALTER TABLE ... ADD COLUMN` does not need it. A migration file without the directive -- or with it anywhere but the first line -- is applied exactly as before, on the plain path; the directive is part of the migration file's own text, so the existing checksum-drift guard covers it automatically, with no special case in the guard itself.

The failure this mode can produce is a startup `SchemaVersionError` (`code = "db_unavailable"`) -- the server refuses to start rather than run against a schema it cannot prove is internally consistent -- and its message always begins `migration_foreign_key_check_failed:`, the same way the checksum-drift and downgrade guards each have their own recognizable prefix.

See `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` §12.0 for the motivating case (0008's `vaults` rebuild, not yet shipped) and [`docs/NOTES.md`](NOTES.md#known-source-facts-and-gaps) for why root migrations 0003 and 0005 did not need this mode.

## Rollback

Revert the single dependency/re-export change and reinstall GoVibe dependencies. The original `packages/govibe-core/src/msp-client.mjs` and `msp-stdio-transport.mjs` remain available until the consumer cutover is independently accepted.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.5b | 2026-09-13 | beta | Documented the migration runner's `-- msp-migration: foreign-keys=off` mode (WP-E0): the exact sequence, when a migration author must use it, and the `migration_foreign_key_check_failed:`-prefixed `SchemaVersionError` it raises on failure. | working-tree | JANUS |
| 0.1.4b | 2026-09-12 | beta | Documented `close()` returning a promise (client 0.2.1), and when a consumer must await it before touching the runtime's database file. | working-tree | Claude Opus 5 |
| 0.1.3b | 2026-09-08 | beta | Replaced the retired hard-coded local path with an explicit checkout variable and documented the GenesisRAG17 relay handoff, role split, no-migration boundary and pinned contract. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Added exact consumer diff, verified commands/results, and cleanup evidence. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial local consumer cutover and rollback procedure. | 394a176 | ATHER |

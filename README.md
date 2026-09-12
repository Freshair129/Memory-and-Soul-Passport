---
version: "0.1.2b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-12T12:00:00+07:00,Claude Opus 5"
status: "beta"
attributes:
  domain: "msp"
  doc_type: "repository-readme"
  scope: "standalone-repository"
---

# Mission State Protocol (MSP)

Standalone ESM workspace for the MSP memory/context runtime extracted from GoVibe without changing its wire protocol, storage schema, or public behavior.

## Workspace

- `apps/msp-server` — runnable NDJSON JSON-RPC stdio process and optional GKS provider bridge
- `packages/msp-core` — vault, entity, temporal, lineage, journal, and decay domain logic
- `packages/msp-contracts` — runtime guards, reference vocabulary, and API-009 machine contract
- `packages/msp-client-js` — publishable Node client for external consumers
- `packages/msp-retrieval` — exact/FTS/vector retrieval and fusion
- `packages/msp-storage` — SQLite connection and ordered migration runner
- `migrations` — canonical schema ownership
- `tests` — contract, security, and end-to-end integration proof

## Local verification

```powershell
npm install
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

## Compatibility status

See [docs/NOTES.md](docs/NOTES.md) for extraction evidence and known gaps, and [docs/MIGRATION.md](docs/MIGRATION.md) for consumer cutover. Gate A is not considered passed until the standalone server, external packaged client, all behavior/security suites, and GoVibe compatibility proof are verified.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.2b | 2026-09-12 | beta | Toolchain section: Node `>=22` for `better-sqlite3` 13 (N-API), why 11.x/12.x must not return, and the second-process rule that `close()` now enforces. | working-tree | Claude Opus 5 |
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial standalone workspace documentation. | 394a176 | ATHER |

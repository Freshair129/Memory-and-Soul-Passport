---
version: "0.1.2b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-08-12T08:37:19+07:00,ATHER"
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
$env:MSP_DB_PATH = (Join-Path $env:TEMP 'msp-smoke.sqlite')
node .\apps\msp-server\bin\msp-server.mjs
```

The process communicates only through newline-delimited JSON-RPC on stdin/stdout. Absence of `MSP_DB_PATH` is a startup error.

## Package consumer

For a durable local dependency, add:

```json
{
  "dependencies": {
    "@freshair129/msp-client-js": "file:D:/msp/packages/msp-client-js"
  }
}
```

The GoVibe MSP exports then re-export the client symbols from `@freshair129/msp-client-js`. The deprecated local `gks-client.mjs` shim remains in GoVibe because it is a separate fail-closed compatibility surface.

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

## Rollback

Revert the single dependency/re-export change and reinstall GoVibe dependencies. The original `packages/govibe-core/src/msp-client.mjs` and `msp-stdio-transport.mjs` remain available until the consumer cutover is independently accepted.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.2b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Added exact consumer diff, verified commands/results, and cleanup evidence. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial local consumer cutover and rollback procedure. | 394a176 | ATHER |

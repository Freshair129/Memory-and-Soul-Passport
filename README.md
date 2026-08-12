---
version: "0.1.1b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-08-12T08:37:19+07:00,ATHER"
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
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial standalone workspace documentation. | 394a176 | ATHER |

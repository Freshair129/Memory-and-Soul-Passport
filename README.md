---
version: "0.2.0b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-08T00:00:00+07:00,ATHER"
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

Booting the server requires an explicit absolute database path:

```powershell
$env:MSP_DB_PATH = (Join-Path $env:TEMP 'msp.sqlite')
npm start
```

The server uses JSON-RPC 2.0 messages separated by newlines on stdin/stdout. It implements `initialize`, `notifications/initialized`, and `tools/call`; tool discovery is intentionally static and there is no `tools/list`.

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
The raw-to-publication acceptance is pinned to [commit `b64b46df`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257).

## Compatibility status

See [docs/NOTES.md](docs/NOTES.md) for extraction evidence and known gaps, and [docs/MIGRATION.md](docs/MIGRATION.md) for consumer cutover. Gate A is not considered passed until the standalone server, external packaged client, all behavior/security suites, and GoVibe compatibility proof are verified. The GenesisRAG17 relay has its own contract, scope and cross-repository acceptance evidence; a successful relay response alone is not pipeline completion evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-08 | beta | Added the authenticated GenesisRAG17 relay boundary, nine-tool ownership summary, pinned zuri-ai acceptance pointer, ADR and isolated local runbook. | working-tree | ATHER |
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial standalone workspace documentation. | 394a176 | ATHER |

---
version: "0.2.0b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-08T00:00:00+07:00,ATHER"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "architecture"
  scope: "standalone-repository"
---

# Standalone MSP architecture

## Boundary

MSP is the memory and context authority between a consumer such as GoVibe and the optional GKS knowledge provider. For the isolated GenesisRAG17 pipeline it is the Tier 2 authenticated relay between Tier 1 zuri-ai, Tier 3 GKS and the Tier 4 worker. The extracted repository preserves the process boundary:

```text
consumer -> msp-client-js -> NDJSON JSON-RPC over stdio -> msp-server
                                                     -> msp-storage (SQLite)
                                                     -> optional GKS provider child process
```

Clients initialize using protocol version `2024-11-05`, send `notifications/initialized`, then call static tool contracts through `tools/call`. The server intentionally has no `tools/list` method.

## GenesisRAG17 relay composition

The nine `msp_pipeline_*` tools are registered by `apps/msp-server/src/server.mjs`.
`pipeline-handlers.mjs` authenticates the runtime grant, checks the exact
six-field private scope and nested envelopes, strips caller-selected authority,
and validates the downstream response. Eight operations use the GKS stdio
provider as `gks_pipeline_*`; `msp_pipeline_query` uses the explicit Tier 4
loopback `POST /query` and never calls GKS.

```text
zuri-ai source (source grant)
  └─ submit / evidence / query ──► MSP ──► GKS or Tier 4 query worker
GenesisBlock worker (worker grant)
  └─ claim / graph_receipt / write_receipt / gate /
     publication_receipt / stage_failure / query ──► MSP
```

MSP owns no stage, source or decision payload, cursor, worker result, gate
verdict, physical index, graph object or publication pointer. It journals only
principal identities and counts. Source and worker grants cannot be used for
each other's write paths. Runtime `actor`, caller credentials and a supplied
`authenticatedPrincipal` never become authority; `MSP_PIPELINE_PRINCIPALS`
and `MSP_GKS_PIPELINE_CREDENTIAL` are the authority inputs.

The exact contract and extension rules are in
[`GENESISRAG17-RELAY.md`](GENESISRAG17-RELAY.md) and
[`ADR-MSP-GENESISRAG17-RELAY.md`](ADR-MSP-GENESISRAG17-RELAY.md). The
machine-readable surface is
[`packages/msp-contracts/schemas/GENESISRAG17.tools.json`](../packages/msp-contracts/schemas/GENESISRAG17.tools.json).

## Package dependency direction

```text
msp-core          (domain only)
  ^
  +-- msp-contracts
  +-- msp-retrieval

msp-storage       (better-sqlite3 + migration runner)

msp-server        -> msp-core
                  -> msp-contracts
                  -> msp-retrieval
                  -> msp-storage

msp-client-js     (Node built-ins + local authority enforcement only)
```

`msp-server` is the composition root and the only package allowed to assemble all runtime layers. `msp-core`, `msp-contracts`, and `msp-retrieval` never open the database themselves. `msp-storage` owns the SQLite driver and ordered migration execution.

## Migration ownership

The repository-root `migrations/` directory is canonical. `msp-storage` owns the runner; `msp-server` resolves the canonical directory and supplies it to the runner. Tests may supply a temporary migration directory explicitly. Migration filenames, ordering, checksums, and SQL content are preserved from GoVibe.

## Security invariants

- Every entity and promotion is vault-scoped.
- Cross-vault read, mutation, link creation, decay, and promotion are denied.
- Unknown vaults remain distinguishable from inaccessible vaults.
- Candidate input cannot assign a `gks:` canonical identity.
- Missing GKS configuration never fabricates canonical success.
- The server never chooses an implicit database path.
- GenesisRAG17 requests require `schemaVersion: "genesisrag17.v1"`, exact six-field scope and an explicit source or worker runtime grant.
- MSP strips pipeline credentials before starting a GKS child process; the Tier 4 worker token is used only for the explicit loopback query.
- A malformed, foreign-scope, redirected or unconfigured pipeline hop fails closed; MSP never turns it into an empty success.

## Change risk

Risk is HIGH because code crosses package and repository boundaries and migration ownership moves. Mitigation is byte comparison for copied SQL and logic, source-baseline tests, standalone package tests, external-process proof, and a final GoVibe consumer compatibility gate.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-08 | beta | Documented the GenesisRAG17 Tier 2 relay composition, exact grant boundary, Tier 4 query route and fail-closed invariants. | working-tree | ATHER |
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial extraction architecture and dependency rules. | 394a176 | ATHER |

---
version: "0.1.0b"
created_at: "2026-08-12T08:14:50+07:00,ATHER"
last_update: "2026-08-12T08:14:50+07:00,ATHER"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "architecture"
  scope: "standalone-repository"
---

# Standalone MSP architecture

## Boundary

MSP is the memory and context authority between a consumer such as GoVibe and the optional GKS knowledge provider. The extracted repository preserves the process boundary:

```text
consumer -> msp-client-js -> NDJSON JSON-RPC over stdio -> msp-server
                                                     -> msp-storage (SQLite)
                                                     -> optional GKS provider child process
```

Clients initialize using protocol version `2024-11-05`, send `notifications/initialized`, then call static tool contracts through `tools/call`. The server intentionally has no `tools/list` method.

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

## Change risk

Risk is HIGH because code crosses package and repository boundaries and migration ownership moves. Mitigation is byte comparison for copied SQL and logic, source-baseline tests, standalone package tests, external-process proof, and a final GoVibe consumer compatibility gate.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-12 | beta | Initial extraction architecture and dependency rules. | pending | ATHER |

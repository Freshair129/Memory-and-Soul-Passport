---
version: "1.2.0b"
created_at: "2026-09-07T23:00:00+07:00,RWANG"
last_update: "2026-09-07T23:00:00+07:00,RWANG"
status: active
attributes:
  domain: mission-state-protocol
  doc_type: cross-repository-boundary
---

# GenesisRAG17 authenticated test relay

The worker-only `msp_pipeline_stage_failure` forwards exact run/decision/stage/attempt identity, six metrics, operation timestamps and a bounded error to GKS. GKS records the actual failed stage without inventing downstream successes. Transport failures remain retryable durable requests. `msp_pipeline_graph_receipt` acknowledges the native graph transaction before GKS enrichment and worker embeddings (contract 1.2.0b).

Approved by the user's 2026-09-07 implementation request. C-3 / HIGH; isolated synthetic runtimes only. Frozen cross-tier contract: zuri-ai `docs/plans/GENESISRAG17-CONTRACT.md`, genesisrag17.v1. New tools use the `msp_pipeline_` prefix with operations `submit`, `claim`, `graph_receipt`, `write_receipt`, `stage_failure`, `gate`, `publication_receipt`, `evidence`, and `query`. Existing knowledge promotion and memory APIs remain unchanged.

MSP owns no stage, payload persistence, cursor or verdict. zuri owns durable source/parsed/chunks. GKS decides canonical knowledge and the combined five-dimension quality gate. The GenesisBlock worker pulls through MSP, performs native writes, embeddings and index checks, and physically publishes only with GKS permission. Publication evidence reaches GKS before Tier1 can finish. GKS never calls outward.

Runtime `MSP_PIPELINE_PRINCIPALS` binds credentials to exact six-field scope and source/worker role. Source may submit, read evidence and query; worker may claim, send receipts, obtain the gate and query. Unknown credentials, roles, missing/extra scope fields and cross-scope nested envelopes fail before provider calls. Caller actor/relay credentials are replaced with runtime `MSP_GKS_PIPELINE_CREDENTIAL` and authenticated identity. GKS checks `GKS_PIPELINE_RELAY_CREDENTIAL`. No privileged defaults. Child GKS processes do not inherit caller credentials or worker query tokens. Journal stores only identities/counts.

Queries use POST `/query` on explicit loopback `MSP_PIPELINE_WORKER_URL`, bearer `MSP_PIPELINE_WORKER_TOKEN`. Worker checks `GENESIS_WORKER_QUERY_TOKEN`. Redirects forbidden. Worker binds one published generation per query. MSP rejects cross-scope responses. Missing config, malformed provider responses and timeouts fail closed. Retries preserve exact idempotency/attempt identities. MSP adds no migration or data store.

Tests cover every new tool across each scope field, role/credential spoofing, malformed responses and real process wiring. End-to-end acceptance starts at Tier1 raw input and requires real Tier4 embedding/native query evidence. No skip is completion evidence.

## Version diff

1.1.0b adds worker-only `msp_pipeline_graph_receipt`: actual graph-only write
acknowledgement precedes GKS enrichment and physical embedding/indexing.
MSP relays it without stage logic. The matching GKS response binds
graphReceiptHash and immutable derivedHash. Final write receipts carry those
hashes and actual operation intervals for13/15/16; Stage13 is never emitted twice.

1.0.0b introduces the authenticated genesisrag17.v1 relay, with no changes to frozen API-009 memory fields or vault behavior.

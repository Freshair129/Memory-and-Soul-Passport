---
version: "0.1.1b"
created_at: "2026-09-17T03:26:49+07:00,Freshair129,d7451b5"
last_update: "2026-09-18T00:00:00+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "line-oa-local-llm-cin"
  doc_type: "feature-contract"
  scope: "typed scoped published product query relay"
---

# Published product query relay

Owner-approved Zuri LINE-OA-LOCAL-LLM-CIN P2, 2026-09-17; C-3/HIGH.
MSP adds `msp_pipeline_product_query` for source/worker principals in their exact
six-field private scope. It routes only to the configured worker's loopback
`/products/query`, never GKS, SQL or a caller endpoint. The product wire marker
is `published-products.v1` inside the existing `genesisrag17.v1` envelope.

The Server supplies an `edge-published-corpus.v1` context containing active
catalog snapshot refs, manifest identity and an expiry <= the turn deadline.
MSP validates bounded operation/quantity/budget inputs, scope/manifest identity,
and output citations against that manifest. The worker checks publication and
native evidence. The Server rechecks live authority before disclosure.

Operations: `search` (query), `price` (exact code), `budget` (quantity and
maxPriceThb). Prices are explicit THB minor units and have snapshot provenance;
missing expiry, unit, tax and shipping remain unknown, never a live quote.
No request or response payload/credentials is written to the relay journal.
Tool errors and old-worker incompatibility are explicit failures.

The manifest is an authenticated Server-to-Edge handoff, not a signed grant at
MSP/worker. A compromised scoped source principal can still select historical
published snapshots inside that same scope. This capability does not claim to
close that pre-existing same-scope threat boundary; Server revalidation controls
normal job disclosure. Cross-scope substitution is denied before network access.

Local verification: product security tests 3/3 and relay contracts 14/14 pass.
The GenesisBlock P2 companion test starts the real MSP process against an actual
authenticated worker HTTP handler and native vector/graph database: 5/5 tests,
zero skips when P2_MSP_ROOT points here, with two synthetic source snapshots.
Current checkout evidence: this companion test is `NOT_RUN` because
`P2_MSP_ROOT` is not configured.
This is not real catalog, 17-stage publication or production LINE evidence.

The parent boundary records are [GENESISRAG17 relay](GENESISRAG17-RELAY.md),
[the MSP ADR](ADR-MSP-GENESISRAG17-RELAY.md), and [the local runbook](RUNBOOK-GENESISRAG17-LOCAL.md).

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1b | 2026-09-18 | beta | Added repository metadata, parent-boundary references and the expanded 14-case relay contract evidence. | 2696d4e | RWANG |
| 0.1.0b | 2026-09-17 | beta | Owner-approved typed scoped published product query relay contract and local acceptance boundary. | d7451b5 | Freshair129 |

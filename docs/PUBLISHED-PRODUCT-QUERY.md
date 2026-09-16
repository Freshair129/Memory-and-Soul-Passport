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

Local verification: product security tests 3/3 and relay contracts 10/10 pass.
The GenesisBlock P2 companion test starts the real MSP process against an actual
authenticated worker HTTP handler and native vector/graph database: 5/5 tests,
zero skips when P2_MSP_ROOT points here, with two synthetic source snapshots.
This is not real catalog, 17-stage publication or production LINE evidence.

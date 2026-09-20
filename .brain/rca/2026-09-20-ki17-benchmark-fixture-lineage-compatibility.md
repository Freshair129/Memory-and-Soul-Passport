# RCA — KI17 benchmark fixture compatibility regression

Date: 2026-09-20
Scope: GenesisRAG17 worker image cutover after GenesisBlock PR #178

## Symptom

The hardened `genesis-worker` image passed the Linux G-3 acceptance image, but
the local production-like Compose worker entered a restart loop and remained
unhealthy with `BENCHMARK_FIXTURE_INVALID`.

## Evidence

- The cutover image embedded GenesisBlock merge `fd4cedd66fef6c64ee535039e3d94fd810d74c19` and the exact pinned MSP/GKS contexts.
- The baked fixture `/opt/ki17/fixtures/genesisrag17-smartgift-benchmark-v1.json` has the production shape `{ fixtureVersion, benchmarks: [{ fixtureVersion, queries }] }` and no root `queries` array.
- The old healthy runtime image accepts both root `queries` and `benchmarks[].queries`, scopes benchmark rows to the candidate generation, and then computes metrics.
- The new `b0d235f` lineage accepted only a non-empty root `queries` array and iterated it directly. `cli.mjs` therefore failed before opening the worker port.
- G-3 did not expose this because its harness passes each benchmark object directly to the worker process; it does not boot the long-running CLI with the baked derived fixture from `GENESIS_WORKER_BENCHMARK_FIXTURE`.

## Root Cause

The hardening PR was based on a reachable Linux worker lineage that had lost the
benchmark fixture compatibility contract present in the previously deployed
GenesisBlock object. The zuri deployment fixture contract and the worker CLI
validator were therefore out of sync.

## Why the issue escaped detection

CI and G-3 exercised the worker's direct fixture injection path. The deployment
smoke only ran after Compose cutover, and the container startup path was not
covered by the acceptance image with the baked `benchmarks[]` fixture.

## Proposed prevention

- Restore validation and candidate-scoped flattening for `benchmarks[].queries`
  while preserving the legacy root `queries` form.
- Add a worker regression test that calls the benchmark path with the exact
  derived multi-benchmark shape.
- Add a pre-cutover container-start check with the baked
  `GENESIS_WORKER_BENCHMARK_FIXTURE`, not only direct in-process harness tests.
- Keep the exact dependency lineage and embedded pin receipt in the deployment
  evidence before changing the Compose image tags.

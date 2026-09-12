---
version: "1.0.0b"
created_at: "2026-09-08T00:00:00+07:00,ATHER,working-tree"
last_update: "2026-09-08T00:00:00+07:00,ATHER"
status: "beta"
superseded_by: null
attributes:
  domain: "mission-state-protocol"
  doc_type: "runbook"
  scope: "isolated local GenesisRAG17 MSP relay smoke"
---

# Runbook: isolated GenesisRAG17 MSP relay

This runbook starts MSP with a fresh SQLite file, a fresh GKS child-process
database, synthetic credentials and an explicit loopback query origin. It is a
relay smoke, not a production deployment and not the complete raw-to-published
acceptance. The complete acceptance begins at the zuri-ai raw entrypoint and
is pinned to [`b64b46df057d3160c659afa3c34628ee86520257`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257).

MSP has no implicit database path. Do not run this from a shell carrying a
production `DATABASE_URL`, `POSTGRES_*`, MSP database path or GKS database
path. The commands below overwrite only the current PowerShell process and
create a disposable directory under the explicitly resolved temporary root.

## Preconditions

Use the verified Node `v24.18.x` runtime at the explicit path below. The
packages advertise Node `>=20` as their compatibility minimum, but the
raw-to-publication acceptance uses this pinned runtime profile:

```powershell
$ErrorActionPreference = 'Stop'
$MspRoot = (Resolve-Path 'C:\Users\pc\workspace\msp-ki17').Path
$GksRoot = (Resolve-Path 'C:\Users\pc\workspace\gks-ki17').Path
$GksEntry = Join-Path $GksRoot 'apps/gks-server/bin/gks-server.mjs'
if (-not (Test-Path -LiteralPath $GksEntry)) { throw 'GKS entrypoint must exist at the explicit path' }
$Node = (Resolve-Path 'C:\Users\pc\workspace\ki17-runtime\node.exe').Path
if (-not [IO.Path]::IsPathRooted($Node)) { throw 'node runtime must be an absolute executable path' }
$NodeVersion = (& $Node --version)
if ($NodeVersion -notmatch '^v24\.18\.') { throw "verified Node v24.18.x required; got $NodeVersion" }

Push-Location $MspRoot
npm ci
Pop-Location
Push-Location $GksRoot
npm ci
Pop-Location

Write-Output "Node runtime: $NodeVersion"
```

The GKS checkout must be independently installed as well. Its standalone
entrypoint is `apps/gks-server/bin/gks-server.mjs`; it requires its own
absolute `GKS_DB_PATH`.

## Configure one disposable relay run

Run this in the same PowerShell session that will invoke the client. Every
credential and path is explicit. The values are synthetic and must not be
replaced with production secrets in a local smoke.

```powershell
$ErrorActionPreference = 'Stop'
$MspRoot = (Resolve-Path 'C:\Users\pc\workspace\msp-ki17').Path
$GksRoot = (Resolve-Path 'C:\Users\pc\workspace\gks-ki17').Path
$GksEntry = Join-Path $GksRoot 'apps/gks-server/bin/gks-server.mjs'
if (-not (Test-Path -LiteralPath $GksEntry)) { throw 'GKS entrypoint must exist at the explicit path' }
$Node = (Resolve-Path 'C:\Users\pc\workspace\ki17-runtime\node.exe').Path
if (-not [IO.Path]::IsPathRooted($Node)) { throw 'node runtime must be an absolute executable path' }
$NodeVersion = (& $Node --version)
if ($NodeVersion -notmatch '^v24\.18\.') { throw "verified Node v24.18.x required; got $NodeVersion" }
if ([string]::IsNullOrWhiteSpace($env:TEMP)) { throw 'TEMP must be explicitly available for the isolated run root' }

Get-ChildItem Env: | Where-Object {
  $_.Name -match '^(DATABASE_URL|DATABASE_POSTGRES_URL|POSTGRES_)'
} | ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

$RunRoot = Join-Path $env:TEMP ('msp-genesisrag17-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $RunRoot -Force | Out-Null
if (-not [IO.Path]::IsPathRooted($RunRoot)) { throw 'isolated run root must be absolute' }

$Scope = [ordered]@{
  portfolioId = 'portfolio-test'
  tenantId = 'tenant-test'
  businessId = 'business-test'
  workspaceId = 'workspace-test'
  agentId = 'agent-test'
  visibility = 'private'
}

$env:MSP_DB_PATH = Join-Path $RunRoot 'msp.sqlite'
$env:GKS_DB_PATH = Join-Path $RunRoot 'gks.sqlite'
$env:MSP_PIPELINE_PRINCIPALS = @(
  [ordered]@{ credential = 'synthetic-source-credential'; principalId = 'runbook-source'; role = 'source'; scope = $Scope }
  [ordered]@{ credential = 'synthetic-worker-credential'; principalId = 'runbook-worker'; role = 'worker'; scope = $Scope }
) | ConvertTo-Json -Compress -Depth 8
$env:MSP_GKS_PIPELINE_CREDENTIAL = 'synthetic-msp-gks-credential'
$env:GKS_PIPELINE_RELAY_CREDENTIAL = $env:MSP_GKS_PIPELINE_CREDENTIAL

$env:MSP_GKS_COMMAND = $Node
$env:MSP_GKS_ARGS = ConvertTo-Json -InputObject @($GksEntry) -Compress
$env:MSP_GKS_CWD = $GksRoot
if (@($env:MSP_GKS_ARGS | ConvertFrom-Json).Count -ne 1 -or (@($env:MSP_GKS_ARGS | ConvertFrom-Json))[0] -ne $GksEntry) { throw 'MSP_GKS_ARGS must be a one-element JSON array containing the explicit GKS entrypoint' }

# The worker query server is a separate Tier 4 process. Set its exact origin
# and token now; query calls must wait until that process is listening.
$env:MSP_PIPELINE_WORKER_URL = 'http://127.0.0.1:19417'
$env:MSP_PIPELINE_WORKER_TOKEN = 'synthetic-worker-query-token'
$env:GENESIS_WORKER_QUERY_TOKEN = $env:MSP_PIPELINE_WORKER_TOKEN

$required = @(
  'MSP_DB_PATH','GKS_DB_PATH','MSP_PIPELINE_PRINCIPALS',
  'MSP_GKS_COMMAND','MSP_GKS_ARGS','MSP_GKS_CWD',
  'MSP_GKS_PIPELINE_CREDENTIAL','GKS_PIPELINE_RELAY_CREDENTIAL',
  'MSP_PIPELINE_WORKER_URL','MSP_PIPELINE_WORKER_TOKEN',
  'GENESIS_WORKER_QUERY_TOKEN'
)
$required | ForEach-Object {
  $item = Get-Item "Env:$_" -ErrorAction Stop
  [pscustomobject]@{ Name = $item.Name; Present = -not [string]::IsNullOrEmpty($item.Value) }
} | Format-Table -AutoSize
```

Keep the displayed values in the local log only if the credentials remain
synthetic. Never copy a real credential into a report.

## Run contract and security proof

The following commands exercise the MSP contract guard and the exact-scope
security boundary without touching a production database:

```powershell
Push-Location $MspRoot
npm exec vitest run tests/contract/pipeline-relay.test.mjs
& $Node --test --test-concurrency=1 tests/security/pipeline-vault-scoping.security.mjs
Pop-Location
```

The contract suite checks caller identity replacement, fail-closed provider
configuration, six-metric evidence validation, loopback-only query routing,
redirect rejection and ambiguous-grant rejection. The security suite checks
all six scope fields, nested batch/receipt scopes and source/worker role
separation before any downstream call.

## Run the real MSP ↔ GKS stdio hop

This client starts the MSP server as a child process. MSP starts a fresh GKS
child for each GKS relay call, using the explicit GKS path and database above.
The claim is read-only and returns zero decisions on a fresh database; the
evidence request is also read-only and returns an empty page for the synthetic
run. An empty page here is a valid GKS response because the database is fresh;
an unconfigured provider must instead return an error.

```powershell
Push-Location $MspRoot
@'
import path from 'node:path'
import { createMspStdioCaller } from './packages/msp-client-js/src/msp-stdio-transport.mjs'

const scope = {
  portfolioId: 'portfolio-test',
  tenantId: 'tenant-test',
  businessId: 'business-test',
  workspaceId: 'workspace-test',
  agentId: 'agent-test',
  visibility: 'private',
}

const call = createMspStdioCaller({
  command: process.execPath,
  args: [path.resolve(process.cwd(), 'apps/msp-server/bin/msp-server.mjs')],
  cwd: process.cwd(),
  env: process.env,
})

try {
  const base = { schemaVersion: 'genesisrag17.v1', scope }
  const claim = await call('msp_pipeline_claim', {
    ...base,
    credential: 'synthetic-worker-credential',
    limit: 1,
  })
  const evidence = await call('msp_pipeline_evidence', {
    ...base,
    credential: 'synthetic-source-credential',
    runId: 'runbook-run-001',
    afterCursor: 0,
    limit: 100,
  })
  console.log(JSON.stringify({ claim, evidence }, null, 2))
} finally {
  call.close()
}
'@ | & $Node --input-type=module
Pop-Location
```

To exercise `msp_pipeline_submit`, use the exact source, chunks, mentions,
policy and materialized stage identities produced by the zuri-ai raw
entrypoint. Do not hand-build a partial batch and call a GKS response a
successful pipeline. The complete source fixture and acceptance worker are in
the pinned zuri-ai acceptance linked above.

## Tier 4 query requirement

MSP does not provide a fake query result. Start the GenesisBlock worker's
explicit loopback HTTP server at `MSP_PIPELINE_WORKER_URL` with the matching
`GENESIS_WORKER_QUERY_TOKEN` before calling `msp_pipeline_query`. The request
must contain the same six-field scope and `query`/`topK` values. MSP posts to
`/query`, rejects redirects and non-loopback origins, and validates every
result citation. If the worker is absent, the expected result is a typed
`pipeline_worker_unconfigured` or `pipeline_worker_unavailable` failure.

## Cleanup and evidence

Stop the client and all child processes before removing the isolated files:

```powershell
if (Test-Path -LiteralPath $RunRoot) {
  Remove-Item -LiteralPath $RunRoot -Recurse -Force
}
foreach ($name in @(
  'MSP_DB_PATH','GKS_DB_PATH','MSP_PIPELINE_PRINCIPALS',
  'MSP_GKS_PIPELINE_CREDENTIAL','GKS_PIPELINE_RELAY_CREDENTIAL',
  'MSP_GKS_COMMAND','MSP_GKS_ARGS','MSP_GKS_CWD',
  'MSP_PIPELINE_WORKER_URL','MSP_PIPELINE_WORKER_TOKEN',
  'GENESIS_WORKER_QUERY_TOKEN'
)) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
```

Record the MSP and GKS commit ids, Node version, explicit database paths,
contract version and command exit codes. Do not record credentials or source
payloads. The relay tests are not a substitute for the pinned zuri-ai raw
entrypoint acceptance.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.0.0b | 2026-09-08 | beta | Added an isolated, synthetic-credential MSP ↔ GKS relay smoke with explicit paths, fail-closed query guidance and cleanup. | working-tree | ATHER |

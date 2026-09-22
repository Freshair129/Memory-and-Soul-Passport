---
version: "0.1.0b"
created_at: "2026-09-23T00:00:00+07:00,RWANG,working-tree"
last_update: "2026-09-23T00:00:00+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "msp-gks-transport"
  doc_type: "architecture-decision"
  scope: "MSP-owned GKS HTTP consumer"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-09-23"
---

# ADR: MSP GKS HTTP consumer

## Context

GKS now exposes a private HTTP JSON-RPC 2.0 adapter at `POST /mcp` and a
bounded readiness endpoint at `GET /healthz`. MSP currently owns the GKS
provider boundary and uses a child-process stdio bridge. The two transports
must remain contract-compatible, and the stdio bridge must remain available
for local operation and rollback.

## Decision

1. Select the provider explicitly with `MSP_GKS_TRANSPORT`:
   `stdio` is the default and `http` opts into the network adapter. MSP never
   silently falls back between transports.
2. Configure HTTP with `MSP_GKS_HTTP_URL` as an HTTP(S) origin only. MSP
   derives `/mcp`; credentials, paths, queries and fragments in the value are
   rejected.
3. Require `GKS_MSP_AUTH_REQUIRED=1` and reuse the managed
   `GKS_MSP_RELAY_CREDENTIAL` as the HTTP Bearer credential. The provider
   sends that header only on `tools/call`, never on initialize or the
   initialized notification.
4. Preserve `gks-msp-auth/v1`, `msp-runtime`, role `msp`, and the existing
   scope digest for legacy authenticated tools. Pipeline calls keep their
   existing payload relay credential and use the HTTP Bearer only as the
   transport boundary.
5. Use the same MCP handshake as stdio: `initialize`,
   `notifications/initialized`, then one `tools/call`. Do not add a second
   REST contract, mutation retry, redirect following, or response logging.
6. Bound each HTTP request at the existing 10-second provider timeout and
   refuse responses larger than GKS's 8 MiB response limit. Malformed JSON,
   escaped object keys, non-JSON-RPC responses, non-success statuses and
   tool errors become `gks_provider_unavailable` without exposing response
   bodies or credentials.

## Configuration

| Variable | HTTP meaning |
|---|---|
| `MSP_GKS_TRANSPORT` | `http` to opt in; omitted means `stdio` |
| `MSP_GKS_HTTP_URL` | private GKS origin, for example `http://gks.internal:9010` |
| `GKS_MSP_AUTH_REQUIRED` | must be exactly `1` |
| `GKS_MSP_RELAY_CREDENTIAL` | managed Bearer credential and GKS scope-auth secret; never logged |
| `GKS_DEFAULT_PORTFOLIO_ID` | optional default used by promotion scope resolution |
| `NODE_EXTRA_CA_CERTS` | optional private-CA path already allowed by the MSP client |

`MSP_GKS_COMMAND`, `MSP_GKS_ARGS` and `MSP_GKS_CWD` remain the stdio
configuration and are not consulted by an explicit HTTP provider.

## Verification and rollout gates

- Unit/contract: handshake, headers, scope digest, pipeline metadata, URL
  validation, timeout, redirect refusal and response hardening.
- Existing MSP suites: stdio bridge, GKS child environment allowlist, client
  environment allowlist and all security suites remain green.
- Cross-repository canary: the MSP HTTP provider calls the real GKS HTTP
  server, proves health, promotion/evidence parity and protected-call denial.
- Cutover: only after a private endpoint, secret injection, durable GKS
  volume, rollback artifact and owner approval are recorded. A local canary
  is not production evidence.

## Rollback

Set `MSP_GKS_TRANSPORT=stdio`, restore the previously verified
`MSP_GKS_COMMAND`/`MSP_GKS_ARGS`/`MSP_GKS_CWD`, and leave canonical GKS data
untouched. Unsetting the provider configuration returns MSP to its existing
fail-closed `gks_provider_unconfigured` behavior.

## Out of scope

- Public GKS exposure or unauthenticated network access.
- Removing the stdio bridge.
- Zuri/GoVibe consumer cutover.
- Production deployment, DNS, secret-manager provisioning or backup/restore.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-23 | beta | Added the approved MSP HTTP consumer boundary with explicit transport selection and stdio rollback. | working-tree | RWANG |

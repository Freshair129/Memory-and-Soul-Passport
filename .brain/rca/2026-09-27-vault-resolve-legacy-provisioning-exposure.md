# API-010 legacy vault provisioning exposure — RCA candidate

**Status:** MSP-side mitigation implemented and focused verification passed; API-010 v0.3.0b deployment is blocked pending the zuri.ai caller migration
**Change risk:** HIGH — remediation changes security-sensitive authorization and caller compatibility
**Complexity:** C-3 — trusted-identity boundary and cross-repository contract work
**Scope:** Unsigned `msp_vault_resolve` provisioning of `workspace_private`, `shared`, and `global_private` vaults

## Symptom

`msp_vault_resolve` accepts a request without a signed vault grant and still
provisions legacy vault rows from caller-supplied workspace, project, and
agent identifiers. New identifiers can create additional persistent rows.

## Evidence

- `apps/msp-server/src/transport/handlers/vault-resolve-handler.mjs` requires
  `authorization.allowed === true`, but the value comes from the request. A
  grant is verified only when `access` is present.
- The handler calls `provisionWorkspacePrivateVault`, `provisionSharedVault`,
  and `provisionGlobalPrivateVault` regardless of whether a grant is present.
  The grant gates only the `principal_private` and `principal_passport` branch.
- `packages/msp-core/src/domain/vault-registry.mjs` provisions by
  `workspace_id`, `project_id`, and `agent_id`; each method inserts a row when
  the supplied key has no existing row.
- `packages/msp-contracts/schemas/API-010.tools.json` requires
  `access_context` and `authorization` but makes `access` optional.
- `tests/security/principal-vault-scoping.security.mjs` preserves the unsigned
  legacy path and verifies it does not return principal-vault fields. It does
  not test bounds on legacy row creation.
- The design's §5.3 and backlog `RSK-MEMOS-12` explicitly record this as an
  accepted legacy exposure; PH-MEMOS-8 cross-repository activation remains
  deferred.

## Root Cause

The API preserves the original unsigned legacy resolver behavior for caller
compatibility. Its legacy branch treats caller-supplied identity fields and
`authorization` flags as sufficient input and does not bind them to an
independently trusted caller identity or directory entry. The signed grant
introduced for principal vaults does not cover the legacy provisioning branch.

## Why the issue escaped detection

PH-MEMOS-5 specifically closed unsigned access to principal vaults while
preserving the shipped zuri-ai legacy request shape. Existing tests prove that
compatibility and that principal fields remain unavailable without a grant;
they do not assert a resource bound for novel legacy identifiers. The residual
behavior is acknowledged in the design and plan, rather than being an
unnoticed regression. This evidence does not establish reachability from an
untrusted remote caller; the current boundary is the process that can write
to the MSP stdio input.

## Proposed Prevention

Require a distinct signed `legacy_access` grant before any API-010 legacy
vault provisioning. The grant must use the existing tenant service keyring,
name operation `msp_vault_resolve_legacy`, bind the exact request payload,
carry matching `tenantId`, `principalId`, `agentId`, `workspaceId`, and
`projectId` claims, and include a one-use nonce consumed in the same
transaction as provisioning. Its signer must derive those claims from
authenticated server-side session state, never from tool arguments. A valid
signature attests that the trusted gateway approved that request; it does
not prove directory membership or make a compromised/misconfigured signer
safe.

Keep the existing `access` grant separate and optional for principal-vault
provisioning, so granting legacy resolution does not itself create a
principal vault. A missing `legacy_access` must fail before database writes;
the existing successful response fields remain unchanged for signed calls.
Both grant hashes must use the normalized request with top-level `access` and
`legacy_access` removed. This preserves the existing principal-grant payload
shape while letting each grant be verified independently. A missing
`legacy_access` receives a stable `grant_required` refusal; present but
invalid grants keep the existing typed grant-error behavior. The API-010
contract/schema proposal is a breaking bump from `0.2.0b` to `0.3.0b`. The
documented zuri-ai caller currently sends no grant, so its signer/request
update must be coordinated before deploying the new contract. The external
checkout was not modified, and its remote freshness is unverified.

```mermaid
sequenceDiagram
  participant G as Trusted gateway
  participant S as MSP stdio server
  participant H as API-010 handler
  participant D as Vault registry / DB
  G->>G: Derive tuple from authenticated session
  G->>S: msp_vault_resolve + signed legacy_access
  S->>H: Dispatch args only (no caller identity)
  H->>H: Verify signature, expiry, payload, tuple, nonce
  alt grant valid
    H->>D: Consume nonce and provision legacy vault set atomically
    D-->>H: Existing or newly provisioned rows
    H-->>G: Existing API-010 response shape
  else missing or invalid grant
    H-->>G: Refusal; no vault rows written
  end
```

## Implementation and Verification

- API-010 now requires `legacy_access` with operation
  `msp_vault_resolve_legacy`, a payload hash over the request with both grant
  envelopes removed, and matching tenant/principal/agent/workspace/project
  claims. Its nonce, optional principal-grant nonce, provisioning, and
  journal receipt run in one immediate transaction.
- A missing legacy grant returns `grant_required` before writes. A legacy-only
  receipt uses the constant `legacy_access_grant` actor. The existing
  principal `access` grant remains optional and separate.
- Four focused real-process security suites passed **46/46**. The API-010
  contract, Phase 6 contract, and principal-grant integration suites passed
  **6/6**. The cross-zuri resolver test passed **2/2** against the local
  checkout at HEAD `7031a4afa72706b15032141df175e82934dfb058`; that checkout
  is dirty and its remote freshness is unverified. No zuri.ai files were
  changed.
- `npm run test:phase7` exercised the signed legacy-only resolve and all 24
  matrix legs successfully (**33 PASS**). It exited nonzero because four
  later release gates are `NOT_RUN`; this is not full Phase 7/release
  acceptance. JSON schema parsing, changed-file `node --check`, and
  `git diff --check` passed.
- Deployment and risk closure still require the zuri.ai caller to derive
  claims from authenticated session state, sign `legacy_access`, and pass a
  fresh cross-repository success check. MSP cannot establish that trust from
  stdio arguments alone.

## Decision

The owner approved reopening `RSK-MEMOS-12` and the detailed contract before
implementation. The MSP-side fail-closed change is implemented. The existing
unsigned zuri.ai request is refused, so do not deploy API-010 v0.3.0b until
the external caller migration described in `BL-MEMOS-113` is complete and
verified.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-09-27 | implemented | Require the signed legacy resolver grant, consume nonces atomically with provisioning/journaling, and record focused MSP verification plus the outstanding zuri.ai deployment gate. | working-tree | RWANG |
| 0.2.0b | 2026-09-27 | proposed | Reopen RSK-MEMOS-12 and propose a signed legacy resolver grant bound to the trusted gateway's authenticated session, with an API-010 breaking version bump and coordinated caller migration. | working-tree | RWANG |

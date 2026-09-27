---
doc_id: "API-010-VAULT-RESOLVE-CONTRACT"
version: "0.3.0b"
status: "beta"
created_at: "2026-09-16T00:00:00+07:00,KIN"
last_update: "2026-09-27T00:00:00+07:00,RWANG"
---

# API-010 Vault Resolve Contract (`msp_vault_resolve`)

This is the Phase 5 implementation of `msp_vault_resolve`. The current
normative authority is `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md`
v0.12.0b §5.0; earlier §5.1 material is historical. This contract records
the signed legacy grant and the optional, separate signed principal grant.
The required `legacy_access` field is a breaking change from API-010 v0.2.0b:
the currently documented zuri.ai caller sends no grant and must be upgraded
before deploying this version. The cross-repo unsigned request now proves
refusal without vault writes; no upgraded external caller has been verified.

## 1. Purpose

`msp_vault_resolve` composes both MSP's pre-existing legacy vault surface
(`shared`/`workspace_private`/`global_private`, unchanged) and the two new
principal vault types this same phase introduces (`principal_private`, the
"episodic vault"; `principal_passport`, the "Soul Passport vault") into one
response, matching zuri-ai's shipped, already-deployed caller
(`msp-vault-resolver.js`, `origin/main@4ca28c1d`) exactly.

## 2. Endpoint / Tool

```text
msp_vault_resolve(input)
```

Transport: identical newline-delimited JSON-RPC 2.0 stdio transport every
other `msp_*` tool in this runtime already uses. `method` is
`"msp_vault_resolve"`; `params` is the request body below; `result` is the
response body; `error` follows the same JSON-RPC 2.0 error object shape
every other tool in this runtime uses, `data.code` carrying the typed error
code from §5.

Every request requires `legacy_access: { grant, signature }`. Its grant must
verify as operation `msp_vault_resolve_legacy`, bind the normalized request
body (with both `access` and `legacy_access` removed), and match the tenant,
principal, agent, workspace, and project claims to `access_context`. Its
one-use nonce is consumed atomically with all legacy provisioning and the
journal receipt. The optional top-level `access: { grant, signature }` is a
separate grant for operation `msp_vault_resolve`; it uses the same normalized
body and remains required only to resolve or provision principal vaults.

## 3. Request

Transcribed exactly from `createMspVaultResolver`'s `transport` call, not
reconstructed:

```json
{
  "actor": "zuri-agent",
  "access_context": {
    "tenant_id": "string", "business_id": "string|null", "principal_id": "string",
    "agent_id": "string", "instance_id": "string|null", "project_id": "string",
    "workspace_id": "string", "thread_id": "string|null", "session_id": "string|null",
    "policy_version": "string|null"
  },
  "authorization": {
    "membership_active": true, "allowed": true,
    "allow_global_private": false, "allow_tenant_global_private": false,
    "allow_shared": false,
    "read": true, "write_private": false, "write_shared": false,
    "allow_passport": false
  },
  "legacy_access": {
    "grant": {
      "operation": "msp_vault_resolve_legacy",
      "expiresAt": 1757836865123,
      "payloadHash": "sha256(JSON.stringify(request without access and legacy_access))",
      "tenantId": "string", "principalId": "string", "agentId": "string",
      "workspaceId": "string", "projectId": "string",
      "nonce": "128-bit-random-string"
    },
    "signature": "hex HMAC-SHA256(JSON.stringify(grant))"
  },
  "access": {
    "grant": {
      "operation": "msp_vault_resolve",
      "expiresAt": 1757836865123,
      "payloadHash": "sha256(JSON.stringify(request without access and legacy_access))",
      "tenantId": "string", "principalId": "string",
      "agentId": "string", "workspaceId": "string",
      "allowPassport": false, "nonce": "128-bit-random-string"
    },
    "signature": "hex HMAC-SHA256(JSON.stringify(grant))"
  }
}
```

`legacy_access` is required. `access` is optional and independent. A trusted
signer must derive the grant claims from authenticated server-side session
state; it must not sign caller-supplied tool arguments as proof of identity.
The signature proves only that the configured key holder signed the bound
request; MSP does not independently establish directory membership.

- **`actor`** is a plain string (client-side default `"zuri-agent"`),
  carried for audit only — it is not a vault key and not a grant field, and
  MSP does not itself read it.
- **`access_context.tenant_id`/`.principal_id`/`.agent_id`/`.workspace_id`/
  `.project_id`** are all **required non-empty strings**. `.business_id`,
  `.instance_id`, `.thread_id`, `.session_id`, `.policy_version` are
  optional/nullable, provenance only — never authorization input, never
  widening scope (`tests/security/provenance-ids-are-not-owners.security.mjs`).
- **`access_context.project_id`** is consumed by this tool's *legacy*
  vault-set resolution only (`workspacePrivateVaultId`/`sharedVaultIds`
  below) — it has no principal-vault meaning and is never stored on, or
  checked against, a `principal_private`/`principal_passport` row.
- **`authorization.allowed`** must be exactly `true`, else `vault_scope_denied`
  — MSP re-checks this server-side even though the shipped client-side
  `currentScope()` already refuses first in practice.
- **`authorization.allow_passport`** (legacy response preference): absent, or any value other than
  the literal `true`, is treated identically to `false` — no passport vault
  is provisioned, no passport-related response field is populated beyond
  its own safe default. The shipped caller does not send this field at all
  today; this is additive and fail-safe by construction, tracked for the
  shipped caller's own future update as `BL-MEMOS-113`.
- Every other `authorization.*` field is a plain caller-asserted boolean,
  read for the legacy vault-set gating described in §4 below — the same
  "Tier-1 claims MSP does not independently verify beyond structural
  presence and type" property this runtime already documents for API-011
  grants.

## 4. Response

Legacy fields byte-for-byte unchanged in shape and casing; three new fields
additive-only:

```json
{
  "workspacePrivateVaultId": "string",
  "globalPrivateVaultIds": ["string"],
  "sharedVaultIds": ["string"],
  "principalPrivateVaultId": "string",
  "principalPassportVaultId": null,
  "permissions": {
    "read": true, "writePrivate": false, "writeShared": false,
    "policyVersion": "string",
    "allowPassport": false
  }
}
```

- **`workspacePrivateVaultId`**: `VaultRegistry.provisionWorkspacePrivateVault`
  for `(access_context.workspace_id, {projectId: access_context.project_id})`
  — always present.
- **`globalPrivateVaultIds`**: `[VaultRegistry.provisionGlobalPrivateVault(access_context.agent_id).vault_id]`
  when `authorization.allow_global_private === true`, else `[]` — always
  present, never omitted.
- **`sharedVaultIds`**: `[VaultRegistry.provisionSharedVault(access_context.project_id).vault_id]`
  when `authorization.allow_shared === true`, else `[]` — always present.
- **`principalPrivateVaultId`** (new): `null` when `access` is absent. When
  `access` is present and its `msp_vault_resolve` grant verifies, its
  `tenantId`/`principalId`/`agentId`/`workspaceId` claims must match the
  request's `access_context`; only then does
  `VaultRegistry.provisionPrincipalPrivateVault` resolve and lazily provision
  the episodic vault.
- **`principalPassportVaultId`** (new): `null` unless the verified grant is
  present, matches the request, and carries `allowPassport: true` together
  with `authorization.allow_passport === true`; no row is created otherwise.
- **`permissions.read`/`.writePrivate`/`.writeShared`**: echo
  `authorization.read`/`.write_private`/`.write_shared` as booleans.
- **`permissions.policyVersion`**: echoes `access_context.policy_version`
  when it is a non-empty string; otherwise the literal sentinel
  `"unspecified"` (RKOI PH-MEMOS-5 review round 1, WARNING 6 — corrected
  from an earlier draft's "empty string if absent": zuri-ai's shipped,
  unmodified `validateVaultSet` throws on an empty `permissions.policyVersion`,
  so an empty-string default would have silently broken the response
  contract for any caller that legitimately omits `policy_version`, exactly
  the case §3 documents as optional/nullable).
- **`permissions.allowPassport`** (new): `true` only when both the legacy
  authorization preference and the verified grant's literal
  `allowPassport: true` are present; otherwise `false`.

Every field above is **always present with the correct type**, even when a
permission is denied (`false`/`[]`, never omitted) — the shipped, unmodified
`validateVaultSet` throws on a missing or wrongly-typed field, and silently
drops every field it does not itself recognize (`workspacePrivateVaultId`,
`globalPrivateVaultIds`, `sharedVaultIds`, `permissions.{read,writePrivate,
writeShared,policyVersion}` only) — this is the concrete mechanism behind
"additive-only," not an assertion taken on faith.

## 5. Errors

| Code | Trigger |
|---|---|
| `validation_failed` | `access_context` missing a required field (`tenant_id`/`principal_id`/`agent_id`/`workspace_id`/`project_id`), or `authorization` is absent or not an object |
| `vault_scope_denied` | `authorization.allowed` is not exactly `true` |
| `grant_required` | `legacy_access` is absent; no legacy provisioning or journal write occurs |
| `grant_signature_invalid` | A present `access` or `legacy_access` grant is malformed, signed for another operation, or has an invalid required claim |
| `grant_expired` | A present grant is outside the accepted `expiresAt` window |
| `grant_payload_mismatch` | A grant hash or its owner tuple does not match this request |
| `grant_unconfigured` | A present grant cannot be verified because no service key is configured |
| `grant_nonce_required` / `grant_replayed` | The required legacy grant, or optional principal grant, has no usable nonce or its nonce was already consumed |
| `identity_hmac_unconfigured` | A valid principal grant requires an identity key for its receipt actor. Legacy-only signed resolution does not require this key. |
| `vault_provision_conflict` | Defensive unique/snapshot race or exhausted random-ID collision retries. Normal concurrent resolve is serialized with BEGIN IMMEDIATE and returns the winning row to both callers. Retry the whole request with a fresh nonce after a refusal. |

Neither API-009 nor API-010 emits the historical unsigned-scope error codes.
API-009 collapses principal grant failures to `not_found`; this resolver
retains the typed grant failures listed above.

## 6. Idempotency and concurrency

Two authorized calls with fresh legacy nonces and the identical legacy owner
tuple always return the same legacy vault IDs; principal vault resolution
also requires a fresh `access` nonce and the identical
`(tenant_id, principal_id, agent_id, workspace_id)` tuple. The handler
consumes the required legacy nonce, optional principal nonce, legacy
provisioning, optional principal provisioning, and journal receipt inside one
outer immediate transaction. Any refusal rolls back all of them. A
call that needs to newly provision both the episodic vault and (when
gated) the passport vault does so inside that same transaction — a failure
partway through never leaves one vault created and the other not,
including the `vault_provision_conflict` failure above: that transaction
rolls back in full and the error propagates unremapped; this tool never
internally retries a `vault_provision_conflict`. Re-provisioning a tuple
whose only prior row is erased mints a genuinely different `vault_id`,
with a fresh random UUID and bounded primary-key collision retry, never
resurrecting the erased row, and unaffected by whether
`MSP_IDENTITY_HMAC_KEY` was rotated between the original provision and the
re-engagement.

## 7. Journal receipt

Every signed principal `msp_vault_resolve` call — resolving an existing vault or
provisioning a new one — writes one `journal` row: `actor:
"principal_hmac:" + principalHmac` (a per-call pseudonym,
`HMAC-SHA256(MSP_IDENTITY_HMAC_KEY, String(tenant_id.length) + ":" +
tenant_id + "|" + principal_id)`), `tool_name: "msp_vault_resolve"`, `ref`
the resolved episodic `vault_id`, `payload_json: { tenant_id, agent_id,
workspace_id, provisioned_episodic, provisioned_passport,
passport_requested }`. No raw `principal_id`, no `business_id`, no other
provenance field ever appears in this receipt.

Signed legacy-only calls append a receipt with actor `legacy_access_grant`,
NULL `ref` and workspace, NULL tenant/agent/workspace payload fields, and
false principal-provisioned/passport-requested booleans. The actor is a
constant label, not a caller identity. Calls with a principal grant retain
the `principal_hmac` actor and scoped receipt described above.

## 8. Compatibility

Versioning: this contract is `0.3.0b`; breaking changes to any request or
response shape require a version bump and a Changelog row, following
`docs/STD-Document-Versioning-Governance.md`. `docs/API-009-Persistent-
Memory-Contract.md`'s signed-access section (§4.11 there) reuses the same
grant envelope and verifier, while this tool retains its legacy
`access_context` request object for the shipped caller.

## Changelog

| Version | Date | Summary |
|---|---|---|
| 0.3.0b | 2026-09-27 | Require a separately signed, payload-bound, nonce-protected legacy resolver grant; keep the principal grant optional and separate; refuse the unsigned legacy request. |
| 0.2.0b | 2026-09-17 | PH-MEMOS-5 alignment with design §5.0: retained unsigned legacy resolution, added optional signed principal access, target claim checks, nonce consumption, and conditional principal response fields. |
| 0.1.0b | 2026-09-16 | PH-MEMOS-5 (`TASK-MEMOS-008`, `BL-MEMOS-062`): first real implementation and first real contract file for `msp_vault_resolve` — request/response shapes matched exactly against zuri-ai's shipped `msp-vault-resolver.js` (`origin/main@4ca28c1d`), full error table, idempotency/concurrency guarantees, and the journal receipt shape. |

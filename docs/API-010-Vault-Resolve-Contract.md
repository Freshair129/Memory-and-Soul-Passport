---
doc_id: "API-010-VAULT-RESOLVE-CONTRACT"
version: "0.1.0b"
status: "beta"
created_at: "2026-09-16T00:00:00+07:00,KIN"
last_update: "2026-09-16T00:00:00+07:00,KIN"
---

# API-010 Vault Resolve Contract (`msp_vault_resolve`)

This is the first real implementation of `msp_vault_resolve`. Every earlier
revision of `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` (back to
v0.1.0b) named this tool in vocabulary only; it has never had MSP-side code
before PH-MEMOS-5 (`TASK-MEMOS-008`, `BL-MEMOS-062`). Full design
specification, every reviewed correction, and the cross-repo verification
against zuri-ai's shipped caller live in that design document's §5.3/§5.3.1
— this contract file is the wire-shape source of truth; the design document
is the reasoning behind it.

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

**No `access`/`grant`/`signature` field.** Unlike every API-011 tool, this
request is **unsigned** — it carries no HMAC-signed grant. This is a real,
deliberate disagreement with API-011's signed-grant model, not an oversight:
the shipped caller does not send one and cannot be made to without a
zuri-ai-side change this phase does not schedule. `msp_vault_resolve`
accepts the request on the same stdio-only trust boundary every tool that
predates API-011's signed grant already lives on (`RSK-MEMOS-05`,
`RSK-MEMOS-12`) — a caller able to reach this server at all already shares
the process boundary that holds every tenant's actual keys. **`access_context`
here authorizes against a self-asserted identity; it does not authenticate
the caller.**

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
  }
}
```

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
- **`authorization.allow_passport`** (new): absent, or any value other than
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
- **`principalPrivateVaultId`** (new): `VaultRegistry.provisionPrincipalPrivateVault`
  for `(tenant_id, principal_id, agent_id, workspace_id)`, resolved and
  lazily provisioned on **every** well-formed call — the episodic vault is
  not gated by any `authorization.*` flag, matching the design's own tier
  table ("this principal's turns with this agent in this workspace," every
  turn, no separate opt-in).
- **`principalPassportVaultId`** (new): `null` unless
  `authorization.allow_passport === true`, in which case
  `VaultRegistry.provisionPrincipalPassportVault(tenant_id, principal_id).vault_id`.
  Never provisioned when the gate does not hold — no row is created "just
  in case."
- **`permissions.read`/`.writePrivate`/`.writeShared`**: echo
  `authorization.read`/`.write_private`/`.write_shared` as booleans.
- **`permissions.policyVersion`**: echoes `access_context.policy_version`
  (empty string if absent).
- **`permissions.allowPassport`** (new): echoes the same boolean MSP just
  read from `authorization.allow_passport` — confirmation, not an
  independent decision.

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
| `identity_hmac_unconfigured` | No `MSP_IDENTITY_HMAC_KEY` configured. This tool is refused **entirely** without one, not only for principal-vault-touching calls — every well-formed call resolves and journals a `principal_private` vault unconditionally (§4), and that journal receipt's own actor pseudonym needs the key. A deployment must configure `MSP_IDENTITY_HMAC_KEY` before enabling this tool for any caller, including a caller that only wants the legacy fields |
| `vault_provision_conflict` | A concurrent `msp_vault_resolve` call is provisioning the identical `(tenant_id, principal_id, agent_id, workspace_id)` or `(tenant_id, principal_id)` tuple's first-ever generation (`SQLITE_BUSY_SNAPSHOT` on the losing `INSERT`) — retry the whole call; the retry's own fresh transaction sees the winner's committed row |

No `access_context_required`/`access_context_denied` here — those two codes
are specific to API-009's `msp_memory_*` amendment
(`docs/API-009-Persistent-Memory-Contract.md` §4.10); a `msp_vault_resolve`
call's `access_context` is the thing being resolved *from*, not a claim
being checked *against* an already-resolved vault.

## 6. Idempotency and concurrency

Two calls with the identical `(tenant_id, principal_id, agent_id,
workspace_id)` always return the identical `principalPrivateVaultId`. A
call that needs to newly provision both the episodic vault and (when
gated) the passport vault does so inside one outer transaction — a failure
partway through never leaves one vault created and the other not,
including the `vault_provision_conflict` failure above: that transaction
rolls back in full and the error propagates unremapped; this tool never
internally retries a `vault_provision_conflict`. Re-provisioning a tuple
whose only prior row is erased mints a genuinely different `vault_id`,
found by probing that id's own existence, never colliding with or
resurrecting the erased row, and unaffected by whether
`MSP_IDENTITY_HMAC_KEY` was rotated between the original provision and the
re-engagement.

## 7. Journal receipt

Every `msp_vault_resolve` call — resolving an existing vault or
provisioning a new one — writes one `journal` row: `actor:
"principal_hmac:" + principalHmac` (a per-call pseudonym,
`HMAC-SHA256(MSP_IDENTITY_HMAC_KEY, String(tenant_id.length) + ":" +
tenant_id + "|" + principal_id)`), `tool_name: "msp_vault_resolve"`, `ref`
the resolved episodic `vault_id`, `payload_json: { tenant_id, agent_id,
workspace_id, provisioned_episodic, provisioned_passport,
passport_requested }`. No raw `principal_id`, no `business_id`, no other
provenance field ever appears in this receipt.

## 8. Compatibility

Versioning: this contract is `0.1.0b`; breaking changes to any request or
response shape require a version bump and a Changelog row, following
`docs/STD-Document-Versioning-Governance.md`. `docs/API-009-Persistent-
Memory-Contract.md`'s `access_context` amendment (§4.10 there) reuses this
tool's own `access_context` field names/casing field-for-field, so a
caller that already builds one object for this tool can reuse it, trimmed
or widened per tool, for every `msp_memory_*` call in the same turn.

## Changelog

| Version | Date | Summary |
|---|---|---|
| 0.1.0b | 2026-09-16 | PH-MEMOS-5 (`TASK-MEMOS-008`, `BL-MEMOS-062`): first real implementation and first real contract file for `msp_vault_resolve` — request/response shapes matched exactly against zuri-ai's shipped `msp-vault-resolver.js` (`origin/main@4ca28c1d`), full error table, idempotency/concurrency guarantees, and the journal receipt shape. |

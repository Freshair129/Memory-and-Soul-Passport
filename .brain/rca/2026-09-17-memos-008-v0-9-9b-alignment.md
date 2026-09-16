# MEMOS-008 v0.9.9b alignment RCA

## Symptom

The existing PH-MEMOS-5 implementation follows the earlier §5.1–§5.6
implementation pass, while the current normative §5.0 v0.9.9b reopens the
wire and transaction rules. It still accepts `access_context` on direct
memory tools, derives principal vault ids from owner tuples, consumes no
shared nonce in the memory/context paths, and exposes typed access-context
errors that the current design requires to collapse to `not_found`.

## Evidence

- `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` v0.9.9b §5.0.2
  requires `mintVaultId()` and random principal-vault ids.
- §5.0.3 requires `.immediate()` principal provisioning, bounded primary-key
  collision retry, and `VaultProvisionConflictError` only as a backstop.
- §5.0.5–§5.0.9 require a shared, claim-set-aware grant verifier, top-level
  `access`, one refusal rule for principal targets, in-transaction nonce
  consumption, context grant gating, and the global-private deployment gate.
- The current source still contains `provision_epoch`/epoch probing in
  `vault-registry.mjs` and `0011`, uses `access_context` and
  `assertAccessContext` in `memory-handlers.mjs`/context handlers, and has no
  vault-grant verifier or shared nonce domain function.

## Root Cause

The implementation stopped after an earlier approved design revision and the
later normative consolidation was applied only to documentation. Code,
schemas, migrations, and tests were not re-synchronized to the reopened
decisions (`DEC-MEMOS-63..73`).

## Why the issue escaped detection

The existing tests assert the superseded `access_context` and epoch behavior,
so they validate the prior implementation contract rather than the current
§5.0 contract. No conformance test exercised the new `access` field, grant
claim-set differences, conditional outer `.immediate()`, or rollback-safe
nonce consumption.

## Proposed prevention

Keep §5.0 as the sole normative source, update machine schemas and contract
tests in the same change as handlers/domain/migrations, and add explicit
security cases for every branch in §5.0.16: grant refusal collapse, grant
nonce rollback/replay, context ordering, global-private gating, random-id
collision retry, and migration invariants.

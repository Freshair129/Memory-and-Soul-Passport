---
version: "0.1.0b"
created_at: "2026-09-17T00:00:00+07:00,RWANG"
last_update: "2026-09-17T00:00:00+07:00,RWANG"
status: "candidate"
attributes:
  domain: "identity-erasure"
  doc_type: "rca"
  scope: "BL-MEMOS-076-erasure-receipt-idempotency-matching"
---

# RCA: receipt matching conflated a pruned key with a principal mismatch

## Symptom

An idempotency retry for a receipt whose historical identity-key version had
been pruned returned the same generic conflict message as a retry naming a
different principal. That did not honor §12.5's required distinction:
unavailable historical keys must report that the receipt cannot be matched,
never that the caller's principal mismatched.

## Evidence

The original matching helper returned only a boolean. It returned false both
when identity_key_version was absent from the active key plus retained
keyring and when a derivation under an available key differed from the stored
principal_hmac. The caller then emitted one message covering both cases.
Focused security tests now exercise both paths: a retained key permits a
same-principal replay, a pruned key returns an unavailable-version conflict,
and a different principal with the active key returns a mismatch conflict.

## Root Cause

The implementation modeled receipt matching as a predicate even though the
specification defines two operational outcomes for a non-match: the key may
be unavailable, or the available key may prove a different principal. The
boolean erased that state before error mapping.

## Why the issue escaped detection

The first BL076 tests covered successful rotation and receipt pseudonym shape,
but did not run an idempotency retry after removing the retired key. The
existing different-principal test asserted only the broad conflict code, so
it did not require an honest message for the available-key mismatch path.

## Proposed prevention

Keep matching as a three-state result: matched, unavailable_key, or mismatch.
Map the latter two to distinct existing conflict messages and retain dedicated
security assertions for key pruning and wrong-principal retries. Do not
collapse an unavailable version to not_found or report a principal mismatch
without a derivation under an available key.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | candidate | Documented the key-pruning versus principal-mismatch state-loss root cause and the three-state matching prevention. | working-tree | RWANG |

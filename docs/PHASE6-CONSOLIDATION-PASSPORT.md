---
doc_id: "PHASE6-CONSOLIDATION-PASSPORT"
version: "0.3.0b"
status: "candidate"
created_at: "2026-09-17T00:00:00+07:00,RWANG"
last_update: "2026-09-17T00:00:00+07:00,RWANG"
attributes:
  domain: "mission-state-protocol"
  doc_type: "phase6-candidate"
  scope: "BL-MEMOS-070..075-consolidation-passport-and-erasure"
  authority: "owner approval required"
---

# Phase 6 consolidation and passport candidate

This candidate closes the contract gaps left by the current design and
implementation plan for BL-MEMOS-070..075. It is one bounded package for
approval. It authorizes no implementation until the owner approves or amends
the package. BL-MEMOS-076 remains the separately specified §12.5 slice and is
not widened by this document.

The risk level is **HIGH**: this package adds authenticated write/read
surfaces, a provenance table, and a principal-vault erasure transaction.

## 1. Rules already inherited from the approved design

These rules are not new policy in this candidate:

1. Design §10.2 permits a protected record to consolidate only when it is
   status = 'ACTIVE', verification_state = 'CONFIRMED', and the target is
   the record subject's own vault. A bystander cannot use the record in their
   own vault. global_private is never a consolidation target.
2. Principal episodic vault ownership is
   tenant_id × principal_id × agent_id × workspace_id. Two agents serving
   one person therefore have separate episodic vaults.
3. A principal passport vault is owned by tenant_id × principal_id and is
   agent-agnostic. Every passport access requires a verified grant with the
   literal allowPassport: true; agentId and workspaceId do not authorize or
   deny a passport target.
4. Principal vaults are never mountable. Their vault_id values are random
   opaque references, and an erased vault row is retained as a tombstone.
5. The new operations use the current signed-grant envelope
   access: { grant, signature }. The flat grant is verified with the shared
   HMAC verifier, exact tool-name operation, expiry, payloadHash, tenant
   key selection, required tuple claims, and nonce rules from design §5.0.
   A self-asserted access_context is never an authority for these operations.
6. A principal-type target keeps the §5.0 one-refusal rule: unknown vault,
   absent/invalid/mismatched grant, missing allowPassport, erased target, or
   nonce failure is the same not_found result. global_private keeps its
   existing explicit vault_scope_denied rule when a present grant names the
   wrong agent. Existing msp_memory_promote remains its API-006 surface and
   is not silently repurposed by this candidate.
7. Group/room material cannot enter a private context. The proposed
   consolidation and digest paths therefore use only records whose source
   thread is DIRECT; GROUP and ROOM are rejected or excluded before any
   target-vault write.
8. Erasure keeps append-only rows where the existing design requires them.
   entity_history, provenance, and the vault row are retained; content and
   searchable projections are cleared according to the concrete disposition
   in §5 below.

## 2. New policies proposed for owner approval

The following values are deliberate conservative defaults for phase6-v1.
They are new policy, not claims about the current implementation:

| Policy | Proposed value |
|---|---|
| Confidence scale | A finite JSON number in [0, 1]; passport comparison is inclusive confidence >= 0.90. |
| Confidence source | `protected_memory_records.confidence`, added as a bounded [0,1] stored field by the Phase 6 migration and copied read-only into provenance. Consolidation accepts no caller-supplied confidence. Existing rows backfill to 0 and cannot satisfy the passport confidence gate until a producer records a value. |
| Episode gate | At least **2 distinct CONFIRMED sessions** for the same verified subject. Sessions need not be in separate threads. |
| Source gate | Every contributing record is ACTIVE, CONFIRMED, subject-bound to the verified principal, and sourced from a DIRECT thread. GROUP/ROOM, CONTESTED, ERASED, and missing sources are ineligible. |
| Duplicate gate | A source is distinct by record_id; repeating one record never increases the episode count. A session counts once by session_id. |
| Passport time window | None for phase6-v1; the gate evaluates all retained non-erased source records. This avoids silently expiring a confirmed fact until a retention policy exists. |
| Passport decision | Eligible candidates write to the principal passport and return decision = "promoted". Below threshold returns decision = "passport_deferred" with a stable reason and writes no passport entity. |
| Per-call source bound | One source record for msp_memory_consolidate; one candidate entity plus its provenance set for msp_memory_passport_promote. |
| Context digest bound | limit defaults to 20 and may not exceed 50; results use deterministic (recorded_at ASC, entity_id ASC) ordering and an opaque cursor. |
| Erasure bound | Before mutation, count affected rows and refuse when any one table exceeds 200 rows. The refusal is atomic; no partial erasure or receipt is allowed. |
| Policy version | Every decision stores policy_version = "phase6-v1"; changing a threshold requires a new policy version and review. |

Logical identity and merge are also part of the proposed policy: a
consolidation request carries the signed `entity_category` and
`entity_key` that identify the fact, using the existing entity uniqueness
key `(target_vault_id, category, key)`. `entity_category` is a non-empty
API-009 category with no embedded spaces and at most 128 characters;
`entity_key` is a non-empty string of at most 256 characters. The
`entity_id` is therefore derived from that tuple, never from
`source_record_id`. The first source creates the entity; a later eligible
source with the same tuple updates that same entity, appends one
`entity_history` version, and appends its own provenance row. The latest
source body is the current body, while entity confidence is the maximum of
the existing value and the source row's stored confidence. Passport counts
`COUNT(DISTINCT source_session_id)` and
`COUNT(DISTINCT source_record_id)` over non-tombstoned consolidation
provenance for that one entity, so a second session contributes to the same
candidate instead of creating a second candidate.

The owner can approve this package as written or amend any row in this table.
The package is concrete; no open choice is hidden in the implementation work.

## 3. Proposed authenticated API contract

The following tool names are new and must be added to the contracts schema,
handler deny-all list, and test suites only after approval.

### 3.1 msp_memory_consolidate (BL-MEMOS-070)

Request:

~~~json
{
  "source_record_id": "memory-record_...",
  "target_vault_id": "vault_...",
  "entity_category": "preference",
  "entity_key": "language",
  "access": { "grant": {}, "signature": "hex" },
  "idempotency_key": "caller-chosen-..."
}
~~~

The signed grant's exact operation is msp_memory_consolidate.
payloadHash covers the request body with the access envelope removed in the
same way as the existing vault-grant tools. The verified grant must carry
tenantId, principalId, agentId, workspaceId, and a nonce. The target must be
the verified subject's active principal_private vault; a passport target is
accepted only by the passport operation below. The source record's stored
subject must equal the verified principalId, and its thread must be DIRECT.
`entity_category` and `entity_key` are signed payload fields and use the
length/space bounds in §2. The handler reads the source row's stored
`confidence`; the caller cannot provide or override that value.

The operation resolves and validates the source, target, and idempotency key
before writing. One successful call upserts the single logical entity
identified by `(target_vault_id, entity_category, entity_key)`, appends one
entity_history version when its source content changes, and appends one
immutable entity_provenance row in one transaction. A later source with the
same logical key returns the existing entity_id; it does not create a second
candidate. The source confidence is copied into provenance and the entity's
current confidence becomes `MAX(existing, source.confidence)`. The transaction
consumes the nonce in the same transaction and returns:

~~~json
{
  "decision": "consolidated",
  "entity_id": "entity_...",
  "target_vault_id": "vault_...",
  "provenance_id": "provenance_...",
  "replay": false
}
~~~

An identical retry returns the original identifiers with replay: true. The
same `(tenant_id, operation, idempotency_key)` with a different source,
target, category, or key is conflict. An ineligible source returns no entity
and the stable response
{ "decision": "passport_deferred", "reason": "source_ineligible" } only
when the source exists and is authorized; unknown or unauthorized source and
target paths remain the inherited not_found non-oracle.

### 3.2 msp_memory_passport_promote (BL-MEMOS-071)

Request:

~~~json
{
  "entity_id": "entity_...",
  "access": { "grant": {}, "signature": "hex" },
  "idempotency_key": "caller-chosen-..."
}
~~~

The signed grant's exact operation is msp_memory_passport_promote. It carries
tenantId, principalId, **agentId, workspaceId**, `allowPassport: true`, and a
nonce. Before reading the entity, the handler verifies that the source
entity's vault owner tuple exactly equals all four grant tuple claims. The
source tuple is therefore required for source authorization. After that
check, passport target ownership compares only tenantId, principalId, and
the literal allowPassport claim; agentId and workspaceId do not partition
the target passport. The entity must be in the verified subject's active
principal_private vault and have provenance satisfying the phase6-v1 table in
§2. The operation writes the same logical category/key/content to the active
principal_passport vault and appends one `promoted` provenance row for every
retained `consolidated` source row in the candidate's source set. All rows in
that promotion batch share the request idempotency key and a computed
source-set hash; the operation never changes or deletes the episodic source.

A candidate below the gate returns exactly:

~~~json
{
  "decision": "passport_deferred",
  "reason": "threshold_not_met",
  "entity_id": "entity_...",
  "replay": false
}
~~~

No raw source content or other principal's identifier is returned in a
deferred response. source_ineligible, threshold_not_met, and
duplicate_source are the only passport_deferred reasons in phase6-v1.
The successful response is the same shape with decision: promoted and
passport_entity_id, plus `provenance_ids`, an opaque array containing the
promoted rows for that batch. A retry returns the same array. A different
idempotency key for an already-promoted source set is conflict rather than a
second promotion.

### 3.3 msp_memory_context_digest (BL-MEMOS-072)

Request:

~~~json
{
  "query": "optional bounded search text",
  "limit": 20,
  "cursor": null,
  "include_passport": true,
  "access": { "grant": {}, "signature": "hex" }
}
~~~

The exact signed-grant operation is msp_memory_context_digest; the grant
must carry tenantId and principalId, and a nonce is not required because this
is read-only. include_passport: true requires the literal allowPassport: true;
episodic results additionally require the verified agent/workspace tuple. The
query sees only the caller's own active principal_private vault and, when
enabled, the caller's own active passport vault. No GROUP/ROOM source is
eligible for the digest.

Response:

~~~json
{
  "items": [
    {
      "entity_id": "entity_...",
      "vault_id": "vault_...",
      "category": "preference",
      "key": "…",
      "confidence": 0.93,
      "provenance_receipt": "provenance_..."
    }
  ],
  "next_cursor": null
}
~~~

provenance_receipt is an opaque reference only. It never contains raw
principal ids, source text, message bodies, or an access grant. An invalid or
unauthorized principal target returns the inherited not_found; malformed
limits/cursors return validation_failed.

## 4. Provenance storage contract (BL-MEMOS-070/071)

Migration 0015 (number assigned after the reserved 0013 nonce amendment and
the BL076 0014) will add the bounded source-confidence field to
`protected_memory_records`, add `entity_provenance`, add
`entity_history.redaction_state` with its one-way tombstone trigger, and
replace the entity FTS update trigger with the forgotten-state guard described
in §5:

~~~sql
ALTER TABLE protected_memory_records
  ADD COLUMN confidence REAL NOT NULL DEFAULT 0
  CHECK (confidence >= 0 AND confidence <= 1);
~~~

The existing `msp_thread_memory_record` writer gains a `confidence` field in
the same contract update: it is optional for legacy callers and defaults to
0, but when supplied it must be a finite JSON number in [0,1] and is stored
exactly in this column. Its existing signed grant and nonce remain the
authority for who records it. A consolidation request cannot supply or
override the value. A legacy row receives 0 through the additive default and
remains below the passport confidence gate. A non-finite, out-of-range, or
missing source confidence is rejected as source_ineligible before any entity
write.

~~~sql
CREATE TABLE entity_provenance (
  provenance_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('msp_memory_consolidate', 'msp_memory_passport_promote')),
  source_record_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_message_refs_json TEXT NOT NULL,
  target_vault_id TEXT NOT NULL REFERENCES vaults (vault_id),
  target_entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  decision TEXT NOT NULL CHECK (decision IN ('consolidated', 'promoted')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  confirmed_session_count INTEGER NOT NULL CHECK (confirmed_session_count >= 0),
  policy_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_set_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  redaction_state TEXT NOT NULL DEFAULT 'none'
    CHECK (redaction_state IN ('none', 'tombstoned')),
  UNIQUE (tenant_id, operation, idempotency_key, source_record_id),
  UNIQUE (tenant_id, operation, source_record_id, target_entity_id)
);
~~~

The row stores opaque source and vault/entity references, never a raw
principal_id. It is append-only for provenance facts. Erasure may perform
the one permitted redaction_state: none -> tombstoned transition and replace
source_message_refs_json with []; all other columns stay pinned. A
trg_entity_provenance_no_delete trigger rejects physical deletion. A promotion
retry reuses the existing provenance identifiers; it cannot create
a second row with a different policy result under the same operation-scoped
idempotency key and source set. `source_set_hash` is SHA-256 over the sorted
source record ids plus the source entity id and policy version, so a retry
must carry the same candidate and retained source set. The second unique key
also prevents the same source record from counting twice for one target entity
when a caller changes its idempotency key. `confirmed_session_count` is the
distinct-session snapshot at the time of each write; passport promotion
recomputes distinct retained sessions and source records from the provenance
rows rather than trusting a caller-provided count.

The migration must be a normal additive migration after the reserved numbers,
must preserve foreign-key checks, and must pass fresh and populated database
tests. The API contract and table are one approval unit; no implementation
should invent a different table or silently store a principal identifier.

## 5. Vault and content erasure contract (BL-MEMOS-073)

The existing design disposition is retained and made executable:

| Table | Proposed Phase 6 disposition |
|---|---|
| vaults | One guarded UPDATE per affected principal vault: status='erased', principal_id=NULL, tenant_id=NULL, agent_id=NULL, workspace_id=NULL; keep vault_id, vault_type, decay_policy, role, timestamps, and the no-delete invariant. Clearing the complete owner tuple is the inherited §11.1/BL073 disposition; the existing 0011 trigger already permits this erased-row state. |
| entities | Retain the row and id; set lifecycle_state='forgotten', body_json='{}', epistemic_state='deprecated', confidence=0, and updated_at to the erasure time. Pin every other identity/provenance column. |
| entity_history | Retain every append-only row. Migration 0015 adds redaction_state TEXT NOT NULL DEFAULT 'none' with values none/tombstoned and a trigger permitting only none -> tombstoned; that transition sets body_json='{}', epistemic_state='deprecated', and confidence=0 while pinning every other column. |
| embeddings | Delete every embedding whose entity_id is affected. There is no content-preserving embedding tombstone. |
| entities_fts | Delete every affected entity_id projection in the same transaction. Migration 0015 replaces trg_entities_fts_au so it always deletes the old projection and reinserts only when new.lifecycle_state != 'forgotten'; the erasure path also issues an explicit delete after the entity update as defense in depth. MATCH must return no affected id. |
| entity_provenance | Retain the row; transition redaction_state to tombstoned and clear source_message_refs_json to []. |
| principal vault row | Never physically delete it. An erased row is not readable or mountable and remains only as a non-owner tombstone. |

msp_thread_principal_erase is extended with erase_vault: true under the same
signed data-subject grant and idempotency key. Before any update, it resolves
the complete affected set and checks the 200-row-per-table bound. Then one
immediate transaction performs all entity/history/embedding/FTS/provenance/
vault changes, closes applicable principal participant rows according to
existing §11.1 rules, consumes the nonce, and writes the immutable
pseudonymized erasure receipt. A failure at any point rolls back every table.
The operation returns the existing erasure receipt shape without returning a
raw principal id.

The typed error vocabulary is bounded to existing not_found,
grant_signature_invalid, grant_expired, grant_payload_mismatch,
grant_nonce_required, grant_replayed, validation_failed, and conflict, plus one new
memory_erasure_limit_exceeded for the preflight bound. The new limit error is
returned before mutation and never identifies another tenant or principal.

## 6. Transaction, concurrency, and acceptance rules

Mutation replay and idempotency are separate checks. Every consolidate,
passport-promote, and vault-erasure grant carries a nonce. A retry after a
lost response may reuse the same idempotency key only with a **fresh nonce**
and a still-unexpired signed grant. Reusing the nonce is `grant_replayed`
before an idempotency response is considered. `expiresAt` is checked on
every request, including a request whose idempotency row already exists; an
expired retry is `grant_expired` and cannot obtain the old response or alter
state. The nonce insert and the mutation are one transaction, so a rollback
does not consume a nonce.

All three new tools and the vault-erasure extension must:

1. verify the signed grant and request payload before any existence-sensitive
   lookup;
2. use SQLite BEGIN IMMEDIATE for mutation paths;
3. consume the nonce in the same transaction as the entity/provenance or
   erasure mutation;
4. use (tenant_id, operation, idempotency_key) for idempotent response identity
   and return conflict on a changed request;
5. refuse the whole transaction if the row bound is exceeded or a concurrent
   source/entity version changes; no partial success is reported;
6. preserve append-only and no-delete triggers, and map SQLITE_BUSY,
   SQLITE_BUSY_SNAPSHOT, and unique races to the existing typed conflict.

Required proof is the named GATE-MEMOS-6 suite set from the implementation
plan:

| Suite | Required evidence |
|---|---|
| tests/security/consolidation-vault-scoping.security.mjs | Signed subject grant succeeds; bystander, wrong tuple, absent/invalid grant, global_private, erased vault, replay, and cross-agent paths fail with the inherited non-oracle result. |
| tests/security/cross-thread-digest-scoping.security.mjs | Own DIRECT episodic/passport results are ordered and bounded; GROUP/ROOM, bystander, and other-agent rows never appear; receipts are reference-only. |
| tests/security/group-thread-private-context.security.mjs | A group record cannot be consolidated or read through a private digest, including unresolved UNKNOWN/OPERATOR messages. |
| tests/security/erasure-invalidates-retrieval.security.mjs | Entity/history tombstones, deleted embeddings, empty FTS MATCH, cleared vault owner tuple, tombstoned provenance, no-delete rows, limit refusal, retry, and concurrent conflict are proven by direct database assertions. |
| contract/conformance tests | Exact request/response/error enums, grant operation binding, payload hash, policy version, limits, and migration schema are checked. |

No Phase 6 close claim is valid until the docs, migration, contract schema,
security suites, and direct database evidence all agree. BL075 is the review
and merge gate after these proofs; production readiness is not inferred from
local tests.

## 7. Boundary diagram

~~~mermaid
flowchart TD
  C[Caller] --> G[Signed grant + payload hash + nonce]
  G --> S[Resolve authorized source]
  S --> E{ACTIVE + CONFIRMED\nsubject-owned DIRECT?}
  E -- no --> D[passport_deferred or not_found]
  E -- yes --> V[Write episodic entity]
  V --> P[Append entity_provenance]
  P --> Q{confidence >= 0.90\nand 2 confirmed sessions?}
  Q -- no --> D
  Q -- yes --> PP[Write agent-agnostic passport entity]
  C --> R[Signed context digest]
  R --> RD[Own DIRECT episodic + optional passport]
  RD --> RR[Reference-only provenance receipt]
  C --> X[Signed data-subject erase]
  X --> XF[Preflight <= 200 rows per table]
  XF --> XT[One immediate transaction]
  XT --> XE[Entity/history tombstones + embeddings/FTS clear]
  XE --> XV[Cleared vault tombstone + immutable receipt]
~~~

## Approval request

Please approve or amend this single concrete package: the three tool names
and request/response shapes in §3, the entity_provenance schema and redaction
transition in §4, the phase6-v1 thresholds/limits in §2, and the exact
vault/entity/history/FTS/embedding disposition and error in §5. Once approved,
implementation can proceed against this document and the existing §5.0 grant
contract without inventing API or policy at code time. Until then, BL070..075
remain documentation-only; BL076 is independently testable and scoped to
§12.5.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-09-17 | candidate | Bound logical entity identity and merge semantics, added source-owned confidence, required passport source tuple checks, separated fresh-nonce anti-replay from idempotent retry, and marked cleared owner tuples as inherited erasure disposition. | working-tree | RWANG |
| 0.2.1b | 2026-09-17 | candidate | Clarified operation-scoped provenance idempotency, entity-history redaction state, and the conditional FTS update trigger required by the proposed erasure disposition. | working-tree | RWANG |
| 0.2.0b | 2026-09-17 | candidate | Replaced owner-decision placeholders with one bounded proposed Phase 6 contract: inherited grant and vault rules, concrete consolidation/passport/digest APIs, thresholds, limits, provenance schema, tombstone/cleared-vault erasure, transaction guarantees, and acceptance suites. | working-tree | RWANG |
| 0.1.0b | 2026-09-17 | candidate | Initial gap inventory and approval candidate; superseded by 0.2.0b. | working-tree | RWANG |

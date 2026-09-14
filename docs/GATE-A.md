---
version: "0.1.5b"
created_at: "2026-08-12T08:33:00+07:00,ATHER,394a176"
last_update: "2026-09-15T00:00:00+07:00,KIN"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "verification-report"
  scope: "gate-a"
---

# Gate A verification report

Verified on Windows from the standalone MSP checkout on 2026-08-12. A checkbox is marked only where the cited command exercised the behavior.

| Gate | Result | Evidence |
|---|---|---|
| GenesisRAG17 relay scope and role boundary | PASS | `tests/contract/pipeline-relay.test.mjs` proves caller identity replacement, response validation, loopback query restrictions and fail-closed configuration; `tests/security/pipeline-vault-scoping.security.mjs` exercises every scope field, nested envelopes and source/worker separation before downstream access. |
| MSP server boots standalone with no GoVibe path | PASS | `tests/contract/transport-fixture-parity.test.mjs` spawns `apps/msp-server/bin/msp-server.mjs`; root `npm test` passed. |
| `msp-client-js` connects from a separate external process | PASS | `npm pack` tarball installed in an isolated temp npm project; smoke output reported `ping:true`. |
| Memory CRUD (upsert/search/history) | PASS | Packed-client smoke reported `created:true`, `search_hits:1`, `history_versions:1`; API-009 conformance suite passed all nine tools. |
| FTS search without extra infrastructure | PASS | API-009 contract and degradation suites run with a closed Ollama endpoint and pass exact/FTS fallback behavior. |
| Vault isolation | PASS | `npm run test:security`: 30/30, including cross-vault search/read/mutation/link/decay/promotion checks. |
| Context resolve, lineage, and replay | PASS | Contract/context replay suites are included in the 23 passing Vitest files; GoVibe context/runtime consumer tests also passed. |
| Decay lifecycle | PASS | Unit, integration, dry-run, journal, and cross-vault decay tests passed. |
| Contract, security, and integration suites | PASS | Root `npm test`: 23 Vitest files / 176 tests and 30 Node security tests, all passed. |
| GKS promotion remains fail-closed without provider | PASS | Security proof covers `msp_knowledge_promote` and shared `msp_memory_promote`, both returning `gks_provider_unconfigured`. |
| GoVibe uses extracted client unchanged in behavior | PASS | Temporary two-line re-export repoint: targeted 7 files / 32 tests; full GoVibe 616 passed / 1 skipped; security 65/65. Repoint was then cleanly reverted. |

## Packaging evidence

`npm pack --workspace @freshair129/msp-client-js --dry-run` produced a five-file package with no runtime dependencies:

- `package.json`
- `src/authority-enforcement.mjs`
- `src/index.mjs`
- `src/msp-client.mjs`
- `src/msp-stdio-transport.mjs`

The packed tarball was installed with `npm install --ignore-scripts` into an isolated npm project before the external-process smoke test.

## Migration integrity

All seven root migration files matched the SHA-256 of the corresponding GoVibe source migration immediately after copy. Runtime migration tests also passed checksum-drift, downgrade, ordering, and idempotency checks.

## Delivery

- Repository: `https://github.com/Freshair129/msp`
- Review branch: `agent/extract-msp-runtime`
- Draft review: `https://github.com/Freshair129/msp/pull/1`
- The remote branch head was verified equal to the local head after push.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.7b | 2026-09-15 | beta | TASK-MEMOS-002 stage 2 multi-agent (BL-MEMOS-040..048/112, per docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md v0.4.3b, RKOI-approved spec): `agentId`/`workspaceId`/`nonce` required grant claims, `thread_agents` attachment and the agent gate, delivery's own agent scoping (CRITICAL 1), per-agent protected-record visibility (CRITICAL 2), and replay-nonce bookkeeping. New `tests/security/thread-agent-scoping.security.mjs` (GATE-MEMOS-3's umbrella file). Between this row and its predecessor, two prior fixes also landed and are folded in here for the record: a V8 `JSON.parse` non-first-key-corruption engine bug closed in the keyring parser (`tests/security/thread-service-keyring.security.mjs` grew 9 -> 11 cases), and RKOI's merge-blocking transport-level escaped-object-key pre-scan (new `tests/security/transport-json-parse-hardening.security.mjs`, 3 cases). The full security suite is now **100 real-process tests**, up from the 75 this row's predecessor recorded. `npm run test:vitest` (contract+integration) is 425 tests. | working-tree | KIN |
| 0.1.5b | 2026-09-15 | beta | TASK-MEMOS-002 stage 2 (BL-MEMOS-049, per-tenant `MSP_THREAD_SERVICE_KEYRING`): added `tests/security/thread-service-keyring.security.mjs`. After RKOI's stage-2 code review round 1 (the CRITICAL closure: no rejection ever quotes anything read out of the keyring, only an entry's position), the full security suite is **75 real-process tests**, 9 of them keyring cases in that file -- up from the 66/21 (thread-memory) split this row's predecessor recorded. | working-tree | KIN |
| 0.1.4b | 2026-09-14 | beta | TASK-MEMOS-002 stage 1 (API-011 thread memory): `npm run test:security` grew from the pre-existing 45 vault-isolation cases (this row's "30/30" baseline grew into by WP-14/WP-16/pipeline/promotions work, unchanged and still passing) with the addition of `tests/security/thread-memory-scoping.security.mjs`. After RKOI's code review round 2 revision, the full security suite is 66 real-process tests, 21 of them thread cases in that one file (C-1 read-isolation attack reproductions, W1/W6/W7, every RKOI post-implementation review item, and the round-2 CRITICAL room-scope-bypass closure) -- up from an interim 57/12 split recorded earlier in this same stage. | working-tree | KIN |
| 0.1.3b | 2026-09-08 | beta | Added the GenesisRAG17 authenticated relay boundary evidence and removed the retired local checkout path from the verification record. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Added repository, branch, and draft-review delivery evidence. | 04f48f6 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial evidence-backed Gate A report. | 394a176 | ATHER |

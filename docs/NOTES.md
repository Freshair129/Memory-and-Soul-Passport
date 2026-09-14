---
version: "0.2.7b"
created_at: "2026-08-12T08:14:50+07:00,ATHER,394a176"
last_update: "2026-09-15T00:20:00+07:00,KIN"
status: "beta"
attributes:
  domain: "msp-extraction"
  doc_type: "inventory"
  scope: "standalone-repository"
---

# MSP extraction notes

## Scope and invariants

This repository is a packaging extraction of `G:\govibe\packages\msp-runtime` and the GoVibe MSP client. It is not a runtime rewrite. The wire protocol, tool names, SQLite migrations, vault semantics, GKS provider behavior, and public client behavior remain frozen.

The source checkout `G:\govibe` is read-only during extraction. Its pre-extraction baseline passed on 2026-08-12:

- `npm test` from `G:\govibe\packages\msp-runtime`
- Vitest: 22 files, 166 tests passed
- Node security suite: 30 tests passed

No `.env` file was read. Only environment-variable names present in source code are part of this inventory.

## Source-to-package mapping

| GoVibe source | Standalone target | Notes |
|---|---|---|
| `packages/msp-runtime/src/domain/*` | `packages/msp-core/src/domain/*` | Logic copied unchanged; package import paths only. |
| `packages/msp-runtime/src/contracts/*` | `packages/msp-contracts/src/contracts/*` | Depends on `msp-core` only for the existing ID/error vocabulary. |
| `docs/api/API-009-Persistent-Memory-Contract.md` | `docs/API-009-Persistent-Memory-Contract.md` | Frozen human-readable contract copy. |
| API-009 request contracts | `packages/msp-contracts/schemas/API-009.tools.json` | Machine-readable copy; not wired into runtime dispatch, so it cannot change behavior. |
| `packages/msp-runtime/src/db/connection.mjs` | `packages/msp-storage/src/db/connection.mjs` | Owns `better-sqlite3`. |
| `packages/msp-runtime/src/db/migrate.mjs` | `packages/msp-storage/src/db/migrate.mjs` | Migration runner copied unchanged except package path use. |
| `packages/msp-runtime/src/db/migrations/*.sql` | `migrations/*.sql` | Root repository owns the ordered migration set; SQL bytes remain unchanged. |
| `packages/msp-runtime/src/retrieval/*` | `packages/msp-retrieval/src/retrieval/*` | FTS/vector/fusion behavior copied unchanged. |
| `packages/msp-runtime/src/transport/*` | `apps/msp-server/src/transport/*` | NDJSON JSON-RPC/MCP-shaped stdio boundary. |
| `packages/msp-runtime/src/providers/*` | `apps/msp-server/src/providers/*` | MSP-owned GKS bridge; absence of configuration remains fail-closed. |
| `packages/msp-runtime/src/server.mjs` | `apps/msp-server/src/server.mjs` | Composition root; only package imports and migration location change. |
| `packages/msp-runtime/bin/msp-runtime.mjs` | `apps/msp-server/bin/msp-server.mjs` | Keeps the required `MSP_DB_PATH` fail-closed startup rule. |
| `packages/msp-runtime/vitest.config.mjs` | `vitest.config.mjs` | Preserves the source package's 30-second test/hook timeouts; include paths follow the new test layout. |
| `packages/govibe-core/src/msp-stdio-transport.mjs` | `packages/msp-client-js/src/msp-stdio-transport.mjs` | External process transport; Node built-ins only. |
| `packages/govibe-core/src/msp-client.mjs` | `packages/msp-client-js/src/msp-client.mjs` | Public external client. |
| `packages/govibe-core/src/authority-enforcement.mjs` | `packages/msp-client-js/src/authority-enforcement.mjs` | Required local dependency of `msp-client.mjs`; copied to keep the published client standalone. |
| `packages/govibe-core/src/gks-client.mjs` | Not extracted | GoVibe still imports this disabled compatibility shim, but it is not an MSP client dependency and remains owned by `govibe-core`. |

## Test mapping

| Target suite | Source tests |
|---|---|
| `tests/contract/` | `contract-conformance`, `dependency-boundaries`, `temporal-engine.parity`, `transport-fixture-parity`, `transport-framing-boundary` |
| `tests/security/` | Every `*.security.mjs` test plus vault ownership/scoping coverage |
| `tests/integration/` | Database migrations, entity CRUD/history, retrieval, vector degradation, links, context/replay, decay, promotion idempotency, GKS provider bridge, and role-column coverage |

Imports in copied tests may change only to address the new workspace package boundaries. Assertions and fixtures remain unchanged unless an API-009 tool has no existing conformance coverage; any added assertion must describe the frozen behavior rather than introduce a new behavior.

## Known source facts and gaps

- API-009 version `0.1.1+draft` documents nine `msp_memory_*` tools. The runtime also exposes the pre-existing context/vault/promotion surface governed by API-006. The standalone server preserves both surfaces plus diagnostic `msp_ping`.
- API-009 retains an historical amendment describing missing vault scoping, but the current source contains migrations and tests for WP-14. The extraction gate follows current executable evidence: the baseline security suite passed 30/30.
- `msp-client.mjs` is not actually a two-file island: it imports `buildBoundedGraphQuery` from `authority-enforcement.mjs`. That file is therefore copied into `msp-client-js` and recorded here rather than inlining or rewriting it.
- The configured GKS bridge permits `msp_knowledge_promote`; without a provider it fails closed with `gks_provider_unconfigured`. Shared `msp_memory_promote` remains fail-closed. Both behaviors must be tested separately.
- The `genesisrag17.v1` pipeline relay is a separate nine-tool surface. MSP authenticates exact source/worker runtime grants, validates nested scope and downstream envelopes, journals counts only, and owns no stage, payload, cursor, canonical decision, worker result, gate or publication state. The machine contract is `packages/msp-contracts/schemas/GENESISRAG17.tools.json`, with contract proof in `tests/contract/pipeline-relay.test.mjs` and scope/role proof in `tests/security/pipeline-vault-scoping.security.mjs`.
- Pipeline input parsing and raw lineage remain in zuri-ai stages 1–8; canonical decisions and quality remain in GKS; physical graph/vector/index writes and publication remain in the GenesisBlock worker and its DB. The Tier 4 query relay is the only pipeline operation that does not call GKS, and requires an explicit loopback worker origin and token.
- Cross-repository acceptance is pinned to zuri-ai commit [`b64b46df`](https://github.com/Freshair129/zuri.ai/commit/b64b46df057d3160c659afa3c34628ee86520257); the wire authority is the [`genesisrag17.v1` contract](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/plans/GENESISRAG17-CONTRACT.md).
- `Freshair129/msp` currently resolves through GitHub CLI to `Freshair129/cognitive_system`. No remote will be attached until repository identity is resolved without overwriting or repurposing that repository.
- Root migrations 0003 and 0005 rebuild tables (`CREATE ..._new`, `INSERT ... SELECT`, `DROP <table>`, `RENAME <table>_new TO <table>` -- the SAFE order documented in `docs/MIGRATION.md`, never the unsafe "rename the old table away" order) inside the plain `db.transaction(...)` path in `packages/msp-storage/src/db/migrate.mjs`, with `PRAGMA foreign_keys` left `ON` the whole time. Foreign-key risk during a rebuild depends on whether a CHILD row (a row in a table that references the table being rebuilt) exists -- not on rows within the rebuilt table itself, and not at all when nothing references it:
  - 0003 rebuilds `entities`, which by that point in the migration order `entity_history` (added in 0001) already references; that rebuild was at risk only if `entity_history` held rows (`embeddings` and `links` do not exist yet at 0003).
  - 0003 also rebuilds `promotions`, which no table ever references anywhere in the migration set -- its rebuild carried zero foreign-key risk regardless of row count. Its real guard is the NOT NULL `vault_id` backfill in 0003's own header comment (the `INSERT ... SELECT` supplies `NULL` for a pre-existing row, which a real row would reject on the NOT NULL constraint, unrelated to foreign keys).
  - 0005 rebuilds `entities` again, by which point both `entity_history` and `embeddings` (added in 0004) reference it; that rebuild was at risk if either held rows.
  All three rebuilds only worked in practice because the referencing tables were empty in every environment they ran in -- a real child row would have made `DROP TABLE` perform an implicit delete the still-enabled foreign keys refuse, throwing `FOREIGN KEY constraint failed` and rolling the migration back. None of the three files is edited to add the new `-- msp-migration: foreign-keys=off` directive; their checksums are lineage evidence per Gate A. `migrations/0008_thread_memory.sql` (TASK-MEMOS-002 stage 1) claimed migration number 0008 for the thread-memory tables instead: it is pure `CREATE TABLE`, not a rebuild, so it does not need the `foreign-keys=off` mode. The `docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md` `vaults` rebuild this note originally meant is unshipped and will need a later migration number and, when it lands, that `foreign-keys=off` mode (WP-E0); see `docs/MIGRATION.md`.

## Bugs found during extraction

### API-009 history entry shape is incomplete in the source runtime

API-009 defines `MemoryEntityHistoryEntry` as the complete `MemoryEntity` plus `version`. The current runtime's `msp_memory_history` response deliberately omits `lifecycle_state`, `decay_score`, `access_count`, and `current_version` because the `entity_history` schema does not store per-version values for those fields. The source handler already labels this as a documented gap. The extraction preserves that response exactly rather than fabricating values or changing the schema.

### Vector retrieval has no separate enable flag

The source runtime always constructs the optional bge-m3 client. Calls degrade to FTS when Ollama is unavailable, and callers opt into vector participation through search `mode`, but there is no distinct `MSP_VECTOR_ENABLED` feature flag. Adding one during extraction would change behavior, so this remains a recorded separation gap rather than an extraction-time fix.

### GitHub repository slug redirect was resolved during publish

Before publish, `gh repo view Freshair129/msp` resolved to `Freshair129/cognitive_system`, indicating a GitHub rename redirect. The exact `Freshair129/msp` repository was then created without changing or overwriting `cognitive_system`; `main` and `agent/extract-msp-runtime` were pushed and draft PR #1 was opened for review.

## Known gaps from the 2026-08-30 QA audit (design changes required, not test-only fixes)

The 2026-08-30 QA (GHOST) audit surfaced five findings. Three were closed the same day as test-only work (commit `3767738`: the GKS-bridge unconfigured case, a real `msp_memory_forget` attack case, an `msp_memory_links_list` proof, and the `msp_memory_upsert` attacker direction). The remaining two cannot be closed by adding tests, because the behavior they describe is what the current wire contract actually specifies — closing them changes the contract. They are recorded here so they stay visible until a design decision addresses them.

### Context tools perform no caller-ownership check

`msp_context_diff`, `msp_context_audit`, and `msp_context_replay` resolve any `context_id` by primary key and answer with that context's data regardless of who asks. The `actor` string on the request is journaled, never authorized against the stored context's `workspace_id`/`agent_id`.

Evidence:

- `apps/msp-server/src/transport/handlers/context-handlers.mjs:149` (`msp_context_diff`) — resolves `base_context_id`/`target_context_id` via `selectContext.get(...)` and returns `changed_refs` for any caller; with `include_payload: true` it returns both contexts' full `refs_json` payloads.
- `apps/msp-server/src/transport/handlers/context-handlers.mjs:191` (`msp_context_audit`) — returns journal findings and the hash-validity verdict for any `context_id`.
- `apps/msp-server/src/transport/handlers/context-handlers.mjs:247` (`msp_context_replay`) — replays any stored context by id.

A caller holding (or enumerating) another workspace's `context_id` can therefore read that workspace's resolved-context refs and journal trail. Contexts are keyed by `contextRef(randomUUID())` (`context-handlers.mjs:77`), so ids are unguessable in practice — the gap is the absence of an ownership rule, not a live enumeration path. Fixing it requires deciding what ownership means for these three tools' wire shapes (they carry `actor` but API-006/API-009 define no ownership semantics for it), which is a contract change, not a test.

### Evidence refs accept arbitrary un-namespaced strings

`msp_memory_promote` requires `evidence_refs` to be a non-empty array and rejects `gks:`-prefixed entries, but accepts any other string — `"trust me"` is valid evidence on the wire. The same applies to `source_memory_ref`, and to `msp_knowledge_promote`'s `provenance_ref`.

Evidence:

- `apps/msp-server/src/transport/handlers/lifecycle-handlers.mjs:204-214` — the only validation on `evidence_refs`/`source_memory_ref` is non-emptiness plus `requireNoGksRefs` (which rejects only the `gks:` namespace; see `packages/msp-contracts/src/contracts/namespace-guard.mjs:42`). No `msp:` namespace requirement, no check that a ref resolves to any stored record.
- `apps/msp-server/src/transport/handlers/lifecycle-handlers.mjs:56` — `msp_knowledge_promote`'s `provenance_ref` gets the same gks-only screening.

Promotion receipts can therefore be minted whose evidence chain points at nothing. Requiring namespaced (`msp:`-resolvable) evidence refs would reject requests today's contract documents as valid, so this too is a design decision, recorded rather than patched.

## better-sqlite3 13 on Node 24: two failure modes, and what each one was

Recorded 2026-09-12 on Windows 11, Node v24.19.0, npm 11.17.0. Both modes were
reproduced in a sibling worktree before anything was changed.

### Mode 1 — the pinned 11.10.0 aborts the runtime (exit 134)

`better-sqlite3` 11.10.0 publishes no `node-v137` prebuild, so `npm ci` compiles
it from source against the running Node's headers. Node 24.19.0 backported the
`node::ObjectWrap` cleanup hooks into the header-only `node_object_wrap.h`
without the global hook registry that makes removal safe with no live
`Environment`, so `~ObjectWrap()` calls
`RemoveEnvironmentCleanupHook(Isolate::GetCurrent())` and aborts whenever a
wrapped object is collected with no entered context
([nodejs/node#65446](https://github.com/nodejs/node/issues/65446); the v24
backport of the registry is open in
[nodejs/node#65943](https://github.com/nodejs/node/pull/65943), and 24.20/24.21
are unchanged). Any `Statement` finalization can therefore kill the MSP process:

```
node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr
  Statement::`scalar deleting destructor'
```

Observed as `MSP process exited with code 134` — nondeterministically, in
different tests on each run. This is upstream and not fixable in MSP; it is the
same finding, and the same remedy, as
[Genesis-Knowledge-System#9](https://github.com/Freshair129/Genesis-Knowledge-System/pull/9).

### Mode 2 — 12.x/13.x raise `SQLITE_IOERR_TRUNCATE`, and why that was MSP's bug

Upgrading removed the abort and exposed a race MSP's tests had always had.
Every failure landed on the same line — `open()` in
`packages/msp-storage/src/db/connection.mjs`, from the *test* process — with
`SqliteError: disk I/O error`, extended code `SQLITE_IOERR_TRUNCATE`.

The trigger is not the journal mode, the busy timeout, or any open option. An
isolated matrix (spawn a runtime that opens the database in WAL and writes,
then try to open it from a second process) isolates it to one window:

| When the second connection opens | 11.10.0 (SQLite 3.49.2) | 12.11.1 (3.53.2) | 13.0.3 (3.53.4) |
|---|---|---|---|
| while the runtime is alive | pass | pass | pass |
| after `child.kill()`, same synchronous turn | pass | **49/60 fail** | **42/60 fail** |
| after the child's `exit` event | pass | 0/60 fail | 0/60 fail |

`child.kill()` only asks the OS to terminate the process. Until the kernel has
finished tearing it down, the dying process still has the WAL index
(`<db>-shm`) memory-mapped. A connection opened inside that window takes the
WAL dead-man-switch lock, concludes it is the first connection, and truncates
`-shm` to zero to force a WAL-index rebuild — which Windows refuses while a
user-mapped section is open. A direct `ftruncate` on the same file from Node in
that window fails the same way (`UNKNOWN`, errno `-4094`, i.e.
`ERROR_USER_MAPPED_FILE`) while `<db>-wal` truncates fine, which is how the
`-shm` was identified as the file involved. SQLite 3.53.x surfaces that refusal;
3.49.2 did not, so the suite had been resting on the older library tolerating a
race that was always present.

The same window is what the tests' `try { rmSync(...) } catch {}` blocks —
commented "best-effort cleanup (Windows file-lock race on child process exit)"
— had been swallowing, and what
`tests/contract/api-009-conformance.test.mjs`'s `setTimeout(100)` plus
`maxRetries: 5` had been sleeping through.

### What was changed, and what deliberately was not

- `createMspStdioCaller`'s `close()` now returns a promise that resolves on the
  child's real `exit`. It is backward compatible: callers that ignore the
  return value behave exactly as before.
- Every test that reads a vault database from the test process, or deletes the
  directory holding it, awaits that promise. The two hand-rolled JSON-RPC
  harnesses (`canonical-candidate-rejection`, `shared-scope-fail-closed`) and
  `transport-framing-boundary` await their own `child.kill()` the same way.
- The best-effort `rmSync` swallows and the sleep-and-retry were removed rather
  than kept. With the exit awaited, cleanup must succeed on the first try, so
  those blocks now fail loudly if this contract ever regresses — which is how
  the two hand-rolled harnesses were found.
- `tests/contract/transport-close-lifecycle.test.mjs` pins the contract:
  reopening the same WAL database immediately after an awaited `close()`, ten
  times, with no retry and no sleep. Reverting `close()` to fire-and-forget
  fails all three of its cases.
- **`packages/msp-storage/src/db/connection.mjs` is unchanged.** `journal_mode
  = WAL`, `foreign_keys = ON` and `busy_timeout = 5000` all stay as they were.
  A retry around `open()` was considered and rejected: SQLite's busy handler
  does not cover `SQLITE_IOERR`, so a retry there would have to swallow a real
  error class to hide a race that is only reachable inside one synchronous turn
  after killing the process that owns the database. A restart by a supervisor
  cannot reach it — spawning a replacement process costs many event-loop turns —
  which is why `tests/integration/gks-provider-bridge.test.mjs`'s
  close-then-restart case passed throughout.

### Result on this machine

| Suite | 11.10.0 (before) | 13.0.3, no code change | 13.0.3 + this change |
|---|---|---|---|
| `vitest` contract + integration | 7 failed / 173 passed (180), 4 files | 6 failed / 174 passed (180), 2 files | **183 passed (183), 24 files** |
| `node --test` security | 2 failed / 31 passed (33) | 13 failed / 20 passed (33) | **33 passed (33)** |

The 11.10.0 numbers vary run to run — the abort is nondeterministic; the run
recorded here is one sample. The full suite was run five consecutive times on
the final tree, green every time.

## V8 `JSON.parse` non-first-key corruption on Node v24.19.0

Found by GHOST while fuzzing `apps/msp-server/src/config/thread-service-keyring.mjs`
(BL-MEMOS-049's optional per-tenant `MSP_THREAD_SERVICE_KEYRING`). Recorded
2026-09-15 on Windows 11, Node v24.19.0. RKOI then bisected the regression
and ruled it merge-blocking for TASK-MEMOS-002 stage 2 -- see "RKOI's
bisection and the transport-level rule" below for the runtime-wide fix.

### RKOI's bisection and the transport-level rule

RKOI traced the regression to a specific V8 range and assessed it across
the whole runtime, not just the keyring:

| Engine | Affected? |
|---|---|
| Node <= 22.23 (V8 <= 12.4-era) | Clean |
| Node 23 through at least 26.8 (V8 12.4-12.9 regression), including this workspace's Node 24.19.0 | Affected |

RKOI's characterization narrowed the trigger precisely: only a **non-first**
object key that contains an escape sequence, parsed AFTER an earlier parse
in the same process shared the same leading key(s), where that earlier key
was `X\` (i.e. the priming key itself ends in a backslash). The corrupted
key always comes back as that same `X\` -- literally, it always ends in a
backslash. Values, and a key in first position, are never affected.

**There is no isolation or authentication bypass.** Every scope decision
in this runtime reads VALUES, never a key, for its authorization check; a
corrupted key can never become a clean, matching identifier; and grant
corruption fails closed as an HMAC/signature mismatch. It still does real
damage, though: RKOI proved it on the real server (not just the keyring)
-- tenant A's `msp_memory_upsert` with `body_json {"-":K,"\\":K}` corrupts
a LATER, unrelated tenant B's own `msp_memory_upsert` with
`body_json {"-":K,"\"":K}`. The corrupted key (`\` instead of `"`) is what
gets PERSISTED and read back, inside tenant B's own vault -- a real,
if silent, data-corruption bug, and it also causes spurious grant and ajv
validation rejections wherever a corrupted key trips a schema or signature
check downstream.

**The rule.** Since the trigger cannot be reliably predicted or detected
after the fact (the "priming" parse can be any earlier, unrelated request
in the same long-lived process), the only reliable, engine-independent
mitigation is to never hand this engine's `JSON.parse` an object key that
needed an escape sequence at all, anywhere, regardless of position. Both
`apps/msp-server/src/transport/stdio-jsonrpc-server.mjs` (every inbound
request, every tool) and `packages/msp-client-js/src/msp-stdio-transport.mjs`
(every inbound response) now run a small, pure, engine-independent scanner
(`escaped-object-key-scan.mjs`, duplicated verbatim in the client package
so it stays dependency-free) over the RAW text and refuse, before the real
`JSON.parse` ever runs, any line whose object keys -- at any nesting depth
-- contain a backslash escape. Escapes inside VALUES remain fully allowed;
a literal, unescaped non-ASCII character in a key (Thai, emoji, anything
JSON never requires escaping) is not a "backslash escape" and is also
accepted, since `JSON.stringify` does not escape those by default and
ordinary user data must keep working.

V8's own `JSON.parse` has a real, reproducible engine bug: after one object
has been parsed, a LATER, differently-escaped object parsed in the SAME
process can come back with a corrupted **non-first** key name. Values are
never affected. The bug persists under `node --jitless` and disappears
after a garbage collection.

Minimal repro (`K` is any 32+ character placeholder string; run both
`JSON.parse` calls in the same process, in this order):

```js
JSON.parse('{"-":K,"\\":K}');   // priming call -- return value unused
JSON.parse('{"-":K,"\"":K}');  // second key comes back as \ instead of "
```

The second call's `Object.keys(...)[1]` is the single character `\`
(code point 92), not the expected `"` (code point 34) the source text
actually names. Both objects otherwise parse without throwing; only the
second object's second key is wrong.

**How it hit the keyring.** `parseThreadServiceKeyring` already had its own
independent, hand-rolled scanner (`scanTopLevelObjectEntries`) for tenant
ids — added earlier specifically because a duplicate top-level JSON key
cannot be detected from `JSON.parse`'s own return value at all (it silently
keeps only the last occurrence). But the parser still read each entry's
*value* by indexing the native `JSON.parse` result with a tenant id taken
from that scanner: `parsed[tenantId]`. When the native object's key had
been corrupted by this bug, that lookup silently missed (`undefined`),
which the parser's own `typeof key !== "string"` check then reported as a
false "entry N's key must be a string" refusal. This was always
**fail-closed** — a corrupted key can never make a wrong key verify a
grant, only refuse a valid start — but it was wrong, and GHOST's fuzz
harness measured 149 false refusals across 20,000 generated keyrings.

**Fix.** The keyring no longer depends on native `JSON.parse` object keys
*or values* at all. `scanTopLevelObjectEntries` now decodes each entry's
value the same way it already decoded each entry's tenant id, using its
own engine-independent string decoder for both. `JSON.parse(raw)`'s return
value is used only for two whole-document structural facts that do not
depend on any individual key's identity: that `raw` is syntactically valid
JSON, and that its top level is a non-null, non-array object. See
`apps/msp-server/src/config/thread-service-keyring.mjs`'s header comment
and `tests/contract/thread-service-keyring.test.mjs`'s "PRIMED regression"
case (which fails against the pre-fix implementation and passes against
the current one) for the full detail and proof.

### RKOI stage-2 revision: the scanner itself was recursive (CRITICAL, now fixed)

The transport-level scanner (`escaped-object-key-scan.mjs`, both copies)
that the rule above describes was originally implemented as a
RECURSIVE-descent walk (one JS function call per nesting level), and
`stdio-jsonrpc-server.mjs`'s `rl.on("line", ...)` handler called it with no
try/catch. A single ~40 KB line of ~20,000 nested arrays overflowed the
call stack (`RangeError: Maximum call stack size exceeded`), uncaught,
inside a synchronous readline callback -- the whole server process
crashed and never answered another request. The client's own stdout
listener had the identical gap, which would have crashed the *calling*
application on a sufficiently deep response line. Fixed two independent
ways in both copies: the scanner is now ITERATIVE (an explicit
array-based stack stands in for the JS call stack recursion used to
consume), and the function's own body is wrapped in try/catch so it can
only ever return a boolean, never throw -- any internal failure is
treated as a refusal. Key/value classification is unchanged (RKOI's own
20,000-case fuzz: 0 wrong classifications both before and after). See
`tests/security/transport-json-parse-hardening.security.mjs`'s and
`tests/integration/msp-client-escaped-key-scan.test.mjs`'s 100,000-depth
cases.

Two more fixes landed in the same revision, both about the boundary the
scan protects, not the scan itself:

- **GKS response frames** (`apps/msp-server/src/providers/
  gks-stdio-provider.mjs`) call the native `JSON.parse` on GKS's own
  response text in this same long-lived MSP process -- the identical risk
  the parent transport already defends against. Scanned the same way,
  refusing that one in-flight GKS request (`gks_provider_unavailable`,
  the existing provider error vocabulary) without touching MSP's own
  process; a fresh child is spawned per call, so this already fails
  closed for "that request only."
- **The client now also scans its own OUTGOING requests**
  (`msp-stdio-transport.mjs`'s `request()`), not only what the server
  sends back. Previously an escaped-key REQUEST built by the client's own
  caller would sit in `pending` until the full `timeoutMs` elapsed, since
  the server's `id: null` refusal can never be correlated back to a
  specific pending request. Refused synchronously now, before anything is
  written to the child's stdin.

**Accepted resource bound, not fixed (RKOI stage-2 revision round 2,
non-blocking).** The iterative rewrite above stops a pathologically deep
line from crashing the process, but it does not bound how much memory
scanning one costs: on pathologically deep input the scanner's own stack
array runs at roughly 13x the input line's byte length. Separately,
Node's `readline` interface that both the server and the client read
lines from has no maximum line length of its own -- an attacker (or a
misbehaving GKS child) controlling one side of the pipe can still make
the process buffer an arbitrarily large single line before the scanner
ever runs. Neither of these is fixed here: a max-line-length cap would
need its own typed refusal (and a real number to cap at, which is a
product decision, not an engineering default), so this is recorded as an
accepted limit rather than guessed at. Revisit if a concrete ceiling is
ever specified.

### Legacy stored data may already contain an escaped key

A row written to `entities`/`journal`/`protected_memory_records`
(`entity-store.mjs`, `journal.mjs`, `thread-memory.mjs`) or any other
JSON-bearing column **before** this scan existed can still carry a key
that needed an escape sequence -- the scan only ever protects requests
and responses at the transport boundary going forward; it cannot rewrite
data already on disk. Reading such a row back and echoing it in a
response would hand a client the exact line shape this whole defense
exists to refuse.

**Fix, server-side (the simpler of the two options RKOI offered).**
`stdio-jsonrpc-server.mjs`'s own `write(payload)` now scans every
OUTGOING line the same way, before it is ever written: if a stored value
would make a response's own object keys contain an escape sequence, the
server emits a typed `invalid_response` error for that response's `id`
instead of the real payload. This is simpler than a client-side "fail
that request only" fix would have been, because the server already knows
which `id` a response is for -- a client-side fix would first have to
extract an `id` out of the very raw, untrusted text it cannot yet safely
parse, which is the exact problem this whole scan exists to avoid. The
client's own pre-existing "kill the child" behavior on an inbound
escaped-key line (still present, as defense in depth for a non-MSP or
future server) is consequently unreachable in ordinary operation against
this server, since it now never emits such a line at all.

**Audit query.** To find whether any already-stored JSON in this
database might be affected, run (SQLite CLI or `better-sqlite3`). Column
and primary-key names below are checked against the real migrations
(`migrations/0001_init.sql`, `0002_phase2.sql`), not assumed:

```sql
SELECT 'entities.body_json' AS column, entity_id AS row_id FROM entities WHERE body_json LIKE '%\%'
UNION ALL
SELECT 'entity_history.body_json', history_id FROM entity_history WHERE body_json LIKE '%\%'
UNION ALL
SELECT 'journal.payload_json', journal_id FROM journal WHERE payload_json LIKE '%\%'
UNION ALL
SELECT 'protected_memory_records.body_json', record_id FROM protected_memory_records WHERE body_json LIKE '%\%'
UNION ALL
SELECT 'protected_memory_records.scope_json', record_id FROM protected_memory_records WHERE scope_json LIKE '%\%'
UNION ALL
SELECT 'state.value_json', state_key FROM state WHERE value_json LIKE '%\%';
```

`entity_history.body_json` is included because `msp_memory_history`
returns it directly to a caller -- the same read-back-and-echo risk as
`entities.body_json` itself, just reached through a different tool.
`state.value_json` is included for the same reason: it is arbitrary,
caller-shaped JSON, stored the same way.

RKOI verified against real SQLite that `LIKE '%\%'` does match a literal
backslash byte (`\` has no special meaning to `LIKE` itself, only `%`/`_`
do, so no `ESCAPE` clause is needed for this specific pattern). A hit
only means the column contains a literal backslash byte somewhere in the
text -- inside a JSON string VALUE, that is completely normal and
expected (e.g. `\n`, `\"`, a Windows path). It is **not**, by itself,
proof of an escaped object KEY (the actual risk this whole defense is
about); confirming that requires running each hit's text through
`containsEscapedObjectKey` (or the client's identical copy) directly.
This query is a cheap first-pass filter to shrink the set of rows worth
checking that way, not a final verdict on its own. No such row is
currently known to exist in this project's own data; this audit is
provided for whoever operates a deployment old enough to predate this fix
and wants to check for themselves.

**This is not a complete guarantee for legacy rows, even after the audit
finds nothing.** The `write()` refusal above only catches a response
whose text, AS STORED, still needs an escape to round-trip through
`JSON.parse`/`JSON.stringify` today. A legacy key that was ALREADY
corrupted by the V8 bug at write time -- e.g. a key that should have been
`aA` (sent on the wire as `a\u0041`, an escape that decodes to
a plain `A`) but was instead stored, by the same class of engine bug, as a
key that needs no escaping at all -- would round-trip cleanly through
`JSON.stringify` and never trip this scan; the response carrying it would
be emitted as normal, silently wrong. The scan can only ever catch a key
that STILL needs an escape by the time it is read back; it cannot detect
a key that was already silently corrupted into an unescaped one before
this fix existed. Running the audit query above and manually inspecting
(and, where necessary, repairing) any flagged row is the real remedy for
data written before this fix shipped -- the transport-level scan is a
going-forward defense, not a retroactive one.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.7b | 2026-09-15 | beta | RKOI stage-2 revision round 2 (APPROVED at `4d0df3c`, 0 critical; these are the owner-requested non-blocking follow-ups): `recordDelivery`'s internal `appendMessage` call now passes `scope.workspaceId`/the stored pending row's `workspace_id`, closing the last three journal entries (a resolved-path OUTBOUND message, a drain's OUTBOUND message, `reconcile_skipped`) that still recorded `workspace_id = tenant`; the legacy-data audit query gained `entity_history.body_json` (returned by `msp_memory_history`) and `state.value_json`, and this file and `docs/MIGRATION.md` now say plainly that the server's `write()` refusal is not a complete guarantee for legacy rows already corrupted into a key needing no escape; `ThreadMemoryStore#consumeNonce` now validates `grantExpiresAt` is a finite integer within +/-10 years of the server clock, refusing a raw, untyped `RangeError` from `1e20` or a negative value with the same typed `validation_failed` instead; added a NOTES line documenting the scanner's ~13x-line-size memory cost and `readline`'s lack of a line cap as an accepted, undocumented-no-longer resource bound. See "Accepted resource bound, not fixed" and the legacy-data audit section below, and the task's own final report for the finding-to-test map. | working-tree | KIN |
| 0.2.6b | 2026-09-15 | beta | RKOI stage-2 revision of the 0.2.5b/0.2.4b work (NEEDS REVISION, 1 critical): the transport-level escaped-object-key scanner was itself recursive and could crash the server (and, symmetrically, the calling app via the client) on a deeply nested line -- rewritten iterative with an explicit stack, wrapped so it can only ever refuse, never throw. Also: nonce `expires_at` now derives from `grant.expiresAt`, never a caller-suppliable business timestamp; the guard validates nonce type/length (1-128, untrimmed) with a typed `validation_failed`; the GKS provider and the client's own outgoing requests are scanned too; the server refuses to ever emit a response whose (possibly legacy) stored data would itself need an escaped key; journal `workspace_id` is `grant.workspaceId` and a mint's actor is `grant.agentId`, not the old placeholders; a resolve refused `agent_not_current` no longer bumps `threads.updated_at`; sweep consumes its nonce inside its own mutation's transaction. See "RKOI stage-2 revision" below and the task's own report for the full finding-to-test map. | working-tree | KIN |
| 0.2.5b | 2026-09-15 | beta | TASK-MEMOS-002 stage 2 multi-agent complete on `feat/memos-002-stage2-multi-agent` (BL-MEMOS-040..048/112, per docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md v0.4.3b, RKOI-approved spec): migration 0009 (`thread_agents`, `grant_nonces`, per-agent record visibility columns) landed its writers/readers -- required `agentId`/`workspaceId`/`nonce` grant claims (DEC-MEMOS-17 hard cutover, no compatibility mode), the agent gate on every thread-bound tool, mint-race-safe attachment, delivery's own agent scoping (CRITICAL 1), per-agent protected-record visibility with unified supersession refusals (CRITICAL 2), and replay-nonce bookkeeping. `tests/cross/zuri-thread-contract.test.mjs` rewritten in full: zuri-ai's real, unmodified adapter is now refused `grant_signature_invalid` at its very first call, proven against the actual adapter source, plus a shape-only case proving MSP's responses still satisfy every shape check that adapter performs once the three new claims are added to the same wire requests. `packages/msp-client-js` needed no change (grant contents are opaque to it) and was not bumped. Full details and the GATE-MEMOS-3/§15 test mapping are in the task's own final report. | working-tree | KIN |
| 0.2.4b | 2026-09-15 | beta | RKOI ruling (merge-blocking), fixed on `feat/memos-002-stage2-multi-agent`: bisected the V8 `JSON.parse` non-first-key corruption to a real engine regression (V8 12.4-12.9; Node <=22.23 clean, Node 23 through at least 26.8 affected) and proved it reaches real storage on the real server (one tenant's `msp_memory_upsert` body can corrupt a later, unrelated tenant's own upsert body, persisted and read back inside that tenant's own vault). Added a transport-level, engine-independent raw-text scanner refusing any inbound line whose object keys (any depth, every tool) contain an escape sequence, before the real `JSON.parse` runs -- `apps/msp-server/src/transport/stdio-jsonrpc-server.mjs` on the server and `packages/msp-client-js/src/msp-stdio-transport.mjs` on the client (duplicated scanner, client stays dependency-free). See "RKOI's bisection and the transport-level rule" above. | working-tree | KIN |
| 0.2.3b | 2026-09-15 | beta | GHOST QA finding, fixed on `feat/memos-002-stage2-multi-agent`: V8's `JSON.parse` has a real engine bug on Node v24.19.0 (a later, differently-escaped object parsed in the same process can come back with a corrupted non-first key name; values are unaffected). `thread-service-keyring.mjs`'s `parseThreadServiceKeyring` used to read a value via `parsed[tenantId]` on the native `JSON.parse` result, which a corrupted key made miss silently, false-refusing an otherwise-valid keyring (149/20,000 in GHOST's fuzz) -- always fail-closed, never a wrong key. The keyring no longer depends on native `JSON.parse` key OR value content at all; see "V8 `JSON.parse` non-first-key corruption on Node v24.19.0" above. | working-tree | KIN |
| 0.2.2b | 2026-09-14 | beta | RKOI code review round 2 revision (`feat/memos-002-thread-memory`): corrects the 0.2.1b row below -- under this workspace's non-strict npm 11.17, neither `npm approve-scripts` nor an interactive `npm install` prompt is "the actual gate"; an unlisted package's install script simply runs with a notice, nothing blocks it. Also closed the round-2 CRITICAL (a signed grant omitting `externalRoomRef` skipped the room-hash check entirely instead of being refused), added DEC-MEMOS-16 (a resolve naming a different `channel_type` than an existing ACTIVE thread's binding is a typed conflict, never the other channel's thread), and folded further schema/error-text fixes into the still-unshipped `migrations/0008_thread_memory.sql`. | working-tree | KIN |
| 0.2.1b | 2026-09-14 | beta | Removed root `package.json`'s `allowScripts.better-sqlite3@13.0.3` entry (added earlier in this same stage to unblock a local `npm install`): npm 10 on Node 22 ignores `allowScripts` entirely, and this workspace's npm 11.17 treats it as non-strict (an unlisted package's script still runs with a warning, it does not block); the pinned-version key also goes stale the next time `better-sqlite3` bumps a patch. `npm approve-scripts` or an interactive `npm install` prompt remains the actual gate — corrected in 0.2.2b below: this claim is false under this workspace's npm. | working-tree | JANUS |
| 0.2.0b | 2026-09-14 | beta | TASK-MEMOS-002 stage 1: folded the unmerged `origin/codex/msp-thread-memory` thread-memory design onto `main` as a single new `migrations/0008_thread_memory.sql` (nothing past `0007` had shipped), fixed C-1 (a second person could read a DIRECT thread) and C-2 (`msp-contracts` reading the database directly), closed W1/W5/W6/W7/W10, and folded in RKOI's post-implementation review: tenant-scoped consistency triggers, append-only participants with a lifetime one-HUMAN-per-DIRECT-thread invariant, a partial-unique ACTIVE-only channel binding (relink-ready), tombstone-only redaction triggers, a `keyFor(tenantId)` grant-verification hook, and typed `thread_audience_mismatch`/`record_subject_mismatch`/`compaction_lease_conflict`/`grant_*` error codes. Renamed API-010 (reserved for `msp_vault_resolve`) to API-011. Multi-agent (`agentId`, `thread_agents`, per-agent visibility) is stage 2, pending a separate ADR. | working-tree | KIN |
| 0.1.9b | 2026-09-13 | beta | RKOI review revision: corrected the 0003/0005 claim -- foreign-key risk during a rebuild depends on child rows referencing the table, not rows within it; named exactly which of 0003's two rebuilds (`entities`, at risk from `entity_history`; `promotions`, at zero risk, guarded instead by its NOT NULL `vault_id` backfill) and 0005's rebuild (`entities` again, at risk from `entity_history` and `embeddings`) carried real risk, and confirmed both used the safe rebuild order. | working-tree | JANUS |
| 0.1.8b | 2026-09-13 | beta | Recorded that root migrations 0003 and 0005 rebuilt child tables inside the transaction with foreign keys left on, which only worked because those tables were empty everywhere they ran, and that the design's 0008 (a `vaults` rebuild) is the first migration that needs the new `foreign-keys=off` runner mode (WP-E0, `docs/MIGRATION.md`). | working-tree | JANUS |
| 0.1.7b | 2026-09-12 | beta | Recorded both Node 24.19 SQLite failure modes: the upstream `ObjectWrap` abort on `better-sqlite3` 11.x, and the `SQLITE_IOERR_TRUNCATE` WAL-index race that 12.x/13.x expose in tests that open a vault database while a killed runtime is still tearing down. Fixed by making `close()` await the child's real exit; storage pragmas unchanged. | working-tree | Claude Opus 5 |
| 0.1.6b | 2026-09-08 | beta | Recorded the complete GenesisRAG17 relay boundary, source/worker grants, query loopback, code/test proof and pinned cross-repository acceptance. | working-tree | ATHER |
| 0.1.5b | 2026-09-07 | beta | Added `msp_knowledge_evidence_export`, the relay of GKS's `gks_stage_evidence_export` for zuri-ai's evidence pull (`docs/TIER-BOUNDARY-17-STAGE.md` 0.2.0b): provider method, validated page, journal, fail-closed without a provider; reference fixture and bridge cases. The two 2026-08-30 QA design gaps above are unchanged. | working-tree | Claude Fable 5.1 |
| 0.1.4b | 2026-08-30 | beta | Recorded QA-audit known gaps (context-tool caller ownership, evidence-ref namespacing) alongside the same audit's test-only closures. | 3767738 | KIN |
| 0.1.3b | 2026-08-12 | beta | Recorded successful exact-slug repository creation and draft review publication. | 04f48f6 | ATHER |
| 0.1.2b | 2026-08-12 | beta | Finalized implementation commit metadata. | 394a176 | ATHER |
| 0.1.1b | 2026-08-12 | beta | Added source gaps, publish identity risk, and preserved test-runner mapping. | 394a176 | ATHER |
| 0.1.0b | 2026-08-12 | beta | Initial inventory, mapping, invariants, and baseline evidence. | 394a176 | ATHER |

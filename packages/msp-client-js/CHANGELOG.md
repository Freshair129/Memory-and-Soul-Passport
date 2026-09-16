# Changelog

## 0.2.7 (release candidate, unpublished)

- Forward `MSP_GLOBAL_PRIVATE_GRANT_REQUIRED`, `MSP_IDENTITY_HMAC_KEY_VERSION`
  and `MSP_IDENTITY_HMAC_KEYRING` to the child runtime for the approved
  principal/global grant and erasure-receipt contracts.
- The generic stdio caller supports the three Phase 6 tools without changing
  its public call interface. Phase 6 authorization is enforced by the server.
- Package validation is a local dry-run; no npm publication is implied.

## 0.2.6

- `MSP_THREAD_RETENTION_DAYS` is forwarded to the MSP child (added to
  `MSP_RUNTIME_ENV_NAMES`; PH-MEMOS-4, `msp_thread_retention_tick`,
  `BL-MEMOS-054`). It is optional and opt-in: unset or `0`, the tick is a
  documented, always-callable no-op that mutates nothing and returns
  all-zero counts, never refused. Once set to a positive integer, it is
  the single deployment-wide age horizon (in days) `msp_thread_retention_tick`
  tombstones content past, for every tenant that calls it. Never journaled
  or echoed back to a caller, same as the other thread-memory deployment
  ceilings (`MSP_THREAD_IDLE_TIMEOUT_MINUTES`/`MSP_THREAD_RECENT_EXCHANGES`).

## 0.2.5

RKOI stage-2 revision (NEEDS REVISION, 1 critical) of the 0.2.4 defense:

- **CRITICAL fix:** the escaped-object-key scanner (`src/escaped-object-key-scan.mjs`)
  was recursive (one JS function call per nesting level). A sufficiently
  deep response line (RKOI's probe used 100,000 levels of nesting) could
  overflow the call stack inside this client's own stdout listener,
  crashing the CALLING application, not just this client's child process.
  The scanner is now iterative (an explicit stack, not the JS call
  stack) and its own body is wrapped so it can only ever return a
  boolean -- never throw -- regardless of what it encounters.
- **New:** `request()` now also scans its own OUTGOING request before
  writing it to the child's stdin, throwing a typed error immediately.
  Previously an escaped-key request built by this client's own caller
  would sit pending until the full `timeoutMs` elapsed, since the
  server's `id: null` refusal of such a line can never be correlated
  back to a specific pending request.
- Key/value classification is unchanged (RKOI's own 20,000-case fuzz: 0
  wrong classifications, before and after).

## 0.2.4

- Refuses, before parsing, any inbound MSP response whose object keys (at
  any nesting depth) contain a backslash escape sequence -- both the raw
  response line and the `content[].text` JSON.parse fallback used when
  `structuredContent` is absent. RKOI ruling (merge-blocking): V8's own
  `JSON.parse` has a real engine bug (Node 23 through at least 26.8,
  including this workspace's 24.19) that can hand a caller a corrupted
  non-first object key after an earlier parse in the same long-lived
  process shared the same leading key(s). Escapes inside VALUES, and a
  literal (unescaped) non-ASCII character in a key, are unaffected and
  remain accepted. See `docs/NOTES.md` for the finding and
  `apps/msp-server/src/transport/escaped-object-key-scan.mjs`'s header
  comment (this package carries a deliberate, byte-for-byte duplicate --
  see `src/escaped-object-key-scan.mjs` -- to stay dependency-free).

## 0.2.3

- `MSP_THREAD_SERVICE_KEYRING` is forwarded to the MSP child (added to
  `MSP_RUNTIME_ENV_NAMES`; BL-MEMOS-049, stage 2). It is optional and
  opt-in: unset, thread-tool grants keep verifying against the single
  `MSP_THREAD_SERVICE_KEY` exactly as before. Once set (a JSON object of
  `{"<tenantId>": "<key>"}`, every key >= 32 characters), the single key is
  disabled for every tenant with no fallback -- a grant for a tenant
  missing from the keyring fails closed with `grant_unconfigured`, the same
  as an unresolvable single key. Never journaled or echoed back to a
  caller, same as the other two thread-memory secrets.

## 0.2.2

- `MSP_THREAD_SERVICE_KEY` and `MSP_IDENTITY_HMAC_KEY` are forwarded to the
  MSP child (added to `MSP_RUNTIME_ENV_NAMES`), along with
  `MSP_THREAD_IDLE_TIMEOUT_MINUTES` and `MSP_THREAD_RECENT_EXCHANGES`. The
  first two are API-011 thread memory's grant-signing and identity-hashing
  secrets (`docs/API-011-THREAD-MEMORY-CONTRACT.md`); without a resolvable
  service key the thread-tool surface fails closed with `grant_unconfigured`
  (never running unauthenticated), and without the identity key it fails
  closed with `identity_hmac_unconfigured` (never storing a raw channel
  reference). Neither key is ever journaled or echoed back to a caller.
  `MSP_TEST_CLOCK` is deliberately not forwarded here -- see the README.

## 0.2.1

- `NODE_EXTRA_CA_CERTS` is forwarded to the MSP child. Without it a child cannot
  verify an HTTPS endpoint issued by a private CA, and MSP's one outbound call —
  the embedding request to `OLLAMA_BASE_URL` — degrades to FTS-only with a
  diagnostic instead of failing, so the missing certificate showed up as quietly
  worse search results.
- Node floor raised to 22, matching the MSP server it starts (better-sqlite3 13
  declares the same floor).
- `close()` now ends the child's stdin before killing it and resolves once the
  child has exited. The old `close()` returned `undefined` and killed
  immediately, so a caller that reopened MSP's database straight afterwards
  raced a process that still held its write-ahead log.

## 0.2.0

**Breaking.** The MSP child is spawned with an allowlisted environment instead
of a copy of the caller's `process.env`.

Before this, `createMspStdioCaller` passed its `env` straight to `spawn()` and
defaulted to `process.env`, so the child inherited everything the host held —
production database URLs, chat-platform credentials, model API keys, and
`NODE_OPTIONS`, which a host could use to load arbitrary code into the MSP
child.

The child now receives only the variables MSP reads, the `GKS_*` namespace it
must pass on to a GKS child, and the OS basics a Node process needs to start.
Filtering applies to an explicitly-passed `env` as well as to the default.

**If you relied on another variable reaching the MSP child, it no longer
arrives.** Add its name to `MSP_RUNTIME_ENV_NAMES` or `MSP_OS_ENV_NAMES` in this
package. `buildMspChildEnv`, `MSP_RUNTIME_ENV_NAMES` and `MSP_OS_ENV_NAMES` are
exported so you can see what crosses.

## 0.1.0

Initial standalone client: stdio transport, API-009 tool surface, runtime
authority enforcement.

# Changelog

## 0.2.2

- `MSP_THREAD_SERVICE_KEY` and `MSP_IDENTITY_HMAC_KEY` are forwarded to the
  MSP child (added to `MSP_RUNTIME_ENV_NAMES`). These are API-011 thread
  memory's grant-signing and identity-hashing secrets
  (`docs/API-011-THREAD-MEMORY-CONTRACT.md`); without them the thread-tool
  surface fails closed (`thread_scope_denied` / `identity_hmac_unconfigured`)
  rather than running unauthenticated or storing a raw channel reference.
  Neither key is ever journaled or echoed back to a caller.

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

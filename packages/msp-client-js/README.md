# @freshair129/msp-client-js

Node.js client for the Mission State Protocol (MSP) stdio runtime. It starts an
MSP server as a child process, speaks NDJSON JSON-RPC to it, and exposes the
API-009 tool surface.

```js
import { createMspClientFromEnvironment } from "@freshair129/msp-client-js";

const client = createMspClientFromEnvironment(process.env);
```

Configuration is read from the environment: `GOVIBE_MSP_COMMAND` (required — no
command, no client), `GOVIBE_MSP_ARGS` (JSON array of strings) and
`GOVIBE_MSP_CWD`. The MSP server itself requires `MSP_DB_PATH`; it refuses to
start without one rather than choosing a database path for you.

## The child environment is an allowlist

**This is the behaviour most likely to surprise you.** The MSP child is not
given your process environment. It is given exactly:

- `MSP_RUNTIME_ENV_NAMES` — the thirteen variables the MSP server reads:
  `MSP_DB_PATH`, `MSP_GKS_COMMAND`, `MSP_GKS_ARGS`, `MSP_GKS_CWD`,
  `MSP_PIPELINE_PRINCIPALS`, `MSP_GKS_PIPELINE_CREDENTIAL`,
  `MSP_PIPELINE_WORKER_URL`, `MSP_PIPELINE_WORKER_TOKEN`, `OLLAMA_BASE_URL`,
  `MSP_THREAD_SERVICE_KEY`, `MSP_IDENTITY_HMAC_KEY` (API-011 thread-memory
  secrets — see `docs/API-011-THREAD-MEMORY-CONTRACT.md` — never journaled
  or echoed back to a caller), and `MSP_THREAD_IDLE_TIMEOUT_MINUTES` /
  `MSP_THREAD_RECENT_EXCHANGES` (API-011 per-deployment ceilings). The
  server also reads `MSP_TEST_CLOCK`, but that one is deliberately **not**
  in this allowlist: it is read only at the server's own composition root,
  never by a client-spawned child's caller, so a caller can never steal or
  extend a lease by lying about the time.
- any variable named `GKS_*` — MSP does not read these, but must pass them to
  the GKS child it may spawn in turn
- `MSP_OS_ENV_NAMES` — the OS basics a Node child needs to start, plus
  `NODE_EXTRA_CA_CERTS`

Names are matched without case (Windows spells them `Path` and `SystemRoot`)
and copied under the spelling you used. `NODE_OPTIONS` is deliberately excluded:
it can load arbitrary code into the child.

The filter applies to an `env` you pass explicitly as well as to the default.
The host that starts MSP typically holds database URLs, chat-platform
credentials and model API keys that MSP has no use for; a denylist would only
withhold what someone remembered to name.

To see exactly what crosses, or to check a name before relying on it:

```js
import { buildMspChildEnv, MSP_RUNTIME_ENV_NAMES, MSP_OS_ENV_NAMES } from "@freshair129/msp-client-js";

console.log(Object.keys(buildMspChildEnv(process.env)));
```

If your deployment needs a variable that is not on either list, add it to the
list in this package rather than working around the filter.

## Shutting down

`call.close()` ends the child's stdin so the server can finish and close its
database cleanly, and returns a promise that resolves once the child has
actually exited. Await it before touching the MSP database file from your own
process — a killed child leaves its write-ahead log behind for a moment, and
reopening the file in that window races it.

## Requirements

Node 22 or newer.

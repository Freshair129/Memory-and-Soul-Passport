import { spawn } from "node:child_process";

import { containsEscapedObjectKey } from "./escaped-object-key-scan.mjs";

function encode(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

/**
 * Every variable the MSP server itself reads, from MSP's own source:
 *   MSP_DB_PATH                    apps/msp-server/bin/msp-server.mjs
 *   MSP_GKS_COMMAND/_ARGS/_CWD     apps/msp-server/src/providers/gks-stdio-provider.mjs
 *   MSP_PIPELINE_*, MSP_GKS_PIPELINE_CREDENTIAL
 *                                  apps/msp-server/src/transport/handlers/pipeline-handlers.mjs
 *   OLLAMA_BASE_URL                packages/msp-retrieval/src/retrieval/vector.mjs
 *   MSP_THREAD_SERVICE_KEY         apps/msp-server/src/server.mjs (API-011 thread-tool grant HMAC)
 *   MSP_THREAD_SERVICE_KEYRING     apps/msp-server/src/config/thread-service-keyring.mjs (BL-MEMOS-049,
 *                                  optional per-tenant grant HMAC keys; disables MSP_THREAD_SERVICE_KEY
 *                                  entirely for every tenant once set)
 *   MSP_IDENTITY_HMAC_KEY          apps/msp-server/src/server.mjs (API-011 room-ref/journal-actor HMAC)
 *   MSP_GLOBAL_PRIVATE_GRANT_REQUIRED
 *                                   apps/msp-server/src/server.mjs (PH-MEMOS-5 global-private gate)
 *   MSP_IDENTITY_HMAC_KEY_VERSION  apps/msp-server/src/config/identity-hmac-keyring.mjs (BL-MEMOS-076 active receipt-key generation)
 *   MSP_IDENTITY_HMAC_KEYRING      apps/msp-server/src/config/identity-hmac-keyring.mjs (BL-MEMOS-076 retired receipt-key generations)
 *   MSP_THREAD_IDLE_TIMEOUT_MINUTES, MSP_THREAD_RECENT_EXCHANGES
 *                                  apps/msp-server/src/server.mjs (API-011 per-deployment ceilings)
 *   MSP_THREAD_RETENTION_DAYS     apps/msp-server/src/server.mjs (PH-MEMOS-4,
 *                                  msp_thread_retention_tick's deployment-wide
 *                                  horizon; absent or 0 is a documented no-op)
 *
 * Neither MSP_THREAD_SERVICE_KEY, MSP_THREAD_SERVICE_KEYRING, nor
 * MSP_IDENTITY_HMAC_KEY is ever journaled or echoed back to a caller (see
 * docs/API-011-THREAD-MEMORY-CONTRACT.md). MSP_TEST_CLOCK is deliberately
 * NOT in this list -- it is read only at apps/msp-server/src/server.mjs's
 * own composition root, never by a client-spawned child's caller (RKOI
 * review, WARNING 6 / item 12).
 */
export const MSP_RUNTIME_ENV_NAMES = Object.freeze([
  "MSP_DB_PATH",
  "MSP_GKS_COMMAND",
  "MSP_GKS_ARGS",
  "MSP_GKS_CWD",
  "MSP_PIPELINE_PRINCIPALS",
  "MSP_GKS_PIPELINE_CREDENTIAL",
  "MSP_PIPELINE_WORKER_URL",
  "MSP_PIPELINE_WORKER_TOKEN",
  "OLLAMA_BASE_URL",
  "MSP_THREAD_SERVICE_KEY",
  "MSP_THREAD_SERVICE_KEYRING",
  "MSP_IDENTITY_HMAC_KEY",
  "MSP_GLOBAL_PRIVATE_GRANT_REQUIRED",
  "MSP_IDENTITY_HMAC_KEY_VERSION",
  "MSP_IDENTITY_HMAC_KEYRING",
  "MSP_THREAD_IDLE_TIMEOUT_MINUTES",
  "MSP_THREAD_RECENT_EXCHANGES",
  "MSP_THREAD_RETENTION_DAYS",
]);

/**
 * What a Node child needs from the OS to start and to spawn its own child:
 * command lookup, temp and home directories, the Windows system paths libuv
 * and OpenSSL resolve through, and locale/time zone. No credentials, no
 * proxies, and no NODE_OPTIONS — that one can load code into the child.
 */
export const MSP_OS_ENV_NAMES = Object.freeze([
  "PATH", "PATHEXT",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TZ",
  // A file path, not a secret. Without it an MSP child cannot verify an HTTPS
  // endpoint issued by a private CA — and the one outbound call MSP makes,
  // the embedding request to OLLAMA_BASE_URL, never throws on failure: it
  // degrades to FTS-only with a diagnostic. Withholding this turns a
  // configuration problem into silently worse search results.
  "NODE_EXTRA_CA_CERTS",
]);

const ALLOWED_ENV_NAMES = new Set([...MSP_RUNTIME_ENV_NAMES, ...MSP_OS_ENV_NAMES].map((name) => name.toUpperCase()));

/**
 * The environment an MSP child is spawned with: the allowlisted names above,
 * plus GKS's own `GKS_*` namespace, which MSP does not read itself but must
 * receive in order to pass on to the GKS child it spawns (that hop applies the
 * same rule again — apps/msp-server/src/providers/gks-stdio-provider.mjs).
 *
 * Names are matched without case and copied as the caller spelled them:
 * Windows environment names are case-insensitive and arrive as `Path` or
 * `SystemRoot`, so an exact-case match would silently drop them.
 *
 * This is an allowlist, not a denylist, because the host that starts MSP —
 * zuri-ai's server and edge apps today — holds production database URLs, chat
 * platform credentials and model API keys that MSP has no use for. A denylist
 * withholds only what someone remembered to name; anything added to the host's
 * environment later would reach MSP by default.
 */
export function buildMspChildEnv(env = process.env) {
  const childEnv = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    const upper = name.toUpperCase();
    if (ALLOWED_ENV_NAMES.has(upper) || upper.startsWith("GKS_")) childEnv[name] = value;
  }
  return childEnv;
}

export function createMspStdioCaller({ command, args = [], cwd, env = process.env, timeoutMs = 15000 }) {
  if (!command) throw new Error("MSP command is required.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("MSP timeoutMs must be a positive number.");

  const child = spawn(command, args, { cwd, env: buildMspChildEnv(env), stdio: ["pipe", "pipe", "pipe"], shell: false });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let initialized;
  let stderrTail = "";
  let closed = false;
  // `closed` means "this transport will accept no further requests"; `exited`
  // means the OS process is actually gone. They are not the same instant, and
  // close() has to resolve on the second one -- see its comment below.
  let exited = false;
  const pending = new Map();

  function failPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(newline + 1);
      if (!line.trim()) continue;

      // RKOI ruling (merge-blocking): the same V8 JSON.parse engine bug
      // that can corrupt an object key on the server side (see
      // escaped-object-key-scan.mjs's header comment) applies equally to
      // this long-lived client process parsing the server's own
      // responses. Refuse before the real JSON.parse ever runs, for every
      // pending request -- there is no way to know, without parsing, which
      // request this response was even for.
      if (containsEscapedObjectKey(line)) {
        const scanError = new Error("MSP returned a response whose object keys contain escape sequences (refused before parsing).");
        failPending(scanError);
        child.kill();
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const parseError = new Error(`MSP returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
        failPending(parseError);
        child.kill();
        return;
      }

      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
  });

  child.on("error", (error) => failPending(error));
  child.on("exit", (code) => {
    closed = true;
    exited = true;
    failPending(new Error(`MSP process exited with code ${code}.${stderrTail ? ` ${stderrTail.trim()}` : ""}`));
  });

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("MSP process is closed."));
    const id = nextId++;
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    // RKOI review (stage-2 revision, WARNING 5): the client used to scan
    // only what the SERVER sent back, never its own outgoing requests. The
    // server already refuses (id: null) any inbound line shaped like this,
    // but that refusal can never be correlated back to THIS request (no id
    // to match against `pending`) -- the caller previously just waited out
    // the full `timeoutMs` before learning anything was wrong. Scanned and
    // refused here instead, synchronously, before anything is written to
    // the child's stdin, so the caller learns immediately.
    if (containsEscapedObjectKey(text)) {
      throw new Error(`${method} request contains object keys with escape sequences (refused before sending).`);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MSP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(Buffer.from(`${text}\n`, "utf8"));
    });
  }

  async function ensureInitialized() {
    if (!initialized) {
      initialized = request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "govibe-core", version: "0.1.0" },
      }).then(() => child.stdin.write(encode({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })));
    }
    await initialized;
  }

  const call = async (name, input) => {
    await ensureInitialized();
    const result = await request("tools/call", { name, arguments: input });
    const text = result?.content?.find((item) => item.type === "text")?.text;
    if (result?.isError) throw new Error(text ?? `${name} failed.`);
    if (result?.structuredContent === undefined && text) {
      // The same pre-scan as the inbound-line check above, applied to this
      // SEPARATE JSON.parse call on the embedded `content[].text` fallback
      // -- `structuredContent` (already covered, since it is part of the
      // one line already scanned in the `child.stdout` handler above) is
      // absent here, so this text is about to be parsed independently.
      if (containsEscapedObjectKey(text)) {
        throw new Error(`${name} response text contains object keys with escape sequences (refused before parsing).`);
      }
    }
    return result?.structuredContent ?? (text ? JSON.parse(text) : {});
  };

  /**
   * Shut the runtime down and resolve once the OS process is actually gone.
   *
   * Awaiting the exit is not politeness. `child.kill()` only asks the OS to
   * terminate the process; until the kernel has finished tearing it down, the
   * dying process still holds its SQLite WAL index (`<db>-shm`) memory-mapped.
   * A connection opened against the same database inside that window takes the
   * WAL dead-man-switch lock, concludes it is the first connection, and
   * truncates `-shm` to zero to force a WAL-index rebuild -- which Windows
   * refuses while a user-mapped section is open, surfacing as
   * `SqliteError: disk I/O error` (`SQLITE_IOERR_TRUNCATE`). SQLite 3.53.x
   * (better-sqlite3 12/13) reports that refusal; 3.49.2 (better-sqlite3 11)
   * did not, which is why the race only became visible on the upgrade.
   *
   * Callers that touch the database file -- or delete the directory holding it
   * -- after shutting a runtime down must await this.
   *
   * @returns {Promise<void>} resolves when the child process has exited.
   */
  call.close = () => {
    closed = true;
    failPending(new Error("MSP transport closed."));
    if (exited) return Promise.resolve();
    const settled = new Promise((resolve) => {
      child.once("exit", () => resolve());
      // A process that never spawned emits "error" and no "exit"; resolving
      // here keeps close() from hanging on that path.
      child.once("error", () => resolve());
    });
    child.kill();
    return settled;
  };
  return call;
}

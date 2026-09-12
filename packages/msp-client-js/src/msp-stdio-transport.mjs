import { spawn } from "node:child_process";

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
    failPending(new Error(`MSP process exited with code ${code}.${stderrTail ? ` ${stderrTail.trim()}` : ""}`));
  });

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("MSP process is closed."));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MSP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
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
    return result?.structuredContent ?? (text ? JSON.parse(text) : {});
  };

  call.close = () => {
    closed = true;
    failPending(new Error("MSP transport closed."));
    child.kill();
  };
  return call;
}

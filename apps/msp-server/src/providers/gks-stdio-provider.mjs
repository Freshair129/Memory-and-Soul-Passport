// MSP-owned client for the configured GKS MCP stdio provider. It is separate
// from the parent transport boundary even though this installed MCP SDK uses
// the same newline-delimited JSON-RPC framing on both links.
import { spawn } from "node:child_process";
import { GksProviderUnavailableError } from "@freshair129/msp-contracts/errors";

function parseArgs(value) {
  if (!value) return [];
  try {
    const args = JSON.parse(value);
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new Error();
    return args;
  } catch {
    throw new GksProviderUnavailableError("gks_provider_unavailable: MSP_GKS_ARGS must be a JSON array of strings.");
  }
}

// OS/runtime basics a Node child process needs to start and behave normally
// (paths, temp dirs, home/profile dirs, shell, locale, timezone) on both
// Windows and POSIX — the same OS set zuri-ai's own MSP spawn allowlist
// passes. None of these carry application secrets, so they are safe to
// forward unconditionally.
//
// Stored upper-case and matched case-insensitively by whole name (never by
// prefix): Windows environment names are case-insensitive and arrive in
// whatever casing the parent used — Node's own process.env says
// `SystemRoot`/`Path`/`windir`, while zuri-ai's allowlist names them
// `SYSTEMROOT`/`PATH`/`WINDIR` — so an exact-case match would silently drop
// them.
const OS_BASIC_ENV_KEYS = new Set([
  "PATH", "PATHEXT",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TZ",
]);

// Every GKS child spawn (pipeline relay, promote, stage-evidence export)
// gets an environment built from this explicit allowlist, never a copy of
// MSP's own process.env. MSP's own environment arrives from its caller
// (zuri-ai's web server today passes its ENTIRE environment on to MSP) and
// can carry production database URLs, chat-platform credentials and model
// API keys that have no business reaching a GKS child. zuri-ai is fixing its
// side separately; MSP must not rely on that fix.
//
// Besides the OS basics above, only variables in GKS's own configuration
// namespace are forwarded: anything named `GKS_*`, matching the standalone
// GKS server's own environment reads (Freshair129/Genesis-Knowledge-System,
// apps/gks-server/src/server.mjs and packages/gks-contracts/src/resolution.mjs):
//   GKS_DB_PATH                    - required, GKS's own SQLite path
//   GKS_DEFAULT_PORTFOLIO_ID       - optional service default
//   GKS_AUTOMERGE_FLOOR            - optional auto-merge policy floor
//   GKS_PIPELINE_RELAY_CREDENTIAL  - optional; GKS verifies the relayCredential
//     carried in the request payload (built by pipeline-handlers.mjs from
//     MSP_GKS_PIPELINE_CREDENTIAL) against THIS value in its own environment.
//     MSP_GKS_PIPELINE_CREDENTIAL itself is never forwarded as an env var —
//     it travels only inside the signed request payload.
// None of MSP's own secrets (MSP_PIPELINE_PRINCIPALS, MSP_GKS_PIPELINE_CREDENTIAL,
// MSP_PIPELINE_WORKER_TOKEN, GENESIS_WORKER_QUERY_TOKEN, MSP_DB_PATH, or
// anything else outside these two groups) is named `GKS_*`, so the prefix
// rule excludes them by construction — this keeps the credential-stripping
// behaviour the old pipeline-only `pipelineEnv` blocklist had, and now
// applies the same rule to every GKS spawn, not just the pipeline relay.
export function buildGksChildEnv(env) {
  const childEnv = {};
  for (const key of Object.keys(env)) {
    if (OS_BASIC_ENV_KEYS.has(key.toUpperCase()) || key.startsWith("GKS_")) childEnv[key] = env[key];
  }
  return childEnv;
}

export function createGksProviderFromEnvironment(env = process.env) {
  const command = env.MSP_GKS_COMMAND?.trim();
  if (!command) return null;
  const cwd = env.MSP_GKS_CWD?.trim() || undefined;
  const args = parseArgs(env.MSP_GKS_ARGS);
  const gksChildEnv = buildGksChildEnv(env);
  return {
    async pipelineCall(suffix, request) {
      if (!["submit", "claim", "graph_receipt", "write_receipt", "gate", "publication_receipt", "stage_failure", "evidence"].includes(suffix)) throw unavailable("unsupported pipeline operation");
      return callGksTool({ command, args, cwd, env: gksChildEnv }, `gks_pipeline_${suffix}`, request);
    },
    async promote(candidate) {
      return callGksTool({ command, args, cwd, env: gksChildEnv }, "gks_knowledge_promote", candidate);
    },
    // The one read-only tool MSP relays for zuri-ai's evidence pull
    // (GKS ADR-GKS-LEDGER-REPORTING D2, Option B): zuri-ai -> MSP ->
    // gks_stage_evidence_export. MSP owns no stage and no cursor; it carries
    // the caller's scope envelope through and the page back, unchanged.
    async exportStageEvidence(request) {
      return callGksTool({ command, args, cwd, env: gksChildEnv }, "gks_stage_evidence_export", request);
    },
  };
}

function encode(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function unavailable(message) {
  return new GksProviderUnavailableError(`gks_provider_unavailable: ${message}`);
}

async function callGksTool({ command, args, cwd, env }, toolName, input) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let buffer = Buffer.alloc(0);
  let stderrTail = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    pending.clear();
  }

  function close() {
    if (closed) return;
    closed = true;
    child.kill();
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(unavailable(`GKS request timed out: ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
    });
  }

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const body = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        const error = unavailable("GKS returned malformed NDJSON.");
        rejectPending(error);
        close();
        return;
      }
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) continue;
      pending.delete(message.id);
      clearTimeout(pendingRequest.timeout);
      if (message.error) pendingRequest.reject(unavailable(message.error.message ?? "GKS returned an MCP error."));
      else pendingRequest.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2048); });
  child.on("error", (error) => rejectPending(unavailable(error.message)));
  child.on("exit", (code) => {
    if (!closed) rejectPending(unavailable(`GKS process exited with code ${code}.${stderrTail ? ` ${stderrTail.trim()}` : ""}`));
  });

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "govibe-msp-runtime", version: "0.1.0" },
    });
    child.stdin.write(encode({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
    const result = await request("tools/call", { name: toolName, arguments: input });
    if (result?.isError) {
      const text = result.content?.find((item) => item.type === "text")?.text;
      throw unavailable(text ?? "GKS tool returned an error.");
    }
    return result?.structuredContent ?? {};
  } finally {
    close();
  }
}

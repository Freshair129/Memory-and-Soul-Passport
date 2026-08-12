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

export function createGksProviderFromEnvironment(env = process.env) {
  const command = env.MSP_GKS_COMMAND?.trim();
  if (!command) return null;
  const cwd = env.MSP_GKS_CWD?.trim() || undefined;
  const args = parseArgs(env.MSP_GKS_ARGS);
  return {
    async promote(candidate) {
      return callGksTool({ command, args, cwd, env }, "gks_knowledge_promote", candidate);
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

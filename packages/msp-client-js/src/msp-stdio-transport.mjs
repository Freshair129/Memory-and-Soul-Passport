import { spawn } from "node:child_process";

function encode(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

export function createMspStdioCaller({ command, args = [], cwd, env = process.env, timeoutMs = 15000 }) {
  if (!command) throw new Error("MSP command is required.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("MSP timeoutMs must be a positive number.");

  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
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

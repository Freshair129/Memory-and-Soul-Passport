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

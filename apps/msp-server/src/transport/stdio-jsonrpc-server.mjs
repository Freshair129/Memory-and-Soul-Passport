// Newline-delimited JSON-RPC 2.0 stdio server.
//
// Wire contract (verified against the real consumer, not just the docs):
//   packages/govibe-core/src/msp-stdio-transport.mjs's createMspStdioCaller
//   sends `${JSON.stringify(payload)}\n` on stdin and expects the same
//   framing back on stdout: `{jsonrpc:"2.0", id, method, params}` requests,
//   `{jsonrpc:"2.0", id, result}` / `{jsonrpc:"2.0", id, error:{code,message}}`
//   responses, one JSON object per line.
//
// This is readline-based, NDJSON framing. It deliberately does NOT implement
// or require a length-prefixed header of the kind LSP-style transports use
// -- that is the *different*, unrelated framing
// `scripts/mcp/govibe-mcp-server.mjs` uses for its own inbound server (see
// packages/msp-runtime/test/transport-framing-boundary.test.mjs, AC-02).
// The two transports share no framing code path.
import readline from "node:readline";

function encodeLine(payload) {
  return `${JSON.stringify(payload)}\n`;
}

/**
 * @param {object} options
 * @param {import("./tool-registry.mjs").ToolRegistry} options.toolRegistry
 * @param {{name:string,version:string}} [options.serverInfo]
 * @param {string} [options.protocolVersion]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 */
export function createStdioJsonRpcServer({
  toolRegistry,
  serverInfo = { name: "msp-runtime", version: "0.1.0" },
  protocolVersion = "2024-11-05",
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!toolRegistry || typeof toolRegistry.dispatch !== "function") {
    throw new TypeError("createStdioJsonRpcServer requires a toolRegistry with a dispatch(name, args) method.");
  }

  function write(payload) {
    output.write(encodeLine(payload));
  }

  function success(id, result) {
    write({ jsonrpc: "2.0", id, result });
  }

  function failure(id, message, code = -32000) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handleMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      failure(null, "Malformed JSON-RPC message: expected a JSON object.", -32600);
      return;
    }

    const { id, method, params } = message;

    // Notifications carry no id and never get a response, per the JSON-RPC
    // 2.0 spec and per createMspStdioCaller's own handshake, which fires
    // this and does not wait for a reply.
    if (method === "notifications/initialized") {
      return;
    }

    if (method === "initialize") {
      success(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo,
      });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const result = await toolRegistry.dispatch(name, args);
        success(id, result);
      } catch (error) {
        // Unknown tool name and handler failures both land here. Per WP-12,
        // this is reported as a *tool-call* error (isError:true inside a
        // normal JSON-RPC success envelope), not a JSON-RPC protocol-level
        // error -- distinct from the "unsupported method" case below.
        const text = error instanceof Error ? error.message : String(error);
        success(id, {
          isError: true,
          content: [{ type: "text", text }],
          structuredContent: { code: -32601, message: text },
        });
      }
      return;
    }

    // Any other method name is unsupported at the protocol level.
    failure(id ?? null, `Unsupported method: ${method}`, -32601);
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      // Malformed JSON on a line must never crash the process. There is no
      // id to correlate a response to, so we respond with a parse error
      // carrying id:null (mirroring packages/govibe-core/test/fixtures/reference-msp-server.mjs's
      // convention) and keep reading subsequent lines.
      failure(null, `Malformed JSON: ${error instanceof Error ? error.message : String(error)}`, -32700);
      return;
    }

    void handleMessage(message).catch((error) => {
      // Defensive: handleMessage() catches tools/call handler failures
      // internally. This guards against any unexpected failure in the
      // dispatch path itself so the process still never crashes.
      const text = error instanceof Error ? error.message : String(error);
      failure(message && typeof message === "object" ? (message.id ?? null) : null, text, -32000);
    });
  });

  function close() {
    rl.close();
  }

  return { close, rl };
}

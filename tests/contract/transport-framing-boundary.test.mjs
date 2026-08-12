// AC-02: the wire format is confirmed distinct from and non-conflicting
// with the Content-Length/LSP framing used by
// scripts/mcp/govibe-mcp-server.mjs's inbound server -- no shared framing
// code path, no accidental protocol bleed-through.
//
// This is intentionally NOT a *.security.mjs file. WP-12 asks for a
// judgment call on whether this belongs under the repo's `node --test
// *.security.mjs` convention (used for adversarial/attack-surface tests --
// injection, auth bypass, etc.) or as a regular vitest test. This is a
// protocol/wire-format assertion, not a security-vulnerability class check,
// so it stays a regular vitest test alongside the rest of this packet's
// tests, run by `npm test` (vitest run). See the final report for the full
// reasoning.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const sourceDirs = [
  path.join(packageRoot, "apps", "msp-server", "src"),
  path.join(packageRoot, "packages", "msp-core", "src"),
  path.join(packageRoot, "packages", "msp-contracts", "src"),
  path.join(packageRoot, "packages", "msp-client-js", "src"),
  path.join(packageRoot, "packages", "msp-retrieval", "src"),
  path.join(packageRoot, "packages", "msp-storage", "src"),
];
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-framing-test-"));
  tempDirs.push(dir);
  return path.join(dir, "msp.sqlite3");
}

describe("AC-02: wire framing boundary vs Content-Length/LSP framing", () => {
  it("no standalone runtime source file ever mentions Content-Length framing", () => {
    for (const file of sourceDirs.flatMap(collectSourceFiles)) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/Content-Length/i);
    }
  });

  it("the transport module frames with node:readline (newline-delimited), not a length-prefixed reader", () => {
    const transportSource = readFileSync(
      path.join(packageRoot, "apps", "msp-server", "src", "transport", "stdio-jsonrpc-server.mjs"),
      "utf8",
    );
    expect(transportSource).toMatch(/readline/);
    expect(transportSource).not.toMatch(/Content-Length/i);
  });

  it("behaviorally: two JSON-RPC requests sent back-to-back on one write, with no Content-Length header anywhere, are each answered as their own newline-delimited line", async () => {
    const dbPath = tempDbPath();
    const child = spawn(process.execPath, [binPath], {
      env: { ...process.env, MSP_DB_PATH: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex;
      // eslint-disable-next-line no-cond-assign
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) lines.push(line);
      }
    });

    try {
      const initializeRequest = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "framing-test", version: "0" } },
      })}\n`;
      const toolCallRequest = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "msp_ping", arguments: {} },
      })}\n`;

      // Written as one payload, with no Content-Length header anywhere: if
      // the server expected length-prefixed framing, it could not correctly
      // split these two messages apart.
      child.stdin.write(initializeRequest + toolCallRequest);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for two NDJSON responses.")), 8000);
        const poll = setInterval(() => {
          if (lines.length >= 2) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve();
          }
        }, 20);
      });

      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.startsWith("Content-Length")).toBe(false);
        // Each line must parse as a standalone JSON object -- proof of
        // newline-delimited framing, not length-prefixed framing (which
        // would not split cleanly on "\n" this way).
        const parsed = JSON.parse(line);
        expect(parsed.jsonrpc).toBe("2.0");
      }

      const initializeResponse = JSON.parse(lines[0]);
      const toolCallResponse = JSON.parse(lines[1]);
      expect(initializeResponse.result.protocolVersion).toBe("2024-11-05");
      expect(toolCallResponse.result.structuredContent).toEqual({ ok: true, timestamp: expect.any(String) });
    } finally {
      child.kill();
    }
  });
});

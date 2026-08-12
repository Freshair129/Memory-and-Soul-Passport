// AC-01: packages/msp-runtime/server.mjs starts as a child process and
// responds to at least one newline-delimited JSON-RPC 2.0 request over
// stdio, verified by BOTH the existing reference fixture (sanity baseline
// for the client itself) AND a real-process test spawning our OWN
// bin/msp-runtime.mjs through createMspStdioCaller -- the real consumer
// client packages/govibe-core/src/msp-stdio-transport.mjs exports.
//
// This is THE MOST IMPORTANT TEST in the whole packet: a wire-framing
// mismatch here would silently corrupt or misinterpret every later phase
// built on top of this transport.
//
// createMspStdioCaller is reached across from ../../govibe-core/src via a
// relative import, not a package.json dependency -- there is no existing
// precedent in this repo for a packages/* package declaring
// "@govibe/core": "file:../govibe-core" as a devDependency (checked: no
// package.json under packages/ references govibe-core at all), and
// packages/msp-runtime must not become import-coupled to govibe-core at
// runtime (ADR-027 only sanctions the process-spawn boundary). This is a
// test-only reach-across proving wire parity against the real client, the
// same category of exception WP-12 explicitly grants the temporal-engine
// parity test for scripts/mcp/temporal-versioning.mjs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createMspStdioCaller } from "@freshair129/msp-client-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const referenceFixture = path.join(packageRoot, "tests", "fixtures", "reference-msp-server.mjs");

const openCallers = [];
const tempDirs = [];

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-transport-test-"));
  tempDirs.push(dir);
  return path.join(dir, "msp.sqlite3");
}

afterEach(() => {
  while (openCallers.length) openCallers.pop().close();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("AC-01: MSP runtime transport parity", () => {
  it("sanity baseline: createMspStdioCaller round-trips against the existing reference fixture", async () => {
    const call = createMspStdioCaller({ command: process.execPath, args: [referenceFixture], timeoutMs: 10_000 });
    openCallers.push(call);

    const result = await call("msp_vault_status", { workspace_id: "workspace-reference" });
    expect(result.workspace_ref).toBe("msp:workspace/reference");
  });

  it("starts packages/msp-runtime/bin/msp-runtime.mjs as a real child process and round-trips initialize + tools/call over newline-delimited JSON-RPC 2.0", async () => {
    const dbPath = tempDbPath();
    const call = createMspStdioCaller({
      command: process.execPath,
      args: [binPath],
      env: { ...process.env, MSP_DB_PATH: dbPath },
      timeoutMs: 10_000,
    });
    openCallers.push(call);

    const result = await call("msp_ping", {});
    expect(result).toEqual({ ok: true, timestamp: expect.any(String) });
  });

  it("real process: an unknown tool name surfaces as a tool-call error, not a crash", async () => {
    const dbPath = tempDbPath();
    const call = createMspStdioCaller({
      command: process.execPath,
      args: [binPath],
      env: { ...process.env, MSP_DB_PATH: dbPath },
      timeoutMs: 10_000,
    });
    openCallers.push(call);

    await expect(call("msp_definitely_not_a_real_tool", {})).rejects.toThrow(/Unknown tool/i);

    // The process must still be alive and answer a subsequent, valid call.
    const result = await call("msp_ping", {});
    expect(result.ok).toBe(true);
  });
});

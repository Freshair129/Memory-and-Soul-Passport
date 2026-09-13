// createMspStdioCaller's close() contract: it resolves only after the runtime
// process has actually exited, not merely after the kill request was sent.
//
// This is a storage-safety contract, not a politeness one. A dying process
// keeps its SQLite WAL index (`<db>-shm`) memory-mapped until the OS finishes
// tearing it down. A connection opened against the same database inside that
// window takes the WAL dead-man-switch lock, concludes it is the first
// connection, and truncates `-shm` to zero to force a WAL-index rebuild --
// which Windows refuses while a user-mapped section is open, surfacing as
// `SqliteError: disk I/O error` (SQLITE_IOERR_TRUNCATE). SQLite 3.53.x
// (better-sqlite3 12/13) reports that refusal; 3.49.2 (better-sqlite3 11) did
// not, so the whole test suite silently depended on the older library
// tolerating a race that was always there.
//
// Against an un-awaited close() on better-sqlite3 13.0.3 / Node 24.19.0 the
// reopen below fails roughly two runs in three; with the exit awaited it is
// deterministic. Every MSP test that reads the vault database from the test
// process, or deletes the directory holding it, rests on this contract.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function spawnRuntime() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-close-lifecycle-test-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "msp.sqlite3");
  const call = createMspStdioCaller({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, MSP_DB_PATH: dbPath },
    timeoutMs: 15_000,
  });
  return { call, dbPath };
}

// One registration is enough to guarantee the runtime has opened the database
// in WAL mode and written to it, so the -wal/-shm sidecars actually exist.
async function touchDatabase(call, workspaceId) {
  await call("msp_workspace_register", {
    actor: "boss",
    workspace_id: workspaceId,
    project_id: null,
    workspace_path: `/workspace/${workspaceId}`,
  });
}

describe("createMspStdioCaller close() lifecycle", () => {
  it("returns a promise", async () => {
    const { call } = spawnRuntime();
    await touchDatabase(call, "ws-close-returns-promise");
    const settled = call.close();
    expect(typeof settled?.then).toBe("function");
    await settled;
  });

  it("resolves late enough that the same WAL database can immediately be reopened from this process", async () => {
    // Looped: a single pass would pass by luck often enough to be worthless as
    // a regression test for a race.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { call, dbPath } = spawnRuntime();
      await touchDatabase(call, `ws-close-reopen-${attempt}`);
      await call.close();

      // No retry, no sleep, no swallow: this must work on the first try.
      const db = open(dbPath);
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM vaults").get().count).toBeGreaterThanOrEqual(1);
      } finally {
        db.close();
      }
    }
  });

  it("resolves rather than hanging when the runtime has already exited, and is safe to call twice", async () => {
    const { call } = spawnRuntime();
    await touchDatabase(call, "ws-close-twice");
    await call.close();
    await expect(call.close()).resolves.toBeUndefined();
  });
});

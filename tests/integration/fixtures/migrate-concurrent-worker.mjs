// Fixture worker for tests/integration/migrate-concurrent.test.mjs: waits
// for a barrier file to appear (so every process spawned by the test races
// as tightly as possible against every other one), then opens its OWN
// connection to the shared database path and calls `runMigrations` against
// it, exactly like a real MSP server cold start would. Reports the outcome
// as one JSON line on stdout, so the parent test can assert on the EXACT
// error shape (never a raw, unprefixed SqliteError) rather than only on the
// process exit code.
import { existsSync } from "node:fs";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";

const [, , dbPath, migrationsDir, barrierFile] = process.argv;

// Intentionally a tight busy-poll, not a timer-based sleep: this fixture
// only runs for a few milliseconds total, and the whole point is for every
// spawned process to notice the barrier file as close to simultaneously as
// the OS scheduler allows, to race as hard as possible against the others.
function busyPoll(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // no-op
  }
}

while (!existsSync(barrierFile)) {
  busyPoll(1);
}

let db;
try {
  db = open(dbPath);
  const result = runMigrations(db, migrationsDir);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      appliedCount: result.appliedCount,
      currentVersion: result.currentVersion,
    })}\n`,
  );
  process.exitCode = 0;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      pid: process.pid,
      name: error && error.name,
      code: error && error.code,
      message: error && error.message,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  if (db) db.close();
}

// Real multi-PROCESS coverage of the concurrent cold-start migration race
// (RKOI review): two -- or, here, up to eight -- separate OS processes
// calling `runMigrations` against the SAME fresh SQLite database file at
// (as close to) the same instant as possible used to have every loser but
// one fail with a raw, unprefixed SqliteError (`UNIQUE constraint failed:
// schema_migrations.version`, `table "<t>" already exists`, or a bare
// `SQLITE_BUSY` "database is locked", depending on exactly which statement
// lost the race). `tests/integration/migrate.test.mjs` cannot exercise this
// at all -- everything there runs single-process, single-connection, and
// this race does not exist within one process (better-sqlite3's API is
// synchronous, so nothing there can interleave). This file spawns real
// child processes instead.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { open, openLock } from "@freshair129/msp-storage/connection";
import { runMigrations, SchemaVersionError } from "@freshair129/msp-storage/migrate";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "fixtures", "migrate-concurrent-worker.mjs");
const rootMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function tempRunDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-migrate-concurrent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The same filename filter migrate.mjs's own MIGRATION_FILE_PATTERN applies
// (`/^(\d{4})_.*\.sql$/`), sorted the same way `loadMigrationFiles` sorts
// (lexicographic on the name, which sorts numerically here because the
// version prefix is zero-padded to 4 digits) -- this is the actual pending
// set for `rootMigrationsDir` on THIS checkout, not a count fixed at
// whatever it happened to be when this test was written (RKOI review: a
// hard-coded 7 broke the moment a cherry-pick target added 0008/0009).
// Every assertion below that cares how many root migrations exist, or what
// their version numbers are, is derived from this instead of a literal.
function rootMigrationFileNames() {
  return readdirSync(rootMigrationsDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

function rootMigrationVersions() {
  return rootMigrationFileNames().map((name) => Number(name.slice(0, 4)));
}

// Spawns `n` copies of the fixture worker, all pointed at the SAME fresh
// `dbPath`/`migrationsDir`, all blocked on the same barrier file, then drops
// the barrier once every child has had a moment to reach its poll loop.
// Resolves with each child's exit code and parsed stdout line.
async function raceMigrations({ n, migrationsDir, dbPath }) {
  const barrierFile = path.join(path.dirname(dbPath), `barrier-${Math.random().toString(36).slice(2)}`);

  const children = [];
  for (let i = 0; i < n; i++) {
    const child = spawn(process.execPath, [workerPath, dbPath, migrationsDir, barrierFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    children.push(
      new Promise((resolve) => {
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      }),
    );
  }

  // Give every child time to reach its busy-poll loop before dropping the
  // barrier, so they race as tightly as possible instead of trickling in.
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(barrierFile, "go", "utf8");

  const raw = await Promise.all(children);
  return raw.map(({ code, stdout, stderr }) => {
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    let parsed = null;
    try {
      parsed = line ? JSON.parse(line) : null;
    } catch {
      parsed = null;
    }
    return { code, parsed, stdout, stderr };
  });
}

function setupMigrationsDir(files) {
  const dir = path.join(tempRunDir(), "migrations");
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

describe("db/migrate concurrent cold start (multi-process)", () => {
  it(
    "N=6 real OS processes racing to cold-start migrate the same fresh database file all succeed exactly once -- no raw SqliteError, one schema_migrations row per migration, checksums intact, schema correct",
    async () => {
      const runDir = tempRunDir();
      const dbPath = path.join(runDir, "race.sqlite3");

      const results = await raceMigrations({ n: 6, migrationsDir: rootMigrationsDir, dbPath });

      // Every process exits 0 -- a concurrent loser either found nothing
      // left to do (appliedCount 0) or, if it happened to win the race for
      // one of the migrations, applied it -- never a raw driver error.
      for (const { code, parsed, stderr } of results) {
        expect(stderr, "no uncaught exceptions on stderr").toBe("");
        expect(parsed, "worker must print one JSON line").not.toBeNull();
        expect(parsed.ok, `expected ok:true, got: ${JSON.stringify(parsed)}`).toBe(true);
        expect(code).toBe(0);
      }

      // Across all 6 processes, every root migration was applied exactly
      // once in total (not once per process, not zero times).
      const expectedVersions = rootMigrationVersions();
      const expectedNewestVersion = expectedVersions[expectedVersions.length - 1];
      const totalApplied = results.reduce((sum, { parsed }) => sum + parsed.appliedCount, 0);
      expect(totalApplied).toBe(expectedVersions.length);
      for (const { parsed } of results) {
        expect(parsed.currentVersion).toBe(expectedNewestVersion);
      }

      // schema_migrations has EXACTLY one row per migration version, with
      // checksums matching the on-disk files (a duplicate-insert race would
      // have shown up as a UNIQUE constraint failure well before this point,
      // but re-verify the end state is exactly right regardless).
      const db = open(dbPath);
      cleanups.push(() => db.close());
      const rows = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
      const migrationFileNames = rootMigrationFileNames();
      expect(rows).toHaveLength(migrationFileNames.length);
      expect(rows.map((row) => row.version)).toEqual(expectedVersions);
      for (const row of rows) {
        const fileName = migrationFileNames.find((name) => name.startsWith(`${String(row.version).padStart(4, "0")}_`));
        expect(fileName, `migration file for version ${row.version}`).toBeTruthy();
        const sql = readFileSync(path.join(rootMigrationsDir, fileName), "utf8");
        expect(row.checksum).toBe(sha256(sql));
        expect(row.name).toBe(fileName);
      }
      expect(db.pragma("user_version", { simple: true })).toBe(expectedNewestVersion);

      // The schema itself is correct, not just the bookkeeping table --
      // spot-check the same tables/columns migrate.test.mjs checks for a
      // single-process run.
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
            "('entities','entity_history','vaults','vault_mounts','contexts','journal','state','promotions','embeddings','links')",
        )
        .all();
      expect(tables).toHaveLength(10);
      const ftsRows = db.prepare("SELECT name FROM sqlite_master WHERE name = 'entities_fts'").all();
      expect(ftsRows).toHaveLength(1);
    },
    30000,
  );

  it(
    "covers the foreign-keys=off directive path under concurrency too -- a directive migration commits exactly once, foreign_keys is restored, and no process sees a raw error",
    async () => {
      const migrationsDir = setupMigrationsDir({
        "0001_parent.sql": "CREATE TABLE parent (id TEXT PRIMARY KEY);",
        "0002_directive.sql": [
          "-- msp-migration: foreign-keys=off",
          "CREATE TABLE unrelated_under_directive (id INTEGER PRIMARY KEY);",
        ].join("\n"),
      });
      const dbPath = path.join(tempRunDir(), "race-directive.sqlite3");

      const results = await raceMigrations({ n: 5, migrationsDir, dbPath });

      for (const { code, parsed, stderr } of results) {
        expect(stderr).toBe("");
        expect(parsed).not.toBeNull();
        expect(parsed.ok, `expected ok:true, got: ${JSON.stringify(parsed)}`).toBe(true);
        expect(code).toBe(0);
      }

      const totalApplied = results.reduce((sum, { parsed }) => sum + parsed.appliedCount, 0);
      expect(totalApplied).toBe(2);

      const db = open(dbPath);
      cleanups.push(() => db.close());
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      // connection.mjs always opens with foreign_keys ON; the directive
      // path must restore exactly that once its migration commits.
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'unrelated_under_directive'").all(),
      ).toHaveLength(1);
    },
    30000,
  );

  it(
    "refuses with a typed migration_concurrent_conflict: error, never a raw SqliteError, when the lock genuinely cannot be acquired in time",
    () => {
      const migrationsDir = setupMigrationsDir({ "0001_a.sql": "CREATE TABLE t1 (id INTEGER PRIMARY KEY);" });
      const dbPath = path.join(tempRunDir(), "stuck-lock.sqlite3");
      const db = open(dbPath);
      cleanups.push(() => db.close());

      // Simulate "waiting is impossible": hold the SAME dedicated lock file
      // migrate.mjs itself uses (documented in docs/MIGRATION.md as
      // `<dbPath>.migrate-lock`) open and never release it -- exactly what a
      // holder that crashed mid-migration without releasing its OS file lock
      // would leave behind.
      const lockPath = `${dbPath}.migrate-lock`;
      const stuckHolder = openLock(lockPath, 5000);
      stuckHolder.exec("BEGIN IMMEDIATE");
      cleanups.push(() => {
        try {
          stuckHolder.exec("ROLLBACK");
        } catch {
          // already closed by the test below in the success path
        }
        stuckHolder.close();
      });

      // A short lockTimeoutMs so this test does not have to wait out the
      // real default (DEFAULT_LOCK_TIMEOUT_MS, 30s) to prove the refusal.
      expect(() => runMigrations(db, migrationsDir, { lockTimeoutMs: 200 })).toThrow(SchemaVersionError);
      expect(() => runMigrations(db, migrationsDir, { lockTimeoutMs: 200 })).toThrow(
        /^migration_concurrent_conflict:.*did not finish within 200ms/s,
      );

      // Nothing was applied while the lock was stuck -- the migration's own
      // SQL never even had a chance to run, and `applyPendingMigrations`
      // (which creates `schema_migrations` in the first place) was never
      // reached at all, since the failure happens while still waiting to
      // acquire the lock, before that function is ever called.
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't1'").all()).toEqual([]);

      // Releasing the lock lets a normal call through immediately -- the
      // earlier refusals did not corrupt anything.
      stuckHolder.exec("ROLLBACK");
      stuckHolder.close();
      const result = runMigrations(db, migrationsDir);
      expect(result.appliedCount).toBe(1);
    },
    15000,
  );

  it(
    "is not flaky across 20 independent concurrent cold starts (N=4 processes each, real root migrations)",
    async () => {
      const ITERATIONS = 20;
      const loopResults = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const runDir = tempRunDir();
        const dbPath = path.join(runDir, "race.sqlite3");
        const results = await raceMigrations({ n: 4, migrationsDir: rootMigrationsDir, dbPath });

        const allOk = results.every(({ code, parsed }) => code === 0 && parsed && parsed.ok === true);
        const totalApplied = results.reduce((sum, { parsed }) => sum + (parsed ? parsed.appliedCount : 0), 0);

        let rowCount = null;
        let checksumsOk = null;
        if (allOk) {
          const db = open(dbPath);
          try {
            const rows = db.prepare("SELECT version, checksum, name FROM schema_migrations ORDER BY version").all();
            rowCount = rows.length;
            checksumsOk = rows.every((row) => {
              const sql = readFileSync(path.join(rootMigrationsDir, row.name), "utf8");
              return row.checksum === sha256(sql);
            });
          } finally {
            db.close();
          }
        }

        loopResults.push({ iteration: i + 1, allOk, totalApplied, rowCount, checksumsOk });
      }

      // Evidence for the DevOps report: print the full per-iteration outcome.
      // eslint-disable-next-line no-console
      console.log("migrate-concurrent 20-iteration loop result:", JSON.stringify(loopResults, null, 2));

      for (const iterationResult of loopResults) {
        expect(iterationResult.allOk, `iteration ${iterationResult.iteration} had a process fail`).toBe(true);
        expect(iterationResult.totalApplied, `iteration ${iterationResult.iteration} applied count`).toBe(expectedCount);
        expect(iterationResult.rowCount, `iteration ${iterationResult.iteration} schema_migrations row count`).toBe(
          expectedCount,
        );
        expect(iterationResult.checksumsOk, `iteration ${iterationResult.iteration} checksums`).toBe(true);
      }
    },
    120000,
  );
});

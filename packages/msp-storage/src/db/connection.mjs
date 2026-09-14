// better-sqlite3 connection factory. This is the only module allowed to
// import "better-sqlite3" (dependency-boundaries.test.mjs enforces that
// domain/ and transport/ never reach into db/'s implementation, only its
// exported functions).
import Database from "better-sqlite3";

// Found while reproducing the concurrent-cold-start migration race (see
// migrate.mjs's module header comment and docs/MIGRATION.md's "Concurrent
// cold start" section): switching a BRAND-NEW file to WAL mode for the
// first time briefly needs an exclusive lock on the not-yet-created -wal/
// -shm sidecars, and confirmed empirically (repeated multi-process runs on
// this project's Windows/better-sqlite3 combination) that a losing
// connection's `PRAGMA journal_mode = WAL` can throw a raw `SqliteError`
// ("database is locked", `code: "SQLITE_BUSY"`) IMMEDIATELY -- without ever
// invoking the connection's own `busy_timeout` retry loop -- even when
// `busy_timeout` was set on that same connection before this call. This one
// pragma is therefore retried explicitly at the JS level, with its own
// bounded backoff, independent of (and in addition to) `busy_timeout`. Two
// processes opening the SAME fresh database file at close to the same
// instant could otherwise have the SECOND one fail here before either ever
// reaches migrate.mjs, no matter how well that module serializes migrations
// -- there would be nothing yet to make it wait instead.
const JOURNAL_MODE_WAL_RETRY_BUDGET_MS = 5000;

function isSqliteBusy(error) {
  return error instanceof Error && typeof error.code === "string" && error.code.startsWith("SQLITE_BUSY");
}

// Real (not CPU-spinning) synchronous sleep: `better-sqlite3`'s API is
// synchronous, so a caller opening a database has no `await` point to yield
// at, and a plain `while (Date.now() < end) {}` busy-loop would burn a full
// CPU core for every waiter. `Atomics.wait` blocks the calling thread for up
// to `ms` without polling, and needs no worker thread -- it works on the
// main thread against any Int32Array backed by a SharedArrayBuffer.
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Retries `PRAGMA journal_mode = WAL` while SQLite reports `SQLITE_BUSY`,
// backing off a little longer each attempt (capped), until
// `JOURNAL_MODE_WAL_RETRY_BUDGET_MS` elapses -- at which point the original
// `SqliteError` is rethrown unchanged (never wrapped): if switching a file
// to WAL mode is still failing after that long, something other than
// ordinary concurrent-cold-start contention is wrong, and this module has no
// typed error of its own to raise in its place (unlike migrate.mjs, which
// owns its own `SchemaVersionError` prefixes).
function setJournalModeWalWithRetry(db) {
  const deadline = Date.now() + JOURNAL_MODE_WAL_RETRY_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      attempt += 1;
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      sleepSync(Math.min(attempt * 5, 50));
    }
  }
}

/**
 * Open (creating if necessary) the SQLite database at dbPath with the
 * pragmas WP-12 requires: WAL journal mode, foreign-key enforcement, and a
 * busy timeout so concurrent readers/writers back off instead of failing
 * immediately.
 * @param {string} dbPath absolute path to the SQLite database file.
 * @returns {import("better-sqlite3").Database}
 */
export function open(dbPath) {
  if (!dbPath || typeof dbPath !== "string") {
    throw new TypeError("open(dbPath) requires a non-empty database file path.");
  }
  const db = new Database(dbPath);
  // busy_timeout is set before journal_mode on principle (it governs every
  // OTHER pragma and statement below and after), even though it does not by
  // itself cover the journal_mode race above -- see
  // setJournalModeWalWithRetry for why that pragma gets its own retry.
  db.pragma("busy_timeout = 5000");
  setJournalModeWalWithRetry(db);
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Open a connection to a dedicated SQLite file used purely to hold SQLite's
 * own write lock as a cross-process mutex (see migrate.mjs's
 * `withMigrationLock`, which uses this to serialize concurrent cold-start
 * migration runs against the same application database).
 *
 * This is deliberately a DIFFERENT file from the one `open()` above connects
 * application code to, and it gets none of `open()`'s pragmas: it is never
 * queried for anything but `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, so WAL
 * mode and foreign-key enforcement would only add sidecar files and
 * per-statement overhead for no benefit. `busyTimeoutMs` is a separate,
 * independent knob from `open()`'s fixed 5000ms: a lock acquisition may need
 * to wait through an arbitrary number of OTHER processes' entire migration
 * runs ahead of it, not just one write's worth of ordinary contention.
 * @param {string} lockPath absolute path to the dedicated lock file.
 * @param {number} busyTimeoutMs how long a waiter blocks before SQLite raises SQLITE_BUSY.
 * @returns {import("better-sqlite3").Database}
 */
export function openLock(lockPath, busyTimeoutMs) {
  if (!lockPath || typeof lockPath !== "string") {
    throw new TypeError("openLock(lockPath) requires a non-empty path.");
  }
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("openLock(lockPath, busyTimeoutMs) requires a non-negative finite busyTimeoutMs.");
  }
  const db = new Database(lockPath);
  db.pragma(`busy_timeout = ${Math.floor(busyTimeoutMs)}`);
  return db;
}

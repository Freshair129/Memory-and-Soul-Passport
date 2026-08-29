// better-sqlite3 connection factory. This is the only module allowed to
// import "better-sqlite3" (dependency-boundaries.test.mjs enforces that
// domain/ and transport/ never reach into db/'s implementation, only its
// exported functions).
import Database from "better-sqlite3";

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
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

// Migration runner: applies db/migrations/NNNN_*.sql files in order, tracks
// them in a schema_migrations table, and enforces two fail-closed startup
// guards (AC-03):
//   1. checksum-drift guard: every ALREADY-applied migration file is
//      re-hashed on every startup; a mismatch against the recorded checksum
//      throws (someone edited a migration after it shipped).
//   2. downgrade guard: if PRAGMA user_version is higher than the newest
//      migration file present on disk, throws (the code was rolled back
//      without a matching migration).
//
// A third, opt-in mode (WP-E0; see
// docs/DESIGN-SESSION-EPISODIC-INSTANCE-MEMORY.md §12.0): a migration file
// whose FIRST LINE is exactly "-- msp-migration: foreign-keys=off" is
// applied with `PRAGMA foreign_keys = OFF` outside its transaction --
// SQLite ignores that pragma inside one, and better-sqlite3 will not error
// if you try, so ordering is the whole point. Inside the transaction, the
// migration's SQL runs and then `PRAGMA foreign_key_check` must return zero
// rows before the migration is recorded and `user_version` bumped; any
// violation throws the existing SchemaVersionError (still
// `code = "db_unavailable"`, no new code) prefixed
// `migration_foreign_key_check_failed:`, which rolls the whole migration
// back. `PRAGMA foreign_keys` is restored to whatever it was before in a
// `finally`, in practice ON, since connection.mjs always enables it. This is
// the standard SQLite procedure for rebuilding a table that other tables
// reference via foreign key once the database can hold rows that would be
// orphaned by the rebuild -- root migrations 0003 and 0005 rebuilt child
// tables inside a plain transaction with foreign keys left on, which only
// worked because those tables were empty in every environment they ran in
// (see docs/NOTES.md). The directive is part of the migration file's text,
// so the existing checksum-drift guard covers it automatically; the runner
// itself never decides on its own to relax foreign keys. Migrations without
// the directive -- or with it anywhere but the first line -- are applied
// exactly as before, on the plain path.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATION_FILE_PATTERN = /^(\d{4})_.*\.sql$/;
const FOREIGN_KEYS_OFF_DIRECTIVE = "-- msp-migration: foreign-keys=off";

// The directive must be the file's first line, exactly. Migration files in
// this repository are checked out with CRLF line endings (core.autocrlf),
// so a trailing "\r" left by splitting on "\n" is stripped before the
// comparison; nothing else about the line is normalized (leading/trailing
// spaces or different casing do not count).
function hasForeignKeysOffDirective(sql) {
  const firstLine = sql.split("\n")[0].replace(/\r$/, "");
  return firstLine === FOREIGN_KEYS_OFF_DIRECTIVE;
}

// Deliberate note on a spec tension: WP-12's prose says domain/errors.mjs's
// SchemaVersionError is "used by migrate.mjs's guards," but WP-12's own
// dependency-boundary invariant (db <- domain, enforced by an automated
// test in test/dependency-boundaries.test.mjs) forbids db/ from importing
// anything from domain/ -- db/ must have zero internal imports. This
// resolves that in favor of the automated, testable invariant: db/ defines
// its own local SchemaVersionError (same name, same .code, same shape) so
// callers can `instanceof` against either this class or
// domain/errors.mjs's SchemaVersionError depending on which layer they're
// standing in; nothing here imports the domain-layer copy.
export class SchemaVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaVersionError";
    this.code = "db_unavailable";
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadMigrationFiles(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort()
    .map((name) => {
      const match = MIGRATION_FILE_PATTERN.exec(name);
      const version = Number(match[1]);
      const sql = readFileSync(path.join(migrationsDir, name), "utf8");
      return { version, name, sql, checksum: sha256(sql) };
    });
}

// Applies a single migration file carrying the `foreign-keys=off` directive
// (see the module header comment for the full sequence and why the
// PRAGMA foreign_keys toggle happens outside db.transaction(...)).
function applyForeignKeysOffMigration(db, file, insertMigration) {
  const previousForeignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    const applyOne = db.transaction(() => {
      db.exec(file.sql);

      // Must return zero rows before this migration is allowed to commit;
      // any violation throws, which rolls the whole transaction back
      // (the migration's SQL, the schema_migrations insert below, and the
      // user_version bump never take effect).
      const violations = db.pragma("foreign_key_check");
      if (violations.length > 0) {
        const [firstViolation] = violations;
        throw new SchemaVersionError(
          `migration_foreign_key_check_failed: migration "${file.name}" left a foreign-key ` +
            `violation on table "${firstViolation.table}" after its foreign-keys=off rebuild. ` +
            `PRAGMA foreign_key_check must return zero rows before this migration can commit. Refusing to start.`,
        );
      }

      insertMigration.run({
        version: file.version,
        name: file.name,
        checksum: file.checksum,
        applied_at: new Date().toISOString(),
      });
      // PRAGMA statements don't accept bound parameters; file.version is
      // parsed from a filename matched against MIGRATION_FILE_PATTERN
      // (\d{4}), so it is always a small non-negative integer here.
      db.pragma(`user_version = ${file.version}`);
    });
    applyOne();
  } finally {
    // Restore whatever PRAGMA foreign_keys was before this migration ran --
    // in practice ON, since connection.mjs always enables it -- regardless
    // of whether the transaction above committed or threw.
    db.pragma(`foreign_keys = ${previousForeignKeys}`);
  }
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * @param {import("better-sqlite3").Database} db an already-open connection (see db/connection.mjs).
 * @param {string} migrationsDir absolute path to the directory of NNNN_*.sql files.
 * @returns {{ appliedCount: number, currentVersion: number }}
 */
export function runMigrations(db, migrationsDir) {
  ensureMigrationsTable(db);

  const files = loadMigrationFiles(migrationsDir);
  const newestFileVersion = files.length ? Math.max(...files.map((file) => file.version)) : 0;

  // Downgrade guard: a recorded schema version higher than any migration
  // file present means the code was rolled back without a matching
  // migration. Refuse to start rather than run against an schema the
  // present code doesn't know how to speak.
  const currentUserVersion = db.pragma("user_version", { simple: true });
  if (currentUserVersion > newestFileVersion) {
    throw new SchemaVersionError(
      `msp-runtime: database schema (user_version=${currentUserVersion}) is newer than the newest ` +
        `migration file present (version=${newestFileVersion}). This looks like a downgrade -- the ` +
        `running code was rolled back without a matching migration file. Refusing to start.`,
    );
  }

  const appliedRows = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));

  // Checksum-drift guard: re-hash every already-applied migration file on
  // disk and compare against what was recorded when it was first applied.
  for (const file of files) {
    const recorded = appliedByVersion.get(file.version);
    if (recorded && recorded.checksum !== file.checksum) {
      throw new SchemaVersionError(
        `msp-runtime: checksum drift detected for already-applied migration "${file.name}". ` +
          `Recorded checksum ${recorded.checksum} does not match the on-disk checksum ${file.checksum}. ` +
          `An applied migration file must never be edited after the fact. Refusing to start.`,
      );
    }
  }

  const pending = files.filter((file) => !appliedByVersion.has(file.version));
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (@version, @name, @checksum, @applied_at)",
  );

  for (const file of pending) {
    if (hasForeignKeysOffDirective(file.sql)) {
      applyForeignKeysOffMigration(db, file, insertMigration);
    } else {
      const applyOne = db.transaction(() => {
        db.exec(file.sql);
        insertMigration.run({
          version: file.version,
          name: file.name,
          checksum: file.checksum,
          applied_at: new Date().toISOString(),
        });
        // PRAGMA statements don't accept bound parameters; file.version is
        // parsed from a filename matched against MIGRATION_FILE_PATTERN
        // (\d{4}), so it is always a small non-negative integer here.
        db.pragma(`user_version = ${file.version}`);
      });
      applyOne();
    }
  }

  return { appliedCount: pending.length, currentVersion: newestFileVersion };
}

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
// applied as:
//   1. Refuse (prefixed error, see below) if the connection is already
//      inside a transaction -- PRAGMA foreign_keys cannot be changed there.
//   2. PRAGMA foreign_keys = OFF, outside any transaction -- SQLite ignores
//      that pragma inside one, and better-sqlite3 will not error if you
//      try, so ordering is the whole point -- then read it back and refuse
//      if it did not actually take.
//   3. PRAGMA foreign_key_check BEFORE running the migration's SQL: any
//      violation here predates this migration and must not be blamed on
//      it (`migration_preexisting_foreign_key_violation:`).
//   4. Inside the existing db.transaction(...): the migration's SQL runs,
//      then two checks, in order:
//        a. a STRUCTURAL check across every table in the schema, not just
//           this migration's tables (`checkForeignKeyTargetsStructurallyValid`,
//           below) -- PRAGMA foreign_key_check only inspects existing rows,
//           so it says nothing about a REFERENCES clause left pointing at a
//           table that no longer exists when the referencing table happens
//           to be empty (the common case: every fresh database, every first
//           boot). This matters here specifically because SQLite rewrites a
//           child table's REFERENCES clause to follow a RENAME of the table
//           it names -- `ALTER TABLE parent RENAME TO parent_old` rewrites
//           children referencing `parent` to reference `"parent_old"` --
//           regardless of whether PRAGMA foreign_keys is on or off. The
//           "rename the old table away, create the new one under the old
//           name" rebuild order is therefore unsafe under this mode even
//           with zero rows; the safe order is CREATE `<table>_new` -> INSERT
//           ... SELECT -> DROP `<table>` -> RENAME `<table>_new` TO
//           `<table>` (see docs/MIGRATION.md).
//        b. PRAGMA foreign_key_check, which must return zero rows (the
//           row-level case, e.g. an orphaned child row a rebuild dropped).
//      Either failure throws the existing SchemaVersionError (still
//      `code = "db_unavailable"`, no new error code) prefixed
//      `migration_foreign_key_check_failed:`, naming the migration and the
//      offending table, which rolls the whole migration back.
//   5. Otherwise the schema_migrations row is inserted and user_version is
//      bumped, exactly as the plain path does today, and the transaction
//      commits.
//   6. In a `finally`, PRAGMA foreign_keys is restored to the value read in
//      step 2, in practice ON, since connection.mjs always enables it --
//      regardless of whether the migration committed or threw.
// Root migrations 0003 and 0005 predate this mode and were never edited to
// use it (see docs/NOTES.md for exactly which of their rebuilds carried
// real foreign-key risk and which did not); the design's 0008 (a `vaults`
// rebuild) is the first migration that needs it. The directive is part of
// the migration file's text, so the existing checksum-drift guard covers it
// automatically; the runner itself never decides on its own to relax
// foreign keys. A migration without the directive is applied exactly as
// before, on the plain path. A migration that contains the directive text
// in its leading comment block but NOT as the exact first line -- wrong
// line, a leading byte-order mark, leading/trailing whitespace, or
// different casing -- is refused outright
// (`migration_directive_misplaced:`) rather than silently treated as plain,
// so a typo in the one line that turns off foreign-key enforcement is never
// silent.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATION_FILE_PATTERN = /^(\d{4})_.*\.sql$/;
const FOREIGN_KEYS_OFF_DIRECTIVE = "-- msp-migration: foreign-keys=off";

function stripTrailingCr(line) {
  return line.replace(/\r$/, "");
}

function stripLeadingBom(line) {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

// Classifies a migration file's relationship to FOREIGN_KEYS_OFF_DIRECTIVE:
//   - "off": the file's first line is exactly the directive (no BOM, no
//     leading/trailing whitespace, exact case) -- the foreign-keys=off mode
//     applies.
//   - "misplaced": the directive text appears (case-insensitively, ignoring
//     surrounding whitespace) on some other line of the file's LEADING
//     COMMENT BLOCK -- every line from the top of the file that is blank or
//     starts with a SQL line comment ("--"), stopping at the first line
//     that is neither. This also covers a leading UTF-8 BOM in front of an
//     otherwise-exact directive on line 1, since the BOM makes the raw
//     first line not an exact match. A migration in this state is refused
//     rather than silently run on the plain path, on the theory that a
//     malformed directive is far more likely a mistake an author would want
//     to know about than a deliberate comment.
//   - "plain": the directive text does not appear in the leading comment
//     block at all -- applied exactly as every migration was before this
//     mode existed.
function classifyForeignKeysDirective(sql) {
  const lines = sql.split("\n").map(stripTrailingCr);
  const firstLineWithoutBom = stripLeadingBom(lines[0] ?? "");
  const firstLineHasBom = (lines[0] ?? "") !== firstLineWithoutBom;

  if (!firstLineHasBom && firstLineWithoutBom === FOREIGN_KEYS_OFF_DIRECTIVE) {
    return "off";
  }

  const normalizedDirective = FOREIGN_KEYS_OFF_DIRECTIVE.toLowerCase();
  for (const rawLine of lines) {
    const line = stripLeadingBom(rawLine);
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.toLowerCase() === normalizedDirective) return "misplaced";
    if (!trimmed.startsWith("--")) break; // left the leading comment block
  }

  return "plain";
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

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function primaryKeyColumns(db, table) {
  return db
    .pragma(`table_info(${quoteIdentifier(table)})`)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

function sameColumnSet(a, b) {
  if (a.length === 0 || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, index) => name === sortedB[index]);
}

// True if `columns` (as a set, order not significant) is `table`'s
// PRIMARY KEY or is exactly the column set of one of its UNIQUE indexes --
// i.e. `columns` is actually a key on `table`, so a foreign key naming them
// can resolve to at most one row.
function isKeyColumnSet(db, table, columns) {
  if (sameColumnSet(primaryKeyColumns(db, table), columns)) return true;
  for (const index of db.pragma(`index_list(${quoteIdentifier(table)})`)) {
    if (!index.unique) continue;
    const indexColumns = db
      .pragma(`index_info(${quoteIdentifier(index.name)})`)
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name);
    if (sameColumnSet(indexColumns, columns)) return true;
  }
  return false;
}

// Structural companion to PRAGMA foreign_key_check (see the module header
// comment for why the row-level check alone is not enough): for every
// table in the schema, every foreign key's target table must still exist,
// every explicitly named target column must exist on it, and the target
// column set must actually be a key on the target table (its PRIMARY KEY,
// or covered by a UNIQUE index) -- otherwise the "foreign key" can silently
// resolve to zero or many rows instead of at most one. Checked across the
// WHOLE schema, not just tables this migration's SQL touched, because a
// rebuild can break a REFERENCES clause on an unrelated table simply by
// renaming the table that clause names.
function checkForeignKeyTargetsStructurallyValid(db, file) {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
  const tableSet = new Set(tables);

  for (const table of tables) {
    const foreignKeys = db.pragma(`foreign_key_list(${quoteIdentifier(table)})`);
    if (foreignKeys.length === 0) continue;

    const byConstraintId = new Map();
    for (const foreignKey of foreignKeys) {
      if (!byConstraintId.has(foreignKey.id)) byConstraintId.set(foreignKey.id, []);
      byConstraintId.get(foreignKey.id).push(foreignKey);
    }

    for (const constraintRows of byConstraintId.values()) {
      const targetTable = constraintRows[0].table;
      if (!tableSet.has(targetTable)) {
        throw new SchemaVersionError(
          `migration_foreign_key_check_failed: migration "${file.name}" left table "${table}" with a foreign key ` +
            `pointing at table "${targetTable}", which does not exist after the rebuild. Refusing to start.`,
        );
      }

      // to === null on every row of a constraint means SQLite resolves it
      // implicitly against the target's PRIMARY KEY.
      const explicitTargetColumns = constraintRows.map((foreignKey) => foreignKey.to);
      const targetColumns = explicitTargetColumns.every((to) => to === null)
        ? primaryKeyColumns(db, targetTable)
        : explicitTargetColumns;

      if (targetColumns.length === 0) {
        throw new SchemaVersionError(
          `migration_foreign_key_check_failed: migration "${file.name}" left table "${table}" with a foreign key to ` +
            `table "${targetTable}", which has no PRIMARY KEY to resolve the implicit reference against. Refusing to start.`,
        );
      }

      const targetColumnNames = new Set(
        db.pragma(`table_info(${quoteIdentifier(targetTable)})`).map((column) => column.name),
      );
      for (const column of targetColumns) {
        if (!targetColumnNames.has(column)) {
          throw new SchemaVersionError(
            `migration_foreign_key_check_failed: migration "${file.name}" left table "${table}" with a foreign key ` +
              `naming column "${column}" on table "${targetTable}", which does not exist after the rebuild. Refusing to start.`,
          );
        }
      }

      if (!isKeyColumnSet(db, targetTable, targetColumns)) {
        throw new SchemaVersionError(
          `migration_foreign_key_check_failed: migration "${file.name}" left table "${table}" with a foreign key to ` +
            `table "${targetTable}" columns (${targetColumns.join(", ")}), which are neither that table's PRIMARY KEY ` +
            `nor covered by a UNIQUE index after the rebuild. Refusing to start.`,
        );
      }
    }
  }
}

// Applies a single migration file carrying the `foreign-keys=off` directive
// (see the module header comment for the full sequence and why the
// PRAGMA foreign_keys toggle happens outside db.transaction(...)).
function applyForeignKeysOffMigration(db, file, insertMigration) {
  if (db.inTransaction) {
    throw new SchemaVersionError(
      `migration_foreign_key_check_failed: migration "${file.name}" carries the foreign-keys=off directive, but the ` +
        `connection is already inside a transaction -- PRAGMA foreign_keys cannot be changed there. Refusing to start.`,
    );
  }

  const previousForeignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  const confirmedOff = db.pragma("foreign_keys", { simple: true });
  if (confirmedOff !== 0) {
    throw new SchemaVersionError(
      `migration_foreign_key_check_failed: migration "${file.name}" carries the foreign-keys=off directive, but ` +
        `PRAGMA foreign_keys still reads ${confirmedOff} after being set to OFF. Refusing to run its rebuild with ` +
        `foreign keys enforced. Refusing to start.`,
    );
  }

  try {
    // Run once BEFORE this migration's SQL executes: a violation here
    // predates this migration (a previous foreign-keys=off migration, or
    // out-of-band tampering) and must not be misreported as something this
    // migration caused.
    const preExistingViolations = db.pragma("foreign_key_check");
    if (preExistingViolations.length > 0) {
      const [firstPreExistingViolation] = preExistingViolations;
      throw new SchemaVersionError(
        `migration_preexisting_foreign_key_violation: migration "${file.name}" cannot run its foreign-keys=off ` +
          `rebuild -- PRAGMA foreign_key_check already reports a violation on table "${firstPreExistingViolation.table}" ` +
          `before this migration's SQL ran. Refusing to start.`,
      );
    }

    const applyOne = db.transaction(() => {
      db.exec(file.sql);

      // Structural check first: catches a REFERENCES clause left pointing
      // at a table (or non-key column set) that no longer exists,
      // regardless of whether any row currently exercises it.
      checkForeignKeyTargetsStructurallyValid(db, file);

      // Row-level check: must return zero rows before this migration is
      // allowed to commit; any violation throws, which rolls the whole
      // transaction back (the migration's SQL, the schema_migrations
      // insert below, and the user_version bump never take effect).
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
    const directiveState = classifyForeignKeysDirective(file.sql);
    if (directiveState === "misplaced") {
      throw new SchemaVersionError(
        `migration_directive_misplaced: migration "${file.name}" contains the "${FOREIGN_KEYS_OFF_DIRECTIVE}" ` +
          `directive text in its leading comment block, but not as the file's exact first line (wrong line, a ` +
          `leading byte-order mark, surrounding whitespace, or different casing all count). The directive only ` +
          `takes effect there; fix or remove it. Refusing to start.`,
      );
    }
    if (directiveState === "off") {
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

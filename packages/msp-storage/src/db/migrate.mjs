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
//   1. Refuse, prefixed `migration_in_transaction_refused:`, if the
//      connection is already inside a transaction -- PRAGMA foreign_keys
//      cannot be changed there.
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
// before, on the plain path. Any line in the file's leading comment block
// that mentions "msp-migration" (case-insensitively, anywhere in the line)
// and is not exactly the directive on the file's first line -- a near-miss
// spelling of the directive itself (missing space, underscore instead of a
// hyphen, extra or missing whitespace around "="), the directive on the
// wrong line, a leading byte-order mark, leading/trailing whitespace,
// different casing, or even a prose comment that only talks about the
// directive -- is refused outright (`migration_directive_misplaced:`)
// rather than silently treated as plain, so a typo in the one line that
// turns off foreign-key enforcement is never silent. Content outside that
// leading comment block -- the SQL body, or a comment after the file's
// first non-comment statement -- is never scanned for this.
//
// RKOI review (follow-up warning 2): scanning the header can never catch
// every mistake -- a C-style `/* msp-migration: foreign-keys=off */`
// header, a `/* header */` comment ahead of the directive, a leading
// `PRAGMA foreign_keys = OFF;` line, or a marker misspelling that doesn't
// even contain the substring "msp-migration" (`msp_migration`, "msp
// migration", `msp-migraton`) all still classify "plain" and reach the
// PLAIN path below with no directive at all. Because of this,
// `checkForeignKeysResolveOnPlainPath` (below; folds in
// `checkForeignKeyTargetsStructurallyValid`, the structural half of step 4a
// above) now ALSO runs on the plain path, after `db.exec(file.sql)` and
// before the `schema_migrations` insert and `user_version` bump, inside
// that path's own `db.transaction(...)`. This is the durable guarantee: it
// does not depend on any header being spelled correctly. The
// row-level `PRAGMA foreign_key_check` is deliberately NOT run on the plain
// path -- with `PRAGMA foreign_keys` ON there (connection.mjs always
// enables it, and the plain path never turns it off), row-level violations
// are already refused per statement as they happen, and a whole-database
// row check on every ordinary migration would make any database that
// already holds one pre-existing orphaned row unable to apply its next
// migration at all. The structural check itself is schema-only, so it also
// blocks a pending plain migration against a schema that was ALREADY
// structurally invalid before this migration ran; the real root schema
// (migrations 0001-0007) is confirmed structurally valid by
// `tests/integration/migrate.test.mjs`, including the `entities_fts` FTS5
// virtual table and its shadow tables. An already-applied migration never
// re-runs this check (or any other guard below), so a database that is
// fully migrated today boots exactly as it did before this change.
//
// RKOI review (same follow-up, 1 critical, first revision): an earlier
// revision of this file tried to decide whether a foreign key's target
// column set was genuinely a usable key (the right PRIMARY KEY/UNIQUE
// index, matching collation, generated-column and `WITHOUT ROWID` handling,
// etc.) by re-implementing SQLite's own rules against parsed `CREATE TABLE`
// text (`isKeyColumnSet`/`columnCollation`, since removed). It disagreed
// with SQLite on 7 of 27 real parent-key shapes: 6 false REJECTIONS, where
// the text merely LOOKED like it might mention `COLLATE` -- inside a
// `CHECK` expression, a `DEFAULT` string, a block comment, or past an
// apostrophe or a stray `(` inside a `--` comment, or a quoted `"check"`
// column mistaken for the constraint keyword -- and 1 false ACCEPTANCE,
// `PRIMARY KEY (id COLLATE NOCASE)` on an otherwise-`BINARY` column, whose
// PRIMARY KEY short-circuit returned `true` before ever comparing a
// collation.
//
// RKOI review (same critical, second revision): that fix's REPLACEMENT --
// a per-constraint, CHILD-side `UPDATE "<child>" SET "<col>" = "<col>" ...
// WHERE 0` probe -- introduced five NEW false rejections of its own, by
// running a JS pre-filter (table/column existence, "is this a key" by
// column-NAME matching) BEFORE ever consulting SQLite: a case-different
// column name (`REFERENCES parent(ID)` where the column is `id`), a
// case-different table name (`REFERENCES Parent(id)` where the table is
// `parent`), a case-different UNIQUE index column (index on `Code`, FK
// names `code`), a `GENERATED` parent key column (`PRAGMA table_info` omits
// generated columns entirely), and a `GENERATED` CHILD FK column itself
// (SQLite refuses to `UPDATE` a generated column at all, so the child-side
// probe cannot even run against one). Both mistakes share a root cause:
// deciding ANYTHING beyond bare table existence in JS, ahead of SQLite,
// risks disagreeing with SQLite's own rules. The fix removes every such
// pre-filter except the one JS cannot avoid keeping (below), and moves the
// probe to the PARENT side, which cannot fail this way -- it names no
// column at all, so there is no column-name or generated-column mismatch
// for JS to get wrong, and SQLite still resolves every foreign key any
// child declares against that parent, regardless of casing or generated
// columns, when asked to prepare a statement against the parent itself:
//   - JS keeps EXACTLY ONE check: does the target table exist at all,
//     compared case-insensitively (`findMissingForeignKeyTargetTable`,
//     below). This one cannot be delegated: on the PLAIN path, SQLite's own
//     `.prepare()` reports a missing target only as a raw, unprefixed
//     `no such table`; on the DIRECTIVE path, `PRAGMA foreign_key_check`
//     with `PRAGMA foreign_keys` OFF never reports a missing target AT ALL
//     when the referencing table happens to be empty -- exactly the case
//     this whole check exists for (see above). Nothing else -- column
//     existence, key-ness, collation -- is decided in JS anymore.
//   - PLAIN path (`PRAGMA foreign_keys` is ON the whole time here): for
//     every DISTINCT existing target table any foreign key in the schema
//     names, `findParentSideForeignKeyProbeFailure`, below, prepares -- but
//     never executes -- `DELETE FROM "<target>" WHERE 0`. Preparing a
//     DELETE against the PARENT table makes SQLite resolve every foreign
//     key any child declares against it, in ONE statement per parent,
//     regardless of casing, columns, or how many children or constraints
//     reference it; `WHERE 0` guarantees zero rows are ever touched even if
//     the statement somehow ran, which it never does. If ANY foreign key
//     naming that parent does not actually resolve, `.prepare()` throws a
//     `SqliteError` synchronously, before anything executes -- most
//     commonly `foreign key mismatch - ...`, but a raw `SqliteError` of any
//     other message (e.g. an `ON DELETE` trigger on the parent referencing
//     a table that no longer exists) means something about that table's
//     schema is broken too, so it is rethrown prefixed as well, never left
//     raw.
//   - DIRECTIVE path (`PRAGMA foreign_keys` is OFF while the migration's SQL
//     runs): the parent-side probe does NOT resolve foreign keys while the
//     pragma reads OFF, so it is not used there -- no functional change
//     from the previous revision. `PRAGMA foreign_key_check` (already run
//     on this path both before and after the migration's SQL,
//     `runForeignKeyCheck`, below) already raises the identical
//     `SqliteError: foreign key mismatch - ...` regardless of the pragma's
//     current value for every one of these classes, and that is already
//     caught and rethrown, prefixed.
//
// RKOI review (same round, warning 1): a structural defect that PREDATES
// this migration -- introduced out-of-band, or by an earlier migration --
// must not be blamed on this one. BOTH of the checks above -- the missing-
// table check, and the parent-side probe -- therefore also run once
// against the CURRENT schema, before `db.exec(file.sql)`, on BOTH paths
// (`assertNoPreexistingStructuralForeignKeyViolation`, below). On the
// directive path this runs before `PRAGMA foreign_keys` is ever turned
// OFF (see `applyForeignKeysOffMigration`'s call order, below -- do not
// reorder it), so the parent-side probe is meaningful there too, not just
// the missing-table check. A violation found here throws prefixed
// `migration_preexisting_structural_violation:` instead of
// `migration_foreign_key_check_failed:`, naming the table and target, and
// the migration's own SQL never runs -- mirroring the existing
// `migration_preexisting_foreign_key_violation:` guard for row-level
// violations on the directive path, just for the structural question and on
// both paths.
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

// Marker substring the runner treats as "this header line is talking to
// me". Deliberately broader than the directive's own text: a line that
// merely names "msp-migration" without being exactly right is far more
// likely a typo an author would want surfaced than a deliberate comment
// that happens to share the word.
const DIRECTIVE_MARKER = "msp-migration";

// Classifies a migration file's relationship to FOREIGN_KEYS_OFF_DIRECTIVE
// by scanning its LEADING COMMENT BLOCK -- every line from the top of the
// file (after an optional UTF-8 BOM on line 1) that is blank or starts with
// a SQL line comment ("--"), stopping at the first line that is neither:
//   - "off": the file's first line is exactly the directive (no BOM, no
//     leading/trailing whitespace, exact case) -- the foreign-keys=off mode
//     applies.
//   - "misplaced" (with the offending raw line attached, for the error
//     message): some line in the leading comment block contains
//     DIRECTIVE_MARKER (case-insensitively, anywhere in the line) and is
//     not the exact directive on line 1. This single rule covers every
//     near-miss: a misspelled directive on line 1 itself (missing space
//     after "--", underscore instead of a hyphen, spaces around "=", a
//     missing or doubled space after the colon), the directive on the
//     wrong line, a leading BOM in front of an otherwise-exact line 1, and
//     a prose comment that only talks about the directive (e.g. "-- see
//     msp-migration directive docs"). A migration in this state is refused
//     rather than silently run on the plain path.
//   - "plain": no line in the leading comment block contains
//     DIRECTIVE_MARKER at all -- applied exactly as every migration was
//     before this mode existed. Content outside the leading comment block
//     (the SQL body, or a comment after the file's first non-comment
//     statement) is never scanned, so mentioning the marker there has no
//     effect.
function classifyForeignKeysDirective(sql) {
  const lines = sql.split("\n").map(stripTrailingCr);
  const firstLineWithoutBom = stripLeadingBom(lines[0] ?? "");
  const firstLineHasBom = (lines[0] ?? "") !== firstLineWithoutBom;

  if (!firstLineHasBom && firstLineWithoutBom === FOREIGN_KEYS_OFF_DIRECTIVE) {
    return { state: "off" };
  }

  for (const rawLine of lines) {
    const line = stripLeadingBom(rawLine);
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) break; // left the leading comment block
    if (trimmed.toLowerCase().includes(DIRECTIVE_MARKER)) {
      return { state: "misplaced", line: trimmed };
    }
  }

  return { state: "plain" };
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

// Every ordinary (non-`sqlite_*`) table currently in the schema, in the
// exact case SQLite itself recorded it under.
function allTableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

// Finds the first foreign key in the CURRENT schema whose target table does
// not exist -- compared CASE-INSENSITIVELY, since SQLite itself resolves
// table names that way, and a mismatch here used to be a false rejection
// (RKOI: `REFERENCES Parent(id)` against an actual table `parent`). This is
// the ONE thing this module still decides in JS rather than asking SQLite
// (see the module header comment for why): SQLite's own `.prepare()` on the
// plain path reports a missing target table only as a raw, unprefixed
// `no such table`, and `PRAGMA foreign_key_check` with `PRAGMA foreign_keys`
// OFF never reports it at all when the referencing table happens to be
// empty (the exact case this whole check exists for -- see the module
// header comment). Checked across the WHOLE schema, not just tables a
// migration's SQL touched, because a rebuild can break a REFERENCES clause
// on an unrelated table simply by renaming the table that clause names.
// Shared by the four callers below (post-migration and pre-existing, on
// both paths) so all four agree on what counts as "missing".
function findMissingForeignKeyTargetTable(db) {
  const tableNames = allTableNames(db);
  const lowerTableNames = new Set(tableNames.map((name) => name.toLowerCase()));
  for (const table of tableNames) {
    for (const foreignKey of db.pragma(`foreign_key_list(${quoteIdentifier(table)})`)) {
      if (!lowerTableNames.has(foreignKey.table.toLowerCase())) {
        return { table, targetTable: foreignKey.table };
      }
    }
  }
  return null;
}

// Everything else about whether a foreign key's parent key is genuinely
// usable -- the right PRIMARY KEY/UNIQUE index actually existing, matching
// collation, generated columns, composite keys, `WITHOUT ROWID`, every
// other nuance SQLite itself cares about -- is answered by SQLite, not by
// re-implementing its rules (see the module header comment for the parser
// this replaced and why). For every DISTINCT existing target table any
// foreign key in the schema names, this prepares -- but never executes --
// `DELETE FROM "<target>" WHERE 0`. Preparing a DELETE against the PARENT
// table makes SQLite resolve EVERY foreign key ANY child table declares
// against it, in one statement, regardless of which child or which
// columns; `WHERE 0` guarantees zero rows are ever touched even if the
// statement somehow ran, which it never does. A target already found
// missing by `findMissingForeignKeyTargetTable` is skipped here -- there is
// no real name left to quote and prepare against. Returns `{ targetTable,
// message }` for the first table SQLite itself refuses to resolve or even
// prepare a DELETE against (a raw `SqliteError` here -- not only "foreign
// key mismatch" -- means something about that table's schema is broken,
// e.g. an ON DELETE trigger referencing a table that no longer exists), or
// `null` if every distinct target resolves cleanly.
function findParentSideForeignKeyProbeFailure(db) {
  const tableNames = allTableNames(db);
  const targetTableNames = new Set();
  for (const table of tableNames) {
    for (const foreignKey of db.pragma(`foreign_key_list(${quoteIdentifier(table)})`)) {
      targetTableNames.add(foreignKey.table);
    }
  }

  for (const targetTable of targetTableNames) {
    const realName = tableNames.find((candidate) => candidate.toLowerCase() === targetTable.toLowerCase());
    if (!realName) continue; // reported separately, by findMissingForeignKeyTargetTable

    try {
      db.prepare(`DELETE FROM ${quoteIdentifier(realName)} WHERE 0`);
    } catch (error) {
      if (error instanceof Error) return { targetTable: realName, message: error.message };
      throw error;
    }
  }
  return null;
}

// Post-migration missing-target-table check (see the module header comment
// for why the row-level check alone is not enough). Throws the existing
// `SchemaVersionError` prefixed `migration_foreign_key_check_failed:`,
// naming the migration and the offending table. Used on BOTH paths: the
// directive path's own `db.transaction(...)` (this is the original WP-E0
// structural check, unchanged), and folded into
// `checkForeignKeysResolveOnPlainPath`, below, for the plain path.
function checkForeignKeyTargetsStructurallyValid(db, file) {
  const missing = findMissingForeignKeyTargetTable(db);
  if (!missing) return;
  throw new SchemaVersionError(
    `migration_foreign_key_check_failed: migration "${file.name}" left table "${missing.table}" with a foreign key ` +
      `pointing at table "${missing.targetTable}", which does not exist after the rebuild. Refusing to start.`,
  );
}

// PLAIN-path-only companion (see the module header comment for why): the
// missing-table check above, plus SQLite's own parent-side resolution of
// everything else a foreign key's parent key needs to be. `PRAGMA
// foreign_keys` is ON for the whole plain path (connection.mjs always
// enables it, and this path never turns it off), which is what makes
// `findParentSideForeignKeyProbeFailure`'s prepare-only probe meaningful
// here.
function checkForeignKeysResolveOnPlainPath(db, file) {
  checkForeignKeyTargetsStructurallyValid(db, file);
  const failure = findParentSideForeignKeyProbeFailure(db);
  if (!failure) return;
  throw new SchemaVersionError(
    `migration_foreign_key_check_failed: migration "${file.name}" left table "${failure.targetTable}" with a foreign ` +
      `key SQLite itself refuses to resolve -- "${failure.message}". Refusing to start.`,
  );
}

// Pre-migration check (RKOI follow-up, warning 1): the SAME two questions
// as above -- missing target table, then SQLite's own parent-side
// resolution of everything else -- asked against the CURRENT schema BEFORE
// this migration's SQL runs at all, on BOTH paths. A defect found here
// predates this migration -- an earlier migration, or out-of-band
// tampering -- and must not be blamed on it, mirroring the existing
// `migration_preexisting_foreign_key_violation:` guard for row-level
// violations on the directive path (`runForeignKeyCheck`/
// `applyForeignKeysOffMigration`, below), just for the structural question
// and on both paths. Throws prefixed `migration_preexisting_structural_violation:`
// -- a distinct prefix from `migration_foreign_key_check_failed:`, since
// this migration's own SQL never even ran. On the directive path this runs
// before `PRAGMA foreign_keys` is ever turned OFF (see
// `applyForeignKeysOffMigration`, below, and do not reorder that), so the
// parent-side probe is meaningful there too.
function assertNoPreexistingStructuralForeignKeyViolation(db, file) {
  const missing = findMissingForeignKeyTargetTable(db);
  if (missing) {
    throw new SchemaVersionError(
      `migration_preexisting_structural_violation: migration "${file.name}" cannot run -- the schema already has table ` +
        `"${missing.table}" with a foreign key pointing at table "${missing.targetTable}", which does not exist, before ` +
        `this migration's SQL ran. Refusing to start.`,
    );
  }
  const failure = findParentSideForeignKeyProbeFailure(db);
  if (failure) {
    throw new SchemaVersionError(
      `migration_preexisting_structural_violation: migration "${file.name}" cannot run -- the schema already has table ` +
        `"${failure.targetTable}" with a foreign key SQLite itself refuses to resolve -- "${failure.message}", before ` +
        `this migration's SQL ran. Refusing to start.`,
    );
  }
}

// Belt-and-braces wrapper around `PRAGMA foreign_key_check` for the
// directive path (RKOI, WP-E0 warning 1): SQLite itself can refuse to even
// run that pragma with a raw `SqliteError` whose message contains "foreign
// key mismatch" when some table's foreign key does not resolve to a real
// key at all -- a case `checkForeignKeyTargetsStructurallyValid` above is
// meant to catch first, but this belt-and-braces catch means a gap in that
// check's own reasoning still surfaces as the same prefixed
// `SchemaVersionError`, naming the migration, rather than an unhandled raw
// driver error.
function runForeignKeyCheck(db, file) {
  try {
    return db.pragma("foreign_key_check");
  } catch (error) {
    if (error instanceof Error && typeof error.message === "string" && error.message.includes("foreign key mismatch")) {
      throw new SchemaVersionError(
        `migration_foreign_key_check_failed: migration "${file.name}" cannot be checked -- PRAGMA foreign_key_check ` +
          `itself refused with "${error.message}", meaning some table's foreign key does not resolve to a real key. ` +
          `Refusing to start.`,
      );
    }
    throw error;
  }
}

// Applies a single migration file carrying the `foreign-keys=off` directive
// (see the module header comment for the full sequence and why the
// PRAGMA foreign_keys toggle happens outside db.transaction(...)).
function applyForeignKeysOffMigration(db, file, insertMigration) {
  if (db.inTransaction) {
    throw new SchemaVersionError(
      `migration_in_transaction_refused: migration "${file.name}" carries the foreign-keys=off directive, but the ` +
        `connection is already inside a transaction -- PRAGMA foreign_keys cannot be changed there. Refusing to start.`,
    );
  }

  // RKOI follow-up warning 1: check the CURRENT schema, before this
  // migration's SQL runs at all, so a defect that predates this migration
  // is never blamed on it.
  assertNoPreexistingStructuralForeignKeyViolation(db, file);

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
    const preExistingViolations = runForeignKeyCheck(db, file);
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
      const violations = runForeignKeyCheck(db, file);
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
    const directive = classifyForeignKeysDirective(file.sql);
    if (directive.state === "misplaced") {
      throw new SchemaVersionError(
        `migration_directive_misplaced: migration "${file.name}" has a line in its leading comment block that ` +
          `mentions "${DIRECTIVE_MARKER}" but is not exactly the directive "${FOREIGN_KEYS_OFF_DIRECTIVE}" on the ` +
          `file's first line (wrong line, a leading byte-order mark, surrounding whitespace, different casing, or ` +
          `a near-miss spelling all count) -- the offending line reads: "${directive.line}". The directive only ` +
          `takes effect there; fix or remove this line. Refusing to start.`,
      );
    }
    if (directive.state === "off") {
      applyForeignKeysOffMigration(db, file, insertMigration);
    } else {
      // RKOI follow-up warning 1: check the CURRENT schema, before this
      // migration's SQL runs at all, so a defect that predates this
      // migration is never blamed on it. Outside the transaction on
      // purpose -- if this throws, db.exec(file.sql) below never runs, so
      // there is nothing to roll back.
      assertNoPreexistingStructuralForeignKeyViolation(db, file);

      const applyOne = db.transaction(() => {
        db.exec(file.sql);

        // RKOI follow-up warning 2 (missing-table half) and the later
        // critical review (parent-side SQLite delegation half): header
        // scanning can never catch every mistake (see the module header
        // comment for the shapes that still reach here with no directive
        // at all), so the plain path enforces its own structural guarantee
        // -- missing target table in JS, everything else delegated to
        // SQLite -- before this migration is allowed to commit.
        checkForeignKeysResolveOnPlainPath(db, file);

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

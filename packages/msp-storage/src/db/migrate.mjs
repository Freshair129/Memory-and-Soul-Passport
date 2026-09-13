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
//      then three checks, in order:
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
//        c. a PARENT-side probe (`findParentSideForeignKeyProbeFailure`,
//           below) -- added by RKOI's final review of the plain-path check:
//           neither (a) nor (b) inspects TRIGGER bodies, so a DELETE
//           trigger on some table UNRELATED to any foreign key, whose body
//           references a table this migration's rebuild dropped, commits
//           cleanly through both. Preparing a DELETE against the parent
//           that owns the trigger still fails to even compile regardless of
//           PRAGMA foreign_keys, since compiling a trigger body is not
//           gated by that pragma. This step does not duplicate key
//           resolution: while PRAGMA foreign_keys is OFF the probe does not
//           resolve foreign keys at all, so (b) remains the sole authority
//           for that; this step exists only to catch a broken trigger (a),
//           and (b) cannot see.
//      Any failure throws the existing SchemaVersionError (still
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
// real foreign-key risk and which did not); 0008 (TASK-MEMOS-002 stage 1,
// thread memory) shipped as brand-new CREATE TABLE statements only, never a
// rebuild, so it does not need this mode either -- a principal-vaults
// rebuild, if one is still needed, is a later migration that will. The
// directive is part of
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
//
// RKOI review (final review of the above, four warnings): "does the target
// table exist" is not actually the same question as "is the target a
// TABLE" -- SQLite has four kinds of schema object a foreign key's target
// name can resolve to (`PRAGMA table_list`'s own `type` column: `table`,
// `view`, `virtual`, `shadow`), and the case-insensitive existence check
// above could not tell them apart, which was wrong in three different
// directions, all confirmed against real SQLite:
//   1. A target that is a VIEW was refused (a view cannot satisfy a
//      foreign key -- SQLite itself raises `foreign key mismatch` the
//      moment anything tries to resolve one), but the message said the
//      target "does not exist", which is false -- it exists, just not as a
//      table.
//   2. A target that is an FTS5 VIRTUAL TABLE was WRONGLY ACCEPTED on the
//      plain path: preparing `DELETE FROM "<virtual>" WHERE 0` compiles no
//      foreign-key code at all against a virtual table (there is nothing
//      for SQLite to resolve at prepare time), so the parent-side probe
//      below reports no failure, the migration commits, and the server
//      boots -- until the first write to the referencing table throws
//      `foreign key mismatch` at runtime, and no later pre-exec check
//      catches it either, since the probe never resolves it going forward.
//   3. A target that is an FTS5 shadow table (e.g. `<fts>_data`,
//      `<fts>_config`) was WRONGLY REFUSED on the plain path: this
//      connection runs under SQLite's "defensive" mode
//      (`SQLITE_DBCONFIG_DEFENSIVE`, a per-connection flag better-sqlite3
//      enables by default, NOT something FTS5 itself sets), under which
//      even a bare `DELETE ... WHERE 0` against a shadow table fails to
//      prepare with `table "<shadow>" may not be modified` -- a real
//      `SqliteError`, so the probe treated it as a genuine resolution
//      failure, even though SQLite resolves and enforces a real foreign
//      key to a shadow table's declared PRIMARY KEY perfectly well at
//      actual write time. Once a directive migration adds such a foreign
//      key, this false rejection then also poisons
//      `assertNoPreexistingStructuralForeignKeyViolation` for every
//      subsequent migration, since the same probe runs there too.
// The fix: resolve every foreign key's target through `PRAGMA table_list`
// (schema `main` only -- `findForeignKeyTargetTypeIssue`, below), a
// catalog fact with no `CREATE TABLE` text parsing involved, instead of
// only checking bare existence against `sqlite_schema`. A target absent
// from `main` (including one that exists only in `temp.`, which SQLite
// itself would refuse to resolve as `no such table: main.<name>`) is still
// "missing", worded exactly as before. A target present as `view` or
// `virtual` is a NEW, distinct refusal, naming the migration, the
// referencing table, the target, and its type -- on both paths, and
// checked BEFORE the parent-side probe runs, so the probe itself never
// has to deal with a virtual table's silent non-resolution. A target
// present as `shadow` is excluded from the parent-side probe entirely --
// the probe's own defensive-mode DELETE failure was never a real signal
// about whether the foreign key resolves -- and is instead checked a
// different way for a REAL key column vs. a non-key one (see the later
// RKOI pre-merge-fixup review, below, for the non-key half: it is not
// simply "accepted outright"). A target present as `table` is unchanged:
// probed as before. Nothing here reintroduces `CREATE TABLE` text parsing
// or any column-/key-matching logic in JS; the type question is answered
// by a
// pragma, and everything about whether a foreign key actually resolves
// remains SQLite's call via the parent-side probe (table targets) or
// `PRAGMA foreign_key_check` (the directive path's row-level check).
//
// RKOI review (same final review, warning 4): `PRAGMA foreign_key_check`
// says nothing about a DELETE trigger, on some table UNRELATED to any
// foreign key, whose body references a table this migration's rebuild
// dropped -- that pragma only inspects declared foreign keys, never
// trigger bodies. Confirmed against real SQLite: preparing
// `DELETE FROM "<parent-with-the-trigger>" WHERE 0` still fails with a raw
// `no such table: main.<dropped>` even while `PRAGMA foreign_keys` reads
// OFF, because compiling a trigger's body is not gated by that pragma at
// all -- only FOREIGN KEY resolution is. The directive path's post-exec
// checks therefore now also run `findForeignKeyTargetTypeIssue` and
// `findParentSideForeignKeyProbeFailure`, the same two checks the plain
// path already ran post-exec, inside the same `db.transaction(...)`, after
// `db.exec(file.sql)` and the existing `runForeignKeyCheck`. Key
// resolution while `PRAGMA foreign_keys` is OFF is still `runForeignKeyCheck`'s
// job alone -- the parent-side probe does not resolve a foreign key while
// the pragma reads OFF (see the earlier RKOI review above), so it is added
// here ONLY to catch this trigger-shaped class of breakage, not to
// duplicate key resolution. A directive migration that drops a table a
// parent's DELETE trigger references is now refused post-exec, prefixed
// `migration_foreign_key_check_failed:`, exactly like the plain path, and
// the next migration is never reached with a poisoned schema.
//
// RKOI review (same final review, wording): a probe failure whose message
// is NOT `foreign key mismatch` (e.g. the trigger case just above, or any
// other raw `SqliteError` preparing the parent-side DELETE) means the
// parent table itself cannot be deleted from for some OTHER reason -- not
// that "a foreign key SQLite refuses to resolve". The message now says the
// parent table "cannot be deleted from" and embeds SQLite's own text
// verbatim (e.g. `no such table: main.side`) for that case, reserving "a
// foreign key SQLite itself refuses to resolve" wording for when the
// message actually contains `foreign key mismatch`
// (`describeParentSideProbeFailure`, below). Every message stays prefixed
// either way.
//
// RKOI review (pre-merge fixup of the above, warning 1, required): a
// `shadow` target being skipped by the parent-side probe (see above) only
// means the DELETE-based probe cannot ask the question -- it does not mean
// the question has no answer. A foreign key naming a shadow target's
// NON-key column (or a column that does not exist on it at all) is still
// invalid, and SQLite still refuses to resolve it, `foreign key mismatch`,
// exactly like a `view` or `virtual` target -- but nothing asked it to,
// so it was WRONGLY ACCEPTED on the plain path. Confirmed against real
// SQLite on four such shapes (an FTS5 shadow table's own non-key column,
// a nonexistent column on one, an FTS5 `_content` shadow table's non-key
// column, and an rtree virtual table's own shadow table's non-key
// column) and against the PRIMARY KEY shapes that must keep being
// accepted. The fix: `findShadowTargetForeignKeyMismatch`, below, asks
// SQLite the SAME question a different way for shadow targets only --
// `PRAGMA main.foreign_key_check("<child>")`, scoped to the CHILD table
// declaring the foreign key rather than to the shadow table itself, which
// never touches the shadow table (no DELETE, no defensive-mode conflict)
// and still raises `foreign key mismatch` when the key does not resolve.
// Any ROWS this returns instead of throwing are deliberately IGNORED: on
// the plain path `PRAGMA foreign_keys` is ON, so row-level violations are
// already refused per statement as they happen (see the RKOI review
// above on why the plain path never runs a whole-database row check), and
// this function's only business is the structural EXCEPTION. This runs
// post-exec on the plain path (`checkForeignKeysResolveOnPlainPath`) and
// pre-exec on both paths (`assertNoPreexistingStructuralForeignKeyViolation`,
// before `PRAGMA foreign_keys` is ever turned OFF on the directive path,
// same as the parent-side probe); the directive path's post-exec
// `runForeignKeyCheck` (a whole-database, unqualified
// `PRAGMA foreign_key_check`) already raises the identical
// `SqliteError` for every one of these shapes regardless of
// `PRAGMA foreign_keys`'s value, confirmed against real SQLite, so no
// change was needed there. `db.unsafeMode(true)` is deliberately NOT
// used to route around defensive mode for the DELETE probe instead: it
// disables defensive mode for the WHOLE connection, not just one probe,
// which is a broader change than this fix needs.
//
// RKOI review (pre-merge fixup, warning 2, included): every unqualified
// object name this module asks SQLite to resolve -- `PRAGMA
// foreign_key_list(<table>)` and the parent-side probe's
// `DELETE FROM "<target>" WHERE 0` -- is resolved using SQLite's ordinary
// name-resolution rules, under which a `temp` object of the same name
// takes priority over one in `main`. Confirmed against real SQLite: if a
// caller creates a `TEMP VIEW` (or table) on this same connection sharing
// a `main` table's name -- BEFORE calling into this module, e.g. some
// other part of the process warming up a scratch view on the connection
// migrations run against -- an unqualified `PRAGMA foreign_key_list` on
// that name silently returns the TEMP object's (likely empty) foreign-key
// list instead of the real `main` table's, and an unqualified `DELETE
// FROM "<name>" WHERE 0` resolves against the TEMP object too, which is
// how a `TEMP VIEW` shadowing a real `main` parent table produced a raw
// `cannot modify <name> because it is a view` -- misattributing a
// same-named TEMP object's shape to the real `main` table's foreign keys.
// `sqlite_schema` itself is exempt from this -- SQLite always resolves
// the bare, unqualified name to `main`'s own schema table, confirmed
// against real SQLite, so `allTableNames`, below, needs no change -- but
// every ordinary table name this module asks SQLite to resolve elsewhere
// does not get that exemption. The fix: every `PRAGMA foreign_key_list`
// call and the parent-side probe's `DELETE` are now schema-qualified
// (`PRAGMA main.foreign_key_list(...)`, `DELETE FROM main."<target>"
// WHERE 0`), so they always resolve against the real `main` table
// regardless of what the connection's `temp` schema happens to hold.
//
// RKOI review (pre-merge fixup, warning 3, included): a foreign key
// naming one of SQLite's own internal `sqlite_*` catalog tables (e.g.
// `sqlite_sequence`, the `AUTOINCREMENT` bookkeeping table) is correctly
// refused -- SQLite has no usable key on `sqlite_sequence` for a foreign
// key to resolve against, confirmed against real SQLite (`foreign key
// mismatch`) -- but `mainSchemaEntries`, below, deliberately excludes
// `sqlite_*` names from its lookups (they are not legitimate migration
// targets), so such a target fell through to the "missing" case and was
// misreported as not existing, when the table is very much present.
// `findForeignKeyTargetTypeIssue` now checks an UNFILTERED `PRAGMA
// table_list` reading for a match before concluding "missing", and
// reports a distinct `kind: "internal"` naming the referencing table and
// the internal table, worded as "an internal SQLite table, not a valid
// foreign-key target" rather than claiming it does not exist. The refusal
// itself, and its prefix, are unchanged -- only the reason given is now
// accurate.
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

// Every row `PRAGMA table_list` reports for the `main` schema (never
// `temp.` -- SQLite itself would refuse to resolve a foreign key against a
// temp-schema object as `no such table: main.<name>`, so a target that
// exists only there must still count as missing below), INCLUDING SQLite's
// own internal `sqlite_*` catalog tables -- `mainSchemaEntries`, below,
// excludes those for ordinary lookups; this unfiltered version exists only
// so a foreign key that targets one (e.g. `sqlite_sequence`) can be
// reported accurately rather than as "missing" (RKOI pre-merge fixup,
// warning 3; see the module header comment).
function allMainSchemaTableListRows(db) {
  return db.pragma("table_list").filter((row) => row.schema === "main");
}

// The subset of `allMainSchemaTableListRows` a migration can legitimately
// target: excludes SQLite's own internal `sqlite_*` catalog tables. Each
// row's `type` is one of `table`, `view`, `virtual` or `shadow` -- a
// catalog fact, not something inferred from `CREATE` text (see the module
// header comment).
function mainSchemaEntries(db) {
  return allMainSchemaTableListRows(db).filter((row) => !row.name.startsWith("sqlite_"));
}

// Case-insensitive lookup of `name` against `entries` (SQLite itself
// resolves table names that way). Returns the matching `{ name, type, ... }`
// row in its REAL on-disk casing, or `null` if nothing matches.
function findTableListEntry(entries, name) {
  return entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? null;
}

// Finds the first foreign key in the CURRENT schema whose target does not
// resolve to a real TABLE -- checked across the WHOLE schema, not just
// tables a migration's SQL touched, because a rebuild can break a
// REFERENCES clause on an unrelated table simply by renaming the table
// that clause names. This is the ONE thing this module still decides in
// JS rather than asking SQLite (see the module header comment for why):
// neither `.prepare()` on the plain path nor `PRAGMA foreign_key_check`
// with `PRAGMA foreign_keys` OFF on the directive path reliably reports a
// missing or wrong-kind target when the referencing table happens to be
// empty (the exact case this whole check exists for). `PRAGMA
// main.foreign_key_list(...)` is schema-qualified (RKOI pre-merge fixup,
// warning 2): an unqualified `PRAGMA foreign_key_list(<table>)` resolves
// against a same-named `temp` object in preference to the real `main`
// table if the connection happens to hold one, silently reporting that
// object's foreign keys (often none) instead -- confirmed against real
// SQLite; see the module header comment. Returns one of:
//   - `null` if every foreign key's target resolves to a `table` or a
//     `shadow` table -- a `shadow` target that names a real key column is
//     fine here; one that does not is caught separately, by
//     `findShadowTargetForeignKeyMismatch`, below (RKOI pre-merge fixup,
//     warning 1; see the module header comment).
//   - `{ kind: "missing", table, targetTable }` if the target does not
//     exist anywhere in the `main` schema (case-insensitive), exactly as
//     before.
//   - `{ kind: "internal", table, targetTable }` if the target IS one of
//     SQLite's own internal `sqlite_*` catalog tables (RKOI pre-merge
//     fixup, warning 3) -- distinct from "missing" because the table is
//     genuinely present, just never a legitimate migration target.
//   - `{ kind: "view" | "virtual", table, targetTable }` if the target
//     exists but is a view or an FTS5-style virtual table, neither of
//     which can satisfy a foreign key -- `targetTable` carries the target's
//     REAL on-disk casing.
// Shared by every caller below (post-exec and pre-existing, on both paths)
// so all of them agree on what counts as a structural problem.
function findForeignKeyTargetTypeIssue(db) {
  const entries = mainSchemaEntries(db);
  const allEntries = allMainSchemaTableListRows(db);
  for (const table of allTableNames(db)) {
    for (const foreignKey of db.pragma(`main.foreign_key_list(${quoteIdentifier(table)})`)) {
      const entry = findTableListEntry(entries, foreignKey.table);
      if (!entry) {
        const internalEntry = findTableListEntry(allEntries, foreignKey.table);
        if (internalEntry) {
          return { kind: "internal", table, targetTable: internalEntry.name };
        }
        return { kind: "missing", table, targetTable: foreignKey.table };
      }
      if (entry.type === "view" || entry.type === "virtual") {
        return { kind: entry.type, table, targetTable: entry.name };
      }
    }
  }
  return null;
}

// Human-readable noun phrase for each `findForeignKeyTargetTypeIssue` kind
// that reads as "which is X, not a table" (`missing` and `internal` do not
// fit that shape and are handled directly in `describeForeignKeyTargetIssue`
// below), so the message reads naturally ("which is a view, not a table")
// rather than treating the raw `PRAGMA table_list` type word as a noun on
// its own ("which is a virtual, not a table").
const FOREIGN_KEY_TARGET_KIND_NOUN = {
  view: "a view",
  virtual: "a virtual table",
};

// Renders a `findForeignKeyTargetTypeIssue` result as the shared middle
// clause of both the post-exec and pre-existing messages below -- neither
// caller repeats the branch on `issue.kind`.
function describeForeignKeyTargetIssue(issue) {
  if (issue.kind === "missing") {
    return `table "${issue.table}" with a foreign key pointing at table "${issue.targetTable}", which does not exist`;
  }
  if (issue.kind === "internal") {
    return (
      `table "${issue.table}" with a foreign key pointing at "${issue.targetTable}", which is an internal SQLite ` +
      `table, not a valid foreign-key target`
    );
  }
  return (
    `table "${issue.table}" with a foreign key pointing at "${issue.targetTable}", which is ` +
    `${FOREIGN_KEY_TARGET_KIND_NOUN[issue.kind]}, not a table`
  );
}

// Everything else about whether a foreign key's parent key is genuinely
// usable -- the right PRIMARY KEY/UNIQUE index actually existing, matching
// collation, generated columns, composite keys, `WITHOUT ROWID`, every
// other nuance SQLite itself cares about -- is answered by SQLite, not by
// re-implementing its rules (see the module header comment for the parser
// this replaced and why). For every DISTINCT existing target that resolves
// to a `table` (a `view` or `virtual` target is already refused by
// `findForeignKeyTargetTypeIssue`, and a `shadow` target is deliberately
// SKIPPED here and checked a different way instead, by
// `findShadowTargetForeignKeyMismatch` below -- see the module header
// comment for both), this prepares -- but never executes -- `DELETE FROM
// main."<target>" WHERE 0`, schema-qualified (RKOI pre-merge fixup, warning
// 2: an unqualified `DELETE FROM "<target>" WHERE 0` resolves against a
// same-named `temp` object in preference to the real `main` table if the
// connection happens to hold one, confirmed against real SQLite; see the
// module header comment). Preparing a DELETE against the PARENT table
// makes SQLite resolve EVERY foreign key ANY child table declares against
// it, in one statement, regardless of which child or which columns;
// `WHERE 0` guarantees zero rows are ever touched even if the statement
// somehow ran, which it never does. A target already found missing (or
// view/virtual) by `findForeignKeyTargetTypeIssue` is skipped here --
// reported separately. Returns `{ targetTable, message }` for the first
// `table`-typed target SQLite itself refuses to resolve or even prepare a
// DELETE against (a raw `SqliteError` here -- not only "foreign key
// mismatch" -- means something about that table's schema is broken, e.g.
// an ON DELETE trigger referencing a table that no longer exists), or
// `null` if every distinct `table`-typed target resolves cleanly.
function findParentSideForeignKeyProbeFailure(db) {
  const entries = mainSchemaEntries(db);
  const targetTableNames = new Set();
  for (const table of allTableNames(db)) {
    for (const foreignKey of db.pragma(`main.foreign_key_list(${quoteIdentifier(table)})`)) {
      targetTableNames.add(foreignKey.table);
    }
  }

  for (const targetTable of targetTableNames) {
    const entry = findTableListEntry(entries, targetTable);
    if (!entry) continue; // reported separately, by findForeignKeyTargetTypeIssue
    if (entry.type !== "table") continue; // shadow is checked a different way, by findShadowTargetForeignKeyMismatch below; view/virtual are already refused earlier

    try {
      db.prepare(`DELETE FROM main.${quoteIdentifier(entry.name)} WHERE 0`);
    } catch (error) {
      if (error instanceof Error) return { targetTable: entry.name, message: error.message };
      throw error;
    }
  }
  return null;
}

// Finds the first CHILD table whose foreign key names a `shadow`-typed
// target but does not actually resolve to a real key on it -- e.g. a
// foreign key to a shadow table's own NON-key column, a column that does
// not exist on it at all, or an rtree virtual table's shadow table's
// non-key column (RKOI pre-merge fixup, warning 1). `findParentSideForeignKeyProbeFailure`
// above deliberately SKIPS `shadow` targets entirely, because a bare
// `DELETE ... WHERE 0` against one fails to prepare under this
// connection's defensive mode (`SQLITE_DBCONFIG_DEFENSIVE`, a
// per-connection flag better-sqlite3 enables by default, not something
// FTS5 itself sets -- see the module header comment) regardless of
// whether the foreign key itself is valid. That skip means a shadow
// target that does NOT name a real key column was wrongly ACCEPTED on the
// plain path: nothing else ever asked SQLite to resolve it, so it
// committed, booted, and only the first real child write threw `foreign
// key mismatch` at runtime. `PRAGMA main.foreign_key_check("<child>")`,
// scoped to the CHILD table declaring the foreign key (never to the
// shadow table itself), answers the same question a different way,
// without touching the shadow table or its defensive-mode restrictions:
// SQLite still raises a raw `SqliteError` containing "foreign key
// mismatch" when the key does not resolve. Confirmed against real SQLite
// on four non-key shapes (an FTS5 shadow table's own non-key column, a
// nonexistent column on one, an FTS5 `_content` shadow table's non-key
// column, and an rtree virtual table's shadow table's non-key column) and
// against the PRIMARY KEY shapes SQLite genuinely accepts, which this
// leaves alone (it returns zero rows, not a mismatch, for those). Any ROWS
// this pragma returns instead of throwing are deliberately IGNORED: on the
// PLAIN path `PRAGMA foreign_keys` is ON, so row-level enforcement already
// happens per statement as it happens (see the module header comment on
// why the plain path never runs a whole-database row check), and a
// pre-existing orphaned row must never block boot -- only the mismatch
// EXCEPTION, a structural fact independent of any row's contents, is this
// function's business. `db.unsafeMode(true)` is deliberately NOT used to
// route around defensive mode for the parent-side probe instead: it
// disables defensive mode for the WHOLE connection, not just one probe.
// Returns `{ table, message }` for the first child this happens to, or
// `null` if every shadow-targeting foreign key resolves cleanly.
function findShadowTargetForeignKeyMismatch(db) {
  const entries = mainSchemaEntries(db);
  for (const table of allTableNames(db)) {
    const foreignKeys = db.pragma(`main.foreign_key_list(${quoteIdentifier(table)})`);
    const referencesShadowTarget = foreignKeys.some((foreignKey) => {
      const entry = findTableListEntry(entries, foreignKey.table);
      return entry !== null && entry.type === "shadow";
    });
    if (!referencesShadowTarget) continue;

    try {
      db.pragma(`main.foreign_key_check(${quoteIdentifier(table)})`);
    } catch (error) {
      if (error instanceof Error && typeof error.message === "string" && error.message.includes("foreign key mismatch")) {
        return { table, message: error.message };
      }
      throw error;
    }
  }
  return null;
}

// Renders a `findShadowTargetForeignKeyMismatch` result as the shared
// middle clause of both the post-exec and pre-existing messages below.
// Every case this function reports is, by construction, a `foreign key
// mismatch`, so unlike `describeParentSideProbeFailure` there is no
// non-mismatch branch to distinguish.
function describeShadowTargetForeignKeyMismatch(mismatch) {
  return `table "${mismatch.table}" with a foreign key SQLite itself refuses to resolve -- "${mismatch.message}"`;
}

// Renders a `findParentSideForeignKeyProbeFailure` result as the shared
// middle clause of both the post-exec and pre-existing messages below.
// Reserves "a foreign key SQLite itself refuses to resolve" wording for the
// case SQLite's own message actually says `foreign key mismatch`; any other
// raw `SqliteError` (e.g. the trigger case in the module header comment)
// means the parent table cannot be deleted from for some other reason, and
// says so, embedding SQLite's own message verbatim either way.
function describeParentSideProbeFailure(failure) {
  if (failure.message.includes("foreign key mismatch")) {
    return `table "${failure.targetTable}" with a foreign key SQLite itself refuses to resolve -- "${failure.message}"`;
  }
  return `table "${failure.targetTable}" that cannot be deleted from -- SQLite reports "${failure.message}"`;
}

// Post-migration structural check (see the module header comment for why
// the row-level check alone is not enough). Throws the existing
// `SchemaVersionError` prefixed `migration_foreign_key_check_failed:`,
// naming the migration and the offending table. Used on BOTH paths: the
// directive path's own `db.transaction(...)` (the original WP-E0
// structural check), and folded into `checkForeignKeysResolveOnPlainPath`,
// below, for the plain path.
function checkForeignKeyTargetsStructurallyValid(db, file) {
  const issue = findForeignKeyTargetTypeIssue(db);
  if (!issue) return;
  const contextSuffix = issue.kind === "missing" ? " after the rebuild" : "";
  throw new SchemaVersionError(
    `migration_foreign_key_check_failed: migration "${file.name}" left ${describeForeignKeyTargetIssue(issue)}` +
      `${contextSuffix}. Refusing to start.`,
  );
}

// PLAIN-path-only companion (see the module header comment for why): the
// type check above, plus SQLite's own parent-side resolution of everything
// else a foreign key's parent key needs to be. `PRAGMA foreign_keys` is ON
// for the whole plain path (connection.mjs always enables it, and this path
// never turns it off), which is what makes
// `findParentSideForeignKeyProbeFailure`'s prepare-only probe -- and
// `findShadowTargetForeignKeyMismatch`'s `PRAGMA foreign_key_check`-based
// probe for `shadow` targets the DELETE probe cannot reach (RKOI pre-merge
// fixup, warning 1) -- meaningful here.
function checkForeignKeysResolveOnPlainPath(db, file) {
  checkForeignKeyTargetsStructurallyValid(db, file);

  const failure = findParentSideForeignKeyProbeFailure(db);
  if (failure) {
    throw new SchemaVersionError(
      `migration_foreign_key_check_failed: migration "${file.name}" left ${describeParentSideProbeFailure(failure)}. ` +
        `Refusing to start.`,
    );
  }

  const shadowMismatch = findShadowTargetForeignKeyMismatch(db);
  if (!shadowMismatch) return;
  throw new SchemaVersionError(
    `migration_foreign_key_check_failed: migration "${file.name}" left ` +
      `${describeShadowTargetForeignKeyMismatch(shadowMismatch)}. Refusing to start.`,
  );
}

// Pre-migration check (RKOI follow-up, warning 1): the SAME questions as
// above -- target type, SQLite's own parent-side resolution of everything
// else, and (RKOI pre-merge fixup, warning 1) a `shadow` target's own
// non-key mismatch -- asked against the CURRENT schema BEFORE this
// migration's SQL runs at all, on BOTH paths. A defect found here predates
// this migration -- an earlier migration, or out-of-band tampering -- and
// must not be blamed on it, mirroring the existing
// `migration_preexisting_foreign_key_violation:` guard for row-level
// violations on the directive path (`runForeignKeyCheck`/
// `applyForeignKeysOffMigration`, below), just for the structural question
// and on both paths. Throws prefixed `migration_preexisting_structural_violation:`
// -- a distinct prefix from `migration_foreign_key_check_failed:`, since
// this migration's own SQL never even ran. On the directive path this runs
// before `PRAGMA foreign_keys` is ever turned OFF (see
// `applyForeignKeysOffMigration`, below, and do not reorder that), so the
// parent-side probe -- and the shadow-target check, which also relies on
// `PRAGMA foreign_keys` being ON to ignore returned rows safely -- are
// meaningful there too.
function assertNoPreexistingStructuralForeignKeyViolation(db, file) {
  const issue = findForeignKeyTargetTypeIssue(db);
  if (issue) {
    throw new SchemaVersionError(
      `migration_preexisting_structural_violation: migration "${file.name}" cannot run -- the schema already has ` +
        `${describeForeignKeyTargetIssue(issue)}, before this migration's SQL ran. Refusing to start.`,
    );
  }

  const failure = findParentSideForeignKeyProbeFailure(db);
  if (failure) {
    throw new SchemaVersionError(
      `migration_preexisting_structural_violation: migration "${file.name}" cannot run -- the schema already has ` +
        `${describeParentSideProbeFailure(failure)}, before this migration's SQL ran. Refusing to start.`,
    );
  }

  const shadowMismatch = findShadowTargetForeignKeyMismatch(db);
  if (shadowMismatch) {
    throw new SchemaVersionError(
      `migration_preexisting_structural_violation: migration "${file.name}" cannot run -- the schema already has ` +
        `${describeShadowTargetForeignKeyMismatch(shadowMismatch)}, before this migration's SQL ran. Refusing to start.`,
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

      // RKOI review (final review, warning 4): neither the structural check
      // above nor PRAGMA foreign_key_check inspects trigger bodies -- a
      // DELETE trigger on some table UNRELATED to any foreign key, whose
      // body references a table this migration's rebuild dropped, commits
      // cleanly through both, and only surfaces once the parent-side probe
      // (below) tries to prepare a DELETE against the table that owns the
      // trigger, which fails to even compile regardless of PRAGMA
      // foreign_keys (see the module header comment). This does not
      // duplicate `runForeignKeyCheck`'s job: key resolution while
      // `PRAGMA foreign_keys` reads OFF stays with that pragma alone, since
      // the DELETE probe does not resolve keys in that state.
      const probeFailure = findParentSideForeignKeyProbeFailure(db);
      if (probeFailure) {
        throw new SchemaVersionError(
          `migration_foreign_key_check_failed: migration "${file.name}" left ${describeParentSideProbeFailure(probeFailure)}. ` +
            `Refusing to start.`,
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

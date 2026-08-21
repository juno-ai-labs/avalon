// Building and reading a **D1 baseline**: a checked-in snapshot of the regional
// schema as of one migration, applied to an empty local database in place of
// replaying the chain that produced it.
//
// This exists for local and sandbox setup only. Production and every hosted
// database still replay `packages/db/migrations/` in full, because that chain is
// the authoritative schema and a baseline is a derived artifact — regenerating
// one is a build step, while a hosted database that skipped a migration is a
// permanent divergence nobody can reconstruct. `data-model.md` invariant 10
// ("migration files are immutable after deployment") is what makes a baseline
// safe to derive at all: the input cannot change under it.
//
// Three properties make the derivation trustworthy, and each is enforced by a
// test rather than by care:
//
//   1. **Equivalence.** Applying the baseline leaves the same tables, columns,
//      indexes, triggers, and seeded control rows as applying every subsumed
//      migration in order.
//   2. **Staleness is loud.** The manifest records the exact ordered list of
//      files the baseline subsumes and a digest of their contents. Editing one,
//      or adding a file that sorts at or below the boundary, changes the digest
//      and fails the suite. That second case is not hypothetical: the sequence
//      has a hole at 0084, so a later `0084_*.sql` would sort *below* the 0090
//      boundary and would otherwise be silently skipped forever on every
//      baselined database while still applying to production.
//   3. **It only ever runs on an empty database.** A baseline carries no
//      migration history of its own, so applying it over existing tables would
//      merge two schemas rather than reproduce one. The generated SQL refuses
//      through a named CHECK, the same shape migration 0090 uses, because a D1
//      file is a flat statement sequence with nowhere to put an `if`.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Tables SQLite and D1 maintain for themselves. They are never emitted into a
 * baseline and never counted when deciding whether a database is empty:
 * `d1_migrations` is Wrangler's ledger, the `_cf_` names are the platform's own
 * bookkeeping, and the `sqlite_` names are the engine's. Treating any of them as
 * user schema would make a freshly created database look occupied.
 *
 * The `_cf_` prefix is matched rather than the individual names because **the
 * two D1s do not agree on them**: a hosted database carries `_cf_KV`, while a
 * local Miniflare one carries `_cf_METADATA` and no `_cf_KV`. An exact list
 * built from production — which is how this was first written — passes every
 * offline test and then fails the moment the baseline meets a real local
 * database, because the emptiness guard counts `_cf_METADATA` as user schema
 * and refuses the one case it exists to allow.
 */
export const INTERNAL_TABLE_NAMES = ["d1_migrations"];

/** Name prefixes reserved by SQLite and by D1, in both regions and both runtimes. */
export const INTERNAL_TABLE_PREFIXES = ["sqlite_", "_cf_"];

/** The guard table the generated SQL creates and drops to assert emptiness. */
export const GUARD_TABLE_NAME = "_baseline_empty_database_guard";

/** The named CHECK a non-empty database trips, quoted in errors and tests. */
export const GUARD_CONSTRAINT_NAME = "baseline_requires_empty_database";

/**
 * Wrangler's own ledger DDL, reproduced verbatim — tabs included — from a
 * deployed D1 database (`SELECT sql FROM sqlite_schema WHERE name =
 * 'd1_migrations'`).
 *
 * The baseline creates it rather than waiting for Wrangler because the ledger
 * rows are written in the same file: the whole point is that
 * `wrangler d1 migrations apply` finds the subsumed migrations already recorded
 * and applies only what came after. `IF NOT EXISTS` keeps this a no-op when
 * Wrangler created it first, and matching its text byte for byte means a
 * baselined database and a fully migrated one are indistinguishable afterwards
 * rather than differing in a way someone has to investigate once.
 */
export const D1_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

export function isInternalTableName(name) {
  return INTERNAL_TABLE_NAMES.includes(name)
    || INTERNAL_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))
    || name === GUARD_TABLE_NAME;
}

/**
 * The `WHERE` fragment that excludes every table an emptiness check must ignore,
 * shared by the baseline's own guard and by the local migrate wrapper's
 * inventory query so the two can never disagree about what "empty" means.
 * `LIKE` treats `_` as a wildcard, hence the `ESCAPE`.
 *
 * The guard table is excluded along with the platform's own, because **a fired
 * guard leaves it behind**. D1 rejects `CREATE TEMP TABLE` outright
 * (`SQLITE_AUTH`), so the guard has to be a real table, and the `DROP` that
 * would clean it up is the statement after the `INSERT` that aborts. Counting
 * that leftover as user schema would mean a database that refused the baseline
 * once could never be offered it again — it would look permanently occupied by
 * the evidence of its own refusal. The next attempt's `DROP TABLE IF EXISTS`
 * clears it.
 */
export function internalTableExclusionSql(columnName = "name") {
  return [
    ...INTERNAL_TABLE_PREFIXES.map(
      (prefix) => `${columnName} NOT LIKE '${prefix.replaceAll("_", "\\_")}%' ESCAPE '\\'`,
    ),
    ...INTERNAL_TABLE_NAMES.map((name) => `${columnName} <> ${sqlLiteral(name)}`),
    `${columnName} <> ${sqlLiteral(GUARD_TABLE_NAME)}`,
  ].join("\n              AND ");
}

/** Every migration file in `directory`, in the order Wrangler applies them. */
export function listMigrationFiles(directory) {
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
}

/**
 * The migrations a baseline `through` a given file subsumes.
 *
 * The boundary is a **file name, not a number**. Six numbers in this repository
 * carry two files each (`0039_slack_connector.sql` and
 * `0039_workstream_read_state.sql`, and five more), so a numeric comparison
 * would include one of a pair and drop the other, producing a baseline missing
 * a migration that every real database ran.
 *
 * The string comparison is the same ordering Wrangler applies migrations in,
 * and it is correct only because the sequence is zero-padded to four digits —
 * the convention `classify-pending-d1-migrations.mjs` also encodes. A name that
 * broke it (`0090a_…`, or a five-digit sequence) would sort somewhere this does
 * not expect. The manifest digest is the backstop: it fails on any insertion at
 * or below the boundary, however that file sorts.
 */
export function subsumedMigrations(allFiles, throughFile) {
  if (!allFiles.includes(throughFile)) {
    throw new Error(`${throughFile} is not a migration in this repository`);
  }
  return allFiles.filter((name) => name <= throughFile);
}

/**
 * A digest over the subsumed files' names *and* contents.
 *
 * Names are included so that adding a file below the boundary changes the
 * digest even if it is empty, and lengths are framed into the hash so two
 * different file splits cannot collide by concatenating to the same bytes.
 */
export function digestMigrations(directory, files) {
  const hash = createHash("sha256");
  for (const name of files) {
    const contents = readFileSync(join(directory, name), "utf8");
    hash.update(`${name} ${contents.length} ${contents} `);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The schema and seeded rows of a database that has just had a migration chain
 * applied to it, in a form that can be compared or rendered back out as SQL.
 *
 * Objects keep their `sql` verbatim; comparison normalizes, rendering does not,
 * so a regenerated baseline still carries the comments the migrations wrote.
 */
export function snapshotDatabase(database) {
  const objects = database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all()
    .filter((object) => !isInternalTableName(object.name) && !isInternalTableName(object.tbl_name ?? ""))
    // An index SQLite creates for a UNIQUE or PRIMARY KEY constraint has no
    // `sql` of its own; it comes back when the table is created and must not be
    // emitted as a statement.
    .filter((object) => typeof object.sql === "string" && object.sql.trim() !== "");

  const rows = {};
  for (const { name } of objects.filter((object) => object.type === "table")) {
    const tableRows = database.prepare(`SELECT * FROM "${name}"`).all();
    if (tableRows.length > 0) rows[name] = tableRows;
  }
  return { objects, rows };
}

/**
 * The columns whose value a migration chain computes fresh on every run, found
 * by comparing two independent applications of the same chain rather than by
 * parsing SQL for `datetime('now')` and its spellings.
 *
 * Two control rows are seeded by the chain today (`workstream_authority_control`
 * and `digest_reconciliation_control`), both stamping `datetime('now')`. A
 * baseline that froze those literals would hand every local database a
 * timestamp from whenever the baseline was generated, and — worse for reviewing
 * it — no comparison against a chain replay could ever be an equality, because
 * two chain replays do not agree either. Detecting the columns instead means
 * the generated SQL re-derives exactly those and freezes everything else.
 *
 * Returns `{ [table]: string[] }`. Callers separate the two runs in wall-clock
 * time; `datetime('now')` has one-second resolution, so runs inside the same
 * second are indistinguishable and would report nothing volatile.
 */
export function detectVolatileColumns(firstRows, secondRows) {
  const volatileColumns = {};
  for (const [table, firstTableRows] of Object.entries(firstRows)) {
    const secondTableRows = secondRows[table] ?? [];
    const names = new Set();
    for (const [index, firstRow] of firstTableRows.entries()) {
      const secondRow = secondTableRows[index];
      if (!secondRow) continue;
      for (const column of Object.keys(firstRow)) {
        if (firstRow[column] !== secondRow[column]) names.add(column);
      }
    }
    if (names.size > 0) volatileColumns[table] = [...names].sort();
  }
  return volatileColumns;
}

/** A SQL literal for a value read back out of SQLite. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${value} has no SQL literal`);
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Cannot render ${typeof value} as a SQL literal`);
}

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function renderGuard() {
  return `-- A baseline reproduces a schema; it cannot merge into one. Applying it over a
-- database that already has tables would leave a mixture of two schemas with no
-- migration history explaining either, and applying it over a partially
-- migrated database would claim every subsumed migration had run when some had
-- not. Both are unrecoverable without dropping the database, so this refuses
-- first, by name, before creating anything.
--
-- A D1 file is a flat sequence of statements with no branching, so the check is
-- a CHECK: the INSERT computes 1 only for an empty database and the constraint
-- rejects anything else. Migration 0090 guards itself the same way.
DROP TABLE IF EXISTS ${GUARD_TABLE_NAME};
CREATE TABLE ${GUARD_TABLE_NAME} (
  ready INTEGER NOT NULL
    CONSTRAINT ${GUARD_CONSTRAINT_NAME} CHECK (ready = 1)
);

INSERT INTO ${GUARD_TABLE_NAME} (ready)
VALUES (
  CASE
    WHEN NOT EXISTS (
           SELECT 1 FROM sqlite_schema
            WHERE type = 'table'
              AND ${internalTableExclusionSql()}
         )
     AND NOT EXISTS (SELECT 1 FROM d1_migrations)
    THEN 1
    ELSE 0
  END
);

DROP TABLE ${GUARD_TABLE_NAME};`;
}

/** The object types `renderBaselineSql` knows how to write back out. */
export const RENDERABLE_OBJECT_TYPES = ["table", "index", "trigger"];

/**
 * Refuses a snapshot holding anything the renderer would drop on the floor.
 *
 * The renderer partitions `sqlite_schema` into tables, indexes and triggers,
 * and anything else — a view — would be read, emitted nowhere, and produce a
 * baseline quietly missing an object. Nothing offline would catch it: the
 * equivalence suite compares tables, per-table shapes and triggers, and
 * `manifest.objectCounts` has no slot for anything else, so the only check that
 * would notice is the credentialed remote verify.
 *
 * This repository has held such objects before — `0036_scoped_agent_memory.sql`
 * and `0037_scoped_memory_tables.sql` create FTS5 virtual tables, and they are
 * only absent from the 0090 snapshot because 0090 drops them. The next boundary
 * meets whatever the chain holds then, so the generator stops rather than
 * guesses.
 */
export function assertEveryObjectRenderable(objects) {
  const unsupported = objects.filter((object) => !RENDERABLE_OBJECT_TYPES.includes(object.type));
  if (unsupported.length === 0) return;
  throw new Error(
    `Cannot render ${unsupported.map((object) => `${object.type}:${object.name}`).join(", ")} into a `
    + "baseline. Teach renderBaselineSql to emit it — in an order that respects what it depends on — "
    + "rather than dropping it.",
  );
}

/** The shape `datetime('now')` produces: `2026-08-21 18:40:42`. */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

/**
 * Refuses a volatile column whose value the renderer would silently retype.
 *
 * Detection is deliberately expression-agnostic — it finds *which* columns move
 * by replaying the chain twice rather than by parsing SQL — but re-derivation
 * writes one expression, `datetime('now')`. A column the chain computes some
 * other way is therefore detected correctly and then written back as something
 * else: a `strftime('%s','now')` epoch integer comes back as a text timestamp,
 * in a column declared `INTEGER`.
 *
 * Nothing downstream catches that. The equivalence suite strips volatile columns
 * from both sides before comparing, the stamping test reads only the baseline,
 * and the fingerprint reads `sqlite_schema` and never a row. So the assumption
 * is asserted here, at generation, where the message can name the column and
 * say what the renderer needs to learn.
 */
export function assertVolatileValuesAreTimestamps(rows, volatileColumns) {
  for (const [table, columns] of Object.entries(volatileColumns)) {
    for (const row of rows[table] ?? []) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === "string" && SQLITE_DATETIME.test(value)) continue;
        throw new Error(
          `${table}.${column} is volatile but holds ${JSON.stringify(value)}, which `
          + "datetime('now') does not produce. renderBaselineSql would rewrite it as a text "
          + "timestamp and change its type. Teach the renderer that column's expression.",
        );
      }
    }
  }
}

function renderRows(table, tableRows, volatileForTable) {
  const columns = Object.keys(tableRows[0]);
  const rendered = tableRows.map((row) => {
    const values = columns.map((column) => (
      volatileForTable.includes(column) ? "datetime('now')" : sqlLiteral(row[column])
    ));
    return `  (${values.join(", ")})`;
  });
  return `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})\nVALUES\n${rendered.join(",\n")};`;
}

/**
 * Renders a baseline file from a snapshot.
 *
 * Statement order is load-bearing, and is the order SQLite's own `.dump` uses:
 * every table, then the seeded rows, then indexes and triggers. Creating the
 * triggers first would let them fire on the baseline's own inserts — several in
 * this schema RAISE(ABORT) on writes they consider out of phase, so the file
 * would abort partway through and leave a half-built database. Indexes follow
 * the data for the same reason a bulk load builds them last.
 *
 * The ledger rows come last of all: they are the claim "these migrations have
 * run", and it must not be recorded before the schema they describe exists.
 */
export function renderBaselineSql({ through, files, digest, snapshot, volatileColumns = {} }) {
  const tables = snapshot.objects.filter((object) => object.type === "table");
  const indexes = snapshot.objects.filter((object) => object.type === "index");
  const triggers = snapshot.objects.filter((object) => object.type === "trigger");

  assertEveryObjectRenderable(snapshot.objects);
  assertVolatileValuesAreTimestamps(snapshot.rows, volatileColumns);

  const sections = [];
  sections.push(`-- Generated by \`node scripts/create-d1-baseline.mjs ${through}\` — do not edit by hand.
--
-- A snapshot of the regional D1 schema as of ${through}, applied to an empty
-- local database instead of replaying the ${files.length} migrations that produce it.
-- Regenerate it rather than editing it: \`packages/db/test/baseline-migration.test.ts\`
-- compares this file against a real replay of those migrations and fails on any
-- difference, so a hand edit is caught, but only after it has cost someone the
-- afternoon.
--
-- Hosted databases never apply this. They replay \`packages/db/migrations/\` in
-- full, which is what keeps the chain authoritative and this file derived.
--
-- Subsumes: ${files[0]} .. ${files.at(-1)} (${files.length} migrations)
-- Digest:   ${digest}`);

  sections.push(`-- Wrangler's ledger, created here because the rows recorded at the end of this
-- file are what make \`wrangler d1 migrations apply\` skip the subsumed
-- migrations and apply only those that came after ${through}.
${D1_MIGRATIONS_TABLE_SQL};`);

  sections.push(renderGuard());

  sections.push(`-- Tables.\n${tables.map((table) => `${table.sql.trim()};`).join("\n\n")}`);

  const seeded = Object.entries(snapshot.rows);
  if (seeded.length > 0) {
    const rendered = seeded
      .map(([table, tableRows]) => renderRows(table, tableRows, volatileColumns[table] ?? []))
      .join("\n\n");
    sections.push(`-- Control rows the subsumed migrations seed. A column the chain recomputes on
-- every run is re-derived here rather than frozen, so a baselined database is
-- stamped when it is created rather than when this file was generated.
${rendered}`);
  }

  if (indexes.length > 0) {
    sections.push(`-- Indexes.\n${indexes.map((index) => `${index.sql.trim()};`).join("\n")}`);
  }
  if (triggers.length > 0) {
    sections.push(`-- Triggers, last so they cannot fire on the rows inserted above.\n${triggers.map((trigger) => `${trigger.sql.trim()};`).join("\n\n")}`);
  }

  const ledgerValues = files.map((name) => `  (${sqlLiteral(name)})`).join(",\n");
  sections.push(`-- The ledger claim. Recorded only now that every object above exists.
INSERT OR IGNORE INTO d1_migrations (name)
VALUES
${ledgerValues};`);

  return `${sections.join("\n\n")}\n`;
}

/** Applies migration files to an open database, in order. */
export function applyMigrations(database, directory, files) {
  for (const name of files) {
    database.exec(readFileSync(join(directory, name), "utf8"));
  }
}

/**
 * A schema object's SQL reduced to what a database actually enforces.
 *
 * Comments and whitespace are removed because D1 does not preserve them: a
 * `CREATE TABLE` whose body carries a `--` comment comes back from a deployed
 * database with the comment stripped, while the same statement replayed through
 * `node:sqlite` keeps it. `telemetry_eu_events` is the one table in this schema
 * where that happens, and comparing raw text reports it as a difference on
 * every run — a false positive that would train everyone to ignore the check.
 *
 * **Quoted tokens are copied verbatim, which is why this lexes rather than
 * running two regular expressions over the whole statement.** A regex cannot
 * tell a comment from the characters `--` inside a string, so
 * `DEFAULT '--a'` and `DEFAULT '--b'` both normalize to `DEFAULT '` and hash
 * the same, as do `'a  b'` and `'a b'`. Two different schemas comparing equal
 * is the exact failure this function exists to detect, and it is worse than no
 * check because `db:baseline:verify` and the recorded production fingerprint
 * are trusted. Nothing in the schema triggers it today — a CHECK enumerating a
 * value containing `--`, or a default with a doubled space, would.
 */
export function normalizeSchemaSql(sql) {
  const source = sql ?? "";
  // Alternating runs of code (comments stripped, whitespace collapsed) and
  // quoted tokens (copied byte for byte). Collecting them rather than rewriting
  // in place is what keeps a collapse from reaching inside a literal.
  const parts = [];
  let code = "";
  const flushCode = () => {
    parts.push(code.replace(/\s+/gu, " "));
    code = "";
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];

    // `'` is a string, `"` and `` ` `` and `[` are quoted identifiers. SQLite
    // escapes a quote by doubling it; `[` has no escape and ends at the first
    // `]`. An unterminated token runs to the end rather than throwing — this
    // reads schema from a database, not user input, and a parse error here
    // would be a worse failure than a conservative comparison.
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] !== closing) { end += 1; continue; }
        if (closing !== "]" && source[end + 1] === closing) { end += 2; continue; }
        end += 1;
        break;
      }
      flushCode();
      parts.push(source.slice(index, end));
      index = end;
      continue;
    }

    if (character === "-" && source[index + 1] === "-") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      code += " ";
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      code += " ";
      continue;
    }

    code += character;
    index += 1;
  }
  flushCode();

  return parts.join("").replace(/^ | $/gu, "");
}

/**
 * A `{ "type:name": digest }` map over a schema's objects.
 *
 * Digests rather than the DDL itself: the fingerprint is checked in beside a
 * baseline that already contains every statement in full, and a second copy
 * would double the review surface while adding nothing a hash does not. Keying
 * per object means a drift report names the table that moved instead of saying
 * the schema changed.
 */
export function schemaFingerprint(objects) {
  const fingerprint = {};
  for (const object of objects) {
    if (isInternalTableName(object.name) || isInternalTableName(object.tbl_name ?? "")) continue;
    if (typeof object.sql !== "string" || object.sql.trim() === "") continue;
    const digest = createHash("sha256").update(normalizeSchemaSql(object.sql)).digest("hex");
    fingerprint[`${object.type}:${object.name}`] = `sha256:${digest}`;
  }
  return fingerprint;
}

/**
 * Compares two fingerprints, returning what a person needs to act on: which
 * objects only one side has, and which exist on both but differ.
 */
export function compareFingerprints(expected, actual) {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  return {
    missing: expectedKeys.filter((key) => !(key in actual)).sort(),
    unexpected: actualKeys.filter((key) => !(key in expected)).sort(),
    changed: expectedKeys.filter((key) => key in actual && expected[key] !== actual[key]).sort(),
  };
}

/** Whether a comparison found nothing at all to report. */
export function fingerprintsMatch(comparison) {
  return comparison.missing.length === 0
    && comparison.unexpected.length === 0
    && comparison.changed.length === 0;
}

/**
 * Pulls the JSON payload out of `wrangler --json` output.
 *
 * Wrangler prints a banner before the payload, so the JSON has to be located
 * rather than parsed from the start. Taking the first `[` — the obvious way,
 * and the way this was first written — finds the bracket in wrangler's own
 * `[ERROR] …` line instead, so a failed command is reported as a JSON syntax
 * error rather than as the failure it was, and a caller asking "is this
 * database empty?" gets a parse error where it should get a refusal.
 *
 * Candidates are therefore filtered to brackets that can actually open a JSON
 * array, and each is tried until one parses.
 *
 * A banner line containing a bare `[]` passes that filter, but cannot win: each
 * candidate is parsed from its bracket **to the end of the output**, and
 * `JSON.parse` rejects trailing non-whitespace. So a candidate only succeeds if
 * it is the last thing wrangler printed, which the payload always is. Anything
 * that changes this to parse a bounded slice loses that property and has to
 * replace it with something else.
 */
export function parseWranglerJson(stdout, context) {
  for (let index = stdout.indexOf("["); index !== -1; index = stdout.indexOf("[", index + 1)) {
    if (!/^\[\s*[[{\]"]/u.test(stdout.slice(index, index + 8))) continue;
    try {
      const parsed = JSON.parse(stdout.slice(index));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not the payload — a bracket inside a log line. Keep looking.
    }
  }
  throw new Error(`wrangler returned no JSON for ${context}`);
}

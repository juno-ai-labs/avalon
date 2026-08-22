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
    const movedIn = new Map();
    let compared = 0;
    for (const [index, firstRow] of firstTableRows.entries()) {
      const secondRow = secondTableRows[index];
      if (!secondRow) continue;
      compared += 1;
      for (const column of Object.keys(firstRow)) {
        if (firstRow[column] !== secondRow[column]) movedIn.set(column, (movedIn.get(column) ?? 0) + 1);
      }
    }

    const names = [];
    for (const [column, moved] of movedIn) {
      // Volatility is recorded per column, but a table can seed several rows and
      // compute the column in only some of them. The renderer would then rewrite
      // every row's value as `datetime('now')`, replacing the stable ones — and
      // no test would notice, because the equivalence suite strips volatile
      // columns from both sides before comparing. Refusing keeps the per-column
      // shape honest; teaching the renderer per-row volatility is the fix if a
      // migration ever genuinely needs it.
      if (moved !== compared) {
        throw new Error(
          `${table}.${column} moved in ${moved} of ${compared} seeded rows. A column that is `
          + "computed in some rows and hardcoded in others cannot be re-derived per table without "
          + "overwriting the hardcoded ones; renderBaselineSql needs per-row volatility first.",
        );
      }
      names.push(column);
    }
    if (names.length > 0) volatileColumns[table] = names.sort();
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
 * **Known limitation, accepted rather than overlooked.** These regular
 * expressions run over the whole statement, so they cannot tell a comment from
 * the characters `--` inside a string literal, nor meaningful whitespace inside
 * one from trivia between tokens. `DEFAULT '--a'` and `DEFAULT '--b'` therefore
 * normalize to the same text and hash the same, as do `'a  b'` and `'a b'`.
 * `normalizeSchemaSqlCollides` in the test suite pins that this is still true.
 *
 * Reaching it needs production to have drifted from the migrations at all —
 * already an incident — *and* for that drift to sit exclusively inside a quoted
 * literal; drift touching anything else is still caught. The fix is a lexer that
 * copies quoted tokens verbatim, which was written and then reverted as more
 * machinery than that residue of risk warranted. Nothing in the schema triggers
 * it today: a CHECK enumerating a value containing `--`, or a default with a
 * doubled space, would be the first.
 */
export function normalizeSchemaSql(sql) {
  return (sql ?? "")
    .replace(/--[^\n]*/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\s+/gu, " ")
    .trim();
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

// ---------------------------------------------------------------------------
// Choosing a baseline, and deciding what to apply on top of it
// ---------------------------------------------------------------------------

/**
 * Reads the baselines manifest as a list, newest boundary last.
 *
 * Accepts the single-baseline shape the first version wrote (`{ baseline }`)
 * as well as the list (`{ baselines }`), so a checkout mid-upgrade still runs.
 */
export function readBaselineManifest(contents) {
  const parsed = typeof contents === "string" ? JSON.parse(contents) : contents;
  const baselines = parsed.baselines ?? (parsed.baseline ? [parsed.baseline] : []);
  return [...baselines].sort((left, right) => (left.through < right.through ? -1 : 1));
}

/**
 * The baselines that still describe the migrations on disk, newest first.
 *
 * A baseline is usable only if the files it claims to subsume are *exactly* the
 * files at or below its boundary today, and their contents still hash to what
 * it recorded. Either check failing means the chain moved underneath it — a
 * migration edited, or one inserted into a gap below the boundary — and the
 * snapshot no longer describes what replaying would produce.
 *
 * Unusable baselines are skipped rather than fatal: the chain is always there
 * to fall back to, and a setup command that refuses to run because a *cache* is
 * stale would be a worse trade than one that is briefly slower. The staleness
 * is still a test failure — `d1-baseline.test.mjs` asserts the checked-in
 * manifest matches disk — so it is loud in CI and quiet in your terminal, which
 * is the right way round.
 */
export function usableBaselines(baselines, migrationsOnDisk, digestFor) {
  return baselines
    .filter((baseline) => {
      const expected = migrationsOnDisk.filter((name) => name <= baseline.through);
      if (expected.length !== baseline.migrations.length) return false;
      if (expected.some((name, index) => name !== baseline.migrations[index])) return false;
      return digestFor(expected) === baseline.digest;
    })
    .sort((left, right) => (left.through < right.through ? 1 : -1));
}

/**
 * The baseline that gets a fresh database furthest, or null to replay the chain.
 *
 * "Furthest" is the largest subsumed set, not the newest file on disk: several
 * baselines can coexist, and the one that saves the most work is the one whose
 * boundary is highest. Everything after that boundary is applied on top by
 * Wrangler in the ordinary way, so adding a migration does not invalidate a
 * baseline — it just means there is one more thing to apply after it.
 */
export function selectBaseline(baselines, migrationsOnDisk, digestFor) {
  return usableBaselines(baselines, migrationsOnDisk, digestFor)[0] ?? null;
}

/**
 * What to do with one database, given what it already has.
 *
 * The three outcomes, and what separates them:
 *
 * - **`baseline`** — the database is empty, and a usable baseline exists. Apply
 *   the snapshot, then the migrations after its boundary.
 * - **`migrate`** — anything else with work outstanding. A database that has
 *   tables, or a ledger, gets the ordinary chain: a baseline reproduces a
 *   schema and cannot merge into one, and a ledger without the schema it
 *   describes is a failed migration rather than an invitation to start over.
 * - **`up-to-date`** — nothing pending.
 *
 * `allowBaseline` is how the hosted policy is expressed rather than assumed:
 * hosted databases replay the chain in full, so the caller passes `false` and
 * the plan can never be `baseline`. Keeping it a parameter rather than a
 * separate code path means the rule is one line, and a test can state it.
 *
 * `unknownApplied` names ledger rows with no file on disk. That is a database
 * ahead of this checkout — a branch that added migrations, or a rollback — and
 * it is reported rather than acted on, because guessing which is wrong.
 *
 * `outOfOrder` names pending migrations that sort *below* something the
 * database has already applied. Wrangler applies whatever is missing in sort
 * order without regard to what ran before, so such a file runs late on an old
 * database and early on a fresh one — and the two end up with different
 * schemas. It is silent: `ALTER TABLE` in the late file appends its column
 * after the earlier one's instead of before, so the columns exist, the
 * migration succeeds, and only the order differs. Where the inserted file
 * *creates* something a later one already used, it fails outright instead.
 *
 * A baseline makes this easier to hit rather than causing it: a baselined
 * database is fresh by construction, so it takes the fresh ordering while
 * production takes the late one. Reported rather than refused, because the
 * repair is a decision about migrations — renumber, or accept — that this
 * script cannot make.
 *
 * `applied` may be **null**, meaning the ledger was deliberately not read: a
 * database with tables is never baselined whatever its ledger says, so reading
 * it there costs a wrangler start-up to learn something that cannot change the
 * decision. The plan then carries `pending: null` rather than a count it did not
 * compute — an earlier version filled in "every migration is pending", which on
 * a fully migrated database is both wrong and alarming. Wrangler works the real
 * figure out when it runs.
 */
export function planMigration({
  applied = [],
  userTables = 0,
  baselines = [],
  migrationsOnDisk = [],
  digestFor,
  allowBaseline = true,
}) {
  const ledgerKnown = Array.isArray(applied);
  const appliedSet = new Set(ledgerKnown ? applied : []);
  const pending = ledgerKnown ? migrationsOnDisk.filter((name) => !appliedSet.has(name)) : null;
  const unknownApplied = ledgerKnown
    ? applied.filter((name) => !migrationsOnDisk.includes(name)).sort()
    : [];
  const highestApplied = ledgerKnown && applied.length > 0
    ? applied.reduce((highest, name) => (name > highest ? name : highest))
    : null;
  const outOfOrder = highestApplied === null
    ? []
    : (pending ?? []).filter((name) => name < highestApplied);
  const isEmpty = userTables === 0 && ledgerKnown && applied.length === 0;

  if (isEmpty && allowBaseline) {
    const baseline = selectBaseline(baselines, migrationsOnDisk, digestFor);
    if (baseline) {
      return {
        action: "baseline",
        baseline,
        thenApply: migrationsOnDisk.filter((name) => name > baseline.through),
        pending,
        unknownApplied,
        outOfOrder,
      };
    }
  }

  return {
    action: pending !== null && pending.length === 0 ? "up-to-date" : "migrate",
    baseline: null,
    thenApply: [],
    pending,
    unknownApplied,
    outOfOrder,
  };
}

/** One line saying what a region is about to do, and why. */
export function describePlan(region, plan) {
  const notes = [];
  if (plan.unknownApplied.length > 0) {
    notes.push(`${plan.unknownApplied.length} applied migration(s) not in this checkout: `
      + plan.unknownApplied.join(", "));
  }
  if (plan.outOfOrder.length > 0) {
    // Worth a sentence rather than a word: the reader has to know this produces
    // a different schema from a fresh database, not merely an odd ordering.
    notes.push(`out of order — ${plan.outOfOrder.join(", ")} sort(s) below a migration `
      + "this database already applied, so applying now gives it a different schema than a "
      + "fresh database gets");
  }
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  if (plan.action === "baseline") {
    const after = plan.thenApply.length === 0
      ? "nothing after it"
      : `${plan.thenApply.length} migration(s) after it`;
    return `${region}: empty — applying ${plan.baseline.file} (${plan.baseline.migrations.length} migrations), then ${after}.${suffix}`;
  }
  if (plan.action === "up-to-date") return `${region}: already up to date.${suffix}`;
  if (plan.pending === null) {
    return `${region}: has tables — Wrangler will apply whatever is still pending.${suffix}`;
  }
  return `${region}: applying ${plan.pending.length} pending migration(s) the ordinary way.${suffix}`;
}

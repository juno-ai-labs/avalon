// The baseline *mechanism* and the checked-in artifacts: name/boundary rules,
// the staleness digest, rendering order, and the recorded production
// fingerprint.
//
// The SQL behaviour of the generated file — that applying it reproduces a chain
// replay, that its guard refuses the databases it must refuse — is covered by
// `packages/db/test/baseline-migration.test.ts`, which runs the statements
// against real SQLite. The split is not arbitrary: that suite deliberately
// re-derives its expectations with its own comparison code instead of importing
// this module, so a bug in the helpers here cannot make both sides agree on the
// wrong answer.

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GUARD_CONSTRAINT_NAME,
  GUARD_TABLE_NAME,
  compareFingerprints,
  detectVolatileColumns,
  digestMigrations,
  fingerprintsMatch,
  internalTableExclusionSql,
  isInternalTableName,
  listMigrationFiles,
  normalizeSchemaSql,
  parseWranglerJson,
  renderBaselineSql,
  schemaFingerprint,
  snapshotDatabase,
  sqlLiteral,
  subsumedMigrations,
} from "./d1-baseline.mjs";
import { MIGRATIONS_DIRECTORY, baselineFileNameFor, buildBaseline, snapshotChain } from "./create-d1-baseline.mjs";
import { verifyAgainstRegions, baselineFingerprint, describeComparison } from "./check-d1-baseline-against-remote.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinesDirectory = join(repositoryRoot, "packages", "db", "baselines");
const manifest = JSON.parse(readFileSync(join(baselinesDirectory, "manifest.json"), "utf8")).baseline;
const baselineSql = readFileSync(join(baselinesDirectory, manifest.file), "utf8");

/**
 * Runs `body` against a throwaway migrations directory.
 *
 * Awaits an async body before cleaning up. A plain `try/finally` deletes the
 * directory the moment the body *returns its promise*, so the migrations
 * disappear while the body is still reading them — which is a confusing ENOENT
 * rather than a failed assertion.
 */
function withTemporaryMigrations(files, body) {
  const directory = mkdtempSync(join(tmpdir(), "avalon-baseline-"));
  const cleanUp = () => rmSync(directory, { recursive: true, force: true });
  let result;
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(directory, name), contents, "utf8");
    }
    result = body(directory);
  } catch (error) {
    cleanUp();
    throw error;
  }
  if (typeof result?.then === "function") return result.finally(cleanUp);
  cleanUp();
  return result;
}

// ---------------------------------------------------------------------------
// Boundary selection
// ---------------------------------------------------------------------------

test("the boundary is a file name, so both files sharing a sequence number are subsumed", () => {
  const all = listMigrationFiles(MIGRATIONS_DIRECTORY);
  const subsumed = subsumedMigrations(all, "0039_workstream_read_state.sql");
  // 0039 carries two files. A numeric boundary would take one and leave the
  // other pending forever on a baselined database while production ran both.
  assert.ok(subsumed.includes("0039_slack_connector.sql"));
  assert.ok(subsumed.includes("0039_workstream_read_state.sql"));
  assert.equal(subsumed.at(-1), "0039_workstream_read_state.sql");
  assert.ok(!subsumed.includes("0040_realtime_transcription_admission.sql"));
});

test("the boundary migration is itself included, and nothing after it is", () => {
  const all = listMigrationFiles(MIGRATIONS_DIRECTORY);
  const subsumed = subsumedMigrations(all, manifest.through);
  assert.equal(subsumed.at(-1), manifest.through);
  assert.ok(subsumed.every((name) => name <= manifest.through));
  const excluded = all.filter((name) => name > manifest.through);
  assert.ok(excluded.every((name) => !subsumed.includes(name)));
});

test("an unknown boundary is refused rather than silently producing an empty baseline", () => {
  assert.throws(
    () => subsumedMigrations(["0001_initial.sql"], "0099_not_a_migration.sql"),
    /is not a migration in this repository/u,
  );
});

test("a baseline is named b_<nnnn>_<text>.sql after the migration it stands through", () => {
  assert.equal(
    baselineFileNameFor("0090_drop_legacy_product_tables.sql"),
    "b_0090_drop_legacy_product_tables.sql",
  );
  assert.match(manifest.file, /^b_\d{4}_[a-z0-9][a-z0-9_.-]*\.sql$/u);
  assert.equal(manifest.file, baselineFileNameFor(manifest.through));
});

test("a name that is not a migration file cannot become a baseline name", () => {
  for (const bad of ["baseline.sql", "90_short.sql", "0090_drop.txt", "b_0090_already.sql"]) {
    assert.throws(() => baselineFileNameFor(bad), /is not a migration file name/u, bad);
  }
});

// ---------------------------------------------------------------------------
// Staleness — the property that makes a derived artifact safe to trust
// ---------------------------------------------------------------------------

test("the manifest lists exactly the migrations on disk at or below the boundary", () => {
  const expected = subsumedMigrations(listMigrationFiles(MIGRATIONS_DIRECTORY), manifest.through);
  assert.deepEqual(manifest.migrations, expected);
});

test("the manifest digest matches the migrations it claims to subsume", () => {
  // The gate. If this fails, a migration at or below the boundary was edited or
  // a new one was inserted below it — regenerating the baseline would bless the
  // change rather than surface it.
  assert.equal(digestMigrations(MIGRATIONS_DIRECTORY, manifest.migrations), manifest.digest);
});

test("editing a subsumed migration changes the digest", () => {
  withTemporaryMigrations({ "0001_a.sql": "CREATE TABLE a(id TEXT);" }, (directory) => {
    const before = digestMigrations(directory, ["0001_a.sql"]);
    writeFileSync(join(directory, "0001_a.sql"), "CREATE TABLE a(id INT);", "utf8");
    assert.notEqual(digestMigrations(directory, ["0001_a.sql"]), before);
  });
});

test("inserting a migration into a gap below the boundary changes the digest", () => {
  // 0084 is missing from this repository's sequence, so a later `0084_*.sql`
  // would sort *below* the 0090 boundary. Without this, every baselined
  // database would record it as applied and skip it forever, while production —
  // which has no such ledger row — would run it.
  withTemporaryMigrations({
    "0083_a.sql": "CREATE TABLE a(id TEXT);",
    "0085_c.sql": "CREATE TABLE c(id TEXT);",
  }, (directory) => {
    const boundary = "0085_c.sql";
    const before = digestMigrations(directory, subsumedMigrations(listMigrationFiles(directory), boundary));
    writeFileSync(join(directory, "0084_b.sql"), "CREATE TABLE b(id TEXT);", "utf8");
    const after = subsumedMigrations(listMigrationFiles(directory), boundary);
    assert.deepEqual(after, ["0083_a.sql", "0084_b.sql", "0085_c.sql"]);
    assert.notEqual(digestMigrations(directory, after), before);
  });
});

test("the digest frames each file, so a different split of the same bytes differs", () => {
  const split = withTemporaryMigrations(
    { "0001_a.sql": "CREATE TABLE ab(", "0002_b.sql": "id TEXT);" },
    (directory) => digestMigrations(directory, ["0001_a.sql", "0002_b.sql"]),
  );
  const joined = withTemporaryMigrations(
    { "0001_a.sql": "CREATE TABLE ab(id TEXT);", "0002_b.sql": "" },
    (directory) => digestMigrations(directory, ["0001_a.sql", "0002_b.sql"]),
  );
  assert.notEqual(split, joined);
});

test("renaming a subsumed migration changes the digest even when its bytes do not", () => {
  const original = withTemporaryMigrations(
    { "0001_first.sql": "CREATE TABLE a(id TEXT);" },
    (directory) => digestMigrations(directory, ["0001_first.sql"]),
  );
  const renamed = withTemporaryMigrations(
    { "0001_second.sql": "CREATE TABLE a(id TEXT);" },
    (directory) => digestMigrations(directory, ["0001_second.sql"]),
  );
  assert.notEqual(original, renamed);
});

// ---------------------------------------------------------------------------
// Volatile column detection
// ---------------------------------------------------------------------------

test("a column that differs between two chain replays is reported volatile", () => {
  const volatileColumns = detectVolatileColumns(
    { control: [{ id: 1, updated_at: "2026-08-21 10:00:00", phase: "legacy_open" }] },
    { control: [{ id: 1, updated_at: "2026-08-21 10:00:01", phase: "legacy_open" }] },
  );
  assert.deepEqual(volatileColumns, { control: ["updated_at"] });
});

test("identical replays report nothing volatile", () => {
  const rows = { control: [{ id: 1, updated_at: "2026-08-21 10:00:00" }] };
  assert.deepEqual(detectVolatileColumns(rows, structuredClone(rows)), {});
});

test("volatility is reported per table and covers every differing column", () => {
  const volatileColumns = detectVolatileColumns(
    { a: [{ x: 1, y: 1, z: 1 }], b: [{ q: "same" }] },
    { a: [{ x: 2, y: 1, z: 3 }], b: [{ q: "same" }] },
  );
  assert.deepEqual(volatileColumns, { a: ["x", "z"] });
});

test("a row the second replay did not produce is skipped rather than reported as volatile", () => {
  // Not a difference in a value — a difference in row count, which would mean
  // the chain is nondeterministic in a way freezing a literal cannot fix. It is
  // left for the equivalence suite to fail on loudly.
  assert.deepEqual(detectVolatileColumns({ a: [{ x: 1 }] }, { a: [] }), {});
  assert.deepEqual(detectVolatileColumns({ a: [{ x: 1 }] }, {}), {});
});

test("the real chain's volatile columns are exactly the two seeded timestamps", () => {
  assert.deepEqual(manifest.volatileColumns, {
    digest_reconciliation_control: ["updated_at"],
    workstream_authority_control: ["updated_at"],
  });
});

// ---------------------------------------------------------------------------
// SQL literals and internal-table classification
// ---------------------------------------------------------------------------

test("values round-trip into SQL literals", () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(undefined), "NULL");
  assert.equal(sqlLiteral(0), "0");
  assert.equal(sqlLiteral(-12.5), "-12.5");
  assert.equal(sqlLiteral(10n), "10");
  assert.equal(sqlLiteral("plain"), "'plain'");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral(new Uint8Array([0xde, 0xad])), "X'dead'");
});

test("a quoted string literal survives a round trip through SQLite", () => {
  const database = new DatabaseSync(":memory:");
  const hostile = "'; DROP TABLE t; --";
  database.exec("CREATE TABLE t (v TEXT)");
  database.exec(`INSERT INTO t (v) VALUES (${sqlLiteral(hostile)})`);
  assert.equal(database.prepare("SELECT v FROM t").get().v, hostile);
  database.close();
});

test("a value with no SQL literal is refused rather than rendered wrong", () => {
  assert.throws(() => sqlLiteral(Number.NaN), /has no SQL literal/u);
  assert.throws(() => sqlLiteral(Number.POSITIVE_INFINITY), /has no SQL literal/u);
  assert.throws(() => sqlLiteral({}), /Cannot render object/u);
});

test("both D1 runtimes' internal tables are classified internal", () => {
  // `_cf_KV` is hosted D1's; `_cf_METADATA` is local Miniflare's. An exact-name
  // list built from production passes offline and then refuses every real local
  // database, which is exactly how this was first written and first broke.
  for (const name of ["d1_migrations", "_cf_KV", "_cf_METADATA", "sqlite_sequence", GUARD_TABLE_NAME]) {
    assert.ok(isInternalTableName(name), name);
  }
  for (const name of ["users", "workspaces", "workstream_authority_control", "cf_reports", "my_sqlite_notes"]) {
    assert.ok(!isInternalTableName(name), name);
  }
});

test("the shared exclusion fragment escapes the underscore wildcard", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE users (id TEXT);
                 CREATE TABLE "_cf_METADATA" (k TEXT);
                 CREATE TABLE "xcf_notes" (k TEXT);`);
  const names = database
    .prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND ${internalTableExclusionSql()} ORDER BY name`)
    .all().map((row) => row.name);
  // `xcf_notes` proves the `_` in `_cf_` is matched literally: an unescaped
  // LIKE pattern would treat it as "any character" and hide this table too.
  assert.deepEqual(names, ["users", "xcf_notes"]);
  database.close();
});

// ---------------------------------------------------------------------------
// Rendering rules
// ---------------------------------------------------------------------------

function renderFixture(overrides = {}) {
  return renderBaselineSql({
    through: "0002_b.sql",
    files: ["0001_a.sql", "0002_b.sql"],
    digest: "sha256:abc",
    snapshot: {
      objects: [
        { type: "table", name: "t", tbl_name: "t", sql: "CREATE TABLE t (id TEXT, stamped TEXT)" },
        { type: "index", name: "t_idx", tbl_name: "t", sql: "CREATE INDEX t_idx ON t(id)" },
        { type: "trigger", name: "t_guard", tbl_name: "t", sql: "CREATE TRIGGER t_guard BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'no'); END" },
      ],
      rows: { t: [{ id: "one", stamped: "2026-08-21 10:00:00" }] },
    },
    volatileColumns: { t: ["stamped"] },
    ...overrides,
  });
}

test("triggers are rendered after the seeded rows so they cannot fire on them", () => {
  const sql = renderFixture();
  assert.ok(sql.indexOf("INSERT INTO \"t\"") < sql.indexOf("CREATE TRIGGER t_guard"));
  // And the rendered file actually survives execution — a trigger that aborts
  // every insert would take the file down if it were created first.
  const database = new DatabaseSync(":memory:");
  database.exec(sql);
  assert.equal(database.prepare("SELECT COUNT(*) c FROM t").get().c, 1);
  database.close();
});

test("the ledger claim is rendered last, after every object it describes", () => {
  const sql = renderFixture();
  assert.ok(sql.lastIndexOf("CREATE TABLE t ") < sql.indexOf("INSERT OR IGNORE INTO d1_migrations"));
  assert.ok(sql.indexOf("CREATE TRIGGER t_guard") < sql.indexOf("INSERT OR IGNORE INTO d1_migrations"));
});

test("a volatile column is re-derived on apply and a stable one is frozen", () => {
  const sql = renderFixture();
  assert.match(sql, /datetime\('now'\)/u);
  assert.ok(!sql.includes("2026-08-21 10:00:00"), "the volatile literal must not be frozen into the file");
  assert.ok(sql.includes("'one'"), "a stable value is frozen");
});

test("the emptiness guard is rendered before any object is created", () => {
  const sql = renderFixture();
  assert.ok(sql.indexOf(GUARD_CONSTRAINT_NAME) < sql.indexOf("CREATE TABLE t "));
});

test("a snapshot omits constraint indexes SQLite creates without SQL of their own", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE t (id TEXT PRIMARY KEY, email TEXT UNIQUE)");
  const { objects } = snapshotDatabase(database);
  assert.deepEqual(objects.map((object) => object.name), ["t"]);
  database.close();
});

// ---------------------------------------------------------------------------
// The checked-in artifacts
// ---------------------------------------------------------------------------

test("the baseline lives outside the directory Wrangler applies migrations from", () => {
  // Wrangler applies every `.sql` file in `migrations_dir`. A baseline in there
  // would be applied as the next migration on every database including
  // production, where it would collide with the schema already present.
  assert.ok(!listMigrationFiles(MIGRATIONS_DIRECTORY).includes(manifest.file));
  assert.ok(!baselinesDirectory.startsWith(MIGRATIONS_DIRECTORY));
});

test("the baseline records exactly the subsumed migrations in its ledger", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baselineSql);
  const recorded = database.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name);
  assert.deepEqual(recorded, manifest.migrations);
  database.close();
});

test("the baseline's object counts match the manifest", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(baselineSql);
  const { objects, rows } = snapshotDatabase(database);
  assert.deepEqual({
    tables: objects.filter((object) => object.type === "table").length,
    indexes: objects.filter((object) => object.type === "index").length,
    triggers: objects.filter((object) => object.type === "trigger").length,
  }, manifest.objectCounts);
  assert.deepEqual(
    Object.fromEntries(Object.entries(rows).map(([table, tableRows]) => [table, tableRows.length])),
    manifest.seededRowCounts,
  );
  database.close();
});

test("the baseline reproduces the schema recorded from the hosted databases", () => {
  // The offline half of `pnpm db:baseline:verify`: that script needs Cloudflare
  // credentials, this assertion keeps its answer enforced on every run without
  // them. A failure means the baseline no longer describes what production has.
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  const comparison = compareFingerprints(recorded.objects, baselineFingerprint(baselineSql));
  assert.ok(fingerprintsMatch(comparison), describeComparison("baseline vs recorded production", comparison).join("\n"));
  assert.equal(recorded.through, manifest.through);
});

test("the recorded production fingerprint covers every object the baseline creates", () => {
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  assert.equal(
    Object.keys(recorded.objects).length,
    manifest.objectCounts.tables + manifest.objectCounts.indexes + manifest.objectCounts.triggers,
  );
});

// ---------------------------------------------------------------------------
// Comparison and reporting
// ---------------------------------------------------------------------------

test("a fingerprint comparison separates missing, unexpected, and changed objects", () => {
  const comparison = compareFingerprints(
    { "table:a": "sha256:1", "table:b": "sha256:2", "table:c": "sha256:3" },
    { "table:a": "sha256:1", "table:b": "sha256:changed", "table:d": "sha256:4" },
  );
  assert.deepEqual(comparison, { missing: ["table:c"], unexpected: ["table:d"], changed: ["table:b"] });
  assert.equal(fingerprintsMatch(comparison), false);
  assert.ok(fingerprintsMatch(compareFingerprints({ "table:a": "x" }, { "table:a": "x" })));
});

test("comments and whitespace do not count as a schema difference", () => {
  // A hosted database returns `CREATE TABLE` DDL with its comments stripped,
  // while the same statement replayed through node:sqlite keeps them —
  // `telemetry_eu_events` is the case in this schema. Comparing raw text
  // reports it on every run, which trains everyone to ignore the check.
  const withComments = "CREATE TABLE t (\n  -- why\n  id TEXT\n)";
  const without = "CREATE TABLE t ( id TEXT )";
  assert.equal(normalizeSchemaSql(withComments), normalizeSchemaSql(without));
  assert.deepEqual(
    schemaFingerprint([{ type: "table", name: "t", tbl_name: "t", sql: withComments }]),
    schemaFingerprint([{ type: "table", name: "t", tbl_name: "t", sql: without }]),
  );
});

test("a real definition change is still a difference after normalization", () => {
  assert.notEqual(
    normalizeSchemaSql("CREATE TABLE t (id TEXT)"),
    normalizeSchemaSql("CREATE TABLE t (id INTEGER)"),
  );
});

test("a fingerprint ignores internal tables and objects with no SQL", () => {
  const fingerprint = schemaFingerprint([
    { type: "table", name: "users", tbl_name: "users", sql: "CREATE TABLE users (id TEXT)" },
    { type: "table", name: "_cf_METADATA", tbl_name: "_cf_METADATA", sql: "CREATE TABLE _cf_METADATA (k TEXT)" },
    { type: "table", name: "d1_migrations", tbl_name: "d1_migrations", sql: "CREATE TABLE d1_migrations (id INT)" },
    { type: "index", name: "sqlite_autoindex_users_1", tbl_name: "users", sql: null },
  ]);
  assert.deepEqual(Object.keys(fingerprint), ["table:users"]);
});

test("the region check reports a divergence between two hosted databases as itself", () => {
  const table = (sql) => [{ type: "table", name: "t", tbl_name: "t", sql }];
  const baseline = schemaFingerprint(table("CREATE TABLE t (id TEXT)"));
  const { ok, lines } = verifyAgainstRegions({
    baseline,
    regionSchemas: { global: table("CREATE TABLE t (id TEXT)"), eu: table("CREATE TABLE t (id INTEGER)") },
  });
  assert.equal(ok, false);
  assert.ok(lines.some((line) => line.startsWith("baseline vs eu: MISMATCH")));
  assert.ok(lines.some((line) => line.startsWith("global vs eu: MISMATCH")));
  assert.ok(lines.some((line) => line.includes("definition differs:    table:t")));
});

test("the region check passes only when the baseline and both regions agree", () => {
  const table = [{ type: "table", name: "t", tbl_name: "t", sql: "CREATE TABLE t (id TEXT)" }];
  const { ok, lines } = verifyAgainstRegions({
    baseline: schemaFingerprint(table),
    regionSchemas: { global: table, eu: table },
  });
  assert.equal(ok, true);
  assert.deepEqual(lines, ["baseline vs global: match", "baseline vs eu: match", "global vs eu: match"]);
});

// ---------------------------------------------------------------------------
// The generator, end to end on a synthetic chain
// ---------------------------------------------------------------------------

test("a generated baseline reproduces the chain it was generated from", () => {
  withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE a (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
    "0002_b.sql": `CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT REFERENCES a(id));
                   CREATE INDEX b_a_idx ON b(a_id);
                   INSERT INTO b (id, a_id) VALUES ('seed', NULL);`,
    "0003_c.sql": "ALTER TABLE a ADD COLUMN extra TEXT;",
  }, (directory) => {
    const files = subsumedMigrations(listMigrationFiles(directory), "0003_c.sql");
    const chain = snapshotChain(directory, files);
    const sql = renderBaselineSql({
      through: "0003_c.sql",
      files,
      digest: digestMigrations(directory, files),
      snapshot: chain,
    });
    const database = new DatabaseSync(":memory:");
    database.exec(sql);
    const rebuilt = snapshotDatabase(database);
    assert.deepEqual(
      rebuilt.objects.map((object) => normalizeSchemaSql(object.sql)),
      chain.objects.map((object) => normalizeSchemaSql(object.sql)),
    );
    assert.deepEqual(rebuilt.rows, chain.rows);
    // `ALTER TABLE ADD COLUMN` is the case worth naming: SQLite rewrites the
    // stored CREATE statement, so a baseline carries the altered table as one
    // definition rather than replaying the alteration.
    assert.match(rebuilt.objects.find((object) => object.name === "a").sql, /extra TEXT/u);
    database.close();
  });
});

test("the generated file refuses a database that already has the schema", () => {
  withTemporaryMigrations({ "0001_a.sql": "CREATE TABLE a (id TEXT);" }, (directory) => {
    const files = ["0001_a.sql"];
    const sql = renderBaselineSql({
      through: "0001_a.sql",
      files,
      digest: digestMigrations(directory, files),
      snapshot: snapshotChain(directory, files),
    });
    const database = new DatabaseSync(":memory:");
    database.exec(sql);
    assert.throws(() => database.exec(sql), new RegExp(GUARD_CONSTRAINT_NAME, "u"));
    database.close();
  });
});

test("a baseline copied into the migrations directory would be applied twice", () => {
  // Documents the reason the two directories are separate, by demonstrating the
  // failure rather than asserting a path string.
  withTemporaryMigrations({ "0001_a.sql": "CREATE TABLE a (id TEXT);" }, (directory) => {
    const staging = mkdtempSync(join(tmpdir(), "avalon-baseline-staging-"));
    try {
      cpSync(directory, staging, { recursive: true });
      const files = ["0001_a.sql"];
      writeFileSync(join(staging, "b_0001_a.sql"), renderBaselineSql({
        through: "0001_a.sql",
        files,
        digest: digestMigrations(directory, files),
        snapshot: snapshotChain(directory, files),
      }), "utf8");
      // Wrangler sorts and applies every `.sql` file it finds, so the baseline
      // would run after the migration it subsumes and hit its own guard.
      const applied = listMigrationFiles(staging);
      assert.deepEqual(applied, ["0001_a.sql", "b_0001_a.sql"]);
      const database = new DatabaseSync(":memory:");
      assert.throws(
        () => { for (const name of applied) database.exec(readFileSync(join(staging, name), "utf8")); },
        new RegExp(GUARD_CONSTRAINT_NAME, "u"),
      );
      database.close();
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Locating wrangler's JSON payload
// ---------------------------------------------------------------------------

test("the payload is found after wrangler's banner", () => {
  const stdout = `⛅️ wrangler 4.123.0\n────────\nResource location: local\n${JSON.stringify([{ results: [{ a: 1 }] }])}`;
  assert.deepEqual(parseWranglerJson(stdout, "global"), [{ results: [{ a: 1 }] }]);
});

test("a bracket inside wrangler's own log lines is not mistaken for the payload", () => {
  // `[ERROR]` and `[WARNING]` both contain the bracket that the obvious
  // implementation takes as the start of the JSON, which turns a reported
  // failure into a JSON syntax error and loses the message that said what
  // actually went wrong.
  const stdout = `▲ [WARNING] Proxy environment variables detected.\n`
    + `✘ [ERROR] something failed\n${JSON.stringify([{ results: [] }])}`;
  assert.deepEqual(parseWranglerJson(stdout, "global"), [{ results: [] }]);
});

test("output carrying no payload at all is an error naming the region", () => {
  assert.throws(
    () => parseWranglerJson("✘ [ERROR] could not open database", "eu"),
    /wrangler returned no JSON for eu/u,
  );
  assert.throws(() => parseWranglerJson("", "global"), /wrangler returned no JSON for global/u);
});

test("an empty result set is a payload, not an absence", () => {
  assert.deepEqual(parseWranglerJson("banner\n[]", "global"), []);
});

test("regenerating a baseline from unchanged migrations produces identical bytes", async () => {
  // So that regenerating at an unchanged boundary is a no-op in review rather
  // than a diff nobody can read. The real chain's two volatile timestamps are
  // the only thing that could vary, and they are rendered as an expression
  // rather than a value — this proves nothing else slipped in.
  await withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);",
    "0002_b.sql": "CREATE TABLE b (id TEXT PRIMARY KEY, at TEXT);\nINSERT INTO b (id, at) VALUES ('x', datetime('now'));",
  }, async (directory) => {
    const options = { through: "0002_b.sql", directory, settleMilliseconds: 1100 };
    const first = await buildBaseline(options);
    const second = await buildBaseline(options);
    assert.equal(first.sql, second.sql);
    assert.deepEqual(first.manifestEntry, second.manifestEntry);
    assert.deepEqual(first.manifestEntry.volatileColumns, { b: ["at"] });
  });
});

test("a bare [] in a banner line does not win over the real payload", () => {
  // The one way the bracket filter could pick wrong, and why it cannot: every
  // candidate is parsed to the end of the output, so an earlier `[]` fails on
  // the trailing payload rather than being returned as an empty result set —
  // which `inspectLocalDatabase` would otherwise read as "this database is
  // empty" for a database that is not.
  const stdout = `▲ [WARNING] retries: []\n${JSON.stringify([{ results: [{ user_tables: 42 }] }])}`;
  assert.deepEqual(parseWranglerJson(stdout, "global"), [{ results: [{ user_tables: 42 }] }]);
});

test("a payload that is the last thing printed is still found when it is empty", () => {
  assert.deepEqual(parseWranglerJson("▲ [WARNING] retries: []\n[]", "global"), []);
});

// ---------------------------------------------------------------------------
// Normalization must not reach inside a quoted token
// ---------------------------------------------------------------------------

test("a comment sequence inside a string literal is not treated as a comment", () => {
  // Two different schemas hashing equal is the exact failure the fingerprint
  // exists to detect, and it is worse than no check because the production
  // drift comparison is trusted. A regex over the whole statement cannot tell
  // `--` in a literal from a comment, and collapses both defaults to
  // `DEFAULT '`.
  const a = "CREATE TABLE t (v TEXT DEFAULT '--a')";
  const b = "CREATE TABLE t (v TEXT DEFAULT '--b')";
  assert.notEqual(normalizeSchemaSql(a), normalizeSchemaSql(b));
  assert.match(normalizeSchemaSql(a), /'--a'/u);
});

test("a block-comment sequence inside a string literal is preserved", () => {
  assert.notEqual(
    normalizeSchemaSql("CREATE TABLE t (v TEXT DEFAULT '/*x*/')"),
    normalizeSchemaSql("CREATE TABLE t (v TEXT DEFAULT '/*y*/')"),
  );
});

test("whitespace inside a string literal is significant", () => {
  assert.notEqual(
    normalizeSchemaSql("CREATE TABLE t (v TEXT DEFAULT 'a  b')"),
    normalizeSchemaSql("CREATE TABLE t (v TEXT DEFAULT 'a b')"),
  );
});

test("a quote escaped by doubling does not end the literal early", () => {
  const doubled = normalizeSchemaSql("CREATE TABLE t (v TEXT DEFAULT 'it''s  x', w TEXT)");
  assert.match(doubled, /'it''s {2}x'/u);
  assert.match(doubled, /, w TEXT\)/u);
});

test("whitespace inside a quoted or bracketed identifier is significant", () => {
  for (const [open, close] of [['"', '"'], ["`", "`"], ["[", "]"]]) {
    assert.notEqual(
      normalizeSchemaSql(`CREATE TABLE ${open}a  b${close} (id TEXT)`),
      normalizeSchemaSql(`CREATE TABLE ${open}a b${close} (id TEXT)`),
      `${open}${close}`,
    );
  }
});

test("a comment outside a literal is still removed, and separates its neighbours", () => {
  assert.equal(
    normalizeSchemaSql("CREATE TABLE t (\n  -- why\n  id TEXT\n)"),
    normalizeSchemaSql("CREATE TABLE t ( id TEXT )"),
  );
  assert.equal(
    normalizeSchemaSql("CREATE TABLE t (/* c */ id TEXT)"),
    normalizeSchemaSql("CREATE TABLE t ( id TEXT)"),
  );
});

test("an unterminated literal is copied to the end rather than throwing", () => {
  // This reads schema back from a database, not user input; a parse error would
  // be a worse failure than a conservative comparison.
  assert.equal(normalizeSchemaSql("CREATE TABLE t (v TEXT DEFAULT 'oops"), "CREATE TABLE t (v TEXT DEFAULT 'oops");
});

test("normalization leaves every real schema object in the baseline unchanged", () => {
  // Guards the recorded production fingerprint: a change to normalization that
  // moves any of the 129 objects invalidates `production-fingerprint.json`,
  // which then has to be re-recorded against the hosted databases rather than
  // regenerated locally.
  const database = new DatabaseSync(":memory:");
  database.exec(baselineSql);
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  assert.deepEqual(schemaFingerprint(snapshotDatabase(database).objects), recorded.objects);
  database.close();
});

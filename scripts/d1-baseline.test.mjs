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
  assertEveryObjectRenderable,
  assertVolatileValuesAreTimestamps,
  assertWranglerWillNotRewrite,
  compareFingerprints,
  compareMigrationPaths,
  detectVolatileColumns,
  digestMigrations,
  fingerprintsMatch,
  internalTableExclusionSql,
  isInternalTableName,
  listMigrationFiles,
  narrowBigInt,
  normalizeSchemaSql,
  orderSeededTables,
  parseWranglerJson,
  readBaselineManifest,
  renderBaselineSql,
  sameSeededValue,
  schemaFingerprint,
  snapshotDatabase,
  sqlLiteral,
  subsumedMigrations,
  usableBaselines,
} from "./d1-baseline.mjs";
import { MIGRATIONS_DIRECTORY, baselineFileNameFor, buildBaseline, snapshotChain } from "./create-d1-baseline.mjs";
import { verifyAgainstRegions, chainFingerprint, describeComparison } from "./check-d1-baseline-against-remote.mjs";
import { discoverRegions } from "./migrate-d1.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinesDirectory = join(repositoryRoot, "packages", "db", "baselines");
// The newest baseline: the one an empty database would be given, and the one
// whose boundary the single-baseline assertions below are about.
const manifest = readBaselineManifest(readFileSync(join(baselinesDirectory, "manifest.json"), "utf8")).at(-1);
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
  assert.ok(subsumed.every((name) => compareMigrationPaths(name, manifest.through) <= 0));
  const excluded = all.filter((name) => compareMigrationPaths(name, manifest.through) > 0);
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

const FIXTURE_STAMP = "2026-08-21 10:00:00";

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
      rows: { t: [{ id: "one", stamped: FIXTURE_STAMP }] },
    },
    volatileColumns: { t: ["stamped"] },
    // Pinned rather than left to the wall clock: the generator requires a
    // volatile value to be roughly now, and a fixture that drifted out of that
    // window would fail for the date rather than for anything it tests.
    now: Date.parse(`${FIXTURE_STAMP.replace(" ", "T")}Z`),
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
  assert.ok(!sql.includes(FIXTURE_STAMP), "the volatile literal must not be frozen into the file");
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

test("the migration chain reproduces the schema recorded from the hosted databases", () => {
  // The offline half of `pnpm db:baseline:verify`: that script needs Cloudflare
  // credentials, this assertion keeps its answer enforced on every run without
  // them. A failure means the chain no longer describes what production has.
  //
  // The chain rather than a baseline, so this stays correct once migrations
  // land above a boundary: a baseline describes its own boundary, and comparing
  // it to production would then report every newer migration as drift.
  // `packages/db/test/baseline-migration.test.ts` ties the baselines to the
  // chain; this ties the chain to production.
  // Compared against the chain **truncated at what was recorded**, not the whole
  // chain. Recording needs Cloudflare credentials and needs the migration to
  // already be live, neither of which a PR that adds `0091_*.sql` can have — so
  // fingerprinting the full chain here would redden this suite on every
  // migration PR with the only sanctioned repair being to merge and deploy it
  // first. Truncating keeps the assertion enforced on everything production is
  // known to have while staying silent about what it has not been given yet.
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  const comparison = compareFingerprints(recorded.objects, chainFingerprint(MIGRATIONS_DIRECTORY, {
    through: recorded.through,
  }));
  assert.ok(fingerprintsMatch(comparison), describeComparison("chain vs recorded production", comparison).join("\n"));
  // A floor rather than an equality: the recording may lag the chain, but it may
  // never name a migration this checkout does not have. That happens when a
  // migration is deleted or renamed after being deployed, which is the one way
  // the truncation above could quietly start comparing a different chain.
  assert.ok(
    listMigrationFiles(MIGRATIONS_DIRECTORY).includes(recorded.through),
    `production-fingerprint.json was recorded through ${recorded.through}, which is no longer on disk`,
  );
});

test("the recorded production fingerprint covers every object the chain creates", () => {
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  const truncated = chainFingerprint(MIGRATIONS_DIRECTORY, { through: recorded.through });
  assert.equal(Object.keys(recorded.objects).length, Object.keys(truncated).length);
});

test("the recorded production fingerprint covers every region this checkout has", () => {
  // Retirement does not rewrite a historical production observation. Every
  // current deployment must still be covered by the recorded baseline.
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  for (const { region } of discoverRegions()) {
    assert.ok(recorded.regions.includes(region), `Record the baseline fingerprint for ${region}`);
  }
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
  assert.equal(
    normalizeSchemaSql("CREATE TABLE t (/* c */ id TEXT)"),
    normalizeSchemaSql("CREATE TABLE t ( id TEXT)"),
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
    expected: baseline,
    regionSchemas: { global: table("CREATE TABLE t (id TEXT)"), enterprise: table("CREATE TABLE t (id INTEGER)") },
  });
  assert.equal(ok, false);
  assert.ok(lines.some((line) => line.startsWith("chain vs enterprise: MISMATCH")));
  assert.ok(lines.some((line) => line.startsWith("global vs enterprise: MISMATCH")));
  assert.ok(lines.some((line) => line.includes("definition differs:    table:t")));
});

test("the region check passes only when the baseline and both regions agree", () => {
  const table = [{ type: "table", name: "t", tbl_name: "t", sql: "CREATE TABLE t (id TEXT)" }];
  const { ok, lines } = verifyAgainstRegions({
    expected: schemaFingerprint(table),
    regionSchemas: { global: table, enterprise: table },
  });
  assert.equal(ok, true);
  assert.deepEqual(lines, ["chain vs global: match", "chain vs enterprise: match", "global vs enterprise: match"]);
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
    () => parseWranglerJson("✘ [ERROR] could not open database", "enterprise"),
    /wrangler returned no JSON for enterprise/u,
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
// Normalization: what it protects, and what it knowingly does not
// ---------------------------------------------------------------------------

test("normalizeSchemaSqlCollides: quoted literals are not protected, and that is accepted", () => {
  // **This test asserts a limitation, not a feature.** `normalizeSchemaSql`
  // strips comments and collapses whitespace with regular expressions over the
  // whole statement, so it cannot tell a comment from the characters `--`
  // inside a string literal, nor significant whitespace inside one from trivia
  // between tokens. Two different schemas therefore fingerprint identically.
  //
  // It is written down rather than fixed because reaching it needs production
  // to have drifted from the migrations at all — already an incident — *and*
  // for that drift to sit exclusively inside a quoted literal; drift touching
  // anything else is still caught. The fix is a lexer that copies quoted tokens
  // verbatim. It was written, reviewed, and reverted as more machinery than
  // that residue of risk warranted.
  //
  // What it costs when it bites: `db:baseline:verify` reports `match` on a
  // drifted database, and `-- --record` writes that drift into
  // `production-fingerprint.json` as the new truth. There is no second
  // comparator behind this one — the PRAGMA suite covers baseline-versus-chain,
  // not baseline-versus-production.
  //
  // **If this test fails, someone has fixed it.** Delete this test and keep
  // theirs; do not "repair" it back to asserting the collision.
  const collides = (a, b) => normalizeSchemaSql(a) === normalizeSchemaSql(b);
  assert.ok(collides(
    "CREATE TABLE t (v TEXT DEFAULT '--a')",
    "CREATE TABLE t (v TEXT DEFAULT '--b')",
  ), "comment marker inside a literal");
  assert.ok(collides(
    "CREATE TABLE t (v TEXT DEFAULT 'a  b')",
    "CREATE TABLE t (v TEXT DEFAULT 'a b')",
  ), "doubled whitespace inside a literal");
  assert.ok(collides(
    'CREATE TABLE "a  b" (id TEXT)',
    'CREATE TABLE "a b" (id TEXT)',
  ), "doubled whitespace inside a quoted identifier");
});

test("normalization leaves every real schema object in the baseline unchanged", () => {
  // Guards the recorded production fingerprint: a change to normalization that
  // moves any of the 129 objects invalidates `production-fingerprint.json`,
  // which then has to be re-recorded against the hosted databases rather than
  // regenerated locally.
  const recorded = JSON.parse(readFileSync(join(baselinesDirectory, "production-fingerprint.json"), "utf8"));
  // Truncated at the recording for the same reason as the parity test above: a
  // migration that is on disk but not yet in production is not a normalization
  // change, and this assertion exists to catch normalization changes.
  assert.deepEqual(chainFingerprint(MIGRATIONS_DIRECTORY, { through: recorded.through }), recorded.objects);
});

// ---------------------------------------------------------------------------
// The generator refuses what it cannot render faithfully
// ---------------------------------------------------------------------------

test("a volatile column the chain computes with a modifier stops generation", async () => {
  // The shape test alone cannot tell `datetime('now')` from
  // `datetime('now', '+1 day')` — both produce `YYYY-MM-DD HH:MM:SS` — and the
  // renderer writes only the first. Detection would find the column, the file
  // would be written with a value a day earlier than any replay produces, and
  // nothing downstream would notice: the equivalence suite strips volatile
  // columns from both sides before comparing.
  await withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE ctl (id INTEGER PRIMARY KEY, due_at TEXT NOT NULL);\n"
      + "INSERT INTO ctl (id, due_at) VALUES (1, datetime('now', '+1 day'));",
  }, async (directory) => {
    await assert.rejects(
      () => buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 1100 }),
      /ctl\.due_at is volatile and holds .* which is \d+s from now/u,
    );
  });
});

test("a volatile column the chain computes with plain datetime('now') is accepted", async () => {
  // The other half of the check above: the tolerance has to be wide enough for
  // a slow replay, or every real generation would fail on the same rule.
  await withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE ctl (id INTEGER PRIMARY KEY, stamped_at TEXT NOT NULL);\n"
      + "INSERT INTO ctl (id, stamped_at) VALUES (1, datetime('now'));",
  }, async (directory) => {
    const { sql, manifestEntry } = await buildBaseline({
      through: "0001_a.sql",
      directory,
      settleMilliseconds: 1100,
    });
    assert.deepEqual(manifestEntry.volatileColumns, { ctl: ["stamped_at"] });
    assert.match(sql, /datetime\('now'\)/u);
  });
});

test("a seeded TEXT value SQLite hands back truncated stops generation", () => {
  // `node:sqlite` returns TEXT only as far as its first embedded NUL, and the
  // shortened string is indistinguishable from a real one afterwards. Both
  // replays truncate the same way, so volatility detection reports nothing and
  // the baseline is written with the short value — the one failure in this file
  // that produces a file which applies cleanly and is silently wrong.
  withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE a (id TEXT PRIMARY KEY, note TEXT);\n"
      + "INSERT INTO a (id, note) VALUES ('1', CAST(X'610062' AS TEXT));",
  }, (directory) => {
    const files = ["0001_a.sql"];
    const snapshot = snapshotChain(directory, files);
    assert.equal(snapshot.rows.a[0].note, "a", "the probe must be truncated on the way out");
    assert.equal(Number(snapshot.byteLengths.a[0].note), 3, "SQLite must still hold all three bytes");
    assert.throws(
      () => renderBaselineSql({ through: "0001_a.sql", files, digest: "sha256:x", snapshot }),
      /a\.note holds 3 bytes but reads back as 1/u,
    );
  });
});

test("an AUTOINCREMENT counter beyond 2\u00b3 survives the round trip exactly", () => {
  // `seq` is the highest id ever *issued*, so one explicit insert of an external
  // id — a snowflake, a millisecond timestamp — puts a value past 2^53 there
  // permanently. Reading it without BigInt support throws mid-snapshot, and
  // narrowing through `Number()` rounds it down, which reissues exactly the
  // retired ids the sequence block exists to protect.
  const big = 9007199254740993n;
  withTemporaryMigrations({
    "0001_a.sql": `CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT);\n`
      + `INSERT INTO a (id, note) VALUES (${big}, 'issued');\n`
      + "DELETE FROM a;",
  }, (directory) => {
    const files = ["0001_a.sql"];
    const snapshot = snapshotChain(directory, files);
    const sequence = snapshot.sequences.find((entry) => entry.name === "a");
    assert.equal(sequence.seq, big, "the counter must survive the read as an exact integer");

    const sql = renderBaselineSql({ through: "0001_a.sql", files, digest: "sha256:x", snapshot });
    assert.match(sql, new RegExp(`VALUES \\('a', ${big}\\)`, "u"));

    // And the rebuilt database issues the next id after it, not a reused one.
    const rebuilt = new DatabaseSync(":memory:");
    rebuilt.exec(sql);
    rebuilt.prepare("INSERT INTO a (note) VALUES ('after')").run();
    const statement = rebuilt.prepare("SELECT id FROM a");
    statement.setReadBigInts(true);
    assert.equal(statement.get().id, big + 1n);
    rebuilt.close();
  });
});

test("a REAL too large for decimal notation renders as SQL that parses", () => {
  // `${value}.0` is only a REAL literal while `String` stays in decimal form; at
  // 1e21 it switches to exponent notation and the suffix lands after the
  // exponent. The generated file would be committed and reviewed before
  // anything tried to apply it.
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE t (v ANY) STRICT; INSERT INTO t VALUES (${sqlLiteral(1e21, "real")});`);
  assert.equal(database.prepare("SELECT typeof(v) AS t FROM t").get().t, "real");
  database.close();
  assert.equal(sqlLiteral(1e21, "real"), "1e+21");
  assert.equal(sqlLiteral(2, "real"), "2.0", "decimal-form integers still need the suffix");
});

test("an object type the renderer cannot emit stops generation instead of vanishing", () => {
  // A view would be read from `sqlite_schema`, partitioned into nothing, and
  // silently absent from the baseline. Nothing offline would catch it — the
  // equivalence suite asserts on tables, per-table shapes and triggers, and
  // `objectCounts` has no slot for it — so only the credentialed remote verify
  // would ever notice.
  withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE a (id TEXT PRIMARY KEY, name TEXT);\nCREATE VIEW a_named AS SELECT name FROM a;",
  }, (directory) => {
    const files = ["0001_a.sql"];
    const snapshot = snapshotChain(directory, files);
    assert.ok(snapshot.objects.some((object) => object.type === "view"), "the probe must produce a view");
    assert.throws(
      () => renderBaselineSql({ through: "0001_a.sql", files, digest: "sha256:x", snapshot }),
      /Cannot render view:a_named into a baseline/u,
    );
  });
});

test("the checked-in baseline's chain holds nothing the renderer would drop", () => {
  const files = subsumedMigrations(listMigrationFiles(MIGRATIONS_DIRECTORY), manifest.through);
  assert.doesNotThrow(() => assertEveryObjectRenderable(snapshotChain(MIGRATIONS_DIRECTORY, files).objects));
});

test("a volatile column datetime('now') could not have produced stops generation", () => {
  // Detection is expression-agnostic; re-derivation writes one expression. A
  // column the chain computes another way would be detected correctly and then
  // rewritten as a text timestamp — a `strftime('%s','now')` epoch integer
  // landing in an INTEGER column as text. Nothing downstream compares the two
  // values, so the assumption is asserted here.
  assert.throws(
    () => assertVolatileValuesAreTimestamps(
      { ctl: [{ id: 1, seen_at: 1787337642 }] },
      { ctl: ["seen_at"] },
    ),
    /ctl\.seen_at is volatile but holds 1787337642/u,
  );
  assert.throws(
    () => assertVolatileValuesAreTimestamps({ ctl: [{ at: "2026-08-21T18:40:42Z" }] }, { ctl: ["at"] }),
    /datetime\('now'\) does not produce/u,
  );
});

test("the renderer itself refuses a volatile value it would retype", () => {
  // Asserting on the helper alone would leave the renderer free to stop calling
  // it — which is exactly what a later refactor does.
  assert.throws(() => renderBaselineSql({
    through: "0001_a.sql",
    files: ["0001_a.sql"],
    digest: "sha256:x",
    snapshot: {
      objects: [{ type: "table", name: "ctl", tbl_name: "ctl", sql: "CREATE TABLE ctl (id INTEGER, seen_at INTEGER)" }],
      rows: { ctl: [{ id: 1, seen_at: 1787337642 }] },
    },
    volatileColumns: { ctl: ["seen_at"] },
  }), /ctl\.seen_at is volatile but holds 1787337642/u);
});

test("the two real control-row timestamps pass the volatile shape check", () => {
  const files = subsumedMigrations(listMigrationFiles(MIGRATIONS_DIRECTORY), manifest.through);
  const snapshot = snapshotChain(MIGRATIONS_DIRECTORY, files);
  assert.doesNotThrow(() => assertVolatileValuesAreTimestamps(snapshot.rows, manifest.volatileColumns));
});

test("a column volatile in only some of a table's seeded rows stops generation", () => {
  // The renderer substitutes per column, so it would rewrite the hardcoded row
  // too. `stableRows` strips volatile columns from both sides of the
  // equivalence comparison, so nothing downstream would see the overwrite.
  assert.throws(
    () => detectVolatileColumns(
      { ctl: [{ id: 1, at: "2026-08-21 10:00:00" }, { id: 2, at: "2020-01-01 00:00:00" }] },
      { ctl: [{ id: 1, at: "2026-08-21 10:00:01" }, { id: 2, at: "2020-01-01 00:00:00" }] },
    ),
    /ctl\.at moved in 1 of 2 seeded rows/u,
  );
});

test("a column volatile in every seeded row is still just volatile", () => {
  assert.deepEqual(
    detectVolatileColumns(
      { ctl: [{ id: 1, at: "2026-08-21 10:00:00" }, { id: 2, at: "2026-08-21 10:00:00" }] },
      { ctl: [{ id: 1, at: "2026-08-21 10:00:01" }, { id: 2, at: "2026-08-21 10:00:01" }] },
    ),
    { ctl: ["at"] },
  );
});

// ---------------------------------------------------------------------------
// State and shapes the renderer used to lose or choke on
// ---------------------------------------------------------------------------

test("seeded rows are inserted after the rows they reference", async () => {
  // `sqlite_schema` order is alphabetical, so a child whose name sorts before
  // its parent's was inserted first and the file died on a foreign key —
  // naming no table, and partway through, leaving schema with no ledger.
  await withTemporaryMigrations({
    "0001_a.sql": `
      CREATE TABLE workspace (id TEXT PRIMARY KEY);
      CREATE TABLE agent_role (id TEXT PRIMARY KEY, ws TEXT NOT NULL REFERENCES workspace(id));
      INSERT INTO workspace (id) VALUES ('w1');
      INSERT INTO agent_role (id, ws) VALUES ('r1', 'w1');`,
  }, async (directory) => {
    const { sql } = await buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 });
    assert.ok(sql.indexOf('INSERT INTO "workspace"') < sql.indexOf('INSERT INTO "agent_role"'));
    const database = new DatabaseSync(":memory:");
    assert.doesNotThrow(() => database.exec(sql));
    assert.equal(database.prepare("SELECT COUNT(*) c FROM agent_role").get().c, 1);
    database.close();
  });
});

test("seeded tables that reference each other in a cycle are refused, not guessed at", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE a (id TEXT PRIMARY KEY, b_id TEXT REFERENCES b(id));
                 CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT REFERENCES a(id));
                 INSERT INTO a VALUES ('a1', NULL); INSERT INTO b VALUES ('b1', 'a1');`);
  const snapshot = snapshotDatabase(database);
  assert.throws(
    () => renderBaselineSql({ through: "0001_a.sql", files: ["0001_a.sql"], digest: "sha256:x", snapshot }),
    /reference each other in a cycle/u,
  );
  database.close();
});

test("a parent with no seeded rows constrains nothing", () => {
  // Only seeded tables need ordering; an empty parent cannot be violated.
  assert.deepEqual(orderSeededTables({ child: [{}] }, { child: ["parent"] }), ["child"]);
  assert.deepEqual(orderSeededTables({ child: [{}], parent: [{}] }, { child: ["parent"], parent: [] }),
    ["parent", "child"]);
});

test("the AUTOINCREMENT high-water mark survives, including ids the chain deleted", async () => {
  // Re-inserting the surviving rows only raises the counter to the highest
  // surviving id, so a baselined database re-issues ids that are permanently
  // retired everywhere else.
  await withTemporaryMigrations({
    "0001_a.sql": `
      CREATE TABLE tier (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      INSERT INTO tier (name) VALUES ('a'), ('b'), ('c'), ('d');`,
    "0002_b.sql": "DELETE FROM tier WHERE name IN ('c', 'd');",
  }, async (directory) => {
    const { sql } = await buildBaseline({ through: "0002_b.sql", directory, settleMilliseconds: 0 });
    const nextIdAfter = (build) => {
      const database = new DatabaseSync(":memory:");
      build(database);
      database.prepare("INSERT INTO tier (name) VALUES ('next')").run();
      const id = database.prepare("SELECT id FROM tier WHERE name = 'next'").get().id;
      database.close();
      return id;
    };
    const chain = nextIdAfter((database) => {
      for (const name of ["0001_a.sql", "0002_b.sql"]) {
        database.exec(readFileSync(join(directory, name), "utf8"));
      }
    });
    assert.equal(nextIdAfter((database) => database.exec(sql)), chain, "the next id must match a replay");
    assert.equal(chain, 5, "ids 3 and 4 are retired, so the next is 5");
  });
});

test("a seeded BLOB is frozen as a hex literal, not misread as a volatile timestamp", async () => {
  // SQLite returns a fresh Uint8Array per read, so `!==` reported every blob as
  // moving in every row — and the generator refused, citing `datetime('now')`.
  await withTemporaryMigrations({
    "0001_a.sql": `
      CREATE TABLE app_key (id TEXT PRIMARY KEY, secret BLOB NOT NULL);
      INSERT INTO app_key (id, secret) VALUES ('k1', X'0102030405');`,
  }, async (directory) => {
    const { sql, manifestEntry } = await buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 });
    assert.deepEqual(manifestEntry.volatileColumns, {});
    assert.match(sql, /X'0102030405'/u);
    const database = new DatabaseSync(":memory:");
    database.exec(sql);
    assert.deepEqual(
      [...database.prepare("SELECT secret FROM app_key").get().secret],
      [1, 2, 3, 4, 5],
    );
    database.close();
  });
});

test("blob equality is by content, and a blob that really does change is still volatile", () => {
  assert.ok(sameSeededValue(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
  assert.ok(!sameSeededValue(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])));
  assert.ok(!sameSeededValue(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
  assert.deepEqual(
    detectVolatileColumns({ t: [{ b: new Uint8Array([1]) }] }, { t: [{ b: new Uint8Array([1]) }] }),
    {},
  );
  assert.deepEqual(
    detectVolatileColumns({ t: [{ b: new Uint8Array([1]) }] }, { t: [{ b: new Uint8Array([2]) }] }),
    { t: ["b"] },
  );
});

test("a virtual table stops generation rather than being rendered with its shadow tables", async () => {
  // An FTS5 table has `type = 'table'`, so a type check alone waves it through;
  // the renderer then emits the CREATE VIRTUAL TABLE *and* explicit CREATE
  // TABLEs for the shadows it creates for itself, and applying dies on
  // "table already exists".
  await withTemporaryMigrations({
    "0001_a.sql": "CREATE VIRTUAL TABLE note_search USING fts5(body);",
  }, async (directory) => {
    await assert.rejects(
      () => buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 }),
      /Cannot render table:note_search into a baseline/u,
    );
  });
});

test("an ordinary table is not mistaken for a virtual one", () => {
  assert.doesNotThrow(() => assertEveryObjectRenderable([
    { type: "table", name: "t", tbl_name: "t", sql: "CREATE TABLE t (virtual_column TEXT)" },
  ]));
});

// ---------------------------------------------------------------------------
// Values and shapes the renderer used to lose, retype, or choke on
// ---------------------------------------------------------------------------

test("a generated column is left out of the INSERT and recomputed on apply", async () => {
  // `SELECT *` returns generated columns and `INSERT` rejects them outright, so
  // the baseline could not be applied at all.
  await withTemporaryMigrations({
    "0001_a.sql": `
      CREATE TABLE plan (
        id INTEGER PRIMARY KEY, cents INTEGER, seats INTEGER,
        per_seat_cents INTEGER GENERATED ALWAYS AS (cents / seats) VIRTUAL,
        total_cents INTEGER GENERATED ALWAYS AS (cents) STORED
      );
      INSERT INTO plan (id, cents, seats) VALUES (1, 100, 4);`,
  }, async (directory) => {
    const { sql } = await buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 });
    // The names appear in the CREATE, legitimately. What matters is the INSERT's
    // column list, which is what SQLite rejects.
    const insertColumns = /INSERT INTO "plan" \(([^)]*)\)/u.exec(sql)[1];
    assert.deepEqual(insertColumns.split(", "), ['"id"', '"cents"', '"seats"'],
      "generated columns, VIRTUAL and STORED, must be left out of the INSERT");
    const database = new DatabaseSync(":memory:");
    database.exec(sql);
    // Recomputed by SQLite from the columns that were inserted.
    assert.equal(database.prepare("SELECT per_seat_cents AS v FROM plan").get().v, 25);
    assert.equal(database.prepare("SELECT total_cents AS v FROM plan").get().v, 100);
    database.close();
  });
});

test("a REAL with no fractional part stays a REAL", async () => {
  // JavaScript has one number type, so 2.0 and 2 are the same value and
  // `String()` renders both as `2`, which SQLite stores as an INTEGER. Column
  // affinity rescues a declared REAL column; a STRICT `ANY` column is not.
  await withTemporaryMigrations({
    "0001_a.sql": `
      CREATE TABLE m (id INTEGER PRIMARY KEY, v ANY) STRICT;
      INSERT INTO m (id, v) VALUES (1, 2.0), (2, 2), (3, 2.5);`,
  }, async (directory) => {
    const { sql } = await buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 });
    const database = new DatabaseSync(":memory:");
    database.exec(sql);
    assert.deepEqual(
      database.prepare("SELECT id, typeof(v) AS t FROM m ORDER BY id").all().map((row) => String(row.t)),
      ["real", "integer", "real"],
      "each value keeps the storage class the chain gave it",
    );
    database.close();
  });
});

test("an integer beyond 2^53 survives instead of crashing the generator", async () => {
  // A Slack `ts` in nanoseconds, a snowflake id. Previously this threw
  // "Value is too large to be represented as a JavaScript number" with no table
  // or column named and no hint it was a baseline limitation.
  await withTemporaryMigrations({
    "0001_a.sql": `
      CREATE TABLE event (id INTEGER PRIMARY KEY, ts INTEGER);
      INSERT INTO event (id, ts) VALUES (1, 1755870000123456789);`,
  }, async (directory) => {
    const { sql } = await buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 });
    assert.match(sql, /1755870000123456789/u);
    const database = new DatabaseSync(":memory:");
    database.exec(sql);
    const statement = database.prepare("SELECT ts FROM event");
    statement.setReadBigInts(true);
    assert.equal(statement.get().ts, 1755870000123456789n);
    database.close();
  });
});

test("an ordinary integer is still rendered as a plain number", () => {
  assert.equal(narrowBigInt(5n), 5);
  assert.equal(typeof narrowBigInt(5n), "number");
  assert.equal(narrowBigInt(2n ** 60n), 2n ** 60n);
  assert.equal(sqlLiteral(5), "5");
  assert.equal(sqlLiteral(5, "integer"), "5");
  assert.equal(sqlLiteral(5, "real"), "5.0");
  assert.equal(sqlLiteral(5.5, "real"), "5.5");
});

test("text Wrangler would silently edit out of the file stops generation", async () => {
  // `wrangler d1 execute --file` strips the first `BEGIN TRANSACTION;` and the
  // first `COMMIT;` from any file containing the former — wherever they are,
  // including inside a comment or a string — and errors if it appears twice.
  // SQLite keeps comments written inside a CREATE body, and seeded rows are
  // copied verbatim, so both routes reach the file.
  await withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE z (\n  -- once wrapped in BEGIN TRANSACTION; before the cutover\n  id TEXT PRIMARY KEY\n);",
  }, async (directory) => {
    await assert.rejects(
      () => buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 }),
      /contains the text 'BEGIN TRANSACTION'/u,
    );
  });
  await withTemporaryMigrations({
    "0001_a.sql": "CREATE TABLE snippet (id TEXT PRIMARY KEY, body TEXT);\n"
      + "INSERT INTO snippet VALUES ('s1', 'BEGIN TRANSACTION; UPDATE x SET y = 1; COMMIT;');",
  }, async (directory) => {
    await assert.rejects(
      () => buildBaseline({ through: "0001_a.sql", directory, settleMilliseconds: 0 }),
      /contains the text 'BEGIN TRANSACTION'/u,
    );
  });
});

test("an ordinary baseline is not caught by the transaction check", () => {
  assert.doesNotThrow(() => assertWranglerWillNotRewrite("CREATE TABLE t (id TEXT);\nCOMMIT ok;"));
  assert.throws(() => assertWranglerWillNotRewrite("-- BEGIN TRANSACTION\nCREATE TABLE t (id TEXT);"),
    /BEGIN TRANSACTION/u);
});

test("a boundary appearing twice makes neither baseline usable, whatever the input order", () => {
  // Only a merge that kept both sides produces this: `mergeIntoManifest`
  // replaces by boundary. There is no way to tell which snapshot is right, and
  // the comparator never returns 0 for equal boundaries — so the winner used to
  // be a sort artifact that flipped with input order.
  const migrations = ["0001_a.sql"];
  const digestFor = () => "sha256:same";
  const left = { through: "0001_a.sql", file: "b_from_branch_A.sql", migrations, digest: "sha256:same" };
  const right = { through: "0001_a.sql", file: "b_from_branch_B.sql", migrations, digest: "sha256:same" };
  assert.deepEqual(usableBaselines([left, right], migrations, digestFor), []);
  assert.deepEqual(usableBaselines([right, left], migrations, digestFor), []);
  assert.deepEqual(usableBaselines([left], migrations, digestFor).map((entry) => entry.file),
    ["b_from_branch_A.sql"]);
});

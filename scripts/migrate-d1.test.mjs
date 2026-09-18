// What the migrate script decides, and whether acting on that decision actually
// produces the right database.
//
// The shape of these tests matters more than their number. A test that asserts
// `planMigration` returned the string "baseline" has checked a label; it would
// pass just as happily if the baseline it named were the wrong one, or if
// applying it produced a database missing half its tables. So the central
// assertion here is always the same and always behavioural:
//
//   build a real chain of migrations on disk
//     -> generate a real baseline from it with the real generator
//     -> plan against a real SQLite database
//     -> apply that plan for real
//     -> assert the result is byte-identical to replaying every migration
//
// The chains are synthetic because the scenarios are ones the repository's own
// chain cannot be in — a second baseline, a migration above the newest one, a
// migration inserted below a boundary. They are not toys: each carries tables,
// indexes, triggers, foreign keys, `ALTER TABLE ADD COLUMN`, and seeded rows,
// because a chain of `CREATE TABLE t(id)` would make schema equality trivial to
// satisfy and prove nothing about the renderer.
//
// `packages/db/test/baseline-migration.test.ts` runs the same equivalence over
// the repository's real 95-migration chain and its checked-in baseline.

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  compareMigrationPaths,
  digestMigrations,
  listMigrationFiles,
  planMigration,
  readBaselineManifest,
  selectBaseline,
  usableBaselines,
  describePlan,
  snapshotDatabase,
  applyMigrations,
} from "./d1-baseline.mjs";
import { buildBaseline, mergeIntoManifest } from "./create-d1-baseline.mjs";
import {
  API_DIRECTORY,
  discoverRegions,
  assertRegionalEnvFilesExist,
  inspectDatabase,
  inspectForPlan,
  pnpmExecutable,
  loadCatalog,
  parseArguments,
  resolveTargets,
  stripJsonComments,
  wranglerArguments,
} from "./migrate-d1.mjs";

// ---------------------------------------------------------------------------
// A real chain, a real baseline, a real database
// ---------------------------------------------------------------------------

/**
 * Migrations with enough shape that "the schemas match" is a real claim: a
 * parent and child with a foreign key, an index, a trigger that rejects a
 * write, a column added by ALTER, and a seeded row.
 *
 * Deliberately free of `datetime('now')` so a generator run with no settle
 * delay still detects no volatile columns — the volatile path has its own test
 * that pays for the delay.
 */
const CHAIN = [
  ["0001_workspaces.sql", `
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO workspaces (id, name) VALUES ('seed-workspace', 'Seed');`],
  ["0002_streams.sql", `
    CREATE TABLE streams (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL
    );
    CREATE INDEX streams_workspace_idx ON streams(workspace_id);`],
  ["0003_stream_guard.sql", `
    CREATE TRIGGER streams_reject_blank_title BEFORE INSERT ON streams
    WHEN NEW.title = ''
    BEGIN SELECT RAISE(ABORT, 'streams_title_required'); END;`],
  ["0004_stream_scope.sql", `
    ALTER TABLE streams ADD COLUMN scope TEXT NOT NULL DEFAULT 'private';
    CREATE UNIQUE INDEX streams_workspace_title_idx ON streams(workspace_id, title);`],
  ["0005_control.sql", `
    CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), phase TEXT NOT NULL);
    INSERT INTO control (id, phase) VALUES (1, 'open');`],
  ["0006_control_history.sql", `
    CREATE TABLE control_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT '1970-01-01'
    );
    CREATE INDEX control_history_phase_idx ON control_history(phase);`],
];

function withChain(files, body) {
  const root = mkdtempSync(join(tmpdir(), "avalon-migrate-"));
  const migrations = join(root, "migrations");
  const baselines = join(root, "baselines");
  mkdirSync(migrations);
  mkdirSync(baselines);
  for (const [name, sql] of files) writeFileSync(join(migrations, name), sql, "utf8");
  const context = {
    root,
    migrations,
    baselines,
    onDisk: () => listMigrationFiles(migrations),
    digestFor: (subset) => digestMigrations(migrations, subset),
    write: (name, sql) => writeFileSync(join(migrations, name), sql, "utf8"),
  };
  const result = body(context);
  const cleanUp = () => rmSync(root, { recursive: true, force: true });
  if (typeof result?.then === "function") return result.finally(cleanUp);
  cleanUp();
  return result;
}

/** Generates a real baseline at `through` and writes it beside the chain. */
async function generateBaseline(context, through, { settleMilliseconds = 0 } = {}) {
  const { sql, manifestEntry } = await buildBaseline({
    through,
    directory: context.migrations,
    settleMilliseconds,
  });
  writeFileSync(join(context.baselines, manifestEntry.file), sql, "utf8");
  return manifestEntry;
}

/**
 * Applies migrations the way Wrangler does: run the file, then record its name.
 * The ledger write is what makes a later run skip it, so a simulation that
 * skipped it would test a database nobody ends up with.
 */
function applyLikeWrangler(database, directory, files) {
  database.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  for (const name of files) {
    database.exec(readFileSync(join(directory, name), "utf8"));
    database.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").run(name);
  }
}

/** Carries out a plan against a real database, as the script would. */
function executePlan(database, context, plan) {
  if (plan.action === "baseline") {
    database.exec(readFileSync(join(context.baselines, plan.baseline.file), "utf8"));
    applyLikeWrangler(database, context.migrations, plan.thenApply);
    return;
  }
  applyLikeWrangler(database, context.migrations, plan.pending);
}

/** Everything about a database two different routes must agree on. */
function stateOf(database) {
  const { objects, rows } = snapshotDatabase(database);
  const tables = objects.filter((object) => object.type === "table");
  return {
    schema: objects.map((object) => `${object.type}:${object.name}:${object.sql.replace(/\s+/gu, " ").trim()}`),
    // The engine's own column order, which is what an `ALTER TABLE ADD COLUMN`
    // applied at a different point in the sequence actually changes. Reading it
    // back through PRAGMA rather than parsing the CREATE text, because after
    // several ALTERs that text is a shape no regex should be asked about.
    columns: Object.fromEntries(tables.map((table) => [
      table.name,
      database.prepare("SELECT name FROM pragma_table_info(?)").all(table.name).map((row) => String(row.name)),
    ])),
    rows,
    ledger: database.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((row) => String(row.name)),
  };
}

function replayedState(context, files = context.onDisk()) {
  const database = new DatabaseSync(":memory:");
  try {
    applyLikeWrangler(database, context.migrations, files);
    return stateOf(database);
  } finally {
    database.close();
  }
}

/** Plans for an empty local database and carries it out. */
function planAndExecute(context, baselines, { applied = [], userTables = 0, allowBaseline = true } = {}) {
  const plan = planMigration({
    applied,
    userTables,
    baselines,
    migrationsOnDisk: context.onDisk(),
    digestFor: context.digestFor,
    allowBaseline,
  });
  const database = new DatabaseSync(":memory:");
  try {
    if (applied.length > 0) applyLikeWrangler(database, context.migrations, applied);
    executePlan(database, context, plan);
    return { plan, state: stateOf(database) };
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Using a baseline, and building on top of one
// ---------------------------------------------------------------------------

test("a baselined empty database ends up identical to replaying every migration", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    const { plan, state } = planAndExecute(context, [baseline]);

    assert.equal(plan.action, "baseline");
    assert.equal(plan.baseline.through, "0004_stream_scope.sql");
    assert.deepEqual(plan.thenApply, ["0005_control.sql", "0006_control_history.sql"]);
    // The claim that matters: the two routes produce the same database.
    assert.deepEqual(state, replayedState(context));
  });
});

test("the baseline that reaches furthest is the one chosen", async () => {
  await withChain(CHAIN, async (context) => {
    const early = await generateBaseline(context, "0002_streams.sql");
    const later = await generateBaseline(context, "0004_stream_scope.sql");
    const { plan, state } = planAndExecute(context, [early, later]);

    assert.equal(plan.baseline.through, "0004_stream_scope.sql");
    assert.equal(plan.thenApply.length, 2);
    assert.deepEqual(state, replayedState(context));
  });
});

test("a migration added above the newest baseline is applied on top of it", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    // The everyday case: a baseline exists, and work continues above it.
    context.write("0007_stream_archive.sql", `
      ALTER TABLE streams ADD COLUMN archived_at TEXT;
      CREATE INDEX streams_archived_idx ON streams(archived_at);`);

    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "baseline");
    assert.deepEqual(plan.thenApply, [
      "0005_control.sql", "0006_control_history.sql", "0007_stream_archive.sql",
    ]);
    assert.deepEqual(state, replayedState(context));
    // And the new column really is there, not merely planned for.
    assert.ok(state.schema.some((entry) => entry.includes("archived_at")));
  });
});

test("many migrations above a baseline still land, in order", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0002_streams.sql");
    for (const index of [7, 8, 9]) {
      context.write(`000${index}_extra_${index}.sql`, `CREATE TABLE extra_${index} (id TEXT PRIMARY KEY);`);
    }
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.thenApply.length, 7);
    assert.deepEqual(state, replayedState(context));
  });
});

// ---------------------------------------------------------------------------
// When a baseline must not be used
// ---------------------------------------------------------------------------

test("a baseline whose migrations were edited underneath it is skipped, and the chain still runs", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    // `data-model.md` forbids this, which is exactly why the tooling must not
    // trust that it never happens.
    context.write("0002_streams.sql", `
      CREATE TABLE streams (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        edited INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX streams_workspace_idx ON streams(workspace_id);`);

    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "migrate", "a stale baseline must not be used");
    assert.deepEqual(state, replayedState(context));
    assert.ok(state.schema.some((entry) => entry.includes("edited INTEGER")));
  });
});

test("a migration inserted below a boundary invalidates that baseline but not an earlier one", async () => {
  await withChain(CHAIN, async (context) => {
    const early = await generateBaseline(context, "0002_streams.sql");
    const later = await generateBaseline(context, "0004_stream_scope.sql");
    // Sorts between 0003 and 0004, so it is below the later boundary and above
    // the earlier one. This is the 0084-hole hazard, in miniature.
    context.write("0003_stream_notes.sql", "CREATE TABLE stream_notes (id TEXT PRIMARY KEY);");

    const usable = usableBaselines([early, later], context.onDisk(), context.digestFor);
    assert.deepEqual(usable.map((baseline) => baseline.through), ["0002_streams.sql"]);

    const { plan, state } = planAndExecute(context, [early, later]);
    assert.equal(plan.baseline.through, "0002_streams.sql");
    assert.ok(plan.thenApply.includes("0003_stream_notes.sql"));
    assert.deepEqual(state, replayedState(context));
  });
});

test("a database that already has tables is migrated, never baselined", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    const plan = planMigration({
      applied: [], userTables: 3, baselines: [baseline],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.equal(plan.action, "migrate");
    assert.equal(plan.baseline, null);
  });
});

test("a ledger without the schema it describes is migrated, never baselined", async () => {
  // A migration that failed partway. Baselining would record every subsumed
  // migration as applied a second time over a schema that never ran them.
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    const plan = planMigration({
      applied: ["0001_workspaces.sql"], userTables: 0, baselines: [baseline],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.equal(plan.action, "migrate");
    assert.equal(plan.baseline, null);
  });
});

test("a hosted database is never baselined, however empty it is", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    const { plan, state } = planAndExecute(context, [baseline], { allowBaseline: false });
    assert.equal(plan.action, "migrate");
    assert.equal(plan.baseline, null);
    assert.equal(plan.pending.length, CHAIN.length);
    // And replaying the chain is still the correct outcome, which is the whole
    // reason the hosted path can afford to refuse the shortcut.
    assert.deepEqual(state, replayedState(context));
  });
});

test("with no baselines at all, an empty database replays the chain", async () => {
  await withChain(CHAIN, async (context) => {
    const { plan, state } = planAndExecute(context, []);
    assert.equal(plan.action, "migrate");
    assert.deepEqual(state, replayedState(context));
  });
});

// ---------------------------------------------------------------------------
// Partially applied, ahead, and finished databases
// ---------------------------------------------------------------------------

test("a partially migrated database applies only what it is missing", async () => {
  await withChain(CHAIN, async (context) => {
    const applied = ["0001_workspaces.sql", "0002_streams.sql", "0003_stream_guard.sql"];
    const { plan, state } = planAndExecute(context, [], { applied });
    assert.deepEqual(plan.pending, [
      "0004_stream_scope.sql", "0005_control.sql", "0006_control_history.sql",
    ]);
    assert.deepEqual(state, replayedState(context));
  });
});

test("a fully migrated database is up to date and nothing is applied", async () => {
  await withChain(CHAIN, async (context) => {
    const applied = context.onDisk();
    const { plan, state } = planAndExecute(context, [], { applied });
    assert.equal(plan.action, "up-to-date");
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(state, replayedState(context));
  });
});

test("a database ahead of this checkout is reported rather than acted on", async () => {
  // A branch that added migrations, or a rollback. Guessing which would be
  // wrong either way, so the names are surfaced and nothing is undone.
  await withChain(CHAIN, async (context) => {
    const applied = [...context.onDisk(), "0099_from_another_branch.sql"];
    const plan = planMigration({
      applied, userTables: 6, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.deepEqual(plan.unknownApplied, ["0099_from_another_branch.sql"]);
    assert.equal(plan.action, "up-to-date");
    assert.match(describePlan("global", plan), /not in this checkout: 0099_from_another_branch\.sql/u);
  });
});

// ---------------------------------------------------------------------------
// Volatile columns survive the round trip
// ---------------------------------------------------------------------------

test("a column the chain recomputes is re-derived by the baseline, not frozen", async () => {
  await withChain([
    ["0001_control.sql", `
      CREATE TABLE control (id INTEGER PRIMARY KEY, stamped_at TEXT NOT NULL, label TEXT NOT NULL);
      INSERT INTO control (id, stamped_at, label) VALUES (1, datetime('now'), 'fixed');`],
    ["0002_more.sql", "CREATE TABLE more (id TEXT PRIMARY KEY);"],
  ], async (context) => {
    // Pays the settle delay, because detecting volatility is what is under test.
    const baseline = await generateBaseline(context, "0001_control.sql", { settleMilliseconds: 1100 });
    assert.deepEqual(baseline.volatileColumns, { control: ["stamped_at"] });

    const generated = readFileSync(join(context.baselines, baseline.file), "utf8");
    assert.match(generated, /datetime\('now'\)/u, "the volatile column must be re-derived");
    assert.match(generated, /'fixed'/u, "the stable column must be frozen");

    const { state } = planAndExecute(context, [baseline]);
    const stamped = state.rows.control[0].stamped_at;
    assert.ok(!generated.includes(stamped), "the produced value must not be a literal in the file");
    assert.match(String(stamped), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
  });
});

// ---------------------------------------------------------------------------
// Selection, in isolation
// ---------------------------------------------------------------------------

test("selection prefers the highest boundary and returns null when none is usable", async () => {
  await withChain(CHAIN, async (context) => {
    const early = await generateBaseline(context, "0002_streams.sql");
    const later = await generateBaseline(context, "0005_control.sql");
    assert.equal(selectBaseline([early, later], context.onDisk(), context.digestFor).through, "0005_control.sql");
    assert.equal(selectBaseline([later, early], context.onDisk(), context.digestFor).through, "0005_control.sql");
    assert.equal(selectBaseline([], context.onDisk(), context.digestFor), null);

    const corrupted = { ...later, digest: "sha256:0000" };
    assert.equal(selectBaseline([corrupted], context.onDisk(), context.digestFor), null);
  });
});

test("a baseline claiming a file list that no longer matches disk is unusable", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    const tampered = { ...baseline, migrations: baseline.migrations.slice(0, -1) };
    assert.deepEqual(usableBaselines([tampered], context.onDisk(), context.digestFor), []);
  });
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test("a manifest accumulates baselines and replaces one at the same boundary", () => {
  const first = { through: "0002_a.sql", file: "b_0002_a.sql" };
  const second = { through: "0004_b.sql", file: "b_0004_b.sql" };
  const replacement = { through: "0002_a.sql", file: "b_0002_a.sql", digest: "sha256:new" };
  assert.deepEqual(mergeIntoManifest([first], second).map((entry) => entry.through), ["0002_a.sql", "0004_b.sql"]);
  const merged = mergeIntoManifest([first, second], replacement);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((entry) => entry.through === "0002_a.sql").digest, "sha256:new");
});

test("both manifest shapes are read, so a checkout mid-upgrade still runs", () => {
  const entry = { through: "0090_x.sql", file: "b_0090_x.sql" };
  assert.deepEqual(readBaselineManifest({ baseline: entry }), [entry]);
  assert.deepEqual(readBaselineManifest({ baselines: [entry] }), [entry]);
  assert.deepEqual(readBaselineManifest("{}"), []);
  assert.deepEqual(
    readBaselineManifest({ baselines: [{ through: "0004_b.sql" }, { through: "0002_a.sql" }] })
      .map((baseline) => baseline.through),
    ["0002_a.sql", "0004_b.sql"],
  );
});

// ---------------------------------------------------------------------------
// Region discovery
// ---------------------------------------------------------------------------

test("regions come from the Wrangler configs that actually own a migration history", () => {
  const discovered = discoverRegions();
  assert.deepEqual(discovered.map((entry) => entry.region), ["global"]);
  assert.ok(discovered.every((entry) => entry.binding === "DB"));
  // `wrangler.test.jsonc` binds D1 with no `migrations_dir`. Migrating it would
  // create schema in a fixture database, so the marker is the migrations
  // directory rather than the presence of a binding.
  assert.ok(!discovered.some((entry) => entry.region === "test"));
  const testConfig = JSON.parse(stripJsonComments(readFileSync(join(API_DIRECTORY, "wrangler.test.jsonc"), "utf8")));
  assert.ok(testConfig.d1_databases?.length > 0, "the fixture config must still bind D1 for this to prove anything");
  assert.ok(!testConfig.d1_databases.some((entry) => entry.migrations_dir));
});

/** Where `../../packages/db/migrations` lands for a throwaway `apps/api`. */
function sharedChain(apiDirectory) {
  return resolve(apiDirectory, "../../packages/db/migrations");
}

test("a region whose migrations_dir is a different chain is refused", () => {
  // `migrations_dir` is what Wrangler applies; everything here plans against
  // `packages/db/migrations` — the baseline, its ledger rows, the digest, the
  // pending count. A region naming a different directory would be given this
  // chain's baseline and then have another chain applied on top of it, which no
  // later check would notice because each half is internally consistent.
  const directory = mkdtempSync(join(tmpdir(), "avalon-chain-"));
  try {
    writeFileSync(join(directory, "wrangler.enterprise.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: "../../other/migrations" }],
    }), "utf8");
    assert.throws(
      () => discoverRegions(directory, { migrationsDirectory: sharedChain(directory) }),
      /points migrations_dir at \.\.\/\.\.\/other\/migrations/u,
    );

    writeFileSync(join(directory, "wrangler.enterprise.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: "../../packages/db/migrations" }],
    }), "utf8");
    assert.deepEqual(
      discoverRegions(directory, { migrationsDirectory: sharedChain(directory) }).map((entry) => entry.region),
      ["enterprise"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the repository's own configs all name the shared chain", () => {
  // The seam above lets a test say which chain a throwaway tree shares; this is
  // the one that holds the real configs to the real directory.
  assert.deepEqual(
    discoverRegions().map((entry) => entry.region),
    ["global"],
  );
});

test("a new region config is discovered without any list being edited", () => {
  const directory = mkdtempSync(join(tmpdir(), "avalon-regions-"));
  try {
    writeFileSync(join(directory, "wrangler.global.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: "../../packages/db/migrations" }],
    }), "utf8");
    writeFileSync(join(directory, "wrangler.apac.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: "../../packages/db/migrations" }],
    }), "utf8");
    writeFileSync(join(directory, "wrangler.test.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB" }],
    }), "utf8");
    assert.deepEqual(
      discoverRegions(directory, { migrationsDirectory: sharedChain(directory) }).map((entry) => entry.region),
      ["apac", "global"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a config that cannot be parsed stops discovery rather than dropping a region", () => {
  const directory = mkdtempSync(join(tmpdir(), "avalon-regions-"));
  try {
    writeFileSync(join(directory, "wrangler.enterprise.jsonc"), "{ this is not json", "utf8");
    assert.throws(() => discoverRegions(directory), /wrangler\.enterprise\.jsonc could not be parsed/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a URL inside a config string is not mistaken for a comment", () => {
  // Every regional config carries `https://…` route patterns. A regex-based
  // comment stripper truncates the file at the first one and the config stops
  // parsing — or worse, parses to something smaller.
  const source = '{ "a": "https://with-avalon.com/app", /* b */ "c": 1 } // trailing';
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: "https://with-avalon.com/app", c: 1 });
  const real = stripJsonComments(readFileSync(join(API_DIRECTORY, "wrangler.global.jsonc"), "utf8"));
  assert.ok(JSON.parse(real).routes?.length > 0, "the real config must still parse with its routes intact");
});

test("pnpm is launched through the shim its platform installs", () => {
  // `execFile` and `spawn` run an executable directly rather than through a
  // shell, and on Windows the installed entry point is `pnpm.cmd` — so a bare
  // "pnpm" is not found there. `scripts/dev-regional-api.mjs` already knew this;
  // both D1 scripts now share one answer instead of each carrying their own.
  assert.equal(pnpmExecutable("win32"), "pnpm.cmd");
  assert.equal(pnpmExecutable("linux"), "pnpm");
  assert.equal(pnpmExecutable("darwin"), "pnpm");
});

test("a trailing comma is accepted, because Wrangler accepts it", () => {
  // Wrangler reads these files with a real JSONC parser, so a trailing comma is
  // valid input rather than a mistake. Discovery parses every wrangler.*.jsonc
  // before choosing a region, so rejecting one would fail local migration,
  // hosted migration and baseline verification for every region at once.
  const source = `{
    "d1_databases": [
      { "binding": "DB", "migrations_dir": "../../packages/db/migrations", },
    ],
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(source)), {
    d1_databases: [{ binding: "DB", migrations_dir: "../../packages/db/migrations" }],
  });
  // A comma inside a string is data, and a comment may sit between the comma
  // and the bracket that makes it trailing.
  assert.deepEqual(JSON.parse(stripJsonComments('{"a": "x,", "b": [1, /* c */ ]}')), { a: "x,", b: [1] });
});

test("a string ending in an escaped backslash does not swallow its own closing quote", () => {
  // Looking one character back cannot tell `\"` from `\\` followed by a real
  // closing quote. Getting it wrong runs the scanner on inside a string that
  // was already closed, so the `//` after it stops being recognised as a
  // comment and the whole file fails to parse — and since `discoverRegions`
  // reads every `wrangler.*.jsonc`, one such value anywhere takes down
  // `pnpm db:migrate` for every region, hosted path included.
  const source = String.raw`{"a": "C:\\", "b": 1} // trailing`;
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: "C:\\", b: 1 });
  const quoted = String.raw`{"a": "say \"hi\"", "b": "back\\slash\"quote"} // trailing`;
  assert.deepEqual(JSON.parse(stripJsonComments(quoted)), { a: 'say "hi"', b: 'back\\slash"quote' });
});

// ---------------------------------------------------------------------------
// Reading a database's state through the wrangler seam
// ---------------------------------------------------------------------------

/**
 * A stand-in for `wrangler d1 execute` that runs the query it is given against
 * a real SQLite database and answers in Wrangler's JSON shape.
 *
 * The transport is the only thing faked. The SQL in `inspectDatabase` is real
 * SQL against a real engine here, which is the half that can be wrong — an
 * inventory query that miscounts internal tables, or a ledger query naming a
 * table that does not exist, would both pass a test built on canned responses.
 */
function wranglerAgainst(database, { failOn = null } = {}) {
  return async (_command, args) => {
    const sql = args[args.indexOf("--command") + 1];
    if (failOn && sql.includes(failOn)) throw new Error("D1 is temporarily unavailable");
    return { stdout: JSON.stringify([{ results: database.prepare(sql).all() }]) };
  };
}

const LOCAL_TARGET = { region: "enterprise", config: "wrangler.enterprise.jsonc", binding: "DB", remote: false };

test("a database that already has tables still has its ledger read", async () => {
  // The whole value of `outOfOrder` and `unknownApplied` is on databases that
  // have tables — an established local one, and production. Skipping the ledger
  // read there left both unreachable everywhere they can actually fire.
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
                 CREATE TABLE _cf_KV (key TEXT PRIMARY KEY);
                 CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
                 INSERT INTO d1_migrations (name) VALUES ('0001_a.sql'), ('0090_b.sql')`);
  const state = await inspectDatabase(LOCAL_TARGET, { run: wranglerAgainst(database) });
  assert.equal(state.userTables, 1, "the platform's own tables are not user schema");
  assert.ok(state.ledgerRead);
  assert.deepEqual(state.applied, ["0001_a.sql", "0090_b.sql"]);
  database.close();
});

test("an out-of-order migration is reported on a populated database, end to end", async () => {
  // The reviewer's scenario: production already ran 0090, a PR inserts 0084.
  // A fresh or baselined database applies 0084 before 0090; this one applies it
  // after. Nothing stops the apply — but it has to be *said*, and before this
  // the ledger it needs was never read.
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
                 CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
                 INSERT INTO d1_migrations (name) VALUES ('0001_a.sql'), ('0090_b.sql')`);
  const state = await inspectDatabase(LOCAL_TARGET, { run: wranglerAgainst(database) });
  const plan = planMigration({
    applied: state.applied,
    userTables: state.userTables,
    baselines: [],
    migrationsOnDisk: ["0001_a.sql", "0084_inserted_later.sql", "0090_b.sql"],
    digestFor: () => "sha256:x",
    allowBaseline: false,
  });
  assert.equal(plan.action, "migrate");
  assert.deepEqual(plan.outOfOrder, ["0084_inserted_later.sql"]);
  assert.match(describePlan("enterprise", plan), /0084_inserted_later\.sql/u);
  database.close();
});

test("a ledger row with no file on disk is reported rather than ignored", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
                 CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
                 INSERT INTO d1_migrations (name) VALUES ('0001_a.sql'), ('0002_deleted_since.sql')`);
  const state = await inspectDatabase(LOCAL_TARGET, { run: wranglerAgainst(database) });
  const plan = planMigration({
    applied: state.applied,
    userTables: state.userTables,
    baselines: [],
    migrationsOnDisk: ["0001_a.sql"],
    digestFor: () => "sha256:x",
    allowBaseline: false,
  });
  assert.deepEqual(plan.unknownApplied, ["0002_deleted_since.sql"]);
  database.close();
});

test("a database with tables and no ledger reports nothing rather than nothing-applied", async () => {
  // `applied: []` here would have the plan announce every migration as pending
  // on a database that may be entirely up to date.
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  const state = await inspectDatabase(LOCAL_TARGET, { run: wranglerAgainst(database) });
  assert.equal(state.applied, null);
  assert.equal(state.ledgerRead, false);
  const plan = planMigration({
    applied: state.applied,
    userTables: state.userTables,
    baselines: [],
    migrationsOnDisk: ["0001_a.sql"],
    digestFor: () => "sha256:x",
    allowBaseline: true,
  });
  assert.equal(plan.pending, null);
  database.close();
});

test("an empty database reports an empty ledger, which is what lets it be baselined", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY)");
  const state = await inspectDatabase(LOCAL_TARGET, { run: wranglerAgainst(database) });
  assert.equal(state.userTables, 0);
  assert.deepEqual(state.applied, []);
  database.close();
});

test("a hosted database that cannot be inspected still gets its migrations applied", async () => {
  // Nothing read on the hosted path can change the plan, so an inspection
  // failure must not abort the deploy before `migrations apply` runs. The
  // warning is the deliverable; `applied: null` keeps the plan honest about
  // not having read a ledger.
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const state = await inspectForPlan(
      { ...LOCAL_TARGET, remote: true },
      { run: wranglerAgainst(database, { failOn: "sqlite_schema" }) },
    );
    assert.deepEqual(state, { userTables: 0, applied: null, hasLedger: false, ledgerRead: false });
    assert.match(warnings.join("\n"), /enterprise: could not inspect before applying/u);
  } finally {
    console.warn = warn;
  }
  database.close();
});

test("a local database that cannot be inspected stops rather than guessing", async () => {
  // Locally the inspection decides whether the baseline is applied at all, and
  // the two wrong answers are replaying every migration or handing a snapshot
  // to a database that already has tables.
  const database = new DatabaseSync(":memory:");
  await assert.rejects(
    () => inspectForPlan(LOCAL_TARGET, { run: wranglerAgainst(database, { failOn: "sqlite_schema" }) }),
    /D1 is temporarily unavailable/u,
  );
  database.close();
});

test("a discovered region with no env file is named, rather than left to wrangler", () => {
  // Regions come from the Wrangler configs; `pnpm env:sync` still writes env
  // files for a hardcoded global and enterprise. A third region is therefore discovered
  // and handed an `--env-file` nothing created, and wrangler's message for that
  // names the file rather than the reason.
  const directory = mkdtempSync(join(tmpdir(), "envfiles-"));
  try {
    writeFileSync(join(directory, ".dev.vars.global"), "A=1\n");
    const targets = [
      { region: "global", remote: false },
      { region: "apac", remote: false },
    ];
    assert.throws(
      () => assertRegionalEnvFilesExist(targets, directory),
      /No apps\/api\/\.dev\.vars\.apac for the discovered region apac/u,
    );
    // The hosted path passes no `--env-file` at all, so it is not held to this.
    assert.doesNotThrow(() => assertRegionalEnvFilesExist(
      targets.map((target) => ({ ...target, remote: true })),
      directory,
    ));
    assert.doesNotThrow(() => assertRegionalEnvFilesExist([targets[0]], directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The command line and the wrangler invocation
// ---------------------------------------------------------------------------

test("arguments parse into the run's shape", () => {
  assert.deepEqual(parseArguments([]), { remote: false, list: false, regions: [] });
  assert.deepEqual(parseArguments(["--remote"]), { remote: true, list: false, regions: [] });
  assert.deepEqual(parseArguments(["--remote", "--list", "--region", "enterprise"]),
    { remote: true, list: true, regions: ["enterprise"] });
  assert.deepEqual(parseArguments(["--region", "enterprise", "--region", "global"]).regions, ["enterprise", "global"]);
  assert.throws(() => parseArguments(["--region"]), /--region needs a region name/u);
  assert.throws(() => parseArguments(["--region", "--remote"]), /--region needs a region name/u);
  assert.throws(() => parseArguments(["--nope"]), /Unrecognized argument --nope/u);
});

test("an unknown region is refused, naming the ones that exist", () => {
  const discovered = [{ region: "global" }, { region: "enterprise" }];
  assert.deepEqual(resolveTargets(discovered, []), discovered);
  assert.deepEqual(resolveTargets(discovered, ["enterprise"]), [{ region: "enterprise" }]);
  assert.throws(() => resolveTargets(discovered, ["apac"]), /apac is not a region here; found global, enterprise/u);
});

test("the database name lands after the subcommand, whichever subcommand it is", () => {
  const target = { region: "enterprise", config: "wrangler.enterprise.jsonc", binding: "DB", remote: false };
  // `d1 execute DB …` is one token deep; `d1 migrations apply DB` is two.
  // Splicing on a fixed index puts the binding inside `migrations apply`.
  assert.deepEqual(
    wranglerArguments(target, ["execute"], ["--json", "--command", "SELECT 1"]).slice(0, 6),
    ["exec", "wrangler", "d1", "execute", "DB", "--json"],
  );
  assert.deepEqual(
    wranglerArguments(target, ["migrations", "apply"]).slice(0, 6),
    ["exec", "wrangler", "d1", "migrations", "apply", "DB"],
  );
});

test("a local run is pinned to its own state directory and a hosted run is not", () => {
  const target = { region: "enterprise", config: "wrangler.enterprise.jsonc", binding: "DB" };
  const local = wranglerArguments({ ...target, remote: false }, ["migrations", "apply"]);
  assert.ok(local.includes("--local"));
  assert.deepEqual(local.slice(local.indexOf("--persist-to"), local.indexOf("--persist-to") + 2),
    ["--persist-to", ".wrangler/state/enterprise"]);
  assert.deepEqual(local.slice(local.indexOf("--env-file"), local.indexOf("--env-file") + 2),
    ["--env-file", ".dev.vars.enterprise"]);

  const remote = wranglerArguments({ ...target, remote: true }, ["migrations", "apply"]);
  assert.ok(remote.includes("--remote"));
  // A hosted run must not be pointed at local state or local secrets.
  assert.ok(!remote.includes("--local"));
  assert.ok(!remote.includes("--persist-to"));
  assert.ok(!remote.includes("--env-file"));
  assert.deepEqual(remote.slice(-2), ["--config", "wrangler.enterprise.jsonc"]);
});

test("every discovered region produces a runnable argument vector", () => {
  for (const target of discoverRegions()) {
    for (const remote of [false, true]) {
      const argv = wranglerArguments({ ...target, remote }, ["migrations", "apply"]);
      assert.equal(argv[0], "exec");
      assert.ok(argv.includes(target.config));
      assert.ok(argv.includes(target.binding));
    }
  }
});

// ---------------------------------------------------------------------------
// The repository's own chain, through the same machinery
// ---------------------------------------------------------------------------

test("the checked-in baselines are all usable against the real chain", () => {
  const migrationsDirectory = join(API_DIRECTORY, "..", "..", "packages", "db", "migrations");
  const baselinesDirectory = join(API_DIRECTORY, "..", "..", "packages", "db", "baselines");
  const baselines = readBaselineManifest(readFileSync(join(baselinesDirectory, "manifest.json"), "utf8"));
  const onDisk = listMigrationFiles(migrationsDirectory);
  const digestFor = (files) => digestMigrations(migrationsDirectory, files);

  assert.ok(baselines.length > 0, "the repository ships at least one baseline");
  assert.deepEqual(
    usableBaselines(baselines, onDisk, digestFor).map((baseline) => baseline.through),
    [...baselines].reverse().map((baseline) => baseline.through),
    "every checked-in baseline must still describe the chain",
  );
});

test("the real chain plans a baseline for an empty database and the chain for a hosted one", () => {
  const migrationsDirectory = join(API_DIRECTORY, "..", "..", "packages", "db", "migrations");
  const baselinesDirectory = join(API_DIRECTORY, "..", "..", "packages", "db", "baselines");
  const baselines = readBaselineManifest(readFileSync(join(baselinesDirectory, "manifest.json"), "utf8"));
  const shared = {
    applied: [],
    userTables: 0,
    baselines,
    migrationsOnDisk: listMigrationFiles(migrationsDirectory),
    digestFor: (files) => digestMigrations(migrationsDirectory, files),
  };
  const local = planMigration({ ...shared, allowBaseline: true });
  assert.equal(local.action, "baseline");
  assert.equal(local.baseline.through, baselines.at(-1).through);

  const hosted = planMigration({ ...shared, allowBaseline: false });
  assert.equal(hosted.action, "migrate");
  assert.equal(hosted.pending.length, shared.migrationsOnDisk.length);
});

test("applying the real baseline plus what follows equals replaying the real chain", () => {
  // The repository's own version of the central claim, over 95 real migrations.
  const migrationsDirectory = join(API_DIRECTORY, "..", "..", "packages", "db", "migrations");
  const baselinesDirectory = join(API_DIRECTORY, "..", "..", "packages", "db", "baselines");
  const baselines = readBaselineManifest(readFileSync(join(baselinesDirectory, "manifest.json"), "utf8"));
  const onDisk = listMigrationFiles(migrationsDirectory);

  for (const baseline of baselines) {
    // `compareMigrationPaths`, not `>`: an unpadded name is misordered
    // identically on both sides of this comparison, so a string compare would
    // keep the two databases agreeing with each other while the real
    // `planMigration` put that file on the other side of the boundary.
    const after = onDisk.filter((name) => compareMigrationPaths(name, baseline.through) > 0);
    const viaBaseline = new DatabaseSync(":memory:");
    const viaChain = new DatabaseSync(":memory:");
    try {
      viaBaseline.exec(readFileSync(join(baselinesDirectory, baseline.file), "utf8"));
      applyMigrations(viaBaseline, migrationsDirectory, after);
      applyMigrations(viaChain, migrationsDirectory, onDisk);

      const normalize = (database) => snapshotDatabase(database).objects
        .map((object) => `${object.type}:${object.name}:${object.sql.replace(/\s+/gu, " ").trim()}`);
      assert.deepEqual(normalize(viaBaseline), normalize(viaChain), baseline.through);

      const recorded = viaBaseline.prepare("SELECT name FROM d1_migrations ORDER BY name").all()
        .map((row) => String(row.name));
      assert.deepEqual(recorded, baseline.migrations, "the ledger names exactly the subsumed migrations");
    } finally {
      viaBaseline.close();
      viaChain.close();
    }
  }
});

// ---------------------------------------------------------------------------
// What the plan knows, versus what it assumes
// ---------------------------------------------------------------------------

test("an unread ledger is reported as unknown, never as nothing applied", async () => {
  // A database with tables is never baselined whatever its ledger holds, so the
  // ledger is not read there. Filling that in as `[]` made the plan report
  // every migration as pending on a fully migrated database — wrong, and
  // alarming to whoever is reading setup output.
  await withChain(CHAIN, async (context) => {
    const plan = planMigration({
      applied: null, userTables: 6, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.equal(plan.pending, null);
    assert.equal(plan.action, "migrate");
    assert.equal(plan.baseline, null);
    assert.match(describePlan("global", plan), /has tables — Wrangler will apply whatever is still pending/u);
    assert.ok(!describePlan("global", plan).includes(String(CHAIN.length)));
  });
});

test("a read ledger reports the real pending count", async () => {
  await withChain(CHAIN, async (context) => {
    const plan = planMigration({
      applied: context.onDisk().slice(0, 2), userTables: 2, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.equal(plan.pending.length, CHAIN.length - 2);
    assert.match(describePlan("enterprise", plan), /applying 4 pending migration\(s\)/u);
  });
});

test("an unread ledger cannot be mistaken for an empty database", async () => {
  await withChain(CHAIN, async (context) => {
    const baseline = await generateBaseline(context, "0004_stream_scope.sql");
    // userTables 0 with a null ledger should still not baseline: the emptiness
    // claim needs both halves established, not one assumed.
    const plan = planMigration({
      applied: null, userTables: 0, baselines: [baseline],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.equal(plan.action, "migrate");
    assert.equal(plan.baseline, null);
  });
});

test("a finished database says so plainly", async () => {
  await withChain(CHAIN, async (context) => {
    const plan = planMigration({
      applied: context.onDisk(), userTables: 6, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.equal(plan.action, "up-to-date");
    assert.equal(describePlan("global", plan), "global: already up to date.");
  });
});

// ---------------------------------------------------------------------------
// Numbering that is not a tidy sequence
// ---------------------------------------------------------------------------

/**
 * A chain with holes at 0002 and 0004, and a number carrying two files.
 *
 * Both shapes are real here: `packages/db/migrations/` skips 0084, and six
 * numbers carry two files each. The migrations are order-sensitive on purpose —
 * each `ALTER TABLE` appends a column, so applying the same set in a different
 * order produces a different table rather than the same one.
 */
const GAPPED = [
  ["0001_base.sql", "CREATE TABLE t (id TEXT PRIMARY KEY);"],
  ["0003_alpha.sql", "ALTER TABLE t ADD COLUMN alpha TEXT;"],
  ["0003_beta.sql", "ALTER TABLE t ADD COLUMN beta TEXT;"],
  ["0005_gamma.sql", "ALTER TABLE t ADD COLUMN gamma TEXT;"],
];

const columnsOf = (state) => state.columns.t.join(",");

test("a gap in the numbering is not a gap in the chain", async () => {
  await withChain(GAPPED, async (context) => {
    const baseline = await generateBaseline(context, "0003_beta.sql");
    // 0002 and 0004 do not exist; the boundary is a file name, so nothing here
    // is inferred from the numbers being consecutive.
    assert.deepEqual(baseline.migrations, ["0001_base.sql", "0003_alpha.sql", "0003_beta.sql"]);
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.deepEqual(plan.thenApply, ["0005_gamma.sql"]);
    assert.deepEqual(state, replayedState(context));
    assert.equal(columnsOf(state), columnsOf(replayedState(context)));
  });
});

test("a migration that fills a gap above the boundary is applied on top", async () => {
  await withChain(GAPPED, async (context) => {
    const baseline = await generateBaseline(context, "0003_beta.sql");
    // 0004 sorts above the boundary and below the tip. The baseline stays valid
    // and the new file slots into place ahead of 0005 on a fresh database.
    context.write("0004_delta.sql", "ALTER TABLE t ADD COLUMN delta TEXT;");
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "baseline");
    assert.deepEqual(plan.thenApply, ["0004_delta.sql", "0005_gamma.sql"]);
    assert.deepEqual(state, replayedState(context));
    assert.equal(columnsOf(state), "id,alpha,beta,delta,gamma");
  });
});

test("a migration that fills a gap below the boundary invalidates the baseline", async () => {
  await withChain(GAPPED, async (context) => {
    const baseline = await generateBaseline(context, "0003_beta.sql");
    // 0002 sorts below the boundary, so the snapshot no longer describes what
    // replaying would produce — it would place `two` after `beta` rather than
    // before it. The digest catches the changed file list.
    context.write("0002_two.sql", "ALTER TABLE t ADD COLUMN two TEXT;");
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "migrate", "the stale baseline must not be used");
    assert.deepEqual(state, replayedState(context));
    assert.equal(columnsOf(state), "id,two,alpha,beta,gamma");
  });
});

// ---------------------------------------------------------------------------
// A boundary that shares its number with other migrations
// ---------------------------------------------------------------------------

test("a boundary sharing a number subsumes its siblings up to and including itself", async () => {
  await withChain(GAPPED, async (context) => {
    // Boundary at the *first* of the 0003 pair: its sibling is above the
    // boundary and applied on top, even though they share a number. A numeric
    // comparison would swallow both and produce a baseline claiming a migration
    // it never ran.
    const baseline = await generateBaseline(context, "0003_alpha.sql");
    assert.deepEqual(baseline.migrations, ["0001_base.sql", "0003_alpha.sql"]);
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.deepEqual(plan.thenApply, ["0003_beta.sql", "0005_gamma.sql"]);
    assert.deepEqual(state, replayedState(context));
  });
});

test("a migration added to the boundary's number after the fact, sorting above it, is applied on top", async () => {
  await withChain(GAPPED, async (context) => {
    const baseline = await generateBaseline(context, "0003_beta.sql");
    // Same number as the boundary, added later, and `zeta` > `beta`. It is
    // above the boundary despite sharing 0003, so the baseline stays usable.
    context.write("0003_zeta.sql", "ALTER TABLE t ADD COLUMN zeta TEXT;");
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "baseline");
    assert.deepEqual(plan.thenApply, ["0003_zeta.sql", "0005_gamma.sql"]);
    assert.deepEqual(state, replayedState(context));
    assert.equal(columnsOf(state), "id,alpha,beta,zeta,gamma");
  });
});

test("a migration added to the boundary's number, sorting below it, invalidates the baseline", async () => {
  await withChain(GAPPED, async (context) => {
    const baseline = await generateBaseline(context, "0003_beta.sql");
    // Same number again, but `aardvark` < `beta`, so it lands *inside* what the
    // baseline claims to have run. Sharing a number is not what decides this —
    // sorting is.
    context.write("0003_aardvark.sql", "ALTER TABLE t ADD COLUMN aardvark TEXT;");
    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "migrate");
    assert.deepEqual(state, replayedState(context));
    assert.equal(columnsOf(state), "id,aardvark,alpha,beta,gamma");
  });
});

test("two baselines on the same number are both kept and the later one wins", async () => {
  await withChain(GAPPED, async (context) => {
    const atAlpha = await generateBaseline(context, "0003_alpha.sql");
    const atBeta = await generateBaseline(context, "0003_beta.sql");
    const merged = mergeIntoManifest([atAlpha], atBeta);
    assert.deepEqual(merged.map((entry) => entry.through), ["0003_alpha.sql", "0003_beta.sql"]);

    const { plan, state } = planAndExecute(context, merged);
    assert.equal(plan.baseline.through, "0003_beta.sql");
    assert.deepEqual(state, replayedState(context));
  });
});

test("when the later of two same-numbered baselines goes stale, the earlier one is still used", async () => {
  await withChain(GAPPED, async (context) => {
    const atAlpha = await generateBaseline(context, "0003_alpha.sql");
    const atBeta = await generateBaseline(context, "0003_beta.sql");
    // Sorts above alpha and below beta: invalidates only the later baseline.
    context.write("0003_atlas.sql", "ALTER TABLE t ADD COLUMN atlas TEXT;");

    assert.deepEqual(
      usableBaselines([atAlpha, atBeta], context.onDisk(), context.digestFor).map((entry) => entry.through),
      ["0003_alpha.sql"],
    );
    const { plan, state } = planAndExecute(context, [atAlpha, atBeta]);
    assert.equal(plan.baseline.through, "0003_alpha.sql");
    assert.ok(plan.thenApply.includes("0003_atlas.sql"));
    assert.deepEqual(state, replayedState(context));
    assert.equal(columnsOf(state), "id,alpha,atlas,beta,gamma");
  });
});

// ---------------------------------------------------------------------------
// The divergence a late insertion causes on a database that has moved on
// ---------------------------------------------------------------------------

test("a migration inserted below what a database already applied is flagged as out of order", async () => {
  await withChain(GAPPED, async (context) => {
    const applied = ["0001_base.sql", "0003_alpha.sql", "0003_beta.sql", "0005_gamma.sql"];
    context.write("0004_delta.sql", "ALTER TABLE t ADD COLUMN delta TEXT;");

    const plan = planMigration({
      applied, userTables: 1, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.deepEqual(plan.outOfOrder, ["0004_delta.sql"]);
    assert.match(describePlan("global", plan), /sort\(s\) below a migration this database already applied/u);
  });
});

test("the out-of-order case really does produce a different schema, which is why it is flagged", async () => {
  await withChain(GAPPED, async (context) => {
    const applied = ["0001_base.sql", "0003_alpha.sql", "0003_beta.sql", "0005_gamma.sql"];
    context.write("0004_delta.sql", "ALTER TABLE t ADD COLUMN delta TEXT;");

    // The database that had already moved on: Wrangler applies the missing file
    // now, so `delta` lands after `gamma`.
    const { state: late } = planAndExecute(context, [], { applied, userTables: 1 });
    // A database created today replays in file order, so `delta` lands before it.
    const fresh = replayedState(context);

    assert.equal(columnsOf(late), "id,alpha,beta,gamma,delta");
    assert.equal(columnsOf(fresh), "id,alpha,beta,delta,gamma");
    assert.notEqual(columnsOf(late), columnsOf(fresh),
      "if these ever agree, the flag is measuring nothing");
    // Both succeeded. Nothing errored, nothing was skipped — the two databases
    // are simply different, which is exactly why a warning is the only thing
    // that catches it.
    assert.deepEqual(late.ledger, fresh.ledger);
  });
});

test("a baselined database takes the fresh ordering, which is the half production will not have", async () => {
  await withChain(GAPPED, async (context) => {
    const baseline = await generateBaseline(context, "0003_beta.sql");
    context.write("0004_delta.sql", "ALTER TABLE t ADD COLUMN delta TEXT;");

    const { plan, state } = planAndExecute(context, [baseline]);
    // No warning here: nothing was applied before, so nothing is out of order.
    assert.deepEqual(plan.outOfOrder, []);
    assert.equal(columnsOf(state), "id,alpha,beta,delta,gamma");
    assert.deepEqual(state, replayedState(context));
  });
});

test("nothing is flagged out of order when every pending file sorts above what ran", async () => {
  await withChain(GAPPED, async (context) => {
    context.write("0006_later.sql", "ALTER TABLE t ADD COLUMN later TEXT;");
    const plan = planMigration({
      applied: GAPPED.map(([name]) => name), userTables: 1, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.deepEqual(plan.pending, ["0006_later.sql"]);
    assert.deepEqual(plan.outOfOrder, []);
    assert.ok(!describePlan("enterprise", plan).includes("out of order"));
  });
});

test("an unread ledger reports nothing out of order rather than guessing", async () => {
  await withChain(GAPPED, async (context) => {
    const plan = planMigration({
      applied: null, userTables: 1, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.deepEqual(plan.outOfOrder, []);
    assert.equal(plan.pending, null);
  });
});

// ---------------------------------------------------------------------------
// The repository's own numbering, which has both shapes
// ---------------------------------------------------------------------------

test("the real chain's shared numbers are subsumed together, and its 0084 hole stays a hole", () => {
  const onDisk = listMigrationFiles(join(API_DIRECTORY, "..", "..", "packages", "db", "migrations"));
  const numbers = onDisk.map((name) => name.slice(0, 4));
  const shared = [...new Set(numbers.filter((number, index) => numbers.indexOf(number) !== index))];
  assert.ok(shared.length >= 6, `expected several shared numbers, found ${shared.join(", ")}`);
  assert.ok(!numbers.includes("0084"), "0084 is the live gap this tooling is careful about");

  // Every shared number's files must land on the same side of the checked-in
  // boundary, or the baseline would claim one and leave its sibling pending.
  const baselines = readBaselineManifest(
    readFileSync(join(API_DIRECTORY, "..", "..", "packages", "db", "baselines", "manifest.json"), "utf8"),
  );
  for (const baseline of baselines) {
    for (const number of shared) {
      const siblings = onDisk.filter((name) => name.startsWith(number));
      const subsumed = siblings.filter((name) => baseline.migrations.includes(name));
      assert.ok(
        subsumed.length === 0 || subsumed.length === siblings.length,
        `${number} is split across the ${baseline.through} boundary: ${subsumed.join(", ")}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Ordering, as Wrangler does it
// ---------------------------------------------------------------------------

test("migrations are ordered the way Wrangler orders them, not as strings", () => {
  // Wrangler parses the leading integer and compares numerically, falling back
  // to a string compare only when the numbers tie. `Array.sort` disagrees the
  // moment a name is not zero-padded.
  assert.ok(compareMigrationPaths("89_backfill.sql", "0090_boundary.sql") < 0,
    "89 is below 90 numerically, whatever the strings do");
  assert.ok("89_backfill.sql" > "0090_boundary.sql",
    "…and a string compare says the opposite, which is the whole problem");
  // A tie on the number falls through to the string compare, which is how the
  // repository's six doubled numbers keep their order.
  assert.ok(compareMigrationPaths("0039_a.sql", "0039_b.sql") < 0);
  assert.ok(compareMigrationPaths("0002_a.sql", "0010_a.sql") < 0);
  // Unparseable leading segments sort after parseable ones, as Wrangler does.
  assert.ok(compareMigrationPaths("0001_a.sql", "readme_notes.sql") < 0);
  assert.equal(compareMigrationPaths("0001_a.sql", "0001_a.sql"), 0);
});

test("an unpadded migration below the boundary invalidates the baseline", async () => {
  // The case a string sort misses entirely: `89_…` is below the 0090 boundary
  // for Wrangler and above it for `Array.sort`, so the subsumed set never
  // changed, the digest never changed, and the baseline stayed "usable" while
  // producing a database that differs from a replay.
  await withChain([
    ["0088_a.sql", "CREATE TABLE t (id TEXT PRIMARY KEY);"],
    ["0089_b.sql", "ALTER TABLE t ADD COLUMN scopes TEXT;"],
    ["0090_boundary.sql", "ALTER TABLE t ADD COLUMN installed_at TEXT;"],
    ["0091_d.sql", "ALTER TABLE t ADD COLUMN region TEXT;"],
  ], async (context) => {
    const baseline = await generateBaseline(context, "0090_boundary.sql");
    context.write("89_backfill_scope_defaults.sql", "ALTER TABLE t ADD COLUMN scope_defaults TEXT;");

    assert.deepEqual(context.onDisk(), [
      "0088_a.sql", "0089_b.sql", "89_backfill_scope_defaults.sql", "0090_boundary.sql", "0091_d.sql",
    ]);
    assert.deepEqual(usableBaselines([baseline], context.onDisk(), context.digestFor), []);

    const { plan, state } = planAndExecute(context, [baseline]);
    assert.equal(plan.action, "migrate");
    assert.deepEqual(state, replayedState(context));
  });
});

test("an unpadded migration below what a database applied is flagged out of order", async () => {
  await withChain([
    ["0088_a.sql", "CREATE TABLE t (id TEXT PRIMARY KEY);"],
    ["0090_b.sql", "ALTER TABLE t ADD COLUMN x TEXT;"],
  ], async (context) => {
    context.write("89_late.sql", "ALTER TABLE t ADD COLUMN y TEXT;");
    const plan = planMigration({
      applied: ["0088_a.sql", "0090_b.sql"], userTables: 1, baselines: [],
      migrationsOnDisk: context.onDisk(), digestFor: context.digestFor,
    });
    assert.deepEqual(plan.outOfOrder, ["89_late.sql"]);
  });
});

test("the repository's own migrations sort identically under both orderings", () => {
  // True today, and the reason a string sort survived this long. If this ever
  // fails, a filename stopped being zero-padded and the two orders have parted.
  const onDisk = listMigrationFiles(join(API_DIRECTORY, "..", "..", "packages", "db", "migrations"));
  assert.deepEqual(onDisk, [...onDisk].sort());
});

// ---------------------------------------------------------------------------
// Manifest states a bad merge leaves behind
// ---------------------------------------------------------------------------

test("a manifest entry whose baseline file is missing is dropped, and said so", () => {
  // The usual cause is a merge that took the manifest hunk while the generated
  // `.sql` was never staged. The plan would otherwise announce a baseline and
  // then hand Wrangler a path that does not exist — a confusing failure for
  // something the chain can do perfectly well. Dropping it is right; dropping
  // it in silence is not, because what the operator then sees is a chain replay
  // that looks like an ordinary slow first run.
  const root = mkdtempSync(join(tmpdir(), "avalon-catalog-"));
  try {
    const migrations = join(root, "m");
    const baselines = join(root, "b");
    mkdirSync(migrations);
    mkdirSync(baselines);
    writeFileSync(join(migrations, "0001_a.sql"), "CREATE TABLE a (id TEXT);", "utf8");
    writeFileSync(join(baselines, "manifest.json"), JSON.stringify({
      baselines: [{ through: "0001_a.sql", file: "b_0001_a.sql", migrations: ["0001_a.sql"], digest: "x" }],
    }), "utf8");

    const without = loadCatalog({ migrationsDirectory: migrations, baselinesDirectory: baselines });
    assert.deepEqual(without.baselines, []);
    assert.equal(without.anomalies.length, 1);
    assert.match(without.anomalies[0], /b_0001_a\.sql is in manifest\.json but not on disk/u);
    assert.match(without.anomalies[0], /replaying the migration chain instead/u);

    writeFileSync(join(baselines, "b_0001_a.sql"), "-- present", "utf8");
    const with_ = loadCatalog({ migrationsDirectory: migrations, baselinesDirectory: baselines });
    assert.equal(with_.baselines.length, 1);
    assert.deepEqual(with_.anomalies, [], "a healthy manifest reports nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a boundary claimed twice is dropped in both copies, and said so", () => {
  // Only a merge that kept both sides produces this — `mergeIntoManifest`
  // replaces by boundary. Neither copy can be trusted over the other, so both
  // go and the chain runs; without the report that is indistinguishable from
  // having no baseline at all.
  const root = mkdtempSync(join(tmpdir(), "avalon-catalog-"));
  try {
    const migrations = join(root, "m");
    const baselines = join(root, "b");
    mkdirSync(migrations);
    mkdirSync(baselines);
    writeFileSync(join(migrations, "0001_a.sql"), "CREATE TABLE a (id TEXT);", "utf8");
    for (const file of ["b_0001_a.sql", "b_0001_a_theirs.sql"]) {
      writeFileSync(join(baselines, file), "-- present", "utf8");
    }
    writeFileSync(join(baselines, "manifest.json"), JSON.stringify({
      baselines: [
        { through: "0001_a.sql", file: "b_0001_a.sql", migrations: ["0001_a.sql"], digest: "ours" },
        { through: "0001_a.sql", file: "b_0001_a_theirs.sql", migrations: ["0001_a.sql"], digest: "theirs" },
      ],
    }), "utf8");

    const catalog = loadCatalog({ migrationsDirectory: migrations, baselinesDirectory: baselines });
    assert.equal(catalog.baselines.length, 2, "both are still loaded; selection is what drops them");
    assert.equal(catalog.anomalies.length, 1);
    assert.match(catalog.anomalies[0], /claims 0001_a\.sql twice/u);

    // And selection really does drop both rather than picking by sort order.
    assert.deepEqual(
      usableBaselines(catalog.baselines, catalog.migrationsOnDisk, () => "ours"),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a region declaring its own migrations_table is refused rather than silently mismatched", () => {
  // Wrangler reads the ledger from `migrations_table || "d1_migrations"`. The
  // baseline hardcodes `d1_migrations` in its guard and its ledger rows, and one
  // baseline serves every region, so a per-region table cannot work — and the
  // failure would be the tooling reading a ledger Wrangler never writes.
  const directory = mkdtempSync(join(tmpdir(), "avalon-mt-"));
  try {
    writeFileSync(join(directory, "wrangler.enterprise.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: "../../packages/db/migrations", migrations_table: "custom_ledger" }],
    }), "utf8");
    const options = { migrationsDirectory: sharedChain(directory) };
    assert.throws(() => discoverRegions(directory, options), /sets migrations_table to "custom_ledger"/u);

    writeFileSync(join(directory, "wrangler.enterprise.jsonc"), JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: "../../packages/db/migrations", migrations_table: "d1_migrations" }],
    }), "utf8");
    assert.deepEqual(discoverRegions(directory, options).map((entry) => entry.region), ["enterprise"],
      "spelling out the default explicitly is fine");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("no region in this repository declares a migrations_table", () => {
  assert.doesNotThrow(() => discoverRegions());
});

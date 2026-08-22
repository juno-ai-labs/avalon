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
import { join } from "node:path";

import {
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
  return {
    schema: objects.map((object) => `${object.type}:${object.name}:${object.sql.replace(/\s+/gu, " ").trim()}`),
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
  assert.deepEqual(discovered.map((entry) => entry.region), ["eu", "global"]);
  assert.ok(discovered.every((entry) => entry.binding === "DB"));
  // `wrangler.test.jsonc` binds D1 with no `migrations_dir`. Migrating it would
  // create schema in a fixture database, so the marker is the migrations
  // directory rather than the presence of a binding.
  assert.ok(!discovered.some((entry) => entry.region === "test"));
  const testConfig = JSON.parse(stripJsonComments(readFileSync(join(API_DIRECTORY, "wrangler.test.jsonc"), "utf8")));
  assert.ok(testConfig.d1_databases?.length > 0, "the fixture config must still bind D1 for this to prove anything");
  assert.ok(!testConfig.d1_databases.some((entry) => entry.migrations_dir));
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
      discoverRegions(directory).map((entry) => entry.region),
      ["apac", "global"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a config that cannot be parsed stops discovery rather than dropping a region", () => {
  const directory = mkdtempSync(join(tmpdir(), "avalon-regions-"));
  try {
    writeFileSync(join(directory, "wrangler.eu.jsonc"), "{ this is not json", "utf8");
    assert.throws(() => discoverRegions(directory), /wrangler\.eu\.jsonc could not be parsed/u);
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

// ---------------------------------------------------------------------------
// The command line and the wrangler invocation
// ---------------------------------------------------------------------------

test("arguments parse into the run's shape", () => {
  assert.deepEqual(parseArguments([]), { remote: false, list: false, regions: [] });
  assert.deepEqual(parseArguments(["--remote"]), { remote: true, list: false, regions: [] });
  assert.deepEqual(parseArguments(["--remote", "--list", "--region", "eu"]),
    { remote: true, list: true, regions: ["eu"] });
  assert.deepEqual(parseArguments(["--region", "eu", "--region", "global"]).regions, ["eu", "global"]);
  assert.throws(() => parseArguments(["--region"]), /--region needs a region name/u);
  assert.throws(() => parseArguments(["--region", "--remote"]), /--region needs a region name/u);
  assert.throws(() => parseArguments(["--nope"]), /Unrecognized argument --nope/u);
});

test("an unknown region is refused, naming the ones that exist", () => {
  const discovered = [{ region: "global" }, { region: "eu" }];
  assert.deepEqual(resolveTargets(discovered, []), discovered);
  assert.deepEqual(resolveTargets(discovered, ["eu"]), [{ region: "eu" }]);
  assert.throws(() => resolveTargets(discovered, ["apac"]), /apac is not a region here; found global, eu/u);
});

test("the database name lands after the subcommand, whichever subcommand it is", () => {
  const target = { region: "eu", config: "wrangler.eu.jsonc", binding: "DB", remote: false };
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
  const target = { region: "eu", config: "wrangler.eu.jsonc", binding: "DB" };
  const local = wranglerArguments({ ...target, remote: false }, ["migrations", "apply"]);
  assert.ok(local.includes("--local"));
  assert.deepEqual(local.slice(local.indexOf("--persist-to"), local.indexOf("--persist-to") + 2),
    ["--persist-to", ".wrangler/state/eu"]);
  assert.deepEqual(local.slice(local.indexOf("--env-file"), local.indexOf("--env-file") + 2),
    ["--env-file", ".dev.vars.eu"]);

  const remote = wranglerArguments({ ...target, remote: true }, ["migrations", "apply"]);
  assert.ok(remote.includes("--remote"));
  // A hosted run must not be pointed at local state or local secrets.
  assert.ok(!remote.includes("--local"));
  assert.ok(!remote.includes("--persist-to"));
  assert.ok(!remote.includes("--env-file"));
  assert.deepEqual(remote.slice(-2), ["--config", "wrangler.eu.jsonc"]);
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
    const after = onDisk.filter((name) => name > baseline.through);
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
    assert.match(describePlan("eu", plan), /applying 4 pending migration\(s\)/u);
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

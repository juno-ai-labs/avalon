// The decision the local migrate wrapper makes before it runs anything: is this
// database empty enough to be baselined, or does it get the ordinary chain?
//
// Wrangler itself is injected rather than run. What is worth covering here is
// the classification and the reporting — the two places a wrong answer is
// silent. Applying the baseline for real, and the guard that catches a
// misclassification anyway, are covered by
// `packages/db/test/baseline-migration.test.ts` and by the end-to-end
// `pnpm db:migrate` the session-start hook runs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  REGIONS,
  describePlan,
  inspectLocalDatabase,
  readManifest,
  shouldApplyBaseline,
} from "./migrate-local-region.mjs";

/**
 * A stand-in for `execFile` that answers each query in the order asked and
 * records the SQL it was given. The SQL is read from the argument after
 * `--command` rather than from the end of the list, because the region's
 * `--env-file` is what actually sits last.
 */
function wranglerReturning(...payloads) {
  const calls = [];
  const run = (command, args) => {
    calls.push(args[args.indexOf("--command") + 1]);
    const payload = payloads[calls.length - 1];
    if (payload === undefined) throw new Error(`unexpected query #${calls.length}`);
    // Wrangler prints a banner before the JSON; the parser has to find it.
    return Promise.resolve({ stdout: `⛅️ wrangler 4.123.0\n──────\n${JSON.stringify([{ results: payload }])}` });
  };
  return { run, calls };
}

test("both regions are named, and each maps to a baseline the manifest knows", () => {
  assert.deepEqual(REGIONS, ["global", "eu"]);
  const manifest = readManifest();
  assert.match(manifest.file, /^b_\d{4}_.*\.sql$/u);
  assert.ok(Array.isArray(manifest.migrations) && manifest.migrations.length > 0);
});

test("a database with no tables and no ledger rows gets the baseline", () => {
  assert.equal(shouldApplyBaseline({ userTables: 0, ledgerRows: 0 }), true);
});

test("a database with tables does not get the baseline", () => {
  assert.equal(shouldApplyBaseline({ userTables: 42, ledgerRows: 95 }), false);
  assert.equal(shouldApplyBaseline({ userTables: 42, ledgerRows: 0 }), false);
  assert.equal(shouldApplyBaseline({ userTables: 42, ledgerRows: null }), false);
});

test("a database with ledger rows but no tables does not get the baseline", () => {
  // The state a migration that failed partway leaves, and the one that wedged
  // the sandbox. Baselining here would record every subsumed migration as
  // applied a second time over a schema that never ran them — so the two
  // conditions are separate checks rather than one.
  assert.equal(shouldApplyBaseline({ userTables: 0, ledgerRows: 1 }), false);
});

test("an empty database is inspected without querying a ledger that does not exist", async () => {
  // SQLite compiles a statement whole, so naming `d1_migrations` before knowing
  // it exists would fail on exactly the database this is meant to detect.
  const { run, calls } = wranglerReturning([{ user_tables: 0, has_ledger: 0 }]);
  const state = await inspectLocalDatabase("global", { run });
  assert.deepEqual(state, { userTables: 0, ledgerRows: 0, hasLedger: false });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("FROM d1_migrations"));
});

test("a table-less database with a ledger is asked how many migrations it has applied", async () => {
  // The one case where the count changes the answer: no tables, so the ledger
  // decides between "empty, baseline it" and "a migration failed partway".
  const { run, calls } = wranglerReturning(
    [{ user_tables: 0, has_ledger: 1 }],
    [{ applied: 95 }],
  );
  const state = await inspectLocalDatabase("eu", { run });
  assert.deepEqual(state, { userTables: 0, ledgerRows: 95, hasLedger: true });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /FROM d1_migrations/u);
  assert.equal(shouldApplyBaseline(state), false);
});

test("a ledger table that exists but is empty still reports zero applied", async () => {
  // Wrangler creates the ledger before it applies anything, so this is the
  // state a first run interrupted at the wrong moment leaves behind.
  const { run } = wranglerReturning([{ user_tables: 0, has_ledger: 1 }], [{ applied: 0 }]);
  const state = await inspectLocalDatabase("global", { run });
  assert.deepEqual(state, { userTables: 0, ledgerRows: 0, hasLedger: true });
  assert.equal(shouldApplyBaseline(state), true);
});

test("the inventory query ignores the tables the platform creates for itself", async () => {
  const { run, calls } = wranglerReturning([{ user_tables: 0, has_ledger: 0 }]);
  await inspectLocalDatabase("global", { run });
  const [inventory] = calls;
  for (const excluded of ["_cf\\_%", "sqlite\\_%", "d1_migrations", "_baseline_empty_database_guard"]) {
    assert.ok(inventory.includes(excluded), `inventory must exclude ${excluded}`);
  }
});

test("a response with no JSON payload is an error rather than an empty database", async () => {
  // The failure that would otherwise baseline a populated database: wrangler
  // erroring out, its message parsed as "nothing here".
  const run = () => Promise.resolve({ stdout: "✘ [ERROR] could not open database" });
  await assert.rejects(() => inspectLocalDatabase("global", { run }), /returned no JSON/u);
});

test("a missing result row is read as empty rather than as NaN", async () => {
  const { run } = wranglerReturning([]);
  assert.deepEqual(await inspectLocalDatabase("global", { run }), {
    userTables: 0, ledgerRows: 0, hasLedger: false,
  });
});

test("the plan says which database is getting the baseline and which is not", () => {
  assert.match(
    describePlan("global", { userTables: 0, ledgerRows: 0 }, "b_0090_x.sql"),
    /^global: empty database — applying b_0090_x\.sql/u,
  );
  assert.match(
    describePlan("eu", { userTables: 42, ledgerRows: null }, "b_0090_x.sql"),
    /^eu: 42 tables — skipping the baseline/u,
  );
});

test("a database with tables is not asked how many migrations it has applied", () => {
  // The warm path `scripts/session-start.sh` takes on every session after the
  // first. The ledger cannot change the answer once there are tables, and
  // counting it costs a second wrangler start-up per region.
  const { run, calls } = wranglerReturning([{ user_tables: 42, has_ledger: 1 }]);
  return inspectLocalDatabase("global", { run }).then((state) => {
    assert.deepEqual(state, { userTables: 42, ledgerRows: null, hasLedger: true });
    assert.equal(calls.length, 1, "the ledger must not be counted");
  });
});

test("a ledger that was not counted is reported as unknown, not as none", () => {
  // `ledgerRows: 0` would be a fact nobody established. Anything downstream
  // reading it as "no migrations applied" would conclude the opposite of the
  // truth on a fully migrated database.
  const { run } = wranglerReturning([{ user_tables: 42, has_ledger: 1 }]);
  return inspectLocalDatabase("eu", { run }).then((state) => {
    assert.equal(state.ledgerRows, null);
    assert.equal(shouldApplyBaseline(state), false);
  });
});

test("the plan names whichever fact settled the question, and invents neither", () => {
  assert.equal(
    describePlan("global", { userTables: 42, ledgerRows: null }, "b_0090_x.sql"),
    "global: 42 tables — skipping the baseline and migrating the ordinary way.",
  );
  assert.equal(
    describePlan("eu", { userTables: 0, ledgerRows: 3 }, "b_0090_x.sql"),
    "eu: 3 applied migrations and no tables — skipping the baseline and migrating the ordinary way.",
  );
});

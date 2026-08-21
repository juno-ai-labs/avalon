// Migrates one region's **local** D1 database: `node scripts/migrate-local-region.mjs <global|eu>`
//
// An empty database is seeded from the checked-in baseline
// (`packages/db/baselines/`) and then handed to Wrangler, which finds every
// subsumed migration already recorded in the ledger and applies only what came
// after. A database that already has tables skips the baseline entirely and is
// migrated the ordinary way, so this is a fast path for a fresh checkout rather
// than a change to how migrations work.
//
// Why the emptiness question is asked here rather than left to the baseline's
// own CHECK: the guard exists to make misapplication impossible, and it fails
// the whole command when it fires. A warm container re-running setup has a
// populated database and must continue quietly to Wrangler, not stop with a
// constraint error — `scripts/session-start.sh` runs this on every session.
//
// Wrangler remains the only thing that applies migrations and the only thing
// that writes ledger rows for them. Hosted databases never reach this file;
// `db:migrate:remote` still runs `wrangler d1 migrations apply --remote` over
// the full chain, which is what keeps `packages/db/migrations/` authoritative.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";
import { internalTableExclusionSql, parseWranglerJson } from "./d1-baseline.mjs";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(repositoryRoot, "apps", "api");
const baselinesDirectory = join(repositoryRoot, "packages", "db", "baselines");

export const REGIONS = ["global", "eu"];

/**
 * Counts the tables a baseline would collide with, and whether Wrangler's
 * ledger exists. The internal tables are excluded through the same shared
 * fragment the baseline's own guard uses, so this cannot decide a database is
 * empty and then be refused by the file it goes on to apply.
 */
const INVENTORY_QUERY = `SELECT
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table'
      AND ${internalTableExclusionSql()}
  ) AS user_tables,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations') AS has_ledger`;

function wranglerArguments(region, rest) {
  return [
    "exec", "wrangler", "d1", ...rest,
    "--local",
    "--persist-to", `.wrangler/state/${region}`,
    "--config", `wrangler.${region}.jsonc`,
    "--env-file", `.dev.vars.${region}`,
  ];
}

async function query(region, sql, { run = execFileAsync } = {}) {
  const { stdout } = await run(
    "pnpm",
    wranglerArguments(region, ["execute", "DB", "--json", "--command", sql]),
    { cwd: apiDirectory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return parseWranglerJson(stdout, region)[0]?.results ?? [];
}

/**
 * What is already in the local database: how many user tables it has, and how
 * many migrations its ledger claims.
 *
 * The ledger is counted in a second query because SQLite compiles a statement
 * whole — naming `d1_migrations` in the first one would fail outright on a
 * database that has never been migrated, which is precisely the case this is
 * trying to detect.
 */
export async function inspectLocalDatabase(region, options = {}) {
  const [inventory] = await query(region, INVENTORY_QUERY, options);
  const userTables = Number(inventory?.user_tables ?? 0);
  const hasLedger = Number(inventory?.has_ledger ?? 0) > 0;

  // Counting the ledger costs a second `wrangler d1 execute`, about three
  // seconds of start-up per region, and it can only change the answer on a
  // database with no tables — `shouldApplyBaseline` already refuses one that
  // has any. `scripts/session-start.sh` takes this path on every session after
  // the first, so asking the second question anyway roughly tripled what a warm
  // `pnpm db:migrate` costs. `ledgerRows` is null when it was not counted,
  // rather than 0, so nothing downstream can read "not asked" as "none".
  if (userTables > 0) return { userTables, ledgerRows: null, hasLedger };
  if (!hasLedger) return { userTables, ledgerRows: 0, hasLedger };

  const [ledger] = await query(region, "SELECT COUNT(*) AS applied FROM d1_migrations", options);
  return { userTables, ledgerRows: Number(ledger?.applied ?? 0), hasLedger };
}

/**
 * Whether the baseline may be applied. Both conditions are required and they
 * are not redundant: a database can carry ledger rows with no user tables (a
 * migration that failed partway, or a hand-emptied database), and applying a
 * baseline there would record migrations as applied a second time over a schema
 * that does not match them.
 */
export function shouldApplyBaseline({ userTables, ledgerRows }) {
  return userTables === 0 && ledgerRows === 0;
}

/**
 * What the run is about to do, phrased for someone reading setup output.
 *
 * Reports whichever fact settled the question, rather than both: a database with
 * tables never has its ledger counted, so naming a number here that was not
 * fetched would be inventing it.
 */
export function describePlan(region, state, baselineFile) {
  if (shouldApplyBaseline(state)) {
    return `${region}: empty database — applying ${baselineFile}, then any migrations after it.`;
  }
  const reason = state.userTables > 0
    ? `${state.userTables} tables`
    : `${state.ledgerRows} applied migrations and no tables`;
  return `${region}: ${reason} — skipping the baseline and migrating the ordinary way.`;
}

function runInherited(region, rest) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("pnpm", wranglerArguments(region, rest), { cwd: apiDirectory, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`wrangler was interrupted by ${signal}`));
      else if (code !== 0) reject(new Error(`wrangler exited ${code}`));
      else resolveRun();
    });
  });
}

export function readManifest() {
  return JSON.parse(readFileSync(join(baselinesDirectory, "manifest.json"), "utf8")).baseline;
}

async function main() {
  const region = process.argv[2];
  if (!REGIONS.includes(region)) {
    throw new Error(`Usage: node scripts/migrate-local-region.mjs <${REGIONS.join("|")}>`);
  }

  const baseline = readManifest();
  const state = await inspectLocalDatabase(region);
  console.log(describePlan(region, state, baseline.file));

  if (shouldApplyBaseline(state)) {
    await runInherited(region, ["execute", "DB", "--file", join(baselinesDirectory, baseline.file)]);
  }
  await runInherited(region, ["migrations", "apply", "DB"]);
}

if (isEntryPoint(import.meta.url)) await main();

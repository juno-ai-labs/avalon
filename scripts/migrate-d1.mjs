// The one script that migrates D1 — every region, local or hosted.
//
//   node scripts/migrate-d1.mjs                     # every region, local
//   node scripts/migrate-d1.mjs --region global         # one region, local
//   node scripts/migrate-d1.mjs --remote            # every region, hosted
//   node scripts/migrate-d1.mjs --remote --list     # what is pending, hosted
//
// It replaced a pair of scripts and four package aliases that each knew one
// region by name. Regions are now **discovered** from `apps/api/wrangler.*.jsonc`
// — a config with a D1 binding that declares `migrations_dir` is a region, and
// nothing else is — so adding one is adding its config, not editing a list here
// and three more elsewhere. `wrangler.test.jsonc` binds D1 without a
// `migrations_dir`, which is exactly the distinction: it is a test fixture, not
// a database anybody migrates.
//
// The baseline is likewise **calculated** rather than named. Several baselines
// may exist; the script picks the one that gets an empty database furthest,
// skips any whose migrations have moved underneath it, and lets Wrangler apply
// whatever comes after. See `planMigration` in `d1-baseline.mjs`.
//
// **Hosted databases never get a baseline.** That is passed in as
// `allowBaseline: false` rather than living in a separate script, so it is one
// line, stated once, and a test can assert it. The reasoning is in
// `docs/d1-baseline-migrations.md`: the chain is the authoritative schema, a
// baseline is derived from it, and a hosted database whose provenance is a
// generated file is one nobody can check. Replaying 43 seconds once, when a
// region is created, is not a cost worth trading that for.
//
// Wrangler remains the only thing that applies a migration or writes a ledger
// row for one. This script decides what should happen and then asks Wrangler to
// do it.

import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";
import {
  describePlan,
  digestMigrations,
  duplicateBoundaries,
  internalTableExclusionSql,
  listMigrationFiles,
  parseWranglerJson,
  planMigration,
  readBaselineManifest,
} from "./d1-baseline.mjs";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const API_DIRECTORY = join(repositoryRoot, "apps", "api");
export const MIGRATIONS_DIRECTORY = join(repositoryRoot, "packages", "db", "migrations");
export const BASELINES_DIRECTORY = join(repositoryRoot, "packages", "db", "baselines");

/**
 * Every region with a migratable D1 database, in a stable order.
 *
 * The marker is a `d1_databases` entry carrying `migrations_dir`. A Worker can
 * bind D1 without owning a migration history — `wrangler.test.jsonc` does — and
 * migrating that one would create schema in a fixture database nobody reads.
 *
 * Comments are stripped before parsing because these are `.jsonc`; Wrangler
 * accepts comments in them and `JSON.parse` does not.
 */
export function discoverRegions(apiDirectory = API_DIRECTORY, {
  read = readFileSync,
  list = readdirSync,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
} = {}) {
  const regions = [];
  for (const fileName of list(apiDirectory).sort()) {
    const match = /^wrangler\.([a-z0-9-]+)\.jsonc?$/u.exec(fileName);
    if (!match) continue;
    let config;
    try {
      config = JSON.parse(stripJsonComments(read(join(apiDirectory, fileName), "utf8")));
    } catch {
      // A config this cannot parse is not silently skipped as "not a region" —
      // that would drop a real region on a stray comma and migrate one fewer
      // database than the operator asked for.
      throw new Error(`${fileName} could not be parsed while discovering regions`);
    }
    const binding = (config.d1_databases ?? []).find((entry) => typeof entry.migrations_dir === "string");
    if (!binding) continue;
    // Wrangler reads the ledger from `migrations_table || "d1_migrations"`, but
    // the baseline's emptiness guard, its ledger INSERT, and the inventory query
    // all name `d1_migrations` outright — and one baseline file serves every
    // region, so it cannot carry a different table per region anyway. A config
    // that set this would leave the tooling reading a ledger Wrangler does not
    // use, which is silent and total.
    if (typeof binding.migrations_table === "string" && binding.migrations_table !== "d1_migrations") {
      throw new Error(
        `${fileName} sets migrations_table to ${JSON.stringify(binding.migrations_table)}. The baseline `
        + "hardcodes d1_migrations in its guard and its ledger rows, and one baseline serves every "
        + "region, so a per-region ledger table cannot be supported without reworking both.",
      );
    }
    // `migrations_dir` is the marker that this binding is migratable, and it is
    // also the chain Wrangler will actually apply — while everything here plans
    // against `packages/db/migrations`: the baseline, its ledger rows, the
    // digest, the pending count. A region pointing somewhere else would be
    // handed this chain's baseline and then have a different chain applied on
    // top of it. Refused for the same reason `migrations_table` is: one baseline
    // serves every region, so every region has to be the same chain.
    const declared = resolve(apiDirectory, binding.migrations_dir);
    if (declared !== migrationsDirectory) {
      throw new Error(
        `${fileName} points migrations_dir at ${binding.migrations_dir}, which resolves to ${declared} `
        + `rather than ${migrationsDirectory}. Every region shares one chain and one baseline, so `
        + "planning here and applying there would build a database from two different histories.",
      );
    }
    regions.push({ region: match[1], config: fileName, binding: binding.binding ?? "DB" });
  }
  return regions;
}

/**
 * Turns JSONC into JSON: strips `//` and block comments, and drops the trailing
 * commas JSONC allows.
 *
 * A `//` inside a string is a URL, not a comment — `wrangler.global.jsonc` is
 * full of `https://…` in routes — so this tracks quoting rather than running a
 * regular expression over the whole file.
 *
 * Trailing commas are dropped because Wrangler reads these files with a real
 * JSONC parser and accepts them, so a config carrying one is valid input that
 * this would otherwise reject. Discovery parses *every* `wrangler.*.jsonc`
 * before picking the requested region, so one such comma anywhere fails local
 * migration, hosted migration and baseline verification for every region at
 * once.
 */
export function stripJsonComments(source) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      // Stepping *over* an escape rather than looking one character back: a
      // backslash-quote and an escaped backslash followed by a real closing
      // quote are indistinguishable from behind, so `"C:\\\\"` swallowed its own
      // terminator, ran the scanner on inside a string that was already closed,
      // stopped recognising `//` as a comment, and took `JSON.parse` down. One
      // such value in one region config fails `discoverRegions` for every
      // region — including the hosted path in `deploy-api.yml`.
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      output += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    // A closing brace or bracket retroactively makes any comma behind it — and
    // any whitespace or comment that was between them — a trailing comma.
    // Trimming here rather than with a regex over the finished text keeps
    // `{"a": "x,"}` intact, since a comma inside a string never reaches this.
    if (character === "}" || character === "]") output = output.replace(/,\s*$/u, "");
    output += character;
    index += 1;
  }
  return output;
}

/**
 * The wrangler argument vector for one region.
 *
 * `command` is the subcommand path and `args` what follows the database name,
 * because the name's position depends on the subcommand: `d1 execute DB …` is
 * one token deep and `d1 migrations apply DB` is two. Splicing on a fixed index
 * puts the binding in the middle of `migrations apply`, which wrangler rejects
 * with a usage error rather than doing something quietly wrong — but only when
 * the command actually runs.
 *
 * A hosted run passes `--remote` and nothing else: no `--persist-to`, and no
 * `--env-file`, matching what the remote scripts did before they were unified.
 */
export function wranglerArguments({ region, config, binding, remote }, command, args = []) {
  const location = remote
    ? ["--remote"]
    : ["--local", "--persist-to", `.wrangler/state/${region}`, "--env-file", `.dev.vars.${region}`];
  return ["exec", "wrangler", "d1", ...command, binding, ...args, ...location, "--config", config];
}

/** Require the local environment files produced by env:sync before invoking Wrangler. */
export function assertRegionalEnvFilesExist(targets, directory = API_DIRECTORY) {
  const missing = targets
    .filter((target) => !target.remote)
    .map((target) => target.region)
    .filter((region) => !existsSync(join(directory, `.dev.vars.${region}`)));
  if (missing.length === 0) return;
  throw new Error(`No apps/api/.dev.vars.${missing[0]} for the discovered region `
    + `${missing.join(", ")}. \`pnpm env:sync\` generates regional env files for configured deployments, `
    + "so add this deployment to config/regions.json and run env:sync.");
}

/**
 * The pnpm to launch, which is not `pnpm` everywhere.
 *
 * On Windows the installed entry point is the `pnpm.cmd` shim, and `execFile`
 * and `spawn` run an executable directly rather than through a shell, so they
 * do not find it under the bare name. `scripts/dev-regional-api.mjs` already
 * carries this; naming it once means the next script that shells out inherits
 * the answer instead of rediscovering it.
 */
export function pnpmExecutable(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

const LEDGER_QUERY = "SELECT name FROM d1_migrations ORDER BY id";

/**
 * Counts the tables a baseline would collide with, and whether Wrangler's
 * ledger exists, through the same exclusion rule the baseline's own guard uses
 * so the two can never disagree about what "empty" means.
 */
const INVENTORY_QUERY = `SELECT
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table'
      AND ${internalTableExclusionSql()}
  ) AS user_tables,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations') AS has_ledger`;

async function query(target, sql, { run = execFileAsync } = {}) {
  const { stdout } = await run(
    pnpmExecutable(),
    wranglerArguments(target, ["execute"], ["--json", "--command", sql]),
    { cwd: API_DIRECTORY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseWranglerJson(stdout, target.region)[0]?.results ?? [];
}

/**
 * What one database already holds: its user-table count and the migrations its
 * ledger names.
 *
 * The ledger is read in a second query, and only when the first says it exists:
 * SQLite compiles a statement whole, so naming `d1_migrations` before knowing it
 * exists fails on the very database this is meant to detect.
 *
 * It *is* read on a database that already has tables, even though nothing there
 * can turn the plan into a baseline. That costs one wrangler start-up on a
 * command that already spends several, and it is the only way `outOfOrder` and
 * `unknownApplied` ever fire: an established local database and production are
 * precisely the databases that have tables, so skipping the read there left
 * both checks unreachable everywhere they matter.
 */
export async function inspectDatabase(target, options = {}) {
  const [inventory] = await query(target, INVENTORY_QUERY, options);
  const userTables = Number(inventory?.user_tables ?? 0);
  const hasLedger = Number(inventory?.has_ledger ?? 0) > 0;
  // `null`, not `[]`: a database with tables and no ledger has applied something
  // this tooling cannot name, and saying "nothing applied" would have the plan
  // report every migration as pending on a database that may be fully migrated.
  if (!hasLedger) return { userTables, applied: userTables > 0 ? null : [], hasLedger, ledgerRead: false };
  const rows = await query(target, LEDGER_QUERY, options);
  return { userTables, applied: rows.map((row) => String(row.name)), hasLedger, ledgerRead: true };
}

/**
 * `inspectDatabase`, except that on a hosted database a failure warns instead of
 * throwing.
 *
 * With `allowBaseline: false` the hosted plan is `migrate` or `up-to-date` and
 * both fall through to the same unconditional `migrations apply`, so nothing
 * read here can change what happens — it is reporting. A transient D1 error or
 * a permissions change on the ledger query would otherwise be a new way for the
 * migration step of `deploy-api.yml` to fail *before* Wrangler is reached,
 * where the raw alias it replaced would simply have applied the migrations.
 *
 * Locally a failure still throws: there the inspection decides whether the
 * database gets a baseline, and guessing wrong replays ninety-five migrations
 * or, worse, hands the baseline to a database that already has tables.
 */
export async function inspectForPlan(target, options = {}) {
  if (!target.remote) return inspectDatabase(target, options);
  try {
    return await inspectDatabase(target, options);
  } catch (error) {
    console.warn(`${target.region}: could not inspect before applying (${error.message})`);
    return { userTables: 0, applied: null, hasLedger: false, ledgerRead: false };
  }
}

/** Loads the migrations and baselines this checkout offers. */
export function loadCatalog({
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  baselinesDirectory = BASELINES_DIRECTORY,
} = {}) {
  const migrationsOnDisk = listMigrationFiles(migrationsDirectory);
  const manifestPath = join(baselinesDirectory, "manifest.json");
  const declared = existsSync(manifestPath) ? readBaselineManifest(readFileSync(manifestPath, "utf8")) : [];
  // A manifest entry whose `.sql` is not on disk — the usual cause is a merge
  // that took the manifest hunk while the generated file was never staged. The
  // plan would otherwise announce a baseline and then hand Wrangler a path that
  // does not exist, which is a confusing failure for something the chain can do
  // perfectly well.
  const baselines = declared.filter((baseline) => existsSync(join(baselinesDirectory, baseline.file)));
  // Both ways a manifest can be wrong end the same way — the chain replays and
  // nothing says why — so they are reported rather than only dropped. A slow
  // setup is what a broken manifest looks like from the outside, and that is
  // exactly the failure nobody investigates.
  const anomalies = [
    ...declared
      .filter((baseline) => !baselines.includes(baseline))
      .map((baseline) => `${baseline.file} is in manifest.json but not on disk`),
    ...duplicateBoundaries(baselines)
      .map((through) => `manifest.json claims ${through} twice, and there is no way to tell which snapshot is right`),
  ].map((detail) => `${detail} — ignoring it and replaying the migration chain instead`);
  return {
    migrationsOnDisk,
    baselines,
    baselinesDirectory,
    anomalies,
    digestFor: (files) => digestMigrations(migrationsDirectory, files),
  };
}

function runInherited(target, command, args = []) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(pnpmExecutable(), wranglerArguments(target, command, args), {
      cwd: API_DIRECTORY,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`wrangler was interrupted by ${signal}`));
      else if (code !== 0) reject(new Error(`wrangler exited ${code}`));
      else resolveRun();
    });
  });
}

/** Parses argv into the run's shape, so the CLI surface is testable. */
export function parseArguments(argv) {
  const options = { remote: false, list: false, regions: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remote") options.remote = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--region") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--region needs a region name");
      options.regions.push(value);
      index += 1;
    } else throw new Error(`Unrecognized argument ${argument}`);
  }
  return options;
}

/** The regions a run covers, refusing a name this checkout does not define. */
export function resolveTargets(discovered, requested) {
  if (requested.length === 0) return discovered;
  return requested.map((name) => {
    const found = discovered.find((entry) => entry.region === name);
    if (!found) {
      throw new Error(`${name} is not a region here; found ${discovered.map((entry) => entry.region).join(", ")}`);
    }
    return found;
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const targets = resolveTargets(discoverRegions(), options.regions)
    .map((entry) => ({ ...entry, remote: options.remote }));
  if (targets.length === 0) throw new Error("No regions discovered in apps/api");
  assertRegionalEnvFilesExist(targets);

  const catalog = loadCatalog();
  for (const anomaly of catalog.anomalies) console.warn(`baselines: ${anomaly}`);

  for (const target of targets) {
    if (options.list) {
      // Delegated to Wrangler verbatim. `.github/workflows/deploy-api.yml` pipes
      // this into `classify-pending-d1-migrations.mjs`, which reads every
      // migration filename it sees as pending — so the deploy gate keys off
      // Wrangler's own answer rather than this script's reimplementation of it.
      await runInherited(target, ["migrations", "list"]);
      continue;
    }

    const state = await inspectForPlan(target);
    const plan = planMigration({
      applied: state.applied,
      userTables: state.userTables,
      baselines: catalog.baselines,
      migrationsOnDisk: catalog.migrationsOnDisk,
      digestFor: catalog.digestFor,
      // The hosted policy, stated once.
      allowBaseline: !target.remote,
    });
    console.log(describePlan(`${target.region}${target.remote ? " (remote)" : ""}`, plan));

    if (plan.action === "baseline") {
      await runInherited(target, ["execute"], ["--file", join(catalog.baselinesDirectory, plan.baseline.file)]);
    }
    await runInherited(target, ["migrations", "apply"]);
  }
}

if (isEntryPoint(import.meta.url)) await main();

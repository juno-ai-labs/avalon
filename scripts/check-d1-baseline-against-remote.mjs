// Checks the checked-in D1 baseline against the schema the hosted databases
// actually have: `pnpm db:baseline:verify` (add `-- --record` to refresh the
// fingerprint the offline suite compares against).
//
// The baseline is derived from the migration chain, and the equivalence suite
// already proves it matches a replay of that chain. This script answers the
// different question that suite cannot: **does the chain still describe
// production?** A migration that was hand-applied, half-applied, or applied and
// then patched around leaves the hosted database somewhere the repository does
// not know about, and every local database built from the baseline would then be
// faithfully reproducing a schema nobody runs.
//
// It also compares Global against regional. The two regions run the same migrations
// but are separate databases with separate ledgers, so "both are migrated" and
// "both are the same" are genuinely different claims, and only the second one
// makes a single baseline correct for both.
//
// Requires Cloudflare credentials and network access, so it is a manual and
// operator step rather than a CI gate — `scripts/d1-baseline.test.mjs` compares
// the baseline against the fingerprint this records, which is what keeps the
// result enforced afterwards without credentials.

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";
import { discoverRegions, pnpmExecutable, wranglerArguments } from "./migrate-d1.mjs";
import {
  applyMigrations,
  compareFingerprints,
  fingerprintsMatch,
  listMigrationFiles,
  parseWranglerJson,
  schemaFingerprint,
  snapshotDatabase,
  subsumedMigrations,
} from "./d1-baseline.mjs";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(repositoryRoot, "apps", "api");
export const BASELINES_DIRECTORY = join(repositoryRoot, "packages", "db", "baselines");
export const MIGRATIONS_DIRECTORY = join(repositoryRoot, "packages", "db", "migrations");
export const FINGERPRINT_PATH = join(BASELINES_DIRECTORY, "production-fingerprint.json");

/**
 * The regions to read, discovered from the Wrangler configs rather than listed
 * here, so a new region is checked the day it exists instead of the day someone
 * remembers this file.
 */
export function regions() {
  return discoverRegions().map((entry) => entry.region);
}

const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";

/**
 * Reads a hosted database's schema. Only `sqlite_schema` is selected — the
 * script never reads a row of production data, which is what makes running it
 * against a live customer database an unremarkable thing to do.
 */
export async function readRemoteSchema(region, { run = execFileAsync } = {}) {
  const target = discoverRegions().find((entry) => entry.region === region);
  if (!target) throw new Error(`${region} is not a region in this checkout`);
  const { stdout } = await run(
    pnpmExecutable(),
    wranglerArguments({ ...target, remote: true }, ["execute"], ["--json", "--command", SCHEMA_QUERY]),
    { cwd: apiDirectory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = parseWranglerJson(stdout, region);
  const results = parsed[0]?.results;
  if (!Array.isArray(results)) throw new Error(`wrangler returned no schema rows for ${region}`);
  return results;
}

/**
 * The fingerprint of the **migration chain**, by replaying every file.
 *
 * The chain rather than a baseline, deliberately. A baseline describes the
 * schema at its own boundary, so the moment a migration lands above it the two
 * stop being the same thing and comparing the baseline to production would
 * report the new migration as drift. Comparing the chain keeps this check
 * correct as migrations accumulate, and the baselines are tied in by a separate
 * equivalence that does not need credentials: `baseline + everything after it`
 * reproduces the chain, asserted for every baseline in
 * `packages/db/test/baseline-migration.test.ts`. Chain equals production here,
 * baseline equals chain there, so baseline equals production by composition —
 * and each half is checked where it can actually be checked.
 */
export function chainFingerprint(directory = MIGRATIONS_DIRECTORY, { through } = {}) {
  const onDisk = listMigrationFiles(directory);
  // `through` truncates the replay at a migration that has actually been
  // deployed. The live run wants the whole chain — it is asking whether
  // production is current. The offline run wants the chain as it stood when the
  // fingerprint was captured, because a migration merged five minutes ago is
  // legitimately not in production yet and must not be reported as drift by a
  // test with no way to reach a live database.
  const files = through === undefined ? onDisk : subsumedMigrations(onDisk, through);
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database, directory, files);
    return schemaFingerprint(snapshotDatabase(database).objects);
  } finally {
    database.close();
  }
}

/** One line per difference, in the order a reader should work through them. */
export function describeComparison(label, comparison) {
  if (fingerprintsMatch(comparison)) return [`${label}: match`];
  return [
    `${label}: MISMATCH`,
    ...comparison.missing.map((key) => `  missing from actual:   ${key}`),
    ...comparison.unexpected.map((key) => `  not in expected:       ${key}`),
    ...comparison.changed.map((key) => `  definition differs:    ${key}`),
  ];
}

/**
 * The whole check as a pure function over already-fetched schemas, so the
 * reporting and the pass/fail decision are testable without Cloudflare.
 */
export function verifyAgainstRegions({ expected, regionSchemas }) {
  const lines = [];
  let ok = true;

  // A pass has to mean something was compared. Every loop below iterates over
  // `regionSchemas`, so an empty one runs none of them and leaves `ok` at its
  // initial `true` — a green result reporting on nothing at all.
  if (Object.keys(regionSchemas).length === 0) {
    return { ok: false, lines: ["no hosted schemas to compare against"], fingerprints: {} };
  }

  const fingerprints = Object.fromEntries(
    Object.entries(regionSchemas).map(([region, objects]) => [region, schemaFingerprint(objects)]),
  );

  for (const [region, fingerprint] of Object.entries(fingerprints)) {
    const comparison = compareFingerprints(expected, fingerprint);
    ok &&= fingerprintsMatch(comparison);
    lines.push(...describeComparison(`chain vs ${region}`, comparison));
  }

  // Region-to-region, so a divergence between two hosted databases is reported
  // as itself rather than as two separate baseline mismatches.
  const [first, ...rest] = Object.keys(fingerprints);
  for (const other of rest) {
    const comparison = compareFingerprints(fingerprints[first], fingerprints[other]);
    ok &&= fingerprintsMatch(comparison);
    lines.push(...describeComparison(`${first} vs ${other}`, comparison));
  }

  return { ok, lines, fingerprints };
}

async function main() {
  const record = process.argv.includes("--record");
  const expected = chainFingerprint();

  const regionSchemas = {};
  const discovered = regions();
  // Without this, a discovery regression turns the whole check into a pass: an
  // empty `regionSchemas` has nothing to disagree with, `verifyAgainstRegions`
  // reports `ok`, and the command exits 0 having never contacted Cloudflare.
  if (discovered.length === 0) {
    throw new Error("no regions discovered — every wrangler.<region>.jsonc is missing or its D1 binding "
      + "declares no migrations_dir, so there is nothing to verify against");
  }
  for (const region of discovered) {
    process.stderr.write(`Reading ${region} schema…\n`);
    regionSchemas[region] = await readRemoteSchema(region);
  }

  const { ok, lines, fingerprints } = verifyAgainstRegions({ expected, regionSchemas });
  for (const line of lines) console.log(line);

  if (!ok) {
    console.error("\nThe migration chain does not describe the hosted schema. Do not regenerate a "
      + "baseline to make this pass — a baseline is derived from the chain, so that would encode "
      + "the drift rather than fix it. Find out why a hosted database differs from the "
      + "migrations first.");
    process.exitCode = 1;
    return;
  }

  if (record) {
    const capturedAt = new Date().toISOString().slice(0, 10);
    writeFileSync(FINGERPRINT_PATH, `${JSON.stringify({
      // Recorded from live databases; regenerate with `pnpm db:baseline:verify -- --record`.
      through: listMigrationFiles(MIGRATIONS_DIRECTORY).at(-1),
      capturedAt,
      regions: discovered,
      objects: fingerprints[discovered[0]],
    }, null, 2)}\n`, "utf8");
    console.log(`\nRecorded ${Object.keys(fingerprints[discovered[0]]).length} objects to production-fingerprint.json.`);
  }
}

if (isEntryPoint(import.meta.url)) await main();

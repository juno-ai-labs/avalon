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
// It also compares Global against EU. The two regions run the same migrations
// but are separate databases with separate ledgers, so "both are migrated" and
// "both are the same" are genuinely different claims, and only the second one
// makes a single baseline correct for both.
//
// Requires Cloudflare credentials and network access, so it is a manual and
// operator step rather than a CI gate — `scripts/d1-baseline.test.mjs` compares
// the baseline against the fingerprint this records, which is what keeps the
// result enforced afterwards without credentials.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";
import {
  compareFingerprints,
  fingerprintsMatch,
  parseWranglerJson,
  schemaFingerprint,
  snapshotDatabase,
} from "./d1-baseline.mjs";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(repositoryRoot, "apps", "api");
export const BASELINES_DIRECTORY = join(repositoryRoot, "packages", "db", "baselines");
export const FINGERPRINT_PATH = join(BASELINES_DIRECTORY, "production-fingerprint.json");

export const REGIONS = ["global", "eu"];

const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";

/**
 * Reads a hosted database's schema. Only `sqlite_schema` is selected — the
 * script never reads a row of production data, which is what makes running it
 * against a live customer database an unremarkable thing to do.
 */
export async function readRemoteSchema(region, { run = execFileAsync } = {}) {
  const { stdout } = await run(
    "pnpm",
    [
      "exec", "wrangler", "d1", "execute", "DB",
      "--remote", "--json",
      "--config", `wrangler.${region}.jsonc`,
      "--command", SCHEMA_QUERY,
    ],
    { cwd: apiDirectory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = parseWranglerJson(stdout, region);
  const results = parsed[0]?.results;
  if (!Array.isArray(results)) throw new Error(`wrangler returned no schema rows for ${region}`);
  return results;
}

/** The fingerprint of the checked-in baseline file, by applying it. */
export function baselineFingerprint(baselineSql) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(baselineSql);
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
export function verifyAgainstRegions({ baseline, regionSchemas }) {
  const lines = [];
  let ok = true;

  const fingerprints = Object.fromEntries(
    Object.entries(regionSchemas).map(([region, objects]) => [region, schemaFingerprint(objects)]),
  );

  for (const [region, fingerprint] of Object.entries(fingerprints)) {
    const comparison = compareFingerprints(baseline, fingerprint);
    ok &&= fingerprintsMatch(comparison);
    lines.push(...describeComparison(`baseline vs ${region}`, comparison));
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
  const baselineFile = JSON.parse(readFileSync(join(BASELINES_DIRECTORY, "manifest.json"), "utf8")).baseline;
  const baselineSql = readFileSync(join(BASELINES_DIRECTORY, baselineFile.file), "utf8");
  const baseline = baselineFingerprint(baselineSql);

  const regionSchemas = {};
  for (const region of REGIONS) {
    process.stderr.write(`Reading ${region} schema…\n`);
    regionSchemas[region] = await readRemoteSchema(region);
  }

  const { ok, lines, fingerprints } = verifyAgainstRegions({ baseline, regionSchemas });
  for (const line of lines) console.log(line);

  if (!ok) {
    console.error("\nThe baseline does not describe the hosted schema. Do not regenerate the "
      + "baseline to make this pass — that would encode the drift. Find out why a hosted "
      + "database differs from the migrations first.");
    process.exitCode = 1;
    return;
  }

  if (record) {
    const capturedAt = new Date().toISOString().slice(0, 10);
    writeFileSync(FINGERPRINT_PATH, `${JSON.stringify({
      // Recorded from live databases; regenerate with `pnpm db:baseline:verify -- --record`.
      through: baselineFile.through,
      capturedAt,
      regions: REGIONS,
      objects: fingerprints[REGIONS[0]],
    }, null, 2)}\n`, "utf8");
    console.log(`\nRecorded ${Object.keys(fingerprints[REGIONS[0]]).length} objects to production-fingerprint.json.`);
  }
}

if (isEntryPoint(import.meta.url)) await main();

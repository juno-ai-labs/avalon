// Generates a D1 baseline: `node scripts/create-d1-baseline.mjs 0090_drop_legacy_product_tables.sql`
//
// Applies the migration chain up to and including the named file into an
// in-memory SQLite database, then writes that database's schema and seeded rows
// back out as one file under `packages/db/baselines/`, together with a manifest
// recording exactly which migrations it stands in for.
//
// Run it when you want a *new* baseline — after a batch of migrations has been
// deployed everywhere and replaying them locally has become the slow part of
// setting up. Do not run it to "fix" a failing baseline test: that test compares
// the checked-in file against a real replay, so if it fails, either a migration
// at or below the boundary was edited (which `data-model.md` invariant 10
// forbids) or a new file was inserted below it. Regenerating would bless the
// problem rather than surface it. Find out which happened first.
//
// The chain is applied **twice, a second apart**. Two control rows are seeded
// with `datetime('now')`, and the only way to tell a column the chain computes
// fresh from one it hardcodes — without parsing SQL for every spelling of "now"
// — is to run it twice and see what moves. `datetime('now')` has one-second
// resolution, so the gap is the mechanism, not politeness; without it the two
// runs agree and the generator would freeze a timestamp into every future local
// database.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";

import { isEntryPoint } from "./entry-point.mjs";
import {
  applyMigrations,
  readBaselineManifest,
  detectVolatileColumns,
  digestMigrations,
  listMigrationFiles,
  renderBaselineSql,
  snapshotDatabase,
  subsumedMigrations,
} from "./d1-baseline.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIRECTORY = join(repositoryRoot, "packages", "db", "migrations");
export const BASELINES_DIRECTORY = join(repositoryRoot, "packages", "db", "baselines");
export const MANIFEST_PATH = join(BASELINES_DIRECTORY, "manifest.json");

/**
 * `0090_drop_legacy_product_tables.sql` -> `b_0090_drop_legacy_product_tables.sql`.
 *
 * A baseline is named `b_<nnnn>_<text>.sql` after the migration it stands
 * through, so the boundary is legible from the filename and the two sort
 * together in a listing. The `b_` prefix — rather than a `.sql` file that looks
 * like any other — is what keeps a reader from mistaking a baseline for a
 * migration; they live in different directories precisely because Wrangler would
 * otherwise apply this one as migration number 0091.
 */
export function baselineFileNameFor(throughFile) {
  if (!/^\d{4}_[a-z0-9][a-z0-9_.-]*\.sql$/u.test(throughFile)) {
    throw new Error(`${throughFile} is not a migration file name`);
  }
  return `b_${throughFile}`;
}

/**
 * Applies `files` into a fresh in-memory database and returns its snapshot.
 *
 * In-memory rather than a temporary file because nothing here outlives the
 * process, and a stray file on disk is one more thing a failed run can leave
 * behind for the next one to read as real.
 */
export function snapshotChain(directory, files) {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database, directory, files);
    return snapshotDatabase(database);
  } finally {
    database.close();
  }
}

/**
 * Builds a baseline and its manifest entry without writing anything, so the
 * generator's output can be asserted on directly.
 */
export async function buildBaseline({ through, directory = MIGRATIONS_DIRECTORY, settleMilliseconds = 1100 }) {
  const files = subsumedMigrations(listMigrationFiles(directory), through);
  const first = snapshotChain(directory, files);
  await sleep(settleMilliseconds);
  const second = snapshotChain(directory, files);
  const volatileColumns = detectVolatileColumns(first.rows, second.rows);
  const digest = digestMigrations(directory, files);

  const sql = renderBaselineSql({ through, files, digest, snapshot: second, volatileColumns });
  const manifestEntry = {
    through,
    file: baselineFileNameFor(through),
    migrations: files,
    digest,
    volatileColumns,
    objectCounts: {
      tables: second.objects.filter((object) => object.type === "table").length,
      indexes: second.objects.filter((object) => object.type === "index").length,
      triggers: second.objects.filter((object) => object.type === "trigger").length,
    },
    seededRowCounts: Object.fromEntries(
      Object.entries(second.rows).map(([table, rows]) => [table, rows.length]),
    ),
  };
  return { sql, manifestEntry };
}

/**
 * Places a new baseline in the manifest, replacing one at the same boundary.
 *
 * Baselines accumulate rather than replace each other. An older one still
 * describes its own boundary correctly and still gets an empty database most of
 * the way there, so keeping it costs a file and loses nothing;
 * `selectBaseline` picks whichever reaches furthest. Regenerating at a boundary
 * that already has one overwrites it, because two snapshots of the same point
 * cannot both be right.
 */
export function mergeIntoManifest(existing, entry) {
  const others = existing.filter((baseline) => baseline.through !== entry.through);
  return [...others, entry].sort((left, right) => (left.through < right.through ? -1 : 1));
}

async function main() {
  const through = process.argv[2];
  if (!through) {
    throw new Error("Usage: node scripts/create-d1-baseline.mjs <through-migration.sql>");
  }
  const { sql, manifestEntry } = await buildBaseline({ through });

  mkdirSync(BASELINES_DIRECTORY, { recursive: true });
  writeFileSync(join(BASELINES_DIRECTORY, manifestEntry.file), sql, "utf8");

  const existing = existsSync(MANIFEST_PATH) ? readBaselineManifest(readFileSync(MANIFEST_PATH, "utf8")) : [];
  const baselines = mergeIntoManifest(existing, manifestEntry);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ baselines }, null, 2)}\n`, "utf8");

  console.log(`Wrote ${manifestEntry.file}: ${manifestEntry.migrations.length} migrations subsumed, `
    + `${manifestEntry.objectCounts.tables} tables, ${manifestEntry.objectCounts.indexes} indexes, `
    + `${manifestEntry.objectCounts.triggers} triggers.`);
  console.log(`Manifest now holds ${baselines.length} baseline(s): ${baselines.map((b) => b.through).join(", ")}`);
  const volatile = Object.entries(manifestEntry.volatileColumns);
  if (volatile.length === 0) console.log("No volatile columns detected.");
  else for (const [table, columns] of volatile) console.log(`Volatile: ${table}.${columns.join(", ")}`);
}

if (isEntryPoint(import.meta.url)) await main();

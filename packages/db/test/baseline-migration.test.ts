// What the checked-in D1 baseline *does* when it is executed: whether applying
// it leaves the same database as replaying the migrations it stands for, and
// whether it refuses the databases it must refuse.
//
// This suite deliberately re-derives everything itself — it reads the migrations
// and the baseline as files and compares two live SQLite databases through
// `PRAGMA` introspection — rather than importing the helpers in
// `scripts/d1-baseline.mjs` that produced the file. Those helpers compare schema
// as normalized SQL text; this compares what the engine actually resolved the
// text to: columns with their types, defaults and nullability, index membership
// and uniqueness, foreign-key edges, trigger bodies. A generator bug that
// rendered a subtly different table would have to fool two independent
// comparators built on different evidence to survive both.
//
// `scripts/d1-baseline.test.mjs` owns the other half — file naming, the
// staleness digest, rendering order, and parity with the fingerprint recorded
// from the hosted databases.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const baselinesDirectory = fileURLToPath(new URL("../baselines/", import.meta.url));

interface BaselineEntry {
  through: string;
  file: string;
  migrations: string[];
  volatileColumns: Record<string, string[]>;
  objectCounts: { tables: number; indexes: number; triggers: number };
  seededRowCounts: Record<string, number>;
}

const manifestFile = JSON.parse(
  readFileSync(new URL("../baselines/manifest.json", import.meta.url), "utf8"),
) as { baselines?: BaselineEntry[]; baseline?: BaselineEntry };

/**
 * Wrangler's own ordering, re-derived here rather than imported.
 *
 * The rest of this file re-derives everything it checks, and ordering is not an
 * exception: importing `compareMigrationPaths` from `scripts/d1-baseline.mjs`
 * would let the generator and its check agree on a wrong order. A plain string
 * sort is *not* it — `89_backfill.sql` is below a `0090` boundary for Wrangler
 * and above it for `Array.prototype.sort` — and every assertion below about
 * what a baseline subsumes, what is left pending, and what gets replayed on top
 * of it depends on getting that boundary the same way the migrate script does.
 *
 * "records exactly its own subsumed migrations" pins this against the shared
 * implementation through the artifact: the set this comparator puts below a
 * boundary has to be the set the generator recorded in the manifest.
 */
function compareMigrations(left: string, right: string): number {
  const leftNumber = Number.parseInt(left.split("_")[0] ?? "", 10);
  const rightNumber = Number.parseInt(right.split("_")[0] ?? "", 10);
  if (leftNumber !== rightNumber) {
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    if (Number.isFinite(leftNumber)) return -1;
    if (Number.isFinite(rightNumber)) return 1;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Every checked-in baseline, oldest boundary first. */
const allBaselines: BaselineEntry[] = [...(manifestFile.baselines ?? (manifestFile.baseline ? [manifestFile.baseline] : []))]
  .sort((left, right) => compareMigrations(left.through, right.through));

/** The one an empty database is given: the boundary that reaches furthest. */
const manifest = allBaselines.at(-1) as BaselineEntry;

const baselineSql = readFileSync(new URL(`../baselines/${manifest.file}`, import.meta.url), "utf8");

const migrationFileNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort(compareMigrations);

/** The migrations a baseline stands for: everything at or below its boundary. */
function atOrBelow(boundary: string): string[] {
  return migrationFileNames.filter((name) => compareMigrations(name, boundary) <= 0);
}

/** The migrations that still have to run on top of a baseline. */
function above(boundary: string): string[] {
  return migrationFileNames.filter((name) => compareMigrations(name, boundary) > 0);
}

/** Replays every migration in the repository, in Wrangler's order. */
function chainDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const name of migrationFileNames) {
    database.exec(readFileSync(`${migrationsDirectory}${name}`, "utf8"));
  }
  return database;
}

/**
 * A baseline, plus every migration above its boundary — which is what the
 * migrate script actually builds, and the only thing that can be compared to a
 * full replay once work continues above a baseline. Comparing the snapshot
 * alone would hold today, when the boundary happens to be the newest migration,
 * and start failing the day one lands above it.
 */
function baselineOnly(baseline: BaselineEntry = manifest): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL(`../baselines/${baseline.file}`, import.meta.url), "utf8"));
  return database;
}

/**
 * A baseline, plus every migration above its boundary — which is what the
 * migrate script actually builds.
 */
function baselineDatabase(baseline: BaselineEntry = manifest): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL(`../baselines/${baseline.file}`, import.meta.url), "utf8"));
  for (const name of above(baseline.through)) {
    database.exec(readFileSync(`${migrationsDirectory}${name}`, "utf8"));
  }
  return database;
}

// The engine's own view of the schema, which is what a query actually meets.
// Reading it back through PRAGMA rather than comparing CREATE statements is the
// point: `ALTER TABLE ADD COLUMN` and a `CREATE TABLE` that declares the column
// outright produce different text and the same table, and only one of those
// differences would matter.
interface TableShape {
  columns: { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
  foreignKeys: { table: string; from: string; to: string | null; on_delete: string; on_update: string }[];
  indexes: { name: string; unique: number; origin: string; columns: string[] }[];
}

function userTableNames(database: DatabaseSync): string[] {
  return database
    // Mirrors the rule the baseline and the local migrate wrapper share: the
    // platform's own tables, plus the guard table a fired guard leaves behind,
    // are not user schema.
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
                AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
                AND name <> 'd1_migrations'
                AND name <> '_baseline_empty_database_guard'
              ORDER BY name`)
    .all()
    .map((row) => String(row.name));
}

/** The tables holding at least one row. */
function populatedTables(database: DatabaseSync): string[] {
  return userTableNames(database)
    .filter((table) => Number(database.prepare(`SELECT COUNT(*) c FROM "${table}"`).get()?.c) > 0)
    .sort();
}

function tableShape(database: DatabaseSync, table: string): TableShape {
  const columns = database.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => ({
      name: String(row.name),
      type: String(row.type),
      notnull: Number(row.notnull),
      dflt_value: row.dflt_value ?? null,
      pk: Number(row.pk),
    }));
  const foreignKeys = database.prepare(`SELECT "table", "from", "to", on_delete, on_update FROM pragma_foreign_key_list(?)`)
    .all(table)
    .map((row) => ({
      table: String(row.table),
      from: String(row.from),
      to: row.to === null ? null : String(row.to),
      on_delete: String(row.on_delete),
      on_update: String(row.on_update),
    }))
    .sort((a, b) => `${a.table}.${a.from}`.localeCompare(`${b.table}.${b.from}`));
  const indexes = database.prepare(`SELECT name, "unique", origin FROM pragma_index_list(?)`)
    .all(table)
    .map((row) => ({
      name: String(row.name),
      unique: Number(row.unique),
      origin: String(row.origin),
      columns: database.prepare(`SELECT name FROM pragma_index_info(?)`)
        .all(String(row.name))
        .map((column) => String(column.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { columns, foreignKeys, indexes };
}

function triggerBodies(database: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((row) => [String(row.name), String(row.sql).replace(/\s+/gu, " ").trim()]),
  );
}

/** Seeded rows with the columns the chain recomputes on every run removed. */
function stableRows(database: DatabaseSync, table: string): unknown[] {
  const volatileColumns = manifest.volatileColumns[table] ?? [];
  return database.prepare(`SELECT * FROM "${table}"`).all().map((row) => {
    const stable: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (!volatileColumns.includes(column)) stable[column] = value;
    }
    return stable;
  });
}

describe("the D1 baseline reproduces the migration chain", () => {
  let chain: DatabaseSync;
  let baseline: DatabaseSync;

  // Applying 95 migrations costs a second or so; both databases are read-only
  // for every assertion below, so they are built once. Anything that writes
  // opens its own database rather than borrowing these.
  beforeAll(() => {
    chain = chainDatabase();
    baseline = baselineDatabase();
    return () => {
      chain.close();
      baseline.close();
    };
  });

  it("creates exactly the same tables", () => {
    expect(userTableNames(baseline)).toEqual(userTableNames(chain));
  });

  it("gives every table the same columns, types, nullability, defaults, and primary key", () => {
    for (const table of userTableNames(chain)) {
      expect(tableShape(baseline, table).columns, table).toEqual(tableShape(chain, table).columns);
    }
  });

  it("gives every table the same foreign keys, including their delete and update actions", () => {
    // The 0087 and 0088 migrations exist specifically to change ON DELETE and
    // ON UPDATE actions. A baseline that dropped them would leave local
    // databases cascading differently from production, which no column
    // comparison would notice.
    for (const table of userTableNames(chain)) {
      expect(tableShape(baseline, table).foreignKeys, table).toEqual(tableShape(chain, table).foreignKeys);
    }
  });

  it("gives every table the same indexes, over the same columns, with the same uniqueness", () => {
    for (const table of userTableNames(chain)) {
      expect(tableShape(baseline, table).indexes, table).toEqual(tableShape(chain, table).indexes);
    }
  });

  it("creates the same triggers with the same bodies", () => {
    expect(triggerBodies(baseline)).toEqual(triggerBodies(chain));
  });

  it("seeds the same control rows", () => {
    const seeded = Object.keys(manifest.seededRowCounts);
    expect(seeded.length).toBeGreaterThan(0);
    for (const table of seeded) {
      expect(stableRows(baseline, table), table).toEqual(stableRows(chain, table));
    }
  });

  it("leaves no table holding rows the chain does not seed", () => {
    // Against the chain rather than against `manifest.seededRowCounts`: the
    // manifest describes the snapshot file, and this database is the snapshot
    // plus everything above its boundary. A migration that seeds a row into a
    // table it creates is a correct thing to do, and it belongs on both sides
    // of this comparison rather than failing it.
    expect(populatedTables(baseline)).toEqual(populatedTables(chain));
  });

  it("leaves a database whose foreign keys all resolve", () => {
    expect(baseline.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retires the legacy product tables migration 0090 drops", () => {
    // If the baseline were generated from a chain stopped before 0090, every
    // one of these would come back — the schema would look plausible and be a
    // release behind.
    const tables = new Set(userTableNames(baseline));
    for (const retired of ["messages", "harness_runs", "workstream_read_states", "artifacts", "activity_events"]) {
      expect(tables.has(retired), retired).toBe(false);
    }
  });
});

describe("the baseline's triggers are live, not just present", () => {
  it("keeps the Global email ledger a full-address claim register, in both databases", () => {
    // Ported from the per-migration suite when it was retired: it asserted the
    // shape 0092 leaves, and a chain-versus-baseline diff cannot stand in for
    // that — a lifecycle column wrongly present would appear on both sides and
    // compare equal. Driving it through each database keeps the original
    // assertion and adds the one this file exists for.
    //
    // Global records the claim and nothing else. A lifecycle column here would
    // be a second copy of a decision each region already makes from its own row
    // when a message arrives. One assertion per column: `arrayContaining` with
    // two entries would pass while either survived.
    const seed = (database: DatabaseSync) => database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-email', 'google-email', 'email@example.com', 'Email Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-email', 'Email Workspace', 'email-workspace', 'global', 'user-email', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, do_identity_anchor)
      VALUES ('workstream-email', 'workspace-email', 1);
      INSERT INTO workstream_email_routes
        (email_address, address_source, region, workspace_id, workstream_id, created_at, updated_at)
      VALUES ('bright-steady-clear-otter@automation.rallywith.ai', 'owner',
              'global', 'workspace-email', 'workstream-email',
              '2026-01-01', '2026-01-01');
    `);

    for (const [label, open] of [["chain", chainDatabase], ["baseline", baselineDatabase]] as const) {
      const database = open();
      try {
        seed(database);
        const routeColumns = (database.prepare("PRAGMA table_info(workstream_email_routes)")
          .all() as Array<{ name: string }>).map((column) => column.name);
        expect(routeColumns, label).not.toContain("status");
        expect(routeColumns, label).not.toContain("disabled_at");
        expect(routeColumns, label).not.toContain("local_part");
        expect(routeColumns, label).toContain("email_address");
        expect(
          (database.prepare("PRAGMA table_info(workstreams)").all() as Array<{ name: string }>)
            .map((column) => column.name),
          label,
        ).not.toContain("email_address");

        // The route is a permanent claim: nobody else may take the full
        // address, it cannot be renamed, and it cannot be deleted.
        expect(() => database.exec(`
          INSERT INTO workstream_email_routes
            (email_address, address_source, region, workspace_id, workstream_id, created_at, updated_at)
          VALUES ('bright-steady-clear-otter@automation.rallywith.ai', 'owner',
                  'global', 'workspace-other', 'workstream-other',
                  '2026-01-01', '2026-01-01');
        `), label).toThrow();
        expect(() => database.exec(
          "UPDATE workstream_email_routes SET email_address = 'different-route@automation.rallywith.ai' WHERE workstream_id = 'workstream-email'",
        ), label).toThrow(/immutable/u);
        expect(() => database.exec(
          "DELETE FROM workstream_email_routes WHERE workstream_id = 'workstream-email'",
        ), label).toThrow(/permanent tombstones/u);

        // The same local part on another domain is a different address and may
        // belong to a different destination.
        database.exec(`
          INSERT INTO workstream_email_routes
            (email_address, address_source, region, workspace_id, workstream_id, created_at, updated_at)
          VALUES ('bright-steady-clear-otter@customer.example', 'owner',
                  'global', 'workspace-other', 'workstream-other',
                  '2026-01-01', '2026-01-01');
        `);

        // And the original outlives the work stream that claimed it.
        database.exec("DELETE FROM workstreams WHERE id = 'workstream-email'");
        expect(database.prepare(
          "SELECT email_address, workstream_id FROM workstream_email_routes WHERE email_address = 'bright-steady-clear-otter@automation.rallywith.ai'",
        ).get(), label).toEqual({
          email_address: "bright-steady-clear-otter@automation.rallywith.ai",
          workstream_id: "workstream-email",
        });
      } finally {
        database.close();
      }
    }
  });

  it("enforces a post-cutover write rejection the same way the chain does", () => {
    // A trigger created but never exercised is indistinguishable from a comment.
    // This drives one of 0090's surviving guards through both databases and
    // requires the same refusal from each.
    const attempt = (database: DatabaseSync) => {
      try {
        database.exec(`INSERT INTO workstreams (id, workspace_id, title, created_at, updated_at)
                       VALUES ('w1', 'ws1', 'title', '2026-08-21', '2026-08-21')`);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const chain = chainDatabase();
    const baseline = baselineDatabase();
    try {
      const fromBaseline = attempt(baseline);
      expect(fromBaseline).toEqual(attempt(chain));
      expect(fromBaseline).not.toBe("accepted");
    } finally {
      chain.close();
      baseline.close();
    }
  });
});

describe("the baseline only ever applies to an empty database", () => {
  const guard = /baseline_requires_empty_database/u;

  it("refuses a database that already has a user table", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    expect(() => database.exec(baselineSql)).toThrow(guard);
    database.close();
  });

  it("refuses a database whose ledger claims migrations even though it has no tables", () => {
    // The state a failed migration leaves, and the one that wedged the sandbox:
    // ledger rows without the schema they describe. Applying a baseline here
    // would record every subsumed migration as applied a second time over a
    // schema that never ran them.
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE d1_migrations(
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     name TEXT UNIQUE,
                     applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
                   INSERT INTO d1_migrations (name) VALUES ('0001_initial.sql')`);
    expect(() => database.exec(baselineSql)).toThrow(guard);
    database.close();
  });

  it("refuses a partially migrated database, the exact state a broken chain leaves", () => {
    const database = new DatabaseSync(":memory:");
    const partial = atOrBelow("0077_connector_oauth_telemetry_shape.sql");
    for (const name of partial) database.exec(readFileSync(`${migrationsDirectory}${name}`, "utf8"));
    expect(() => database.exec(baselineSql)).toThrow(guard);
    database.close();
  });

  it("refuses a second application rather than merging into itself", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    expect(() => database.exec(baselineSql)).toThrow(guard);
    database.close();
  });

  it("creates none of its own schema in the database it refused", () => {
    // A guard that fired halfway through would be worse than none: the operator
    // would be left with a database that is neither the old schema nor the new.
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    expect(() => database.exec(baselineSql)).toThrow(guard);
    expect(userTableNames(database)).toEqual(["users"]);
    expect(database.prepare("SELECT COUNT(*) c FROM d1_migrations").get()?.c).toBe(0);
    database.close();
  });

  it("leaves only its own inert guard table behind, and clears it on the next attempt", () => {
    // D1 rejects `CREATE TEMP TABLE` (SQLITE_AUTH), so the guard is a real table
    // and the `DROP` that would remove it is the statement after the `INSERT`
    // that aborts. The leftover holds no rows and is excluded from every
    // emptiness check, so a database that refused once can still be baselined
    // after the reason for the refusal is gone — which is the property that
    // matters, and the one a stricter assertion here would hide.
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    expect(() => database.exec(baselineSql)).toThrow(guard);
    expect(database.prepare("SELECT COUNT(*) c FROM _baseline_empty_database_guard").get()?.c).toBe(0);

    database.exec("DROP TABLE users");
    expect(() => database.exec(baselineSql)).not.toThrow();
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '\\_baseline%' ESCAPE '\\'").all())
      .toEqual([]);
    database.close();
  });

  it("accepts a database that holds only the platform's own internal tables", () => {
    // What Wrangler hands over for a database it has opened but never migrated.
    // `_cf_METADATA` is the local runtime's; a hosted one carries `_cf_KV`.
    // Counting either as user schema would refuse every real first run.
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value BLOB);
                   CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)`);
    expect(() => database.exec(baselineSql)).not.toThrow();
    expect(userTableNames(database)).toHaveLength(manifest.objectCounts.tables);
    database.close();
  });

  it("drops its guard table, leaving nothing of itself behind", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    const leftovers = database
      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE '\\_baseline%' ESCAPE '\\'")
      .all();
    expect(leftovers).toEqual([]);
    database.close();
  });
});

describe("the baseline hands a correct ledger to Wrangler", () => {
  it("records every subsumed migration, in order, and nothing else", () => {
    const database = baselineDatabase();
    const recorded = database.prepare("SELECT id, name FROM d1_migrations ORDER BY id").all();
    expect(recorded.map((row) => String(row.name))).toEqual(manifest.migrations);
    // Ascending ids in file order: Wrangler compares names, but a ledger that
    // disagreed with the apply order would mislead anyone reading it.
    expect(recorded.map((row) => Number(row.id))).toEqual(manifest.migrations.map((_, index) => index + 1));
    database.close();
  });

  it("records the boundary migration and no migration after it", () => {
    const database = baselineDatabase();
    const recorded = database.prepare("SELECT name FROM d1_migrations ORDER BY id").all()
      .map((row) => String(row.name));
    expect(recorded).toContain(manifest.through);
    expect(recorded.filter((name) => compareMigrations(name, manifest.through) > 0)).toEqual([]);
    database.close();
  });

  it("stamps applied_at rather than leaving it null", () => {
    const database = baselineDatabase();
    const unstamped = database.prepare("SELECT COUNT(*) c FROM d1_migrations WHERE applied_at IS NULL").get();
    expect(Number(unstamped?.c)).toBe(0);
    database.close();
  });
});

describe("a migration added after the boundary still applies on top", () => {
  it("produces the same schema whether it follows the baseline or the whole chain", () => {
    // The property that makes a baseline safe to keep: it is a starting point,
    // not an ending. There is no migration after 0090 in the repository yet, so
    // this uses a synthetic one — which is the only way to cover the case
    // before the next migration lands and it is too late to find out.
    const next = `CREATE TABLE baseline_followup (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL
                  );
                  CREATE INDEX baseline_followup_workspace_idx ON baseline_followup(workspace_id);`;

    const fromBaseline = baselineDatabase();
    const fromChain = chainDatabase();
    try {
      fromBaseline.exec(next);
      fromChain.exec(next);
      expect(userTableNames(fromBaseline)).toEqual(userTableNames(fromChain));
      expect(tableShape(fromBaseline, "baseline_followup")).toEqual(tableShape(fromChain, "baseline_followup"));
      expect(fromBaseline.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      fromBaseline.close();
      fromChain.close();
    }
  });
});

describe("columns the chain recomputes are recomputed, not frozen", () => {
  it("names at least one volatile column, or the case below proves nothing", () => {
    expect(Object.keys(manifest.volatileColumns).length).toBeGreaterThan(0);
  });

  it("stamps each volatile column when the baseline is applied", () => {
    // A frozen literal would carry the generation date forever. `datetime('now')`
    // is UTC to the second; the window is wide enough to survive a slow suite
    // and narrow enough that a date baked in at generation time fails it.
    const before = Date.now();
    const database = baselineDatabase();
    try {
      for (const [table, columns] of Object.entries(manifest.volatileColumns)) {
        for (const column of columns) {
          const value = database.prepare(`SELECT "${column}" AS v FROM "${table}"`).get()?.v;
          expect(typeof value, `${table}.${column}`).toBe("string");
          const stamped = Date.parse(`${String(value).replace(" ", "T")}Z`);
          expect(Number.isNaN(stamped), `${table}.${column} is not a timestamp`).toBe(false);
          expect(stamped, `${table}.${column}`).toBeGreaterThanOrEqual(before - 120_000);
          expect(stamped, `${table}.${column}`).toBeLessThanOrEqual(Date.now() + 120_000);
        }
      }
    } finally {
      database.close();
    }
  });

  it("does not contain a frozen copy of a volatile value", () => {
    // Applying the file twice into separate databases must not agree by
    // construction. Comparing the file's text to the value it produced is the
    // check that survives a fast machine, where two applies land in the same
    // second and would agree for an honest reason.
    const database = baselineDatabase();
    try {
      for (const [table, columns] of Object.entries(manifest.volatileColumns)) {
        for (const column of columns) {
          const value = String(database.prepare(`SELECT "${column}" AS v FROM "${table}"`).get()?.v);
          expect(baselineSql).not.toContain(value);
        }
      }
      expect(baselineSql).toContain("datetime('now')");
    } finally {
      database.close();
    }
  });
});

describe("the baseline is not mistaken for a migration", () => {
  it("does not live in the directory Wrangler applies migrations from", () => {
    const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql"));
    expect(migrationFiles).not.toContain(manifest.file);
    expect(baselinesDirectory).not.toContain(`${migrationsDirectory}`);
  });

  it("keeps the migration chain intact so hosted databases can still replay it", () => {
    // A baseline is an addition. If someone ever "cleans up" by deleting the
    // migrations it subsumes, every hosted database that has not run them loses
    // the only description of how to get there.
    const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql"));
    for (const subsumed of manifest.migrations) {
      expect(migrationFiles, `${subsumed} was deleted after being subsumed`).toContain(subsumed);
    }
  });
});

describe("every checked-in baseline, not just the newest", () => {
  // The newest baseline is the one an empty database is given, so the suite
  // above is about that one. This asserts the property that makes keeping older
  // baselines safe: each of them, plus the migrations above its own boundary,
  // still reproduces the chain. A baseline that stopped being true would
  // otherwise sit in the manifest looking usable.
  it.each(allBaselines.map((baseline) => [baseline.through, baseline] as const))(
    "%s plus everything after it equals a full replay",
    (_through, baseline) => {
      const chain = chainDatabase();
      const built = baselineDatabase(baseline);
      try {
        expect(userTableNames(built)).toEqual(userTableNames(chain));
        for (const table of userTableNames(chain)) {
          expect(tableShape(built, table), table).toEqual(tableShape(chain, table));
        }
        expect(triggerBodies(built)).toEqual(triggerBodies(chain));
        expect(built.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        chain.close();
        built.close();
      }
    },
  );

  it("records exactly its own subsumed migrations in the ledger, and no more", () => {
    for (const baseline of allBaselines) {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(readFileSync(new URL(`../baselines/${baseline.file}`, import.meta.url), "utf8"));
        const recorded = database.prepare("SELECT name FROM d1_migrations ORDER BY id").all()
          .map((row) => String(row.name));
        expect(recorded, baseline.through).toEqual(baseline.migrations);
        // And the ledger is exactly what this file's own reading of Wrangler's
        // order says it should be. If the two ever disagreed — an unpadded name
        // landing on the other side of the boundary for one of them — the
        // suite would be replaying a different chain than the one the generator
        // subsumed, and every comparison below it would be against the wrong
        // database while still passing.
        expect(recorded, baseline.through).toEqual(atOrBelow(baseline.through));
        // Everything above the boundary must still be pending, or the migrate
        // script would skip work a fresh database has not done.
        expect(recorded.filter((name) => above(baseline.through).includes(name))).toEqual([]);
      } finally {
        database.close();
      }
    }
  });

  it("names a file that exists, at the boundary its name claims", () => {
    for (const baseline of allBaselines) {
      expect(baseline.file).toBe(`b_${baseline.through}`);
      expect(() => readFileSync(new URL(`../baselines/${baseline.file}`, import.meta.url))).not.toThrow();
      expect(migrationFileNames).toContain(baseline.through);
    }
  });
});

describe("the manifest describes the snapshot file, not the chain above it", () => {
  // `objectCounts` and `seededRowCounts` are recorded by the generator from the
  // database it snapshotted, so they are claims about the `.sql` file alone.
  // Asserting them against baseline-plus-later-migrations conflates the two and
  // goes red the day an ordinary migration adds a table — a failure that says
  // nothing about whether the baseline is correct. Here they meet the database
  // they actually describe.
  function schemaCounts(database: DatabaseSync): Record<string, number> {
    const counts = database
      .prepare(`SELECT type, COUNT(*) AS c FROM sqlite_schema
                  WHERE sql IS NOT NULL AND TRIM(sql) <> ''
                    AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                    AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
                    AND name <> 'd1_migrations'
                    AND name <> '_baseline_empty_database_guard'
                    AND COALESCE(tbl_name, '') <> 'd1_migrations'
                  GROUP BY type`)
      .all();
    return Object.fromEntries(counts.map((row) => [String(row.type), Number(row.c)]));
  }

  it.each(allBaselines.map((baseline) => [baseline.through, baseline] as const))(
    "%s holds the tables, indexes and triggers its manifest entry claims",
    (_through, baseline) => {
      const database = baselineOnly(baseline);
      try {
        const counts = schemaCounts(database);
        expect(counts.table ?? 0).toBe(baseline.objectCounts.tables);
        expect(counts.index ?? 0).toBe(baseline.objectCounts.indexes);
        expect(counts.trigger ?? 0).toBe(baseline.objectCounts.triggers);
      } finally {
        database.close();
      }
    },
  );

  it.each(allBaselines.map((baseline) => [baseline.through, baseline] as const))(
    "%s seeds rows into exactly the tables and counts its manifest entry claims",
    (_through, baseline) => {
      const database = baselineOnly(baseline);
      try {
        expect(populatedTables(database)).toEqual(Object.keys(baseline.seededRowCounts).sort());
        for (const [table, count] of Object.entries(baseline.seededRowCounts)) {
          expect(Number(database.prepare(`SELECT COUNT(*) c FROM "${table}"`).get()?.c), table).toBe(count);
        }
      } finally {
        database.close();
      }
    },
  );
});

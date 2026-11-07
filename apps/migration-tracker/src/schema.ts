/**
 * The registry's own SQLite schema, and the append-only runner that applies it.
 *
 * Version 1 is deployed, so it is now frozen: every later change is appended as
 * a new entry, exactly as in `apps/api`. Editing a shipped statement would be
 * applied to a fresh registry and skipped on the live one, which is the one
 * failure mode a migration ledger exists to prevent.
 *
 * This is a deliberate second copy of the runner in
 * `apps/api/src/durable-objects/sqlite-migrations.ts`, not an import: the
 * tracker deploys on its own and must not take a dependency on the Worker it
 * observes — a build break in `apps/api` cannot be allowed to take down the
 * thing that says whether `apps/api` is healthy. The copy is small, and it
 * keeps the same ledger table name so the tracker's own object is legible to
 * exactly the tooling it provides for everything else.
 */

export interface RegistryMigration {
  version: number;
  description: string;
  statements: readonly string[];
}

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT
`;

/**
 * One row per Durable Object the tracker has ever heard of, from either source.
 *
 * `object_id` is the primary key because it is the only identifier both sources
 * produce: the Cloudflare inventory API returns an ID plus its storage-presence
 * flag, and a report carries the same ID from `state.id.toString()`. Everything
 * else on the row is nullable because either source may be the first to arrive —
 * an object discovered by a sweep has no version until it next wakes, and an
 * object that reported before the first sweep has no namespace until one runs.
 */
const V1_DURABLE_OBJECTS = `
  CREATE TABLE IF NOT EXISTS durable_objects (
    object_id TEXT PRIMARY KEY,
    object_name TEXT,
    namespace_id TEXT,
    script_name TEXT,
    class_name TEXT,
    component TEXT,
    region TEXT,
    app_env TEXT,
    worker_version_id TEXT,
    -- The latest inventory fact. Report-only rows keep the default; it is not
    -- interpreted until last_swept_at proves an inventory observation exists.
    has_stored_data INTEGER NOT NULL DEFAULT 0,
    -- The sweep that last listed this object. A monotonic receipt id rather
    -- than a timestamp: absence is decided by comparing against the current
    -- sweep, and two sweeps inside one millisecond would make a clock
    -- comparison silently skip that step.
    last_sweep_id INTEGER,
    report_status TEXT,
    schema_version INTEGER,
    failure_message TEXT,
    failure_version INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_swept_at INTEGER,
    -- The producer's occurredAt, not the tracker's write clock. Queues do not
    -- guarantee ordering, so this is what lets a late-arriving older report be
    -- recognised and dropped instead of overwriting a newer one.
    last_reported_at INTEGER,
    last_failed_at INTEGER,
    absent_since INTEGER
  ) STRICT
`;

/**
 * The append-only report log. The `durable_objects` row answers "where is this
 * object now"; this table answers "how did it get there", which is the question
 * a half-landed deploy actually raises. It is capped rather than kept forever —
 * see `MIGRATION_EVENT_RETENTION`.
 *
 * `report_id` is the producer's per-send UUID and carries a unique index.
 * Cloudflare Queues deliver at least once, so a redelivered batch would
 * otherwise append the same report twice and make a single wake look like two.
 */
const V1_MIGRATION_EVENTS = `
  CREATE TABLE IF NOT EXISTS migration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    object_name TEXT,
    class_name TEXT NOT NULL,
    component TEXT NOT NULL,
    region TEXT NOT NULL,
    app_env TEXT NOT NULL,
    worker_version_id TEXT NOT NULL,
    status TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    latest_version INTEGER NOT NULL,
    applied_versions TEXT NOT NULL,
    failure_message TEXT,
    failure_version INTEGER,
    occurred_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL
  ) STRICT
`;

/**
 * The highest schema version each component has ever been *seen* running, per
 * region. Nothing in the account publishes the head of a migration list, so the
 * tracker learns it from the reports themselves: the first object to run a new
 * build raises the head, and every object still below it is behind. It is
 * monotonic on purpose — a rollback must not retroactively declare the fleet
 * current — and it is per region because the two Workers deploy independently.
 */
const V1_COMPONENT_VERSIONS = `
  CREATE TABLE IF NOT EXISTS component_versions (
    component TEXT NOT NULL,
    region TEXT NOT NULL,
    class_name TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    worker_version_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (component, region)
  ) STRICT
`;

/** One row per inventory sweep, so a stale page is obvious rather than implied. */
const V1_SWEEPS = `
  CREATE TABLE IF NOT EXISTS inventory_sweeps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    namespace_count INTEGER NOT NULL,
    object_count INTEGER NOT NULL,
    truncated_namespaces TEXT NOT NULL,
    error_message TEXT
  ) STRICT
`;

/**
 * One row per Durable Object namespace the account has ever had. Two more
 * columns arrive below — `retired_at` and `last_sweep_id` in v2, then
 * `last_listed_sweep_id` in v5 — so this `CREATE TABLE` is not the whole shape
 * of the deployed table.
 */
const V1_NAMESPACES = `
  CREATE TABLE IF NOT EXISTS durable_object_namespaces (
    namespace_id TEXT PRIMARY KEY,
    script_name TEXT NOT NULL,
    class_name TEXT NOT NULL,
    uses_sqlite INTEGER NOT NULL,
    object_count INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_swept_at INTEGER NOT NULL
  ) STRICT
`;

/**
 * When a namespace stopped existing in the account.
 *
 * Added in v2 because v1 had no way to say it: absence was decided per
 * namespace, inside the loop over the namespaces a sweep returned, so a class
 * deleted from the Worker simply stopped appearing and nothing ever visited it
 * again. Its objects kept whatever status they last held — `current`, or worse,
 * `behind` — with a frozen sweep time, and a retired component went on
 * contributing a red count that nobody could clear.
 *
 * A column rather than a delete, for the same reason objects are marked
 * `absent` rather than removed: "this class used to exist and no longer does"
 * is the answer to a question somebody asks during an incident, and a deleted
 * row cannot answer it. It is cleared again if the namespace comes back.
 *
 * `last_sweep_id` is what decides that, exactly as it does for objects: the
 * sweep stamps every namespace it returned, and a namespace still carrying an
 * older stamp is one this sweep did not find. The alternative was to pass the
 * swept ids into the statement as a `NOT IN` list, which is correct and does
 * not survive the platform — Durable Object SQL allows **100 bound parameters
 * per query**, and an account may hold up to 500 Durable Object classes. Past
 * that the statement throws, and because the sweep runs inside one
 * `transactionSync`, the whole sweep is lost rather than just the retirement.
 * Both columns are NULL when they do not apply, including on the rows a v1
 * registry already holds.
 */
const V2_NAMESPACE_RETIREMENT = [
  `ALTER TABLE durable_object_namespaces ADD COLUMN retired_at INTEGER`,
  `ALTER TABLE durable_object_namespaces ADD COLUMN last_sweep_id INTEGER`,
] as const;

/**
 * The `SubstreamAgent` component key, renamed from `workstream`. (The class
 * has since been renamed `AgentLoopDO`; see v6.)
 *
 * The key is the tracker's own identifier and nothing else: no Durable Object
 * stores it — `_sql_schema_migrations` records a version, a hash, and a build,
 * never a component — so this migration moves the whole of what the rename
 * touches. Without it the new key would arrive as a *second* component starting
 * at head 0, leaving the fleet split between two rows: every object that has
 * not woken since the deploy stranded under `workstream` at v15, and every
 * object that has, silently `current` under a head no build has raised yet.
 *
 * The report log is rewritten along with the live rows. Its component column
 * says which schema a receipt belongs to, and that is the same schema before
 * and after — leaving history under the old key would only mean the object page
 * and the filter list disagree about what to call it. Nothing a report actually
 * witnessed (its version, status, build, or time) is touched.
 *
 * The `component_versions` write is a merge rather than an UPDATE because the
 * two Workers deploy from independent workflows: if the API lands first, its
 * reports have already created the new row, and renaming onto it would collide
 * with the primary key and take the registry down inside its own constructor.
 * `MAX` keeps the head monotonic through the merge, which is the one property
 * the fleet's `behind` count depends on.
 */
const V3_SUBSTREAM_AGENT_COMPONENT = [
  `UPDATE durable_objects SET component = 'substream_agent_do'
     WHERE component = 'workstream'`,
  `UPDATE migration_events SET component = 'substream_agent_do'
     WHERE component = 'workstream'`,
  `INSERT INTO component_versions
     (component, region, class_name, latest_version, worker_version_id, observed_at)
   SELECT 'substream_agent_do', region, class_name, latest_version, worker_version_id,
          observed_at
     FROM component_versions
    WHERE component = 'workstream'
   ON CONFLICT(component, region) DO UPDATE SET
     class_name = excluded.class_name,
     worker_version_id = CASE
       WHEN excluded.latest_version >= component_versions.latest_version
         THEN excluded.worker_version_id
       ELSE component_versions.worker_version_id
     END,
     observed_at = MAX(component_versions.observed_at, excluded.observed_at),
     latest_version = MAX(component_versions.latest_version, excluded.latest_version)`,
  `DELETE FROM component_versions WHERE component = 'workstream'`,
] as const;

/**
 * One row per forced-migration run an operator started from the site.
 *
 * The dispatch itself needs no record — a command is a queue message, and the
 * objects that receive one report their own state afterwards, which is what the
 * rest of this site already renders. This table answers the question the report
 * log cannot: *who asked, for what, and how many objects did the ask actually
 * reach*. Without it a run is a click that produces a slow trickle of reports
 * indistinguishable from ordinary traffic, and an operator watching it has no
 * way to tell a run that dispatched nine hundred messages from one that matched
 * nothing.
 *
 * `matched` and `dispatched` are separate columns because they come apart in
 * two ways worth seeing. An object whose region cannot be resolved is matched
 * and never dispatched — it is counted in `unroutable` — and a run larger than
 * the per-run cap stops early, which `truncated` records. A cap that is not
 * visible reads as "this covered the class", which is the one thing a run
 * record must never imply.
 *
 * `requested_by` is the Access assertion's email. It is the only place this
 * Worker stores an identity rather than displaying one, and it is stored
 * because a forced fan-out over a production fleet is the one action here that
 * someone may later need to attribute. It is an Avalon operator's address, not
 * a workspace member's; nothing about a workspace reaches this table.
 */
const V4_MIGRATION_RUNS = `
  CREATE TABLE IF NOT EXISTS migration_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    class_name TEXT NOT NULL,
    -- NULL means every region the class runs in.
    region TEXT,
    requested_by TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    matched_count INTEGER NOT NULL,
    dispatched_count INTEGER NOT NULL,
    unroutable_count INTEGER NOT NULL,
    truncated INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT
  ) STRICT
`;

/**
 * The sweep receipt that most recently listed this namespace's objects.
 *
 * `last_sweep_id` cannot carry both meanings: it advances whenever the
 * namespace itself was returned, even when its object listing failed, because
 * namespace retirement depends on that fact. `last_listed_sweep_id` advances
 * only when `objects` is non-null, so the displayed Stored count and IDs count
 * remain a projection of the same successful listing.
 */
const V5_NAMESPACE_LISTING_STAMP = [
  `ALTER TABLE durable_object_namespaces ADD COLUMN last_listed_sweep_id INTEGER`,
  `UPDATE durable_object_namespaces
      SET last_listed_sweep_id = last_sweep_id
    WHERE last_swept_at IS NOT NULL`,
] as const;

/**
 * The conversation class renamed `SubstreamAgent` to `AgentLoopDO` (Wrangler
 * tag v15). The Cloudflare namespace, its object ids and every object's
 * storage are unchanged; only the class name the tracker filed them under
 * moves, in the live rows, the report log, the heads, the namespaces and the
 * runs, so the fleet is one class rather than two. The component key
 * (`substream_agent_do`) names the schema, which did not change, and stays.
 */
const V6_AGENT_LOOP_CLASS = [
  `UPDATE durable_objects SET class_name = 'AgentLoopDO' WHERE class_name = 'SubstreamAgent'`,
  `UPDATE migration_events SET class_name = 'AgentLoopDO' WHERE class_name = 'SubstreamAgent'`,
  `UPDATE component_versions SET class_name = 'AgentLoopDO' WHERE class_name = 'SubstreamAgent'`,
  `UPDATE durable_object_namespaces SET class_name = 'AgentLoopDO' WHERE class_name = 'SubstreamAgent'`,
  `UPDATE migration_runs SET class_name = 'AgentLoopDO' WHERE class_name = 'SubstreamAgent'`,
] as const;

export const REGISTRY_MIGRATIONS: readonly RegistryMigration[] = [{
  version: 1,
  description: "durable object inventory, migration reports, and sweep receipts",
  statements: [
    V1_DURABLE_OBJECTS,
    V1_MIGRATION_EVENTS,
    V1_COMPONENT_VERSIONS,
    V1_SWEEPS,
    V1_NAMESPACES,
    `CREATE INDEX IF NOT EXISTS durable_objects_by_component
       ON durable_objects (component, schema_version)`,
    `CREATE INDEX IF NOT EXISTS durable_objects_by_script
       ON durable_objects (script_name, class_name)`,
    `CREATE INDEX IF NOT EXISTS durable_objects_by_failure
       ON durable_objects (last_failed_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS migration_events_report_id
       ON migration_events (report_id)`,
    `CREATE INDEX IF NOT EXISTS migration_events_by_object
       ON migration_events (object_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS migration_events_by_time
       ON migration_events (occurred_at DESC)`,
  ],
}, {
  version: 2,
  description: "retire namespaces that have left the account",
  statements: V2_NAMESPACE_RETIREMENT,
}, {
  version: 3,
  description: "rename the SubstreamAgent migration component to substream_agent_do",
  statements: V3_SUBSTREAM_AGENT_COMPONENT,
}, {
  version: 4,
  description: "record forced migration runs started from the site",
  statements: [
    V4_MIGRATION_RUNS,
    `CREATE UNIQUE INDEX IF NOT EXISTS migration_runs_run_id
       ON migration_runs (run_id)`,
  ],
}, {
  version: 5,
  description: "separate namespace discovery from successful object listings",
  statements: V5_NAMESPACE_LISTING_STAMP,
}, {
  version: 6,
  description: "file the conversation class under its new name, AgentLoopDO",
  statements: V6_AGENT_LOOP_CLASS,
}];

export const REGISTRY_SCHEMA_VERSION = REGISTRY_MIGRATIONS.at(-1)?.version ?? 0;

/** Apply every unapplied migration and its receipt in one synchronous transaction. */
export function applyRegistrySchema(
  storage: DurableObjectStorage,
  migrations: readonly RegistryMigration[] = REGISTRY_MIGRATIONS,
  now: number = Date.now(),
): readonly number[] {
  const applied: number[] = [];
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new Error(`migration_registry_schema_versions_not_strictly_monotonic:${migration.version}`);
    }
    previous = migration.version;
  }

  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(MIGRATIONS_TABLE);
    const known = new Set(sql.exec<{ version: number }>(
      `SELECT version FROM _sql_schema_migrations`,
    ).toArray().map((row) => row.version));
    const ahead = [...known].find((version) => version > previous);
    if (ahead !== undefined) throw new Error(`migration_registry_schema_ahead:${ahead}`);

    for (const migration of migrations) {
      if (known.has(migration.version)) continue;
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec(
        `INSERT INTO _sql_schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
        migration.version,
        migration.description,
        now,
      );
      applied.push(migration.version);
    }
  });

  return applied;
}

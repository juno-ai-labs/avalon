import { regions, isConfiguredRegion } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
/**
 * The registry: one Durable Object holding everything the tracker knows.
 *
 * A single object for the whole account is deliberate. Both writers are
 * low-volume — a report is sent only when an object's version changes or its
 * daily heartbeat comes due, and the inventory sweep runs once an hour — while
 * every read the operator site performs is a cross-cutting aggregate ("which
 * components are behind", "what failed today"). Sharding would buy throughput
 * nothing needs and would turn each of those reads into a scatter-gather.
 *
 * D1 was the other candidate and was rejected for a smaller reason: it is a
 * hosted resource that has to be created, named, and pasted into the Wrangler
 * file before the first deploy, and the whole point of this Worker is to be the
 * thing that still works when a deploy went wrong. A Durable Object namespace
 * is created by the deploy itself.
 */
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectMigrationReport } from "@rally/contracts/durable-object-migrations";
import { applyRegistrySchema, REGISTRY_SCHEMA_VERSION } from "./schema";
import type { Env } from "./env";
import { ObjectStatusSchema, REPORTING_CLASSES } from "./protocol";
import type {
  ComponentSummary,
  ForceableComponent,
  InventorySweep,
  MigrationEvent,
  MigrationRun,
  MigrationRunRequest,
  MigrationTarget,
  MigrationTargetSelection,
  NamespaceSummary,
  ObjectDetail,
  ObjectQuery,
  ObjectStatus,
  RegistryOverview,
  SweepSummary,
  TrackedObject,
  TrackedObjectPage,
} from "./protocol";

/** The one object name; the registry is an account-wide singleton. */
export const REGISTRY_OBJECT_NAME = "registry";

/**
 * Bounds. The event log is the only table that grows without an upper bound
 * from the fleet's size, so it is the only one trimmed aggressively. Both
 * numbers are generous enough to cover a full deploy's rollout several times
 * over, which is the window anyone actually reads.
 */
const MIGRATION_EVENT_RETENTION = 20_000;
const SWEEP_RETENTION = 200;
const RECENT_EVENT_LIMIT = 25;
const RECENT_FAILURE_LIMIT = 25;
const OBJECT_EVENT_LIMIT = 100;
const MIGRATION_RUN_RETENTION = 200;
const MIGRATION_RUN_LIMIT = 25;

/**
 * The most objects one forced run will dispatch to.
 *
 * A ceiling on the fan-out rather than a capacity estimate. A queue takes 5,000
 * messages a second and holds 25 GB, so the messages are not the constraint;
 * what is, is that each one wakes a Durable Object, and an operator who picks
 * the wrong class should not be able to cold-start the entire account from one
 * form. Five thousand is above every class this account holds — the largest is
 * in the hundreds — so in practice it caps nothing, and a run that does hit it
 * says so on the page and in its own row rather than reporting a clean sweep of
 * a class it only partly covered.
 */
const MIGRATION_RUN_TARGET_LIMIT = 5_000;

/**
 * Which region's Worker owns the objects a script name's namespace holds.
 *
 * The forced-migration command has to name a region, because that is what picks
 * the queue, and the region an object reports is the one thing an *unreported*
 * object does not have — which is exactly the object an operator most wants to
 * force. The script name comes from the inventory sweep instead, and it always
 * exists for an enumerated object.
 *
 * A second checked-in fact about `apps/api`, alongside `REPORTING_CLASSES`, and
 * held to the same rule: it is a map rather than a pattern so that a Worker
 * added to the account does not silently acquire a region. An object whose
 * script is not here is counted as unroutable and shown, never guessed at.
 */
export const REGION_BY_SCRIPT_NAME: Readonly<Record<string, Region>> = Object.fromEntries(Object.entries(regions).map(([region, config]) => [config.workerName, region]));

/**
 * `COALESCE(reported region, region implied by the script name)`, as SQL.
 *
 * Built from the map above so the two cannot drift, and bound-parameter free:
 * it is interpolated into statements that already interpolate
 * `REPORTING_CLASS_LIST`, from the same kind of source — a checked-in constant,
 * never anything a request carries.
 */
const RESOLVED_REGION = `COALESCE(o.region, CASE o.script_name${
  Object.entries(REGION_BY_SCRIPT_NAME)
    .map(([script, region]) => ` WHEN '${script}' THEN '${region}'`)
    .join("")
} END)`;

type ObjectRow = {
  object_id: string;
  object_name: string | null;
  namespace_id: string | null;
  script_name: string | null;
  class_name: string | null;
  component: string | null;
  region: string | null;
  app_env: string | null;
  worker_version_id: string | null;
  has_stored_data: number;
  schema_version: number | null;
  component_latest_version: number | null;
  status: string;
  failure_message: string | null;
  failure_version: number | null;
  first_seen_at: number;
  last_swept_at: number | null;
  last_reported_at: number | null;
  last_failed_at: number | null;
  absent_since: number | null;
  namespace_retired_at: number | null;
};

type EventRow = {
  id: number;
  object_id: string;
  object_name: string | null;
  class_name: string;
  component: string;
  region: string;
  app_env: string;
  worker_version_id: string;
  status: string;
  schema_version: number;
  latest_version: number;
  applied_versions: string;
  failure_message: string | null;
  failure_version: number | null;
  occurred_at: number;
};

/**
 * The one component key a report may still arrive under, and what it is now.
 *
 * Registry v3 renamed `AgentLoopDO`'s component, and the two Workers deploy
 * from independent workflows — the tracker's is much the smaller of the two, so
 * it usually lands first and reports from the outgoing API build keep arriving
 * under the old key after the migration has already run. v3 cannot catch those:
 * its receipt is what stops a migration running twice. Without this they would
 * recreate the head row, refile live objects under the old key, and — the part
 * no later migration repairs — write history under a key nothing else uses.
 *
 * Deliberately bounded, and the reason it is acceptable in the write path at
 * all. Delete it, and its test, once no deployed API build carries the old key:
 * everything that reported under it has been rewritten by v3, so a report
 * arriving under `workstream` after that is a producer nobody can account for,
 * which is worth seeing rather than silently renaming.
 */
const RENAMED_COMPONENT_FROM = "workstream";
const RENAMED_COMPONENT_TO = "substream_agent_do";

/**
 * Wrangler tag v15 renamed the conversation class `SubstreamAgent` to
 * `AgentLoopDO`, and registry v6 rewrote every stored row. A report the
 * outgoing API build sends under the old class name after that is filed under
 * the new one, for the reason the component rename above is: the two Workers
 * deploy independently. Delete it, and its test, once no deployed API build
 * carries the old class.
 */
const RENAMED_CLASS_FROM = "SubstreamAgent";
const RENAMED_CLASS_TO = "AgentLoopDO";

const REPORTING_CLASS_LIST = REPORTING_CLASSES.map((name) => `'${name}'`).join(", ");

/**
 * The derived status, computed in SQL so that filtering, counting, and paging
 * all agree on one definition. Recomputing it in TypeScript would mean the
 * status column and the status filter could drift apart without a test noticing.
 *
 * The status strings here, `ObjectStatusSchema`, and `isObjectStatus` in
 * `toTrackedObject` must all agree. A value produced here that the enum does not
 * know degrades silently to `unreported` rather than throwing, so a mismatch
 * shows up as a wrong count rather than an error.
 */
const RESOLVED_OBJECTS = `
  WITH resolved AS (
    SELECT
      o.*,
      c.latest_version AS component_latest_version,
      ns.retired_at AS namespace_retired_at,
      CASE
        WHEN o.absent_since IS NOT NULL THEN 'absent'
        -- Report-only rows default to 0. A false sweep wins unless a strictly
        -- newer report proves storage; toTrackedObject mirrors this projection.
        WHEN o.last_swept_at IS NOT NULL
          AND o.has_stored_data = 0
          AND o.last_swept_at >= COALESCE(o.last_reported_at, 0) THEN 'empty'
        WHEN o.report_status = 'failed' THEN 'failed'
        WHEN o.class_name IS NOT NULL
          AND o.class_name NOT IN (${REPORTING_CLASS_LIST}) THEN 'not_reporting'
        WHEN o.report_status IS NULL THEN 'unreported'
        WHEN c.latest_version IS NOT NULL
          AND o.schema_version IS NOT NULL
          AND o.schema_version < c.latest_version THEN 'behind'
        ELSE 'current'
      END AS status
    FROM durable_objects o
    LEFT JOIN component_versions c
      ON c.component = o.component AND c.region = o.region
    LEFT JOIN durable_object_namespaces ns
      ON ns.namespace_id = o.namespace_id
  )
`;

const OBJECT_COLUMNS = `
  object_id, object_name, namespace_id, script_name, class_name, component,
  region, app_env, worker_version_id, has_stored_data, schema_version,
  component_latest_version, status, failure_message, failure_version,
  first_seen_at, last_swept_at, last_reported_at, last_failed_at, absent_since,
  namespace_retired_at
`;

export class MigrationRegistry extends DurableObject<Env> {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.storage = state.storage;
    state.blockConcurrencyWhile(async () => {
      applyRegistrySchema(state.storage);
    });
  }

  /**
   * Record a batch of Durable Object migration reports in one transaction.
   *
   * One transaction per *batch* rather than per report is the reason this
   * subsystem uses a Queue at all: a herd of reporters costs the registry one
   * write instead of one each. The batch is bounded by the consumer's
   * `max_batch_size`, so the transaction stays small.
   *
   * Written against the two things Cloudflare Queues do not promise. Delivery
   * is at least once, so the same report can arrive twice; ordering is not
   * guaranteed, so an older report can arrive after a newer one. Both are
   * handled in the SQL rather than by sorting the batch, because a late
   * redelivery can arrive in a later batch entirely, where sorting cannot see
   * it.
   */
  recordReports(reports: readonly DurableObjectMigrationReport[]): void {
    const recordedAt = Date.now();
    this.storage.transactionSync(() => {
      for (const report of reports) this.applyReport(report, recordedAt);
      this.storage.sql.exec(
        `DELETE FROM migration_events WHERE id <= (
           SELECT MAX(id) - ? FROM migration_events
         )`,
        MIGRATION_EVENT_RETENTION,
      );
    });
  }

  private applyReport(received: DurableObjectMigrationReport, recordedAt: number): void {
    const sql = this.storage.sql;
    const report = received.className === RENAMED_CLASS_FROM ? { ...received, className: RENAMED_CLASS_TO } : received;
    const component = report.component === RENAMED_COMPONENT_FROM
      ? RENAMED_COMPONENT_TO
      : report.component;

    // Monotonic: the head is the highest version this component has ever been
    // seen running in this region. A rolled-back deploy reporting a lower
    // number must leave every other object marked behind rather than silently
    // declaring the fleet current again.
    sql.exec(
      `INSERT INTO component_versions
         (component, region, class_name, latest_version, worker_version_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(component, region) DO UPDATE SET
         class_name = excluded.class_name,
         observed_at = excluded.observed_at,
         worker_version_id = CASE
           WHEN excluded.latest_version >= component_versions.latest_version
             THEN excluded.worker_version_id
           ELSE component_versions.worker_version_id
         END,
         latest_version = MAX(component_versions.latest_version, excluded.latest_version)`,
      component,
      report.region,
      report.className,
      report.latestVersion,
      report.workerVersionId,
      recordedAt,
    );

    const failed = report.status === "failed";
    sql.exec(
      `INSERT INTO durable_objects (
         object_id, object_name, class_name, component, region, app_env,
         worker_version_id, report_status, schema_version, failure_message,
         failure_version, first_seen_at, last_reported_at, last_failed_at,
         absent_since
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(object_id) DO UPDATE SET
         object_name = COALESCE(excluded.object_name, durable_objects.object_name),
         class_name = excluded.class_name,
         component = excluded.component,
         region = excluded.region,
         app_env = excluded.app_env,
         worker_version_id = excluded.worker_version_id,
         report_status = excluded.report_status,
         schema_version = excluded.schema_version,
         failure_message = excluded.failure_message,
         failure_version = excluded.failure_version,
         last_reported_at = excluded.last_reported_at,
         last_failed_at = COALESCE(excluded.last_failed_at, durable_objects.last_failed_at),
         -- A report proves the object exists, whatever the last sweep decided.
         absent_since = NULL
       WHERE excluded.last_reported_at >= COALESCE(durable_objects.last_reported_at, 0)`,
      report.objectId,
      report.objectName,
      report.className,
      component,
      report.region,
      report.appEnv,
      report.workerVersionId,
      report.status,
      report.schemaVersion,
      report.failure?.message ?? null,
      report.failure?.version ?? null,
      recordedAt,
      report.occurredAt,
      failed ? report.occurredAt : null,
    );

    sql.exec(
      `INSERT INTO migration_events (
         report_id, object_id, object_name, class_name, component, region,
         app_env, worker_version_id, status, schema_version, latest_version,
         applied_versions, failure_message, failure_version, occurred_at,
         recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- A redelivered message is the same report, not a second one.
       ON CONFLICT(report_id) DO NOTHING`,
      report.reportId,
      report.objectId,
      report.objectName,
      report.className,
      component,
      report.region,
      report.appEnv,
      report.workerVersionId,
      report.status,
      report.schemaVersion,
      report.latestVersion,
      JSON.stringify(report.appliedVersions),
      report.failure?.message ?? null,
      report.failure?.version ?? null,
      report.occurredAt,
      recordedAt,
    );
  }

  /**
   * Fold one inventory sweep into the registry.
   *
   * Absence is decided per namespace, and only for a namespace whose listing ran
   * to completion. A truncated or failed listing says nothing about the objects
   * it did not reach, and marking those absent would erase exactly the objects a
   * large namespace is most likely to hide.
   *
   * That pass can only reach namespaces the sweep returned, so a namespace that
   * has left the account entirely is handled separately, by
   * `retireMissingNamespaces` below.
   */
  recordSweep(sweep: InventorySweep): void {
    const now = Date.now();
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const truncated = new Set(sweep.truncatedNamespaces);
      const objectCount = sweep.namespaces
        .reduce((total, namespace) => total + (namespace.objects?.length ?? 0), 0);

      // The receipt is written first so its row id can stamp every object this
      // sweep saw. That id, not the wall clock, is what decides absence below.
      sql.exec(
        `INSERT INTO inventory_sweeps
           (started_at, finished_at, status, namespace_count, object_count,
            truncated_namespaces, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        sweep.startedAt,
        sweep.finishedAt,
        sweep.status,
        sweep.namespaces.length,
        objectCount,
        JSON.stringify(sweep.truncatedNamespaces),
        sweep.errorMessage,
      );
      const sweepId = sql.exec<{ id: number }>(
        `SELECT MAX(id) AS id FROM inventory_sweeps`,
      ).toArray()[0]?.id ?? 0;

      for (const namespace of sweep.namespaces) {
        // A namespace whose object listing failed arrives with `objects: null`,
        // which says nothing about how many objects it has. Writing a count and
        // a sweep time for it would say something — that it is empty and was
        // just enumerated — so the identity columns are refreshed and the two
        // columns that describe the listing are left at whatever the last
        // successful sweep put there. Everything else in this method already
        // treats `null` as "says nothing"; this is the one place that used to
        // read it as "says zero".
        const listed = namespace.objects !== null;
        sql.exec(
          `INSERT INTO durable_object_namespaces
             (namespace_id, script_name, class_name, uses_sqlite, object_count,
              first_seen_at, last_swept_at, last_sweep_id, last_listed_sweep_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?9, CASE WHEN ?8 THEN ?9 ELSE NULL END)
           ON CONFLICT(namespace_id) DO UPDATE SET
             script_name = excluded.script_name,
             class_name = excluded.class_name,
             uses_sqlite = excluded.uses_sqlite,
             object_count = CASE WHEN ?8 THEN excluded.object_count
                                 ELSE durable_object_namespaces.object_count END,
             last_swept_at = CASE WHEN ?8 THEN excluded.last_swept_at
                                  ELSE durable_object_namespaces.last_swept_at END,
             -- Stamped whether or not the object listing worked: this records
             -- that the *namespace* was returned, which is what retirement
             -- asks about.
             last_sweep_id = ?9,
             -- Unlike the namespace-presence stamp above, this advances only
             -- when the object listing succeeded. The Stored and IDs columns
             -- both describe the listing carrying this receipt.
             last_listed_sweep_id = CASE
               WHEN ?8 THEN ?9
               ELSE durable_object_namespaces.last_listed_sweep_id
             END,
             -- Listed again, so it is not retired, whatever a previous sweep
             -- concluded. A class can come back: a rollback restores the
             -- binding a deploy removed.
             retired_at = NULL`,
          namespace.namespaceId,
          namespace.scriptName,
          namespace.className,
          namespace.usesSqlite ? 1 : 0,
          namespace.objects?.length ?? 0,
          now,
          now,
          listed ? 1 : 0,
          sweepId,
        );

        if (!namespace.objects) continue;
        for (const object of namespace.objects) {
          sql.exec(
            `INSERT INTO durable_objects (
               object_id, namespace_id, script_name, class_name, has_stored_data,
               first_seen_at, last_swept_at, last_sweep_id, absent_since
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(object_id) DO UPDATE SET
               namespace_id = excluded.namespace_id,
               script_name = excluded.script_name,
               -- The sweep is authoritative for the class: it reads the
               -- namespace's declared binding rather than the object's opinion.
               class_name = excluded.class_name,
               has_stored_data = excluded.has_stored_data,
               last_swept_at = excluded.last_swept_at,
               last_sweep_id = excluded.last_sweep_id,
               absent_since = NULL`,
            object.objectId,
            namespace.namespaceId,
            namespace.scriptName,
            namespace.className,
            object.hasStoredData ? 1 : 0,
            now,
            object.observedAt ?? sweep.finishedAt,
            sweepId,
          );
        }

        if (truncated.has(namespace.namespaceId)) continue;
        sql.exec(
          `UPDATE durable_objects
              SET absent_since = ?
            WHERE namespace_id = ?
              AND absent_since IS NULL
              AND (last_sweep_id IS NULL OR last_sweep_id < ?)`,
          now,
          namespace.namespaceId,
          sweepId,
        );
      }

      retireMissingNamespaces(sql, sweep, sweepId, now);

      sql.exec(
        `DELETE FROM inventory_sweeps WHERE id <= (SELECT MAX(id) - ? FROM inventory_sweeps)`,
        SWEEP_RETENTION,
      );
    });
  }

  listObjects(query: ObjectQuery): TrackedObjectPage {
    const filters: string[] = [];
    const bindings: (string | number)[] = [];
    if (query.status) {
      filters.push("status = ?");
      bindings.push(query.status);
    }
    if (query.component) {
      filters.push("component = ?");
      bindings.push(query.component);
    }
    if (query.region) {
      filters.push("region = ?");
      bindings.push(query.region);
    }
    if (query.scriptName) {
      filters.push("script_name = ?");
      bindings.push(query.scriptName);
    }
    if (query.search) {
      // Prefix match on either identifier. `LIKE` with an escaped pattern
      // rather than string interpolation: the search box is operator input and
      // it reaches SQL either way, so it reaches it as a bound parameter.
      filters.push("(object_id LIKE ? ESCAPE '\\' OR object_name LIKE ? ESCAPE '\\')");
      const pattern = `${escapeLike(query.search)}%`;
      bindings.push(pattern, pattern);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const total = this.storage.sql.exec<{ total: number }>(
      `${RESOLVED_OBJECTS} SELECT COUNT(*) AS total FROM resolved ${where}`,
      ...bindings,
    ).toArray()[0]?.total ?? 0;

    const rows = this.storage.sql.exec<ObjectRow>(
      `${RESOLVED_OBJECTS}
       SELECT ${OBJECT_COLUMNS} FROM resolved ${where}
       ORDER BY
         CASE status
           WHEN 'failed' THEN 0
           WHEN 'behind' THEN 1
           WHEN 'unreported' THEN 2
           WHEN 'current' THEN 3
           WHEN 'not_reporting' THEN 4
           WHEN 'empty' THEN 5
           WHEN 'absent' THEN 6
           ELSE 7
         END,
         COALESCE(last_reported_at, last_swept_at, first_seen_at) DESC,
         object_id
       LIMIT ? OFFSET ?`,
      ...bindings,
      query.limit,
      query.offset,
    ).toArray();

    return {
      objects: rows.map(toTrackedObject),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  objectDetail(objectId: string): ObjectDetail | null {
    const row = this.storage.sql.exec<ObjectRow>(
      `${RESOLVED_OBJECTS} SELECT ${OBJECT_COLUMNS} FROM resolved WHERE object_id = ?`,
      objectId,
    ).toArray()[0];
    if (!row) return null;
    const events = this.storage.sql.exec<EventRow>(
      `SELECT id, object_id, object_name, class_name, component, region, app_env,
              worker_version_id, status, schema_version, latest_version,
              applied_versions, failure_message, failure_version, occurred_at
         FROM migration_events WHERE object_id = ? ORDER BY id DESC LIMIT ?`,
      objectId,
      OBJECT_EVENT_LIMIT,
    ).toArray();
    return { object: toTrackedObject(row), events: events.map(toMigrationEvent) };
  }

  overview(): RegistryOverview {
    const sql = this.storage.sql;
    const counts = sql.exec<{ status: string; count: number }>(
      `${RESOLVED_OBJECTS} SELECT status, COUNT(*) AS count FROM resolved GROUP BY status`,
    ).toArray();
    const totals = {
      failed: 0,
      behind: 0,
      unreported: 0,
      current: 0,
      not_reporting: 0,
      empty: 0,
      absent: 0,
      all: 0,
    };
    for (const row of counts) {
      if (isObjectStatus(row.status)) totals[row.status] = row.count;
      totals.all += row.count;
    }

    const components = sql.exec<{
      component: string;
      region: string;
      class_name: string;
      latest_version: number;
      worker_version_id: string;
      observed_at: number;
      current: number;
      behind: number;
      failed: number;
      unreported: number;
      empty: number;
      absent: number;
      total: number;
      retired: number;
    }>(
      // `total` counts only live objects, so empty and absent identities are
      // reported beside it rather than folded into it — a component reading
      // "0 of 40" says something a component reading "0" does not.
      //
      // `retired` is decided by the namespaces, not by the object counts. Every
      // object being absent means only that no instance is alive right now,
      // which is ordinary for an on-demand class; the class no longer having a
      // namespace behind it means it is gone.
      //
      // The link from a component to its namespaces runs through the objects,
      // which is the only place the two halves of the tracker meet: a sweep
      // gives an object its `namespace_id`, and a report gives it its
      // `component` and `region`. Grouping the namespaces by class instead
      // would make retirement account-wide, and the same classes are deployed
      // in both regions — deleting a class from `avalon-api-global` while
      // another deployment still runs it would leave the global component looking
      // live because the regional namespace is. A component whose objects have no
      // namespace yet has no evidence either way, and defaults to live.
      `${RESOLVED_OBJECTS}
       SELECT c.component, c.region, c.class_name, c.latest_version,
              c.worker_version_id, c.observed_at,
              COALESCE(SUM(r.status = 'current'), 0) AS current,
              COALESCE(SUM(r.status = 'behind'), 0) AS behind,
              COALESCE(SUM(r.status = 'failed'), 0) AS failed,
              COALESCE(SUM(r.status = 'unreported'), 0) AS unreported,
              COALESCE(SUM(r.status = 'empty'), 0) AS empty,
              COALESCE(SUM(r.status = 'absent'), 0) AS absent,
              COALESCE(SUM(r.status NOT IN ('empty', 'absent')), 0) AS total,
              COALESCE(MAX(ns.live), 1) = 0 AS retired
         FROM component_versions c
         LEFT JOIN resolved r
           ON r.component = c.component AND r.region = c.region
         LEFT JOIN (SELECT o.component, o.region, SUM(n.retired_at IS NULL) AS live
                      FROM durable_objects o
                      JOIN durable_object_namespaces n ON n.namespace_id = o.namespace_id
                     WHERE o.component IS NOT NULL AND o.region IS NOT NULL
                     GROUP BY o.component, o.region) ns
           ON ns.component = c.component AND ns.region = c.region
        GROUP BY c.component, c.region
        ORDER BY retired, failed DESC, behind DESC, c.component, c.region`,
    ).toArray();

    const namespaces = sql.exec<{
      namespace_id: string;
      script_name: string;
      class_name: string;
      uses_sqlite: number;
      object_count: number;
      stored_object_count: number;
      last_swept_at: number;
      retired_at: number | null;
    }>(
      // Retired namespaces sort to the bottom rather than out of the list: what
      // used to be deployed here is exactly what somebody wants to see when a
      // class disappeared and its objects went absent on the same sweep.
      `SELECT n.namespace_id, n.script_name, n.class_name, n.uses_sqlite, n.object_count,
              COALESCE((SELECT COUNT(*) FROM durable_objects o
                         WHERE o.namespace_id = n.namespace_id
                           AND o.last_sweep_id = n.last_listed_sweep_id
                           AND o.has_stored_data = 1), 0) AS stored_object_count,
              n.last_swept_at, n.retired_at
         FROM durable_object_namespaces n
        ORDER BY retired_at IS NOT NULL, script_name, class_name`,
    ).toArray();

    const sweep = this.readSweep();
    // A failed sweep enumerated nothing but still wrote a receipt with a fresh
    // timestamp, so measuring staleness against the newest receipt would let a
    // continuing Cloudflare outage suppress the stale banner indefinitely.
    const enumeration = this.readSweep("WHERE status != 'failed'");

    const recentFailures = sql.exec<ObjectRow>(
      `${RESOLVED_OBJECTS}
       SELECT ${OBJECT_COLUMNS} FROM resolved
        WHERE status = 'failed' ORDER BY last_failed_at DESC LIMIT ?`,
      RECENT_FAILURE_LIMIT,
    ).toArray();

    const recentEvents = sql.exec<EventRow>(
      `SELECT id, object_id, object_name, class_name, component, region, app_env,
              worker_version_id, status, schema_version, latest_version,
              applied_versions, failure_message, failure_version, occurred_at
         FROM migration_events ORDER BY id DESC LIMIT ?`,
      RECENT_EVENT_LIMIT,
    ).toArray();

    return {
      generatedAt: Date.now(),
      registrySchemaVersion: REGISTRY_SCHEMA_VERSION,
      totals,
      components: components.map((row): ComponentSummary => ({
        component: row.component,
        region: row.region,
        className: row.class_name,
        latestVersion: row.latest_version,
        workerVersionId: row.worker_version_id,
        observedAt: row.observed_at,
        current: row.current,
        behind: row.behind,
        failed: row.failed,
        unreported: row.unreported,
        empty: row.empty,
        absent: row.absent,
        total: row.total,
        retired: row.retired === 1,
      })),
      namespaces: namespaces.map((row): NamespaceSummary => ({
        namespaceId: row.namespace_id,
        scriptName: row.script_name,
        className: row.class_name,
        usesSqlite: row.uses_sqlite === 1,
        objectCount: row.object_count,
        storedObjectCount: row.stored_object_count,
        lastSweptAt: row.last_swept_at,
        retiredAt: row.retired_at,
      })),
      latestSweep: sweep,
      latestEnumeration: enumeration,
      recentFailures: recentFailures.map(toTrackedObject),
      recentEvents: recentEvents.map(toMigrationEvent),
    };
  }

  /**
   * The newest sweep receipt matching an optional filter, already mapped.
   *
   * Shared so the "latest receipt" and "latest receipt that enumerated
   * anything" reads cannot drift apart in their column list or mapping.
   */
  private readSweep(where = ""): SweepSummary | null {
    const row = this.storage.sql.exec<{
      id: number;
      started_at: number;
      finished_at: number;
      status: string;
      namespace_count: number;
      object_count: number;
      truncated_namespaces: string;
      error_message: string | null;
    }>(
      `SELECT id, started_at, finished_at, status, namespace_count, object_count,
              truncated_namespaces, error_message
         FROM inventory_sweeps ${where} ORDER BY id DESC LIMIT 1`,
    ).toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      namespaceCount: row.namespace_count,
      objectCount: row.object_count,
      truncatedNamespaces: parseJsonArray(row.truncated_namespaces).map(String),
      errorMessage: row.error_message,
    };
  }

  /**
   * The classes an operator may force, per region, with the size of each run.
   *
   * Only the classes that run the reporter, because those are the ones the API
   * Worker holds a `forceMigration` dispatcher for; a class outside that list
   * has no schema to move. Only live objects: forcing an `absent` identity or
   * one the latest sweep found `empty` would manufacture storage — the
   * opposite of what a migration pass is for.
   *
   * `behind`, `failed`, and `unreported` are carried beside the count because
   * they are why somebody forces a class. A row of zeroes is a class that needs
   * nothing done to it, which is worth being able to see before dispatching a
   * few hundred wake-ups at it.
   */
  forceableComponents(): ForceableComponent[] {
    return this.storage.sql.exec<{
      class_name: string;
      region: string;
      objects: number;
      behind: number;
      failed: number;
      unreported: number;
    }>(
      `${RESOLVED_OBJECTS}
       SELECT class_name, region, COUNT(*) AS objects,
              COALESCE(SUM(status = 'behind'), 0) AS behind,
              COALESCE(SUM(status = 'failed'), 0) AS failed,
              COALESCE(SUM(status = 'unreported'), 0) AS unreported
         FROM (SELECT o.class_name, o.status, ${RESOLVED_REGION} AS region
                 FROM resolved o
                WHERE o.status NOT IN ('empty', 'absent')
                  AND o.class_name IN (${REPORTING_CLASS_LIST}))
        WHERE region IS NOT NULL
        GROUP BY class_name, region
        ORDER BY class_name, region`,
    ).toArray().map((row) => ({
      className: row.class_name,
      region: row.region,
      objects: row.objects,
      behind: row.behind,
      failed: row.failed,
      unreported: row.unreported,
    }));
  }

  /**
   * The objects one run will send a command to.
   *
   * Two numbers come back beside the list and both describe what the list is
   * *not*. `matched` is every live object of the class before the cap, so a run
   * that stopped at `MIGRATION_RUN_TARGET_LIMIT` reports the size of the class
   * rather than the size of its own slice. `unroutable` is the objects whose
   * region could not be resolved from either a report or a script name: a
   * command picks a queue by region, so those have nowhere to go, and counting
   * them is the difference between a run that covered a class and one that
   * quietly skipped part of it.
   *
   * The order is least-recently-heard-from first, which is what makes running a
   * capped class again actually continue rather than re-pick the same slice: a
   * forced object reports as it wakes, so it sorts to the back of the next run.
   * `ORDER BY object_id` alone is stable and deterministic and would have left
   * the tail of a class larger than the cap permanently unreachable, while the
   * page told the operator to run it again.
   */
  migrationTargets(request: MigrationRunRequest): MigrationTargetSelection {
    // The class filter is here as well as in `MigrationRunRequestSchema`
    // because this is the last point before a command is built, and this method
    // is on a Durable Object's RPC surface — a future caller could reach it
    // without passing the schema. The schema is what gives a request a clear
    // refusal and is where that behaviour is tested; this clause is what keeps
    // the guarantee if something ever arrives another way. It is deliberately
    // not covered by a test: the enum makes the call unrepresentable, and
    // faking one would mean casting past the contract, which this repository's
    // own lint rule refuses.
    const regionFilter = request.region ?? null;
    const matched = this.storage.sql.exec<{ matched: number; unroutable: number }>(
      `${RESOLVED_OBJECTS}
       SELECT COUNT(*) AS matched,
              COALESCE(SUM(region IS NULL), 0) AS unroutable
         FROM (SELECT ${RESOLVED_REGION} AS region
                 FROM resolved o
                WHERE o.status NOT IN ('empty', 'absent')
                  AND o.class_name IN (${REPORTING_CLASS_LIST})
                  AND o.class_name = ?)
        WHERE ?2 IS NULL OR region IS NULL OR region = ?2`,
      request.className,
      regionFilter,
    ).toArray()[0] ?? { matched: 0, unroutable: 0 };

    const targets = this.storage.sql.exec<{
      object_id: string;
      object_name: string | null;
      region: string;
    }>(
      `${RESOLVED_OBJECTS}
       SELECT object_id, object_name, region FROM (
         SELECT o.object_id, o.object_name, o.last_reported_at,
                ${RESOLVED_REGION} AS region
          FROM resolved o
          WHERE o.status NOT IN ('empty', 'absent')
            AND o.class_name IN (${REPORTING_CLASS_LIST})
            AND o.class_name = ?
       )
        WHERE region IS NOT NULL AND (?2 IS NULL OR region = ?2)
        ORDER BY COALESCE(last_reported_at, 0), object_id
        LIMIT ?3`,
      request.className,
      regionFilter,
      MIGRATION_RUN_TARGET_LIMIT,
    ).toArray().map((row): MigrationTarget => ({
      objectId: row.object_id,
      objectName: row.object_name,
      region: row.region,
    }));

    const routable = matched.matched - matched.unroutable;
    return {
      targets,
      matched: matched.matched,
      unroutable: matched.unroutable,
      truncated: routable > targets.length,
    };
  }

  /**
   * Record what one run asked for and what it reached.
   *
   * Written after the dispatch rather than before it, so the row describes
   * messages the queue accepted rather than messages somebody intended to send.
   * A dispatch that threw halfway is recorded too, with `status: "failed"` and
   * the count that did land — a partial fan-out is the state an operator most
   * needs to see, and the alternative is a run that vanishes.
   */
  recordMigrationRun(run: MigrationRun): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO migration_runs (
           run_id, class_name, region, requested_by, requested_at, matched_count,
           dispatched_count, unroutable_count, truncated, status, error_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
        run.runId,
        run.className,
        run.region,
        run.requestedBy,
        run.requestedAt,
        run.matched,
        run.dispatched,
        run.unroutable,
        run.truncated ? 1 : 0,
        run.status,
        run.errorMessage,
      );
      this.storage.sql.exec(
        `DELETE FROM migration_runs WHERE id <= (SELECT MAX(id) - ? FROM migration_runs)`,
        MIGRATION_RUN_RETENTION,
      );
    });
  }

  listMigrationRuns(limit: number = MIGRATION_RUN_LIMIT): MigrationRun[] {
    return this.storage.sql.exec<{
      run_id: string;
      class_name: string;
      region: string | null;
      requested_by: string;
      requested_at: number;
      matched_count: number;
      dispatched_count: number;
      unroutable_count: number;
      truncated: number;
      status: string;
      error_message: string | null;
    }>(
      `SELECT run_id, class_name, region, requested_by, requested_at, matched_count,
              dispatched_count, unroutable_count, truncated, status, error_message
         FROM migration_runs ORDER BY id DESC LIMIT ?`,
      limit,
    ).toArray().map((row): MigrationRun => ({
      runId: row.run_id,
      className: row.class_name,
      region: isConfiguredRegion(row.region) ? row.region : null,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      matched: row.matched_count,
      dispatched: row.dispatched_count,
      unroutable: row.unroutable_count,
      truncated: row.truncated === 1,
      status: row.status === "failed" || row.status === "empty" ? row.status : "dispatched",
      errorMessage: row.error_message,
    }));
  }

  /**
   * Distinct component and script names, for the site's filter controls.
   *
   * Retired components stay in the list on purpose. Their objects are `absent`
   * rather than deleted, and filtering to them is exactly how an operator
   * confirms what a class took with it when it went — a name missing from this
   * list has already once been read as "no such objects exist", which is the
   * wrong answer twice over.
   */
  filterOptions(): { components: string[]; scripts: string[] } {
    const components = this.storage.sql.exec<{ component: string }>(
      `SELECT DISTINCT component FROM durable_objects
        WHERE component IS NOT NULL ORDER BY component`,
    ).toArray().map((row) => row.component);
    const scripts = this.storage.sql.exec<{ script_name: string }>(
      `SELECT DISTINCT script_name FROM durable_objects
        WHERE script_name IS NOT NULL ORDER BY script_name`,
    ).toArray().map((row) => row.script_name);
    return { components, scripts };
  }
}

/**
 * Retire every namespace the account no longer has, and mark its objects absent.
 *
 * The per-namespace absence pass in `recordSweep` iterates the namespaces the
 * sweep *returned*, so it structurally cannot see a namespace that is no longer
 * there. Deleting a Durable Object class from the Worker — or deleting the
 * script — makes its namespace vanish from the listing, and until this existed
 * every object in it kept the status it held on the day the class was removed.
 * A retired class that happened to be `behind` when it went stayed red forever,
 * and nothing an operator could do would clear it.
 *
 * Two guards decide whether this is allowed to run at all, and both matter more
 * than the update itself, because the failure mode here is retiring the fleet:
 *
 * - **The sweep must be `complete`.** `partial` means at least one namespace
 *   listing failed or was truncated, and `failed` means the namespace listing
 *   itself did not return — which arrives as `namespaces: []` and would
 *   otherwise read as "the account has no Durable Objects".
 * - **It must have found at least one namespace.** A `complete` sweep of an
 *   empty list is the same claim by a different route, and no plausible state
 *   of this account produces it. An account genuinely emptied of Durable
 *   Objects will not be reported by a tracker that is itself a Durable Object.
 *
 * The set difference is expressed through `last_sweep_id`, not through a list
 * of the ids this sweep returned. Durable Object SQL allows 100 bound
 * parameters per query and an account may hold up to 500 Durable Object
 * classes, so a `NOT IN (?, ?, …)` over the swept set is correct code that
 * stops working at a size this account could reach — and it fails inside the
 * sweep's `transactionSync`, so it would lose the entire sweep rather than just
 * the retirement. Stamping and comparing costs three parameters at any fleet
 * size, and it is the same mechanism object absence already uses.
 *
 * Objects are then matched through their namespace rather than by "not swept
 * this time", because an object that has reported but has never been swept has
 * no namespace yet, and it is not absent — it is unenumerated.
 */
function retireMissingNamespaces(
  sql: SqlStorage,
  sweep: InventorySweep,
  sweepId: number,
  now: number,
): void {
  if (sweep.status !== "complete" || sweep.namespaces.length === 0) return;

  sql.exec(
    `UPDATE durable_object_namespaces
        SET retired_at = ?
      WHERE retired_at IS NULL
        AND (last_sweep_id IS NULL OR last_sweep_id < ?)`,
    now,
    sweepId,
  );
  // Every object of a retired namespace, not only the ones retired just now.
  // `absent_since IS NULL` makes that idempotent, and it also catches an object
  // that arrived by report into a namespace that was already gone.
  sql.exec(
    `UPDATE durable_objects
        SET absent_since = ?
      WHERE absent_since IS NULL
        AND namespace_id IS NOT NULL
        AND namespace_id IN (SELECT namespace_id FROM durable_object_namespaces
                              WHERE retired_at IS NOT NULL)`,
    now,
  );
}

/**
 * Derived from the schema rather than hand-written.
 *
 * This guard is the third party to the agreement the CTE's comment describes,
 * and it fails in the quietest possible way: a status the guard does not know
 * is mapped to `unreported`, so a new status shows up as a wrong count with no
 * error anywhere. Reading the enum's own options makes that drift impossible.
 */
function isObjectStatus(value: string): value is ObjectStatus {
  return (ObjectStatusSchema.options as readonly string[]).includes(value);
}

function toTrackedObject(row: ObjectRow): TrackedObject {
  return {
    objectId: row.object_id,
    objectName: row.object_name,
    namespaceId: row.namespace_id,
    scriptName: row.script_name,
    className: row.class_name,
    component: row.component,
    region: row.region,
    appEnv: row.app_env,
    workerVersionId: row.worker_version_id,
    // has_stored_data remains the immutable latest inventory fact. A report
    // strictly newer than that observation is stronger proof of current
    // storage, including for report-only rows that have never been swept.
    hasStoredData: row.has_stored_data === 1 || (
      row.last_reported_at !== null
      && (row.last_swept_at === null || row.last_reported_at > row.last_swept_at)
    ),
    schemaVersion: row.schema_version,
    componentLatestVersion: row.component_latest_version,
    status: isObjectStatus(row.status) ? row.status : "unreported",
    failureMessage: row.failure_message,
    failureVersion: row.failure_version,
    firstSeenAt: row.first_seen_at,
    lastSweptAt: row.last_swept_at,
    lastReportedAt: row.last_reported_at,
    lastFailedAt: row.last_failed_at,
    absentSince: row.absent_since,
    namespaceRetiredAt: row.namespace_retired_at,
  };
}

function toMigrationEvent(row: EventRow): MigrationEvent {
  return {
    id: row.id,
    objectId: row.object_id,
    objectName: row.object_name,
    className: row.class_name,
    component: row.component,
    region: row.region,
    appEnv: row.app_env,
    workerVersionId: row.worker_version_id,
    status: row.status,
    schemaVersion: row.schema_version,
    latestVersion: row.latest_version,
    appliedVersions: parseJsonArray(row.applied_versions)
      .filter((value): value is number => typeof value === "number"),
    failureMessage: row.failure_message,
    failureVersion: row.failure_version,
    occurredAt: row.occurred_at,
  };
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

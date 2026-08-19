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
import type { DurableObjectMigrationReport } from "@avalon/contracts/durable-object-migrations";
import { applyRegistrySchema, REGISTRY_SCHEMA_VERSION } from "./schema";
import type { Env } from "./env";
import type {
  ComponentSummary,
  InventorySweep,
  MigrationEvent,
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
 * The derived status, computed in SQL so that filtering, counting, and paging
 * all agree on one definition. Recomputing it in TypeScript would mean the
 * status column and the status filter could drift apart without a test noticing.
 */
const RESOLVED_OBJECTS = `
  WITH resolved AS (
    SELECT
      o.*,
      c.latest_version AS component_latest_version,
      CASE
        WHEN o.absent_since IS NOT NULL THEN 'absent'
        WHEN o.report_status = 'failed' THEN 'failed'
        WHEN o.report_status IS NULL THEN 'unreported'
        WHEN c.latest_version IS NOT NULL
          AND o.schema_version IS NOT NULL
          AND o.schema_version < c.latest_version THEN 'behind'
        ELSE 'current'
      END AS status
    FROM durable_objects o
    LEFT JOIN component_versions c
      ON c.component = o.component AND c.region = o.region
  )
`;

const OBJECT_COLUMNS = `
  object_id, object_name, namespace_id, script_name, class_name, component,
  region, app_env, worker_version_id, has_stored_data, schema_version,
  component_latest_version, status, failure_message, failure_version,
  first_seen_at, last_swept_at, last_reported_at, last_failed_at, absent_since
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

  /** Record one Durable Object migration report. Idempotent per wake, not per call. */
  recordReport(report: DurableObjectMigrationReport): void {
    const recordedAt = Date.now();
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;

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
        report.component,
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
           absent_since = NULL`,
        report.objectId,
        report.objectName,
        report.className,
        report.component,
        report.region,
        report.appEnv,
        report.workerVersionId,
        report.status,
        report.schemaVersion,
        report.failure?.message ?? null,
        report.failure?.version ?? null,
        recordedAt,
        recordedAt,
        failed ? recordedAt : null,
      );

      sql.exec(
        `INSERT INTO migration_events (
           object_id, object_name, class_name, component, region, app_env,
           worker_version_id, status, schema_version, latest_version,
           applied_versions, failure_message, failure_version, occurred_at,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        report.objectId,
        report.objectName,
        report.className,
        report.component,
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

      sql.exec(
        `DELETE FROM migration_events WHERE id <= (
           SELECT MAX(id) - ? FROM migration_events
         )`,
        MIGRATION_EVENT_RETENTION,
      );
    });
  }

  /**
   * Fold one inventory sweep into the registry.
   *
   * Absence is decided per namespace, and only for a namespace whose listing ran
   * to completion. A truncated or failed listing says nothing about the objects
   * it did not reach, and marking those absent would erase exactly the objects a
   * large namespace is most likely to hide.
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
        sql.exec(
          `INSERT INTO durable_object_namespaces
             (namespace_id, script_name, class_name, uses_sqlite, object_count,
              first_seen_at, last_swept_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace_id) DO UPDATE SET
             script_name = excluded.script_name,
             class_name = excluded.class_name,
             uses_sqlite = excluded.uses_sqlite,
             object_count = excluded.object_count,
             last_swept_at = excluded.last_swept_at`,
          namespace.namespaceId,
          namespace.scriptName,
          namespace.className,
          namespace.usesSqlite ? 1 : 0,
          namespace.objects?.length ?? 0,
          now,
          now,
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
            now,
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
           ELSE 4
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
      total: number;
    }>(
      `${RESOLVED_OBJECTS}
       SELECT c.component, c.region, c.class_name, c.latest_version,
              c.worker_version_id, c.observed_at,
              COALESCE(SUM(r.status = 'current'), 0) AS current,
              COALESCE(SUM(r.status = 'behind'), 0) AS behind,
              COALESCE(SUM(r.status = 'failed'), 0) AS failed,
              COALESCE(SUM(r.status = 'unreported'), 0) AS unreported,
              COALESCE(COUNT(r.object_id), 0) AS total
         FROM component_versions c
         LEFT JOIN resolved r
           ON r.component = c.component AND r.region = c.region AND r.status != 'absent'
        GROUP BY c.component, c.region
        ORDER BY failed DESC, behind DESC, c.component, c.region`,
    ).toArray();

    const namespaces = sql.exec<{
      namespace_id: string;
      script_name: string;
      class_name: string;
      uses_sqlite: number;
      object_count: number;
      last_swept_at: number;
    }>(
      `SELECT namespace_id, script_name, class_name, uses_sqlite, object_count, last_swept_at
         FROM durable_object_namespaces ORDER BY script_name, class_name`,
    ).toArray();

    const sweep = sql.exec<{
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
         FROM inventory_sweeps ORDER BY id DESC LIMIT 1`,
    ).toArray()[0];

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
        total: row.total,
      })),
      namespaces: namespaces.map((row): NamespaceSummary => ({
        namespaceId: row.namespace_id,
        scriptName: row.script_name,
        className: row.class_name,
        usesSqlite: row.uses_sqlite === 1,
        objectCount: row.object_count,
        lastSweptAt: row.last_swept_at,
      })),
      latestSweep: sweep
        ? {
            id: sweep.id,
            startedAt: sweep.started_at,
            finishedAt: sweep.finished_at,
            status: sweep.status,
            namespaceCount: sweep.namespace_count,
            objectCount: sweep.object_count,
            truncatedNamespaces: parseJsonArray(sweep.truncated_namespaces).map(String),
            errorMessage: sweep.error_message,
          } satisfies SweepSummary
        : null,
      recentFailures: recentFailures.map(toTrackedObject),
      recentEvents: recentEvents.map(toMigrationEvent),
    };
  }

  /** Distinct component and script names, for the site's filter controls. */
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

function isObjectStatus(value: string): value is ObjectStatus {
  return value === "failed" || value === "behind" || value === "unreported"
    || value === "current" || value === "absent";
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
    hasStoredData: row.has_stored_data === 1,
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

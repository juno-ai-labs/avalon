/**
 * How a Durable Object tells the migration tracker what schema it is on.
 *
 * Every object in this Worker runs its migration history in its constructor and
 * then never mentions it again. That is fine until the day a deploy half-lands:
 * some objects are on the new version, some are still hibernating on the old
 * one, and one is throwing `component_schema_hash_mismatch` on every wake with
 * nowhere to say so. Nothing in the account can answer "which objects are
 * behind, and which are broken" — a Durable Object namespace can be enumerated
 * for IDs, but an ID does not carry a schema version.
 *
 * So the object says it itself, on the one occasion it knows the answer. This
 * module wraps the migration call, and afterwards decides whether the tracker
 * already knows what it would be told.
 *
 * The report goes onto a Queue rather than a service-binding RPC. Every object
 * in the fleet converges on one registry object, and a fan-out — the
 * `WorkspaceScheduler` sweeping every workspace's due work, a seed or migration
 * pass walking the fleet — wakes hundreds of them at once. A Durable Object is single-threaded
 * with a soft ceiling near a thousand requests a second, so a synchronous hop
 * would make each reporter wait behind every other one, on a monitor nobody is
 * waiting for. `docs/choosing-queues-or-rpc.md` has the full reasoning.
 *
 * Three rules keep the traffic bounded and the object safe:
 *
 * - **Reporting never breaks the object.** A queue that is unbound or refusing
 *   sends must leave the object exactly as it would have been. Every failure
 *   here is swallowed after being logged.
 * - **A wake that changes nothing sends nothing.** The object keeps its own
 *   one-row report ledger, so the common case — an object waking on the version
 *   it last reported — costs one local SQL read and no subrequest.
 * - **A migration failure always reports**, before the constructor rethrows.
 *   That is the case the tracker exists for. The queue's own retry and
 *   dead-letter queue carry it from there, which matters most exactly here: an
 *   object that fails construction may not be woken again for a long time.
 *
 * The heartbeat covers the third state: an object that has been reported and
 * has not migrated since. Without it, a tracker whose store was rebuilt would
 * stay blind to every object that never migrates again. With it, the inventory
 * sweep's "seen but never reported" set drains on its own within a day.
 */
import {
  DurableObjectMigrationReportSchema,
  isOpaqueDurableObjectName,
  type DurableObjectMigrationFailure,
  type DurableObjectMigrationReport,
  type DurableObjectMigrationStatus,
} from "@avalon/contracts/durable-object-migrations";
import type { Env } from "../env";
import { uuidV7 } from "../lib/uuid-v7";
import { logStructuredEvent } from "../observability/logger";

/**
 * A report is re-sent this long after the last accepted one even when nothing
 * about the object changed. Long enough that a fleet of idle objects is not a
 * write load; short enough that a rebuilt tracker converges overnight.
 */
const REPORT_HEARTBEAT_MS = 24 * 60 * 60 * 1_000;

/**
 * Created here rather than in a migration. The runner already bootstraps
 * `_sql_schema_migrations` this way, and for the same reason: a table that
 * records the migration process cannot be a step inside the history it records
 * — it has to exist for every object, including one whose own history is the
 * thing that just failed.
 */
const REPORT_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS _migration_report_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reported_version INTEGER NOT NULL,
    reported_status TEXT NOT NULL,
    worker_version_id TEXT NOT NULL,
    reported_at INTEGER NOT NULL
  ) STRICT
`;

// A type alias rather than an interface: `sql.exec<T>` requires an implicit
// index signature, which only an alias has.
type ReportState = {
  reported_version: number;
  reported_status: string;
  worker_version_id: string;
  reported_at: number;
};

export interface DurableObjectMigrationReportContext {
  state: DurableObjectState;
  env: Env;
  /** The migration runner's component key for this class. */
  component: string;
  /** The class name as bound in the regional Wrangler file. */
  className: string;
  /** The highest version the running build ships for this component. */
  latestVersion: number;
}

/**
 * Run a Durable Object's migrations and tell the tracker what happened.
 *
 * `apply` is the object's existing migration call, unchanged and still
 * synchronous — it must stay inside the constructor's synchronous prologue so
 * that a broken schema keeps failing construction rather than being observed
 * half-applied. Its value is returned untouched, so a call site can keep
 * building whatever the migration produced.
 */
export function withMigrationReport<T>(
  context: DurableObjectMigrationReportContext,
  apply: () => T,
): T {
  // Read before, not after: the runner returns the versions it applied, but one
  // of the five call sites hands that return value to a constructor instead, so
  // the ledger is the only source every site shares.
  const versionBefore = safeCurrentVersion(context.state.storage);
  let applied: T;
  try {
    applied = apply();
  } catch (error) {
    reportMigrationFailure(context, error);
    throw error;
  }
  reportMigrationSuccess(context, versionBefore);
  return applied;
}

function reportMigrationFailure(
  context: DurableObjectMigrationReportContext,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  send(context, {
    status: "failed",
    schemaVersion: safeCurrentVersion(context.state.storage),
    appliedVersions: [],
    failure: {
      message: message.slice(0, 1_000),
      version: failedVersionFrom(message),
    },
  });
}

function reportMigrationSuccess(
  context: DurableObjectMigrationReportContext,
  versionBefore: number,
): void {
  let currentVersion: number;
  let appliedVersions: number[];
  let previous: ReportState | null;
  try {
    currentVersion = currentVersionOf(context.state.storage);
    appliedVersions = versionBefore < currentVersion
      ? versionsAbove(context.state.storage, versionBefore)
      : [];
    previous = readReportState(context.state.storage);
  } catch (error) {
    // The ledger is the object's own table and this read runs on every wake, so
    // a failure here is a defect worth seeing. It is still not worth failing
    // construction over: the object's schema is already applied.
    logReportProblem(context, "migration_report_state_unreadable", error);
    return;
  }

  // `applied` versus `current` is the difference between "this wake moved the
  // object" and "this wake only told you where it already was". The tracker
  // keeps the distinction in its event log, which is what makes a deploy's
  // rollout visible as it happens rather than as a final tally.
  const status: DurableObjectMigrationStatus = appliedVersions.length > 0 ? "applied" : "current";
  const workerVersionId = workerVersionOf(context.env);
  const unchanged = status === "current"
    && previous !== null
    && previous.reported_status !== "failed"
    && previous.reported_version === currentVersion
    && previous.worker_version_id === workerVersionId
    && Date.now() - previous.reported_at < REPORT_HEARTBEAT_MS;
  if (unchanged) return;

  send(
    context,
    { status, schemaVersion: currentVersion, appliedVersions, failure: null },
    () => writeReportState(context.state.storage, currentVersion, status, workerVersionId),
  );
}

interface ReportOutcome {
  status: DurableObjectMigrationStatus;
  schemaVersion: number;
  appliedVersions: readonly number[];
  failure: DurableObjectMigrationFailure | null;
}

function send(
  context: DurableObjectMigrationReportContext,
  outcome: ReportOutcome,
  onAccepted?: () => void,
): void {
  const queue = context.env.MIGRATION_REPORT_QUEUE;
  // Unbound is the normal state in local development and in every test that
  // builds a partial `Env`. It is not an error, and it must not become one.
  if (!queue) return;

  const report = buildReport(context, outcome);
  if (!report) return;

  context.state.waitUntil((async () => {
    try {
      await queue.send(report);
      // `send` resolving means the message was accepted by the queue, not that
      // the tracker recorded it. That is the right thing to record here: the
      // queue owns delivery from this point, with retries and a dead-letter
      // queue, and neither needs this object to be alive.
      onAccepted?.();
    } catch (error) {
      logReportProblem(context, "migration_report_enqueue_failed", error);
    }
  })());
}

function buildReport(
  context: DurableObjectMigrationReportContext,
  outcome: ReportOutcome,
): DurableObjectMigrationReport | null {
  const name = context.state.id.name;
  const candidate = {
    // Fresh per send. Queues deliver at least once, and this is what lets the
    // consumer collapse a redelivery without collapsing two real reports.
    reportId: uuidV7(),
    objectId: context.state.id.toString(),
    // A name that is not opaque is dropped rather than sent. The report crosses
    // a regional boundary and the guard is what makes that crossing defensible;
    // losing the name costs an operator one lookup, while sending an unreviewed
    // one would be a residency change nobody signed off on.
    objectName: typeof name === "string" && isOpaqueDurableObjectName(name) ? name : null,
    className: context.className,
    component: context.component,
    region: context.env.AVALON_REGION,
    appEnv: context.env.APP_ENV,
    workerVersionId: workerVersionOf(context.env),
    status: outcome.status,
    schemaVersion: outcome.schemaVersion,
    latestVersion: context.latestVersion,
    appliedVersions: [...outcome.appliedVersions],
    failure: outcome.failure,
    occurredAt: Date.now(),
  };

  const parsed = DurableObjectMigrationReportSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logStructuredEvent(context.env, "error", "migration_report_invalid", {
    message: "migration_report_invalid the report was refused by its own contract",
    component: context.component,
    class_name: context.className,
    issues: parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"),
  });
  return null;
}

function workerVersionOf(env: Env): string {
  const version = env.APP_VERSION;
  return typeof version === "string" && version.length > 0 ? version : "unknown";
}

/**
 * Read the object's applied schema version from the runner's own ledger. The
 * runner writes one row per applied migration, so the maximum is the version
 * the object is on; no rows means the very first migration has not landed.
 */
function currentVersionOf(storage: DurableObjectStorage): number {
  const row = storage.sql.exec<{ version: number | null }>(
    `SELECT MAX(version) AS version FROM _sql_schema_migrations`,
  ).toArray()[0];
  return row?.version ?? 0;
}

/** The ledger rows this wake added, in the order the runner applied them. */
function versionsAbove(storage: DurableObjectStorage, version: number): number[] {
  return storage.sql.exec<{ version: number }>(
    `SELECT version FROM _sql_schema_migrations WHERE version > ? ORDER BY version`,
    version,
  ).toArray().map((row) => row.version);
}

/**
 * The failure path runs after a rollback, and on an object whose very first
 * migration may have failed — in which case the ledger table does not exist.
 * An unreadable version is reported as `0` rather than suppressing the report,
 * because the failure itself is the thing worth knowing.
 */
function safeCurrentVersion(storage: DurableObjectStorage): number {
  try {
    return currentVersionOf(storage);
  } catch {
    return 0;
  }
}

/**
 * Every error the runner raises about a specific migration ends in
 * `:<version>`. Pulling it out gives the tracker the version that broke rather
 * than only the version the object is stuck below.
 */
function failedVersionFrom(message: string): number | null {
  const match = /_schema_[a-z_]+:(\d{1,9})$/u.exec(message);
  if (!match?.[1]) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function readReportState(storage: DurableObjectStorage): ReportState | null {
  storage.sql.exec(REPORT_STATE_TABLE);
  return storage.sql.exec<ReportState>(
    `SELECT reported_version, reported_status, worker_version_id, reported_at
       FROM _migration_report_state WHERE id = 1`,
  ).toArray()[0] ?? null;
}

/**
 * Written only after the tracker accepts the report, so a delivery that failed
 * is retried on the next wake instead of being recorded as delivered.
 */
function writeReportState(
  storage: DurableObjectStorage,
  version: number,
  status: DurableObjectMigrationStatus,
  workerVersionId: string,
): void {
  storage.sql.exec(REPORT_STATE_TABLE);
  storage.sql.exec(
    `INSERT INTO _migration_report_state
       (id, reported_version, reported_status, worker_version_id, reported_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       reported_version = excluded.reported_version,
       reported_status = excluded.reported_status,
       worker_version_id = excluded.worker_version_id,
       reported_at = excluded.reported_at`,
    version,
    status,
    workerVersionId,
    Date.now(),
  );
}

function logReportProblem(
  context: DurableObjectMigrationReportContext,
  event: string,
  error: unknown,
): void {
  logStructuredEvent(context.env, "warn", event, {
    message: `${event} ${error instanceof Error ? error.message : String(error)}`,
    component: context.component,
    class_name: context.className,
  });
}

/** The highest version a migration list ships, for the report's `latestVersion`. */
export function latestMigrationVersion(
  migrations: readonly { version: number }[],
): number {
  return migrations.at(-1)?.version ?? 0;
}

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
 * in the fleet converges on one registry object, and a fan-out — a seed or a
 * migration pass walking the fleet, a deploy that wakes every workspace at
 * once — wakes hundreds of them together. A Durable Object is single-threaded
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
 * - **A migration failure always reports**, and the send is *awaited* before the
 *   constructor rethrows. That is the case the tracker exists for, and the one
 *   case where fire-and-forget does not work: the throw breaks the object's
 *   input gate, and workerd aborts the object's pending work along with it — so
 *   a report handed to `waitUntil` here is entered and never delivered. Holding
 *   the throw behind the send costs one queue round trip on a wake that was
 *   already failing. The queue's own retry and dead-letter queue carry it from
 *   there, which matters most exactly here: an object that fails construction
 *   may not be woken again for a long time.
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
} from "@rally/contracts/durable-object-migrations";
import type { Env } from "../env";
import { uuidV7 } from "../lib/uuid-v7";
import { logStructuredEvent } from "../observability/logger";

/**
 * A report is re-sent this long after the last accepted one even when nothing
 * about the object changed. Long enough that a fleet of idle objects is not a
 * write load; short enough that a rebuilt tracker converges overnight.
 *
 * It is also the other half of the tracker's hourly inventory sweep. The sweep
 * discovers objects but cannot learn their version; this heartbeat is what
 * drains the `unreported` set it produces, so the two together bound how long an
 * object can sit unexplained at roughly a day.
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
export async function withMigrationReport<T>(
  context: DurableObjectMigrationReportContext,
  apply: () => T,
): Promise<T> {
  // Read before, not after: the runner returns the versions it applied, but one
  // of the five call sites hands that return value to a constructor instead, so
  // the ledger is the only source every site shares.
  const versionBefore = safeCurrentVersion(context.state.storage);
  let applied: T;
  try {
    // Still the first thing that runs, with no `await` in front of it, so the
    // migration stays inside the caller's synchronous prologue exactly as
    // before this function became async.
    applied = apply();
  } catch (error) {
    // Awaited rather than left to `waitUntil` — see the third rule above. The
    // send swallows its own errors, so this can only delay the throw below,
    // never replace it.
    await reportMigrationFailure(context, error);
    throw error;
  }
  reportMigrationSuccess(context, versionBefore);
  return applied;
}

function reportMigrationFailure(
  context: DurableObjectMigrationReportContext,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const schemaVersion = safeCurrentVersion(context.state.storage);
  const workerVersionId = workerVersionOf(context.env);
  const deliver = prepareDelivery(
    context,
    {
      status: "failed",
      schemaVersion,
      appliedVersions: [],
      failure: {
        message: message.slice(0, 1_000),
        version: failedVersionFrom(message),
      },
    },
    // The failure goes into the ledger too. Without it the ledger still
    // describes the last *successful* report, so a build that is rolled back to
    // exactly the one the object last reported looks unchanged on the next wake
    // and says nothing — leaving the tracker showing a broken object that has
    // already recovered, until the heartbeat expires a day later. It is also
    // what makes the `reported_status !== "failed"` test above reachable.
    () => writeReportState(context.state.storage, schemaVersion, "failed", workerVersionId),
  );
  return deliver ? deliver().then(() => undefined) : Promise.resolve();
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

  const deliver = prepareDelivery(
    context,
    { status, schemaVersion: currentVersion, appliedVersions, failure: null },
    () => writeReportState(context.state.storage, currentVersion, status, workerVersionId),
  );
  // Fire and forget: a successful migration leaves a healthy object that stays
  // alive to finish this, and nothing is waiting on the report.
  if (deliver) context.state.waitUntil(deliver());
}

/**
 * What one forced migration did, as the queue consumer reads it back.
 *
 * `docs/durable-object-migration-tracking.md` owns the flow this belongs to: an
 * operator picks a class on the tracker, the tracker sends one message per
 * object, and the region's Worker calls `forceMigration` on each. This is the
 * value that call returns, and it is the reason that leg is RPC rather than a
 * second queue — the consumer branches on it.
 *
 * Note what the two version fields can and cannot say together. Both are read
 * inside the object's own isolate, and this value is only produced once that
 * object's migration pass has succeeded, so `schemaVersion` and `latestVersion`
 * are equal by construction. Comparing them to each other answers nothing;
 * comparing `schemaVersion` against the *consumer's* head is what reveals an
 * object still awake on an older build. See `migrationShortfall` in
 * `queues/migration-command-consumer.ts`.
 */
export interface ForcedMigrationOutcome {
  objectId: string;
  objectName: string | null;
  component: string;
  className: string;
  /** The version the object is on now that its constructor's pass has finished. */
  schemaVersion: number;
  /** The highest version the running build ships, so a shortfall is visible. */
  latestVersion: number;
  /** Whether the confirming report was accepted by the queue. */
  reported: boolean;
}

/**
 * Report an object's schema state because an operator asked, not because it
 * changed.
 *
 * The dedupe in `reportMigrationSuccess` exists so that an ordinary wake on an
 * unchanged version costs nothing, and it is exactly wrong here: an operator
 * forcing a class is asking to be told where every object stands, and the
 * objects that were already current are the ones whose silence is least
 * informative. So this sends unconditionally.
 *
 * It reports `current` with no applied versions because that is what this call
 * did — the migration itself runs in the constructor, and when it applied
 * anything the constructor's own report already said so, carrying the version
 * list. This one is the receipt that the object was reached.
 *
 * Awaited rather than fired into `waitUntil`: the caller is a queue consumer
 * that reports the outcome, and a receipt nobody waited for is a receipt that
 * can be lost to the invocation ending. It still cannot throw — reporting never
 * breaks the object — so a refusing queue comes back as `reported: false`.
 */
export async function reportForcedMigration(
  context: DurableObjectMigrationReportContext,
  objectName: string | null,
): Promise<ForcedMigrationOutcome> {
  const schemaVersion = safeCurrentVersion(context.state.storage);
  const workerVersionId = workerVersionOf(context.env);
  const deliver = prepareDelivery(
    context,
    { status: "current", schemaVersion, appliedVersions: [], failure: null },
    () => writeReportState(context.state.storage, schemaVersion, "current", workerVersionId),
  );
  return {
    objectId: context.state.id.toString(),
    objectName,
    component: context.component,
    className: context.className,
    schemaVersion,
    latestVersion: context.latestVersion,
    // An unbound queue is the normal state in local development and in tests,
    // and it is not a failure of the forced migration — the object still woke
    // and still ran its schema. The consumer logs the difference.
    reported: deliver === null ? false : await deliver(),
  };
}

interface ReportOutcome {
  status: DurableObjectMigrationStatus;
  schemaVersion: number;
  appliedVersions: readonly number[];
  failure: DurableObjectMigrationFailure | null;
}

/**
 * Decide whether there is a report to deliver, and if so return the delivery.
 *
 * Both paths ask this one question, and neither touches the platform when the
 * answer is no: a `null` here means nothing is sent, nothing is awaited, and
 * `waitUntil` is never called. The delivery itself never rejects — reporting
 * must leave the object exactly as it would have been, so every failure is
 * logged and swallowed.
 */
function prepareDelivery(
  context: DurableObjectMigrationReportContext,
  outcome: ReportOutcome,
  onAccepted?: () => void,
): (() => Promise<boolean>) | null {
  const queue = context.env.MIGRATION_REPORT_QUEUE;
  // Unbound is the normal state in local development and in every test that
  // builds a partial `Env`. It is not an error, and it must not become one.
  if (!queue) return null;

  const report = buildReport(context, outcome);
  if (!report) return null;

  return async () => {
    try {
      await queue.send(report);
      // `send` resolving means the message was accepted by the queue, not that
      // the tracker recorded it. That is the right thing to record here: the
      // queue owns delivery from this point, with retries and a dead-letter
      // queue, and neither needs this object to be alive.
      onAccepted?.();
      return true;
    } catch (error) {
      logReportProblem(context, "migration_report_enqueue_failed", error);
      return false;
    }
  };
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
 * Written only after the queue accepts the report, so a delivery that failed is
 * retried on the next wake instead of being recorded as delivered. Every
 * outcome is recorded, `failed` included: the dedupe check reads this row to
 * decide whether the tracker already knows, and it can only be right if the row
 * describes the last report actually sent.
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

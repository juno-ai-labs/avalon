import { RegionSchema } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
/**
 * The shapes the registry Durable Object returns and the queries it accepts.
 *
 * These stay separate from `@rally/contracts/durable-object-migrations`, which
 * owns the report contract crossing the Worker boundary. This file is internal
 * to the tracker: the app parses a query string into `ObjectQuery`, the registry
 * answers, and the views render it.
 */
import { z } from "zod";

/**
 * What the tracker is able to say about one object, in the order an operator
 * cares about it.
 *
 * - `failed` — its last report was a migration failure. It is broken now.
 * - `behind` — it is running a schema version below the highest this component
 *   has been seen on. Normal for minutes after a deploy, a problem after hours.
 * - `unreported` — an inventory sweep found it, but it has not woken since the
 *   tracker existed, so nothing knows its version.
 * - `current` — it is on the highest version its component has been seen on.
 * - `not_reporting` — its class does not run the migration reporter at all, so
 *   silence from it means nothing. The sweep enumerates every Durable Object in
 *   the account, including this Worker's own registry object and the API's
 *   container class; without this they would sit in `unreported` forever and
 *   make that count useless for spotting a genuinely stranded object.
 * - `empty` — Cloudflare still enumerates the object ID, but the latest sweep
 *   says it has no stored data. It is historical inventory, not a live object
 *   a migration run may wake.
 * - `absent` — it was in a previous sweep and is not in the latest one, either
 *   because the object itself was deleted or because its whole class was.
 */
export const ObjectStatusSchema = z.enum([
  "failed",
  "behind",
  "unreported",
  "current",
  "not_reporting",
  "empty",
  "absent",
]);
export type ObjectStatus = z.infer<typeof ObjectStatusSchema>;

export const ObjectQuerySchema = z.object({
  status: ObjectStatusSchema.nullish(),
  component: z.string().max(64).nullish(),
  region: RegionSchema.nullish(),
  scriptName: z.string().max(128).nullish(),
  /** Matches the object ID or name as a prefix; both are what an operator holds. */
  search: z.string().max(128).nullish(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});
export type ObjectQuery = z.infer<typeof ObjectQuerySchema>;

export interface TrackedObject {
  objectId: string;
  objectName: string | null;
  namespaceId: string | null;
  scriptName: string | null;
  className: string | null;
  component: string | null;
  region: string | null;
  appEnv: string | null;
  workerVersionId: string | null;
  hasStoredData: boolean;
  schemaVersion: number | null;
  /** The head this object's component has been seen on, or null if unknown. */
  componentLatestVersion: number | null;
  status: ObjectStatus;
  failureMessage: string | null;
  failureVersion: number | null;
  firstSeenAt: number;
  lastSweptAt: number | null;
  lastReportedAt: number | null;
  lastFailedAt: number | null;
  absentSince: number | null;
  /**
   * When this object's namespace was retired, or null. It is what turns an
   * unexplained `absent` on the detail page into "the class is gone" — the
   * overview tables say so, and without this the one page an operator opens
   * after clicking through does not.
   */
  namespaceRetiredAt: number | null;
}

export interface TrackedObjectPage {
  objects: TrackedObject[];
  total: number;
  limit: number;
  offset: number;
}

export interface MigrationEvent {
  id: number;
  objectId: string;
  objectName: string | null;
  className: string;
  component: string;
  region: string;
  appEnv: string;
  workerVersionId: string;
  status: string;
  schemaVersion: number;
  latestVersion: number;
  appliedVersions: number[];
  failureMessage: string | null;
  failureVersion: number | null;
  occurredAt: number;
}

export interface ComponentSummary {
  component: string;
  region: string;
  className: string;
  latestVersion: number;
  workerVersionId: string;
  observedAt: number;
  current: number;
  behind: number;
  failed: number;
  unreported: number;
  empty: number;
  absent: number;
  /** Live objects only; `empty` and `absent` are reported beside it. */
  total: number;
  /**
   * The namespaces this component's objects live in are all retired — the class
   * was deleted from the Worker that serves this region. Not the same as every
   * object being absent, which is ordinary for a class whose instances are
   * created on demand, and per region rather than per class: the same classes
   * are deployed in both, and deleting one from a single region retires only
   * that region's component.
   */
  retired: boolean;
}

export interface SweepSummary {
  id: number;
  startedAt: number;
  finishedAt: number;
  status: string;
  namespaceCount: number;
  objectCount: number;
  truncatedNamespaces: string[];
  errorMessage: string | null;
}

export interface NamespaceSummary {
  namespaceId: string;
  scriptName: string;
  className: string;
  usesSqlite: boolean;
  /** Every ID in the latest successful listing, including identities with no stored data. */
  objectCount: number;
  /** IDs in that same listing whose `hasStoredData` flag is true. */
  storedObjectCount: number;
  lastSweptAt: number;
  /** When a completed sweep first failed to find this namespace, or null. */
  retiredAt: number | null;
}

export interface RegistryOverview {
  generatedAt: number;
  registrySchemaVersion: number;
  totals: Record<ObjectStatus, number> & { all: number };
  components: ComponentSummary[];
  namespaces: NamespaceSummary[];
  latestSweep: SweepSummary | null;
  /**
   * The most recent sweep that actually enumerated something — anything but
   * `failed`. Staleness is measured against this rather than `latestSweep`,
   * because a failing sweep still writes a receipt with a fresh timestamp and
   * would otherwise keep the stale banner suppressed through an outage of any
   * length.
   */
  latestEnumeration: SweepSummary | null;
  recentFailures: TrackedObject[];
  recentEvents: MigrationEvent[];
}

export interface ObjectDetail {
  object: TrackedObject;
  events: MigrationEvent[];
}

/** What one inventory sweep found, handed to the registry in a single call. */
export interface InventorySweep {
  startedAt: number;
  finishedAt: number;
  status: "complete" | "partial" | "failed";
  namespaces: InventoryNamespace[];
  /** Namespaces whose object listing hit the page cap and was cut short. */
  truncatedNamespaces: string[];
  errorMessage: string | null;
}

export interface InventoryNamespace {
  namespaceId: string;
  scriptName: string;
  className: string;
  usesSqlite: boolean;
  /** Null when the listing for this namespace failed or was truncated. */
  objects: InventoryObject[] | null;
}

export interface InventoryObject {
  objectId: string;
  hasStoredData: boolean;
  /** When the object-list page carrying this fact finished loading. */
  observedAt?: number;
}

/**
 * What an operator asked for on the **Force a migration** page.
 *
 * The class is the unit because a migration belongs to a class: one schema
 * list, one component key, one head version. The region is optional and means
 * "both" when absent, which is the ordinary case — the same classes are
 * deployed in both Workers and a schema change lands in both.
 */
/**
 * The Durable Object classes that run `withMigrationReport`.
 *
 * The sweep enumerates every namespace in the account, which is more than the
 * classes this Worker observes: the tracker's own `MigrationRegistry` is created
 * by the sweep that discovers it, and `CrashSymbolicatorContainer` is a
 * container rather than a migrated object. Neither will ever report, so without
 * this list they accumulate in `unreported` forever and make that count
 * worthless for its actual job — spotting an API object that should have
 * reported and has not.
 *
 * Keep it in step with the call sites of `withMigrationReport` in `apps/api`. A
 * class missing from here is never swept at all; a class listed here whose
 * objects never wake sits in `unreported` forever. `WorkspaceScheduler`, and
 * later `WorkstreamDO`, `SpaceDO` and `SidekickDO` (once `AutomationDO`), were
 * removed when their classes were deleted: their objects can no longer report,
 * so leaving them here would have parked every one of them in `unreported` —
 * the exact count this list exists to keep meaningful.
 */
export const REPORTING_CLASSES = [
  "AgentLoopDO",
  "WorkspaceDO",
] as const;

export const MigrationRunRequestSchema = z.object({
  /**
   * Only a class the API Worker can actually migrate.
   *
   * An enum rather than an identifier pattern, because the page's own list of
   * classes is a rendering of what is forceable, not a constraint on it: a JSON
   * caller or a hand-edited form reaches this schema directly. A class the
   * consumer holds no dispatcher for would otherwise be fanned out, retried five
   * times per object, and dead-lettered — while the run row recorded it as
   * dispatched. That spends an operator's afternoon and, worse, fills the
   * dead-letter queue this platform relies on as its monitoring signal with
   * messages that were never going to work.
   */
  className: z.enum(REPORTING_CLASSES),
  region: RegionSchema.nullish(),
});
export type MigrationRunRequest = z.infer<typeof MigrationRunRequestSchema>;

/** One object a forced migration will be sent to, and the region that owns it. */
export interface MigrationTarget {
  objectId: string;
  objectName: string | null;
  region: Region;
}

/**
 * The objects a run will reach, and everything about it that is not those.
 *
 * `matched` counts every live object of the class before the cap, so a
 * truncated run reports the size it could not cover rather than the size it
 * did.
 *
 * `unroutable` counts the objects a command cannot be addressed to, and it has
 * two disjoint causes that the run reports as one number because the operator's
 * remedy for both is the same — the object was not reached. Here it is the
 * objects whose *region* could not be resolved from either a report or a known
 * script name. The dispatcher adds the other cause: an object whose region is
 * known but whose command queue this deployment holds no binding for. They
 * cannot overlap, because an object with no region never reaches `targets`.
 */
export interface MigrationTargetSelection {
  targets: MigrationTarget[];
  matched: number;
  unroutable: number;
  truncated: boolean;
}

/** One class an operator may force, per region, with what it would reach. */
export interface ForceableComponent {
  className: string;
  region: Region;
  /** Live objects of this class in this region — the size of a run. */
  objects: number;
  behind: number;
  failed: number;
  unreported: number;
}

/** One recorded run, as the page lists it. */
export interface MigrationRun {
  runId: string;
  className: string;
  /** Null means every region the class runs in. */
  region: Region | null;
  requestedBy: string;
  requestedAt: number;
  matched: number;
  dispatched: number;
  unroutable: number;
  truncated: boolean;
  status: "dispatched" | "empty" | "failed";
  errorMessage: string | null;
}

/** Everything the **Force a migration** page renders. */
export interface MigrationsOverview {
  components: ForceableComponent[];
  runs: MigrationRun[];
  /** Regions whose command queue this Worker actually holds a binding for. */
  dispatchableRegions: (Region)[];
}

/**
 * The shapes the registry Durable Object returns and the queries it accepts.
 *
 * These stay separate from `@avalon/contracts/durable-object-migrations`, which
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
 * - `absent` — it was in a previous sweep and is not in the latest one.
 */
export const ObjectStatusSchema = z.enum(["failed", "behind", "unreported", "current", "absent"]);
export type ObjectStatus = z.infer<typeof ObjectStatusSchema>;

export const ObjectQuerySchema = z.object({
  status: ObjectStatusSchema.nullish(),
  component: z.string().max(64).nullish(),
  region: z.enum(["global", "eu"]).nullish(),
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
  total: number;
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
  objectCount: number;
  lastSweptAt: number;
}

export interface RegistryOverview {
  generatedAt: number;
  registrySchemaVersion: number;
  totals: Record<ObjectStatus, number> & { all: number };
  components: ComponentSummary[];
  namespaces: NamespaceSummary[];
  latestSweep: SweepSummary | null;
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
}

/**
 * The one contract a Durable Object migration report is written and read
 * through.
 *
 * The producer is `apps/api`, inside a Durable Object constructor. The consumer
 * is `apps/migration-tracker`, behind a Worker RPC entrypoint. Neither may
 * import the other, so the schema lives here and both sides parse against it —
 * the producer to fail before it sends, the tracker to fail before it stores.
 *
 * The report crosses a regional boundary: an EU object reports into one
 * account-wide tracker. `docs/regionalization.md` allows exactly one shape of
 * data to make that crossing — a region plus opaque record identifiers — and
 * `OpaqueDurableObjectNameSchema` is what holds the report to it. A Durable
 * Object name is operator-facing and is the fastest way to find the object that
 * is stuck, so it is worth carrying; it is carried only because every segment
 * of it is a region token, a fixed role word, or a UUID. A name that has grown
 * a workspace slug, an email address, or any other legible field stops matching
 * and the report is refused rather than quietly forwarded.
 */
import { z } from "zod";

/** Cloudflare renders a Durable Object ID as 64 lowercase hex characters. */
export const DurableObjectIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NUMERIC_SEGMENT = /^[0-9]{1,12}$/u;

/**
 * The fixed words that appear in a name alongside its identifiers: the two
 * region tokens, and the role word `block-dashboard`. Every one of them is a
 * compile-time constant in `apps/api/src/durable-objects/names.ts`.
 *
 * This is an allowlist rather than a shape. A rule like "any short lowercase
 * word" would admit `eu:acme-corporation:payroll` — a perfectly plausible
 * future naming scheme, and one that would carry a customer's name across the
 * regional boundary the moment somebody wrote it. Adding a role word here is a
 * one-line change in a file a reviewer is looking at for exactly this reason,
 * which is the point.
 */
const FIXED_SEGMENTS = new Set(["global", "eu", "block-dashboard"]);

/**
 * Every segment of an Avalon Durable Object name is one of three things: a
 * region token, a UUID naming a workspace, work stream, substream, or block, or
 * one of the fixed role words above. A name whose segments are anything else is
 * refused rather than sent.
 */
export function isOpaqueDurableObjectName(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  const segments = value.split(":");
  if (segments.length > 8) return false;
  return segments.every((segment) => UUID_SEGMENT.test(segment)
    || NUMERIC_SEGMENT.test(segment)
    || FIXED_SEGMENTS.has(segment));
}

export const OpaqueDurableObjectNameSchema = z.string().refine(
  isOpaqueDurableObjectName,
  { message: "durable_object_name_is_not_opaque" },
);

/**
 * `applied` — this wake ran migration SQL and the object now sits at
 * `schemaVersion`. `current` — nothing ran; the report exists because the
 * tracker had not been told this version yet, or the heartbeat came due.
 * `failed` — the migration threw and the object is broken until someone acts.
 */
export const DurableObjectMigrationStatusSchema = z.enum(["applied", "current", "failed"]);
export type DurableObjectMigrationStatus = z.infer<typeof DurableObjectMigrationStatusSchema>;

/**
 * The failure text is the migration runner's own error — a `component_schema_*`
 * code, or the SQLite error under it. Both describe code rather than workspace
 * content, and both are bounded here so one runaway message cannot become the
 * report.
 */
export const DurableObjectMigrationFailureSchema = z.object({
  message: z.string().min(1).max(1_000),
  /** The version being applied when it threw, where the runner named one. */
  version: z.number().int().positive().nullable(),
});
export type DurableObjectMigrationFailure = z.infer<typeof DurableObjectMigrationFailureSchema>;

export const DurableObjectMigrationReportSchema = z.object({
  objectId: DurableObjectIdSchema,
  /** Absent when the object was addressed by ID rather than derived from a name. */
  objectName: OpaqueDurableObjectNameSchema.nullable(),
  /** The Durable Object class, as declared in the regional Wrangler file. */
  className: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  /** The migration runner's component key — the namespace of `schemaVersion`. */
  component: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  region: z.enum(["global", "eu"]),
  appEnv: z.enum(["development", "test", "staging", "production"]),
  workerVersionId: z.string().min(1).max(64),
  status: DurableObjectMigrationStatusSchema,
  /** The highest version in this object's ledger; `0` before the first one lands. */
  schemaVersion: z.number().int().nonnegative(),
  /** The highest version the running build ships, so the tracker can see drift. */
  latestVersion: z.number().int().nonnegative(),
  /**
   * Versions this wake applied — empty when the object woke already current,
   * and for a failure, where the transaction rolled back. Bounded well above any
   * plausible migration history so a first-ever wake reports its whole list.
   */
  appliedVersions: z.array(z.number().int().positive()).max(512),
  failure: DurableObjectMigrationFailureSchema.nullable(),
  occurredAt: z.number().int().positive(),
});
export type DurableObjectMigrationReport = z.infer<typeof DurableObjectMigrationReportSchema>;

/**
 * The RPC surface `apps/api` calls and `apps/migration-tracker` exports. It is
 * a Worker entrypoint method rather than an HTTP route so that the ingress has
 * no public address at all: the report path is reachable over a service binding
 * and nowhere else, and the tracker's hostname carries only the operator site
 * that Cloudflare Access stands in front of.
 */
export interface DurableObjectMigrationTracker {
  report(input: DurableObjectMigrationReport): Promise<void>;
}

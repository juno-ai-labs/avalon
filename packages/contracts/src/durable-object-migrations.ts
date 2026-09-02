/**
 * The one contract a Durable Object migration report is written and read
 * through.
 *
 * The producer is `apps/api`, inside a Durable Object constructor. The consumer
 * is `apps/migration-tracker`, reading a Queue. Neither may import the other, so
 * the schema lives here and both sides parse against it — the producer to fail
 * before it sends, the tracker to fail before it stores. A queue message is
 * bytes on the wire with no build-time contract behind it, which makes the
 * consumer's parse the only thing standing between a changed producer and a
 * corrupted registry.
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
 * region tokens, and the role words `block-dashboard`, `automation`, and
 * `artifact`. Every one of them is a compile-time constant in
 * `apps/api/src/durable-objects/names.ts`.
 *
 * `automation` was missing until artifacts needed `artifact` added beside it,
 * and the omission was silent in the direction omissions here always are:
 * `migration-reporting.ts` degrades a non-opaque name to `objectName: null`
 * rather than refusing to report, so every `AutomationAgent` report since that
 * name was introduced has been arriving without the field an operator uses to
 * find the object that is stuck. Adding a role word is a one-line change; not
 * adding one costs nothing visible, which is exactly why this list is checked
 * against `names.ts` by a test rather than by memory.
 *
 * This is an allowlist rather than a shape. A rule like "any short lowercase
 * word" would admit `eu:acme-corporation:payroll` — a perfectly plausible
 * future naming scheme, and one that would carry a customer's name across the
 * regional boundary the moment somebody wrote it. Adding a role word here is a
 * one-line change in a file a reviewer is looking at for exactly this reason,
 * which is the point.
 */
const FIXED_SEGMENTS = new Set(["global", "eu", "block-dashboard", "automation", "artifact"]);

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
  /**
   * Identifies this report, not the object — a fresh UUIDv7 per send.
   *
   * Cloudflare Queues deliver at least once, so the same report can arrive
   * twice, and the consumer dedupes on this. It is generated by the reporter
   * rather than derived from the report's contents because two genuinely
   * distinct wakes can produce byte-identical reports, and collapsing those
   * would silently lose a heartbeat.
   */
  reportId: z.string().uuid(),
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
 * The name of the producer binding `apps/api` holds in each region.
 *
 * A Queue rather than an RPC entrypoint, for the reasons in
 * `docs/choosing-queues-or-rpc.md`: every object in the fleet converges on one
 * registry object, nothing waits on the answer, and the sender is frequently a
 * Durable Object that must not be held open. It also means the report path has
 * no public address — a queue is reachable only by a binding — so the tracker's
 * hostname carries nothing but the operator site behind Cloudflare Access.
 *
 * The binding's type is declared in `apps/api/src/env.ts` rather than here:
 * this package is also compiled by the Electron client, so it must not depend
 * on `@cloudflare/workers-types`.
 */
export const DURABLE_OBJECT_MIGRATION_REPORT_QUEUE_BINDING = "MIGRATION_REPORT_QUEUE";

/**
 * The command that asks one Durable Object to be on the running build's schema.
 *
 * This travels the other way to the report above: the tracker sends it, and the
 * regional API Worker consumes it. An operator picks a class on the tracker's
 * **Force a migration** page, the tracker turns the objects it knows of into one
 * message each, and the region's own Worker calls `forceMigration` on the object
 * the message names. `docs/durable-object-migration-tracking.md` owns the flow.
 *
 * One message per object, rather than one message naming a class, is the whole
 * design. A migration is applied by *waking* an object — the schema runs in the
 * constructor — so the work is inherently per instance, and a queue is what
 * turns "wake eight hundred objects" into a paced stream the platform meters
 * instead of a fan-out one invocation has to hold open.
 *
 * It carries the same shapes the report does and clears the same bar: a region,
 * an opaque object identifier, an opaque name, and a class name. Nothing here
 * names a workspace, a person, or anything a workspace owns, which is what lets
 * one account-wide tracker address both regions' fleets.
 */
export const DurableObjectMigrationCommandSchema = z.object({
  /**
   * Identifies this message. The consumer is naturally idempotent — forcing an
   * object twice wakes it twice and reports twice — so this is not a dedupe
   * key; it is what ties a log line to the one message that produced it.
   */
  commandId: z.string().uuid(),
  /** The operator run this message belongs to, as recorded by the tracker. */
  runId: z.string().uuid(),
  /**
   * Selects the Durable Object namespace binding to address the object through.
   * The consumer holds the map; a class it does not know is dropped rather than
   * guessed at.
   */
  className: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  /**
   * The object to wake, addressed by ID rather than by name. The ID is what
   * both of the tracker's sources produce, it is the only identifier an object
   * discovered by the inventory sweep has, and it already carries the
   * jurisdiction the object lives in.
   */
  objectId: DurableObjectIdSchema.nullable(),
  /** Carried for the consumer's log only; the ID is what addresses the object. */
  objectName: OpaqueDurableObjectNameSchema.nullable(),
  /**
   * The region whose Worker must handle this. The queue already implies it —
   * these are split per region because only the region's own Worker holds
   * bindings to its objects — but a message that states it catches a misrouted
   * producer that the queue's name never would.
   */
  region: z.enum(["global", "eu"]),
  /**
   * When the operator started the run. Carried rather than derived, and
   * deliberately not read by the consumer: the case it exists for is a message
   * sitting in the dead-letter queue, where the object could not be reached and
   * the point is to read the message on its own. Without it, dating a stuck
   * command means joining `runId` back to a registry the operator is looking at
   * the queue precisely because they cannot get an answer from.
   */
  requestedAt: z.number().int().positive(),
  /**
   * One merge-triggered, WorkspaceDO-only product-authority cutover. Ordinary
   * migration-tracker messages omit it and retain their existing behavior.
   */
  automationCutover: z.strictObject({
    workspaceId: z.string().uuid(),
    expectedDraftIds: z.array(z.string().uuid()).optional(),
  }).optional(),
}).superRefine((command, context) => {
  if (!command.automationCutover) {
    if (command.objectId === null) {
      context.addIssue({ code: "custom", path: ["objectId"], message: "migration force requires an object ID" });
    }
    return;
  }
  if (command.className !== "WorkspaceDO") {
    context.addIssue({ code: "custom", path: ["className"], message: "automation cutover requires WorkspaceDO" });
  }
  const expectedName = `${command.region}:${command.automationCutover.workspaceId}`;
  if (command.objectName !== expectedName) {
    context.addIssue({ code: "custom", path: ["objectName"], message: "automation cutover workspace name mismatch" });
  }
});
export type DurableObjectMigrationCommand = z.infer<typeof DurableObjectMigrationCommandSchema>;

/**
 * The queue each region's API Worker consumes forced-migration commands from.
 *
 * Split per region, unlike `avalon-migration-reports`, and for the reason
 * `docs/choosing-queues-or-rpc.md` gives as decisive: a queue has exactly one
 * consumer, and the work here can only be done by the Worker that holds
 * bindings to the objects. The reports converge on one destination and so share
 * one queue; the commands diverge to two fleets and cannot.
 */
export function durableObjectMigrationCommandQueue(region: "global" | "eu"): string {
  return `avalon-${region}-migration-commands`;
}

/**
 * True for one of the two queues carrying forced-migration commands.
 *
 * An exact match against the two names rather than a suffix test, because this
 * predicate chooses a Worker's queue handler: a queue added later whose name
 * merely ended the same way — `avalon-apac-migration-commands`, or a
 * `…-migration-commands-replay` — would be parsed as forced-migration traffic
 * and silently bypass the handler it was meant for. The dead-letter queues are
 * excluded by the same exactness rather than by accident of their suffix.
 */
export function isDurableObjectMigrationCommandQueue(queue: string): boolean {
  return queue === durableObjectMigrationCommandQueue("global")
    || queue === durableObjectMigrationCommandQueue("eu");
}

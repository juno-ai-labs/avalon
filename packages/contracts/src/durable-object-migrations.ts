import { configuredRegions } from "./regions";
import { RegionSchema } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
/**
 * Opaque object names and per-object commands shared by migration tooling and
 * the regional API. See docs/forced-migrations.md.
 */
import { z } from "zod";
import { deferredZodSchema } from "./deferred-zod-schema";

/** Cloudflare renders a Durable Object ID as 64 lowercase hex characters. */
export const DurableObjectIdSchema = deferredZodSchema(() => z.string().regex(/^[0-9a-f]{64}$/u));

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NUMERIC_SEGMENT = /^[0-9]{1,12}$/u;

/**
 * The fixed words that appear in a name alongside its identifiers: the two
 * region tokens, and the role words `automation`, `artifact` and
 * `space`. Every one of them is a compile-time constant in
 * `apps/api/src/durable-objects/names.ts`.
 *
 * This is an allowlist rather than a shape. A rule like "any short lowercase
 * word" would admit `enterprise:acme-corporation:payroll` — a perfectly plausible
 * future naming scheme, and one that would carry a customer's name across the
 * regional boundary the moment somebody wrote it. Adding a role word here is a
 * one-line change in a file a reviewer is looking at for exactly this reason,
 * which is the point.
 */
const FIXED_SEGMENTS = new Set(["automation", "artifact", "space"]);

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
    || FIXED_SEGMENTS.has(segment) || configuredRegions.includes(segment));
}

export const OpaqueDurableObjectNameSchema = deferredZodSchema(() => z.string().refine(
  isOpaqueDurableObjectName,
  { message: "durable_object_name_is_not_opaque" },
));

export const DurableObjectMigrationCommandSchema = deferredZodSchema(() => z.object({
  /**
   * Identifies this message. The consumer is naturally idempotent — forcing an
   * object twice wakes it twice and reports twice — so this is not a dedupe
   * key; it is what ties a log line to the one message that produced it.
   */
  commandId: z.string().uuid(),
  /** The operator run this message belongs to, as recorded by the CLI. */
  runId: z.string().uuid(),
  /**
   * Selects the Durable Object namespace binding to address the object through.
   * The consumer holds the map; a class it does not know is dropped rather than
   * guessed at.
   */
  className: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  /**
   * The object to wake, addressed by ID rather than by name. The ID is what
   * the Cloudflare namespace inventory produces; it already carries the
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
  region: RegionSchema,
  /**
   * When the operator started the run. Carried rather than derived, and
   * deliberately not read by the consumer: the case it exists for is a message
   * sitting in the dead-letter queue, where the object could not be reached and
   * the point is to read the message on its own. Without it, dating a stuck
   * command means joining `runId` back to a registry the operator is looking at
   * the queue precisely because they cannot get an answer from.
   */
  requestedAt: z.number().int().positive(),
}).superRefine((command, context) => {
  if (command.objectId === null) {
    context.addIssue({ code: "custom", path: ["objectId"], message: "migration force requires an object ID" });
  }
}));
export type DurableObjectMigrationCommand = z.infer<typeof DurableObjectMigrationCommandSchema>;

/**
 * The queue each region's API Worker consumes forced-migration commands from.
 *
 * Split per region, for the reason
 * `docs/choosing-queues-or-rpc.md` gives as decisive: a queue has exactly one
 * consumer, and the work here can only be done by the Worker that holds
 * bindings to the objects. Commands must be consumed in the region that owns the object.
 */
export function durableObjectMigrationCommandQueue(region: Region): string {
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
  return configuredRegions.some((region) => queue === durableObjectMigrationCommandQueue(region));
}

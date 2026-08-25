/**
 * Turning "force this class" into one queue message per Durable Object.
 *
 * This is the sending half of the flow whose receiving half is
 * `apps/api/src/queues/migration-command-consumer.ts`. An operator picks a
 * class on the site; the registry answers with every live object of that class
 * and the region that owns each one; and this module writes them onto the
 * region's command queue in batches of a hundred.
 *
 * One message per object, rather than one message naming a class, because a
 * Durable Object's schema is applied by *waking it* — there is no bulk
 * operation to ask for. Turning the fan-out into messages is what lets the
 * platform pace it: the queue holds the backlog, the consumer takes a hundred
 * at a time, and a hop that fails retries alone instead of restarting the walk.
 * The alternative, one long loop in this Worker calling objects directly, is
 * the shape `docs/choosing-queues-or-rpc.md` exists to rule out — and it is not
 * even available here, because only the region's own Worker holds bindings to
 * its objects.
 *
 * `docs/durable-object-migration-tracking.md` owns the design.
 */
import type { DurableObjectMigrationCommand } from "@rally/contracts/durable-object-migrations";

import type { Env } from "./env";
import type {
  MigrationRun,
  MigrationRunRequest,
  MigrationTarget,
} from "./protocol";
import type { MigrationRegistry } from "./registry";

/** Cloudflare accepts at most 100 messages, or 256 KB, in one `sendBatch`. */
const QUEUE_SEND_BATCH = 100;

/**
 * The command queue for each region, or `undefined` where this Worker holds no
 * binding — the normal state in local development and in the workerd suite.
 *
 * Two bindings selected by region is the one branch on region this repository
 * allows in code. The usual rule, from `docs/choosing-queues-or-rpc.md`, is to
 * keep one binding name across both regional configs so region selection stays
 * deployment configuration; that rule is written for a Worker deployed once per
 * region. This one is deployed once for the account and addresses both, so the
 * selection has nowhere else to live.
 */
export function migrationCommandQueue(
  env: Env,
  region: "global" | "eu",
): Queue<DurableObjectMigrationCommand> | undefined {
  return region === "eu" ? env.EU_MIGRATION_COMMAND_QUEUE : env.GLOBAL_MIGRATION_COMMAND_QUEUE;
}

/** The regions this Worker can actually dispatch to right now. */
export function dispatchableRegions(env: Env): ("global" | "eu")[] {
  return (["global", "eu"] as const).filter((region) => migrationCommandQueue(env, region));
}

/**
 * Dispatch one forced-migration run and record what it reached.
 *
 * The run is recorded after the sends, including a send that threw partway: the
 * count in the row is the messages the queue accepted, not the messages this
 * function meant to send, so a half-finished fan-out is visible as one rather
 * than disappearing. That is the same rule the reporter follows on the other
 * side — nothing is recorded as delivered until the queue has taken it.
 *
 * The one case that leaves no row is the registry write itself failing after
 * the queue accepted the messages. A `pending` row written before the dispatch
 * and finalized afterwards would close it, and is deliberately not done: it
 * trades a run with no record for a run stuck pending, on a subsystem where
 * forcing an object twice is documented as harmless, so the cost of the missing
 * row is a duplicate fan-out rather than anything corrupted. The registry being
 * unavailable also means the page that would show the row is down anyway.
 *
 * A region with no binding is not a failure of the run; it is a region this
 * deployment cannot reach at all. Its objects are counted as unroutable, which
 * is what the page shows, rather than being sent nowhere and reported as sent.
 *
 * `dispatched + unroutable` does not have to add up to `matched` when a send
 * failed: the objects a refused region never reached are neither dispatched nor
 * unroutable, and the run's `errorMessage` names the region rather than leaving
 * the gap unexplained.
 */
export async function dispatchMigrationRun(
  env: Env,
  registry: DurableObjectStub<MigrationRegistry>,
  request: MigrationRunRequest,
  requestedBy: string,
): Promise<MigrationRun> {
  const runId = crypto.randomUUID();
  const requestedAt = Date.now();
  const selection = await registry.migrationTargets(request);

  const byRegion = new Map<"global" | "eu", MigrationTarget[]>();
  let unroutable = selection.unroutable;
  for (const target of selection.targets) {
    if (!migrationCommandQueue(env, target.region)) {
      unroutable += 1;
      continue;
    }
    const bucket = byRegion.get(target.region) ?? [];
    bucket.push(target);
    byRegion.set(target.region, bucket);
  }

  let dispatched = 0;
  const failures: string[] = [];
  // One try per region, not one around the whole walk. The two regions are
  // separate queues in separate accounts of the platform's attention, and a
  // Global queue refusing says nothing about the EU one — failing both because
  // the first was reached first would turn one region's outage into two. Within
  // a region the loop does stop at the first refusal: the batches after it are
  // going at the same queue that just said no.
  for (const [region, targets] of byRegion) {
    const queue = migrationCommandQueue(env, region);
    if (!queue) continue;
    try {
      for (let index = 0; index < targets.length; index += QUEUE_SEND_BATCH) {
        const slice = targets.slice(index, index + QUEUE_SEND_BATCH);
        await queue.sendBatch(slice.map((target) => ({
          body: {
            commandId: crypto.randomUUID(),
            runId,
            className: request.className,
            objectId: target.objectId,
            objectName: target.objectName,
            region,
            requestedAt,
          } satisfies DurableObjectMigrationCommand,
        })));
        dispatched += slice.length;
      }
    } catch (error) {
      failures.push(`${region}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const errorMessage = failures.length > 0 ? failures.join("; ").slice(0, 1_000) : null;

  const run: MigrationRun = {
    runId,
    className: request.className,
    region: request.region ?? null,
    requestedBy,
    requestedAt,
    matched: selection.matched,
    dispatched,
    unroutable,
    truncated: selection.truncated,
    status: errorMessage !== null ? "failed" : dispatched === 0 ? "empty" : "dispatched",
    errorMessage,
  };
  await registry.recordMigrationRun(run);
  return run;
}

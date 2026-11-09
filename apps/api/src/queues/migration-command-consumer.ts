/**
 * Force one Durable Object onto the running build's schema.
 *
 * The receiving half of the tracker's **Force a migration** page. An operator
 * picks a class there; the tracker turns every object it knows of into one
 * message on this region's `avalon-<region>-migration-commands` queue; and this
 * consumer wakes the object each message names and reads back where it landed.
 * `docs/durable-object-migration-tracking.md` owns the flow.
 *
 * A queue between the two, rather than the tracker calling the objects itself:
 * a class has hundreds of instances and applying a migration means waking every
 * one of them, which is a fan-out no single invocation should hold open, and
 * which the queue meters into batches this Worker can absorb. It is also the
 * only shape available — a Durable Object can only be addressed by a Worker
 * holding a binding to its namespace, and only this region's Worker holds
 * bindings to this region's objects.
 *
 * The hop from here into the object is RPC because this consumer reads the
 * answer: `forceMigration` returns the version the object ended on and whether
 * its receipt was accepted, and an object that comes back below the version
 * *this deployment* ships is logged as a warning rather than a success. That is the split `docs/choosing-queues-or-rpc.md` describes —
 * a queue per hop, RPC inside the hop — and the same one `access-revocation.md`
 * already uses.
 *
 * Forcing an object twice is the same as forcing it once: the wake applies
 * whatever is unapplied and reports where it is. So a redelivered message needs
 * no dedupe key, which is what lets a failed hop retry on its own.
 */
import {
  DurableObjectMigrationCommandSchema,
  type DurableObjectMigrationCommand,
} from "@rally/contracts/durable-object-migrations";

import { latestMigrationVersion, type ForcedMigrationOutcome } from "../durable-objects/migration-reporting";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../durable-objects/workspace-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../durable-objects/workstream-object-schema";
import type { Env } from "../env";
import { durableObjectStubById } from "../lib/durable-object-namespace";
import { logStructuredEvent, logWarn } from "../observability/logger";

/**
 * The classes this region can force, and the binding each is addressed through.
 *
 * The authority on what may be forced, and deliberately not derived from the
 * message: a class name this Worker does not deploy has no namespace to look an
 * ID up in, so guessing one would either throw somewhere less legible or —
 * worse — resolve an ID in the wrong namespace and create an empty object.
 *
 * A map of calls rather than a map of namespaces because
 * `DurableObjectNamespace<T>` is invariant in `T`: four namespaces of four
 * classes have no common supertype to store side by side, even though every one
 * of those classes extends `MigratableDurableObject` and every stub answers the
 * same method. Resolving the stub inside each entry keeps each one concrete.
 *
 * `CrashSymbolicatorContainer` is absent because it is a container rather than a
 * migrated object; it runs no schema and has nothing to force. Add a class here
 * in the same change that adds it to the Worker, and to `REPORTING_CLASSES` in
 * `apps/migration-tracker/src/protocol.ts`, which is what decides whether the
 * tracker offers it at all.
 */
export function migrationCommandDispatchers(env: Env): Record<
  string,
  (objectId: string, command: DurableObjectMigrationCommand) => Promise<ForcedMigrationOutcome>
> {
  return {
    AgentLoopDO: (objectId, command) =>
      durableObjectStubById(env, env.SUBSTREAM_AGENTS, objectId).forceMigration(command),
    WorkspaceDO: (objectId, command) =>
      durableObjectStubById(env, env.WORKSPACE_DOS, objectId).forceMigration(command),
  };
}

/**
 * Classes whose namespaces were deleted. A command for one that was dispatched
 * before the deletion can never be applied, so it is acknowledged rather than
 * retried into the dead-letter queue this platform reads as its signal for
 * stuck migrations.
 */
const DELETED_MIGRATION_CLASSES: ReadonlySet<string> = new Set(["WorkstreamDO", "SpaceDO", "SidekickDO", "AutomationDO"]);

/**
 * The highest schema version *this deployment* ships for each class.
 *
 * Read from the same migration lists the objects run, in the Worker that is
 * consuming the command rather than in the object that answered it. That
 * distinction is the entire point, and it is what makes the shortfall check
 * below able to fire at all.
 */
export const MIGRATION_COMMAND_HEADS: Readonly<Record<string, number>> = {
  AgentLoopDO: latestMigrationVersion(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS),
  WorkspaceDO: latestMigrationVersion(WORKSPACE_DO_SCHEMA_MIGRATIONS),
};

/**
 * Whether a forced object came back below the schema this deployment ships.
 *
 * Comparing the outcome's own two numbers cannot answer this. Both come out of
 * the object's isolate — `schemaVersion` from its ledger, `latestVersion` from
 * the build it is running — and `forceMigration` only returns once the
 * constructor's migration pass has succeeded, so they are equal by
 * construction. A pass that left them unequal would have thrown and been
 * retried. The comparison was therefore dead, and dead in the worst way: the
 * one case worth flagging is an object still awake on a *previous* build, whose
 * `latestVersion` is that older build's head too, so it read as a clean apply.
 *
 * The consumer's own head is the number that makes the case visible, because
 * the consumer is running the new deployment and the stale isolate is not.
 * `null` for a class this Worker has no head for, which cannot happen for a
 * command that reached a dispatcher but keeps the caller from inventing a zero.
 */
export function migrationShortfall(
  outcome: Pick<ForcedMigrationOutcome, "className" | "schemaVersion">,
): number | null {
  if (!Object.hasOwn(MIGRATION_COMMAND_HEADS, outcome.className)) return null;
  const head = MIGRATION_COMMAND_HEADS[outcome.className];
  if (head === undefined) return null;
  return outcome.schemaVersion < head ? head : null;
}

/**
 * Classes renamed by a Wrangler `renamed_classes` tag: a command a tracker
 * queued under the old name before the rename reaches the same objects under
 * the new one, rather than dead-lettering as an unknown class. Delete an entry
 * once no tracker build can still queue the old name.
 */
const RENAMED_MIGRATION_CLASSES: Readonly<Record<string, string>> = { SubstreamAgent: "AgentLoopDO" };

/** Carry one forced migration to one object and read back where it landed. */
export async function applyMigrationCommand(
  env: Env,
  queued: DurableObjectMigrationCommand,
): Promise<ForcedMigrationOutcome> {
  const command = Object.hasOwn(RENAMED_MIGRATION_CLASSES, queued.className)
    ? { ...queued, className: RENAMED_MIGRATION_CLASSES[queued.className]! } : queued;
  const dispatchers = migrationCommandDispatchers(env);
  // `Object.hasOwn`, not a truthiness check on the lookup. `className` is an
  // identifier as far as the contract is concerned, and `constructor`,
  // `toString`, and `valueOf` are all identifiers that resolve off
  // `Object.prototype` to a function — so a plain index finds one, the unknown
  // -class guard passes, and calling it returns something that is not an
  // outcome at all. The consumer would then acknowledge the message as applied
  // having woken nothing.
  if (!Object.hasOwn(dispatchers, command.className)) {
    throw new Error(`migration_command_unknown_class:${command.className}`);
  }
  // The contract's own refinement already refuses a forced migration with no
  // object ID, but a `superRefine` proves nothing to the compiler, so the four
  // dispatchers above used to each carry a non-null assertion at a queue
  // boundary — the one place where an assertion is a promise about bytes
  // somebody else wrote. Narrowing once here makes it a checked fact instead,
  // and an ID that did slip past the parse names itself rather than becoming a
  // stub for an object called "null".
  const { objectId } = command;
  if (objectId === null) throw new Error("migration_command_missing_object_id");
  return dispatchers[command.className]!(objectId, command);
}

/**
 * Queue entry point: one object per message, retried on its own.
 *
 * Three kinds of message are acknowledged rather than retried, because none
 * can ever become valid: one the contract refuses, one for a class whose
 * namespace was deleted, and one addressed to the other region. The second is a misrouted producer rather than a transient
 * fault, and rerouting it here would be the Global fallback
 * `docs/choosing-queues-or-rpc.md` forbids — a command must be applied by the
 * region that owns the object or not at all.
 *
 * Everything else is retried, including a migration that threw. That is the
 * outcome to want: the object reports its own failure on the way past, so the
 * tracker shows the break, and the messages that exhaust their retries land in
 * the dead-letter queue, which counts how many objects are stuck without
 * anybody building a tally.
 */
export async function consumeMigrationCommandQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = DurableObjectMigrationCommandSchema.safeParse(message.body);
    if (!parsed.success) {
      logWarn(env, "migration_command_invalid", {
        queue: batch.queue,
        errors: parsed.error.issues.slice(0, 4).map((issue) =>
          `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`),
      });
      message.ack();
      return;
    }
    const command = parsed.data;
    if (DELETED_MIGRATION_CLASSES.has(command.className)) {
      logWarn(env, "migration_command_class_deleted", {
        queue: batch.queue,
        run_id: command.runId,
        command_id: command.commandId,
        class_name: command.className,
      });
      message.ack();
      return;
    }
    if (command.region !== env.AVALON_REGION) {
      logStructuredEvent(env, "error", "migration_command_misrouted", {
        message: `migration_command_misrouted ${command.region} reached ${env.AVALON_REGION}`,
        queue: batch.queue,
        run_id: command.runId,
        command_id: command.commandId,
        object_id: command.objectId,
        class_name: command.className,
      });
      message.ack();
      return;
    }

    try {
      const outcome = await applyMigrationCommand(env, command);
      // Against this deployment's head, not the object's own — see
      // `migrationShortfall`. An object that answered from an isolate still
      // running an older build is the case this exists to surface, and it is
      // the one that used to read as a clean apply.
      const shortfall = migrationShortfall(outcome);
      logStructuredEvent(env, shortfall === null ? "info" : "warn", "migration_command_applied", {
        message: `migration_command_applied ${outcome.className} v${outcome.schemaVersion}`
          + `${shortfall === null ? "" : ` still behind this build's v${shortfall}`}`,
        run_id: command.runId,
        command_id: command.commandId,
        object_id: outcome.objectId,
        object_name: outcome.objectName,
        class_name: outcome.className,
        component: outcome.component,
        schema_version: outcome.schemaVersion,
        // The head the object's own isolate is running, which is below
        // `expected_version` exactly when that isolate is on an older build.
        latest_version: outcome.latestVersion,
        expected_version: MIGRATION_COMMAND_HEADS[outcome.className] ?? null,
        // False means the object woke and ran its schema but its receipt was
        // not accepted by the report queue, so the tracker will not show this
        // pass until the object's next wake. The migration still happened.
        reported: outcome.reported,
      });
      message.ack();
    } catch (error) {
      logWarn(env, "migration_command_failed", {
        run_id: command.runId,
        command_id: command.commandId,
        object_id: command.objectId,
        class_name: command.className,
        error: error instanceof Error ? error.message : "unknown",
      });
      message.retry();
    }
  }));
}

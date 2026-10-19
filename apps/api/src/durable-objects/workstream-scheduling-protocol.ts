import { MESSAGE_MAX_CHARACTERS } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamSchedulingStorage } from "./workstream-scheduling-storage";

export const OpenElicitationInputSchema = z.strictObject({
  elicitationId: z.string().min(1),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  prompt: z.string().max(MESSAGE_MAX_CHARACTERS),
  responseType: z.string().min(1),
  optionsJson: z.string(),
  minimumSelections: z.number().int().nonnegative(),
  maximumSelections: z.number().int().nonnegative().nullable(),
  targetUserId: z.string().min(1).nullable(),
  messageId: z.string().min(1),
  structuredContentJson: z.string().max(MESSAGE_MAX_CHARACTERS),
  now: z.number().finite(),
});

export const AnswerElicitationExternallyInputSchema = z.strictObject({
  elicitationId: z.string().min(1),
  answerJson: z.string(),
  externalActorJson: z.string(),
  messageId: z.string().min(1),
  clientMessageId: z.string().min(1),
  structuredContentJson: z.string().max(MESSAGE_MAX_CHARACTERS),
  now: z.number().finite(),
});

/**
 * The wire contract for one work stream's scheduling state.
 *
 * Derived from `WorkstreamSchedulingStorage` rather than restated, so a method
 * added there without a name here is a type error at the
 * `SCHEDULING_OPERATIONS` declaration instead of a silent gap over the wire.
 *
 * What is specific to this port rather than shared is `WAKEUP_MUTATIONS`: the
 * other three authorities have no operation that has to leave the object's own
 * alarm index and sidebar projection consistent with the row it just wrote.
 */
type LocalOnlySchedulingOperation =
  | "prepareOpenElicitationMessage"
  | "openPreparedElicitation"
  | "prepareExternalElicitationAnswerMessage"
  | "answerPreparedElicitationExternally";
export type SchedulingOperation = Exclude<keyof WorkstreamSchedulingStorage, LocalOnlySchedulingOperation>;

export type SchedulingObjectPort = ObjectPortOf<WorkstreamSchedulingStorage, SchedulingOperation>;

const DISPATCHED_OPERATIONS = [
  "pendingWakeupCount",
  "pendingWakeups",
  "wakeup",
  "wakeupByIdempotencyKey",
  "scheduleWakeup",
  "claimDueWakeup",
  "releaseClaimedWakeup",
  "cancelWakeup",
  "deleteUnarmedWakeup",
  "activationHints",
  "recordPluginActivation",
  "descriptionRefreshState",
  "claimDescriptionEvaluation",
  "recordDescriptionOutcome",
  "memorySweepState",
  "claimMemorySweep",
  "settleMemorySweep",
  "releaseMemorySweep",
  "deferMemorySweep",
  "memoryDigestCopy",
  "storeMemoryDigestCopy",
  "memoryDigestPrincipals",
  "removeFactFromMemoryDigestCopies",
  "oldestOpenElicitation",
  "openElicitationCount",
  "elicitationExistsForRun",
  "openElicitation",
  "answerElicitationExternally",
] as const satisfies readonly SchedulingOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const SCHEDULING_OPERATIONS:
  Exhaustive<SchedulingOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that can change which wake-ups are pending.
 *
 * The object keeps an alarm entry per pending wake-up, and something has to
 * make that index match the table. It used to be a regex over routed statement
 * text — the only signal available when the writers reached the table through a
 * view — which meant every writer had to keep arriving through that one port for
 * the index to stay true. Naming the operations instead makes the object
 * maintain its own index off its own writes, and an operation added here
 * without a place in this set is the kind of omission a reviewer can see.
 *
 * Only one direction is provable, and it is the one that matters: a mutation
 * missing from this set stops arming, and emptying the set fails four specs in
 * `test-workers/scheduling-authority.test.ts`. A *read* wrongly added costs a
 * transaction and an alarm reconcile and nothing else — `commitWithRegionalEffects`
 * skips an effect whose payload hash matches the last one published, so a call
 * that changed nothing publishes nothing. Do not go looking for the test that
 * catches a misclassified read; there is nothing for it to observe.
 */
const WAKEUP_MUTATIONS = new Set<SchedulingOperation>([
  "scheduleWakeup",
  "claimDueWakeup",
  "releaseClaimedWakeup",
  "cancelWakeup",
  "deleteUnarmedWakeup",
]);

export function mutatesWakeups(operation: SchedulingOperation): boolean {
  return WAKEUP_MUTATIONS.has(operation);
}

export const isSchedulingOperation = operationGuard(SCHEDULING_OPERATIONS);

export const SchedulingOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isSchedulingOperation,
  "unknown_scheduling_operation",
));

export type SchedulingOperationRequest = z.infer<typeof SchedulingOperationRequestSchema>;

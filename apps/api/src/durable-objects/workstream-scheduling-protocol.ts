import { z } from "zod";

import type { WorkstreamSchedulingStorage } from "./workstream-scheduling-storage";

/**
 * The wire contract for one work stream's scheduling state.
 *
 * Derived from `WorkstreamSchedulingStorage` rather than restated, so a method
 * added there without a name here is a type error at the
 * `SCHEDULING_OPERATIONS` declaration instead of a silent gap. The same
 * `Exhaustive` guard as the receipt and block-dashboard protocols, and for the
 * same reason: a `satisfies` clause alone proves every listed name is real and
 * says nothing about a method with no entry.
 */
export type SchedulingOperation = keyof WorkstreamSchedulingStorage;

type StorageMethods = {
  [K in keyof WorkstreamSchedulingStorage]: WorkstreamSchedulingStorage[K] extends (
    ...args: infer A
  ) => infer R
    ? { args: A; result: R }
    : never;
};

/** The typed surface a Worker-side caller sees, one round trip per call. */
export type SchedulingObjectPort = {
  [K in keyof StorageMethods]: (
    ...args: StorageMethods[K]["args"]
  ) => Promise<StorageMethods[K]["result"]>;
};

type Exhaustive<T extends readonly SchedulingOperation[]> =
  [Exclude<SchedulingOperation, T[number]>] extends [never]
    ? T
    : readonly [...T, Exclude<SchedulingOperation, T[number]>];

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
] as const satisfies readonly SchedulingOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const SCHEDULING_OPERATIONS: Exhaustive<typeof DISPATCHED_OPERATIONS> =
  DISPATCHED_OPERATIONS;

const SCHEDULING_OPERATION_SET = new Set<string>(SCHEDULING_OPERATIONS);

export function isSchedulingOperation(value: string): value is SchedulingOperation {
  return SCHEDULING_OPERATION_SET.has(value);
}

/**
 * Positional arguments one scheduling operation may carry over the wire.
 *
 * Bounds: elements in the `args` array of an `/internal/scheduling` request,
 *   before any of them is parsed.
 * Without it: `args` is `z.unknown()`, so an oversized array is held and walked
 *   before dispatch refuses it. The bound keeps the array's shape a fact rather
 *   than caller input; it is not what makes the request cheap, since each
 *   element is still unbounded in size.
 * Direction: upper bound. It is 1 because every method on
 *   `WorkstreamSchedulingStorage` takes one options object or none, so 1 is the
 *   protocol rather than a margin around it.
 * Trips: the request fails Zod parsing and the endpoint answers 400
 *   `invalid_scheduling_operation`, the same code an unknown operation name
 *   takes, because both are a malformed request rather than a lost claim.
 * Derive from: the arity of the storage class. An operation needing a second
 *   positional argument changes this number in the same commit, and the
 *   `Exhaustive` guard above is what makes such an addition visible.
 */
export const MAX_SCHEDULING_OPERATION_ARGS = 1;

/**
 * The request envelope.
 *
 * Identity is validated strictly here and re-checked against the object's own
 * identity before anything executes, which is the check that matters: a
 * misrouted stub must fail rather than claim another work stream's wake-up.
 */
export const SchedulingOperationRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  operation: z.string().min(1).max(64).refine(isSchedulingOperation, {
    message: "unknown_scheduling_operation",
  }),
  args: z.array(z.unknown()).max(MAX_SCHEDULING_OPERATION_ARGS),
}).strict();

export type SchedulingOperationRequest = z.infer<typeof SchedulingOperationRequestSchema>;

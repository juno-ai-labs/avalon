import { z } from "zod";

import type { WorkstreamMessageStorage } from "./workstream-message-storage";

/**
 * The wire contract for one work stream's transcript.
 *
 * Derived from `WorkstreamMessageStorage` rather than restated, so a method
 * added there without a name here is a type error at the
 * `MESSAGE_OPERATIONS` declaration instead of a silent gap. The same
 * `Exhaustive` guard as the three protocols before it, and for the same reason:
 * a `satisfies` clause alone proves every listed name is real and says nothing
 * about a method with no entry.
 */
export type MessageOperation = keyof WorkstreamMessageStorage;

type StorageMethods = {
  [K in keyof WorkstreamMessageStorage]: WorkstreamMessageStorage[K] extends (
    ...args: infer A
  ) => infer R
    ? { args: A; result: R }
    : never;
};

/** The typed surface a Worker-side caller sees, one round trip per call. */
export type MessageObjectPort = {
  [K in keyof StorageMethods]: (
    ...args: StorageMethods[K]["args"]
  ) => Promise<StorageMethods[K]["result"]>;
};

type Exhaustive<T extends readonly MessageOperation[]> =
  [Exclude<MessageOperation, T[number]>] extends [never]
    ? T
    : readonly [...T, Exclude<MessageOperation, T[number]>];

const DISPATCHED_OPERATIONS = [
  "message",
  "messageByClientId",
  "messagesBefore",
  "messagesAfter",
  "mentionsFor",
  "attachmentsFor",
  "authorsFor",
  "appendMessage",
  "upsertToolMessage",
] as const satisfies readonly MessageOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const MESSAGE_OPERATIONS: Exhaustive<typeof DISPATCHED_OPERATIONS> =
  DISPATCHED_OPERATIONS;

const MESSAGE_OPERATION_SET = new Set<string>(MESSAGE_OPERATIONS);

export function isMessageOperation(value: string): value is MessageOperation {
  return MESSAGE_OPERATION_SET.has(value);
}

/**
 * Positional arguments one transcript operation may carry over the wire.
 *
 * Bounds: elements in the `args` array of an `/internal/messages` request,
 *   before any of them is parsed.
 * Without it: `args` is `z.unknown()`, so an oversized array is held and walked
 *   before dispatch refuses it. The bound keeps the array's shape a fact rather
 *   than caller input; it is not what makes the request cheap, since each
 *   element is still unbounded in size — a transcript page's worth of text
 *   travels inside one of them.
 * Direction: upper bound. It is 1 because every method on
 *   `WorkstreamMessageStorage` takes exactly one options object, so 1 is the
 *   protocol rather than a margin around it.
 * Trips: the request fails Zod parsing and the endpoint answers 400
 *   `invalid_message_operation`, the same code an unknown operation name takes,
 *   because both are a malformed request rather than a rejected write.
 * Derive from: the arity of the storage class. An operation needing a second
 *   positional argument changes this number in the same commit, and the
 *   `Exhaustive` guard above is what makes such an addition visible.
 */
export const MAX_MESSAGE_OPERATION_ARGS = 1;

/**
 * The request envelope.
 *
 * Identity is validated strictly here and re-checked against the object's own
 * identity before anything executes, which is the check that matters: a
 * misrouted stub must fail rather than write into another work stream's
 * transcript.
 */
export const MessageOperationRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  operation: z.string().min(1).max(64).refine(isMessageOperation, {
    message: "unknown_message_operation",
  }),
  args: z.array(z.unknown()).max(MAX_MESSAGE_OPERATION_ARGS),
}).strict();

export type MessageOperationRequest = z.infer<typeof MessageOperationRequestSchema>;

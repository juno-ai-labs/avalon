import { z } from "zod";

/**
 * The shape every typed object port shares.
 *
 * Four of these exist — receipts, the block dashboard, scheduling, the
 * transcript — and they were four copies of this file with the nouns changed.
 * What actually differs between them is a storage class, a list of operation
 * names, and an error code; everything else here was duplicated four times,
 * which meant a fix to the pattern had to be made four times and a divergence
 * between them was invisible.
 *
 * The pattern itself is unchanged: a port's surface is *derived* from its
 * storage class rather than restated, so a method added there without a name in
 * the dispatched list is a type error at the declaration instead of a silent
 * gap over the wire.
 */

/** The typed surface a Worker-side caller sees, one round trip per call. */
export type ObjectPortOf<TStorage> = {
  [K in keyof TStorage]: TStorage[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * A list that fails to compile until it names every operation.
 *
 * A `satisfies readonly Operation[]` clause alone proves every listed name is
 * real and says nothing about a method with no entry — which is the direction
 * that matters, because the missing one is the one that cannot be called. When
 * a name is missing this resolves to a tuple with the absentee appended, so the
 * assignment fails and the error names the method.
 */
export type Exhaustive<TOperation extends string, TListed extends readonly TOperation[]> =
  [Exclude<TOperation, TListed[number]>] extends [never]
    ? TListed
    : readonly [...TListed, Exclude<TOperation, TListed[number]>];

/**
 * Positional arguments one operation may carry over the wire.
 *
 * Bounds: elements in the `args` array of an object-port request, before any of
 *   them is parsed.
 * Without it: `args` is unbounded, so an oversized array is held and walked
 *   before dispatch refuses it. What the bound buys is not cheapness — each
 *   element is still unbounded in size — it is that the array's shape stays a
 *   fact rather than caller input.
 * Direction: upper bound. It is 1 because every method on every storage class
 *   behind these ports takes one options object or none, so 1 is the protocol
 *   rather than a margin around it.
 * Trips: the request fails Zod parsing and the endpoint answers 400 with its
 *   own `invalid_*_operation` code, the same one an unknown operation name
 *   takes, because both are a malformed request rather than a refused write.
 * Derive from: the arity of the storage classes. An operation needing a second
 *   positional argument changes this number in the same commit, and the
 *   `Exhaustive` guard is what makes such an addition visible.
 */
export const MAX_OBJECT_PORT_OPERATION_ARGS = 1;

/**
 * The request envelope one endpoint accepts.
 *
 * Identity is validated strictly here and re-checked against the object's own
 * identity before anything executes, which is the check that matters: a
 * misrouted stub must fail rather than write into another work stream. `args`
 * is not re-validated field by field — the caller is this Worker holding a stub
 * for its own object, and the per-argument shapes are enforced at the call site
 * by the port's mapped type, where a mismatch is a compile error.
 */
export function objectPortRequestSchema<TOperation extends string>(
  isOperation: (value: string) => value is TOperation,
  unknownOperationMessage: string,
) {
  return z.object({
    workspaceId: z.string().uuid(),
    workstreamId: z.string().uuid(),
    operation: z.string().min(1).max(64).refine(isOperation, {
      message: unknownOperationMessage,
    }),
    args: z.array(z.unknown()).max(MAX_OBJECT_PORT_OPERATION_ARGS),
  }).strict();
}

/** A membership test over an operation list, for the schema's `refine`. */
export function operationGuard<TOperation extends string>(
  operations: readonly TOperation[],
): (value: string) => value is TOperation {
  const known = new Set<string>(operations);
  return (value): value is TOperation => known.has(value);
}

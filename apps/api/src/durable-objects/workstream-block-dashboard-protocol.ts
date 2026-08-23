import { z } from "zod";

import type { WorkstreamBlockDashboardStorage } from "./workstream-block-dashboard-storage";

/**
 * The wire contract for one work stream's HyperSight block state.
 *
 * Block rows are object-local, but the three writers — the harness runtime, the
 * integrations service, and `BlockDashboardAgent` itself — all run in the
 * Worker. This endpoint is how they reach them. It replaces a routed
 * `D1Database` handle carrying D1-shaped SQL against
 * `_runtime_block_dashboard_runs`, and it replaces a fence-restated-per-write
 * with a fence read once inside the transaction that writes.
 *
 * Derived from `WorkstreamBlockDashboardStorage` rather than restated, so a
 * method added there without a name here is a type error at the
 * `BLOCK_DASHBOARD_OPERATIONS` declaration instead of a silent gap. The same
 * `Exhaustive` guard as the receipt protocol, and for the same reason: a
 * `satisfies` clause alone proves every listed name is real and says nothing
 * about a method with no entry.
 */
export type BlockDashboardOperation = keyof WorkstreamBlockDashboardStorage;

type StorageMethods = {
  [K in keyof WorkstreamBlockDashboardStorage]: WorkstreamBlockDashboardStorage[K] extends (
    ...args: infer A
  ) => infer R
    ? { args: A; result: R }
    : never;
};

/** The typed surface a Worker-side caller sees, one round trip per call. */
export type BlockDashboardObjectPort = {
  [K in keyof StorageMethods]: (
    ...args: StorageMethods[K]["args"]
  ) => Promise<StorageMethods[K]["result"]>;
};

type Exhaustive<T extends readonly BlockDashboardOperation[]> =
  [Exclude<BlockDashboardOperation, T[number]>] extends [never]
    ? T
    : readonly [...T, Exclude<BlockDashboardOperation, T[number]>];

const DISPATCHED_OPERATIONS = [
  "admitDispatch",
  "blockRun",
  "blockRunForHarnessRun",
  "hasPersistedResult",
  "latestConfigurationVersionId",
  "submitMarkdown",
  "settleBlockRun",
  "abandonBlockRun",
] as const satisfies readonly BlockDashboardOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const BLOCK_DASHBOARD_OPERATIONS: Exhaustive<typeof DISPATCHED_OPERATIONS> =
  DISPATCHED_OPERATIONS;

const BLOCK_DASHBOARD_OPERATION_SET = new Set<string>(BLOCK_DASHBOARD_OPERATIONS);

export function isBlockDashboardOperation(value: string): value is BlockDashboardOperation {
  return BLOCK_DASHBOARD_OPERATION_SET.has(value);
}

/**
 * Positional arguments one block-dashboard operation may carry over the wire.
 *
 * Bounds: elements in the `args` array of an `/internal/block-dashboard`
 *   request, before any of them is parsed.
 * Without it: `args` is `z.unknown()`, so an oversized array is held and walked
 *   before dispatch refuses it. What the bound buys is not cheapness — each
 *   element is still unbounded in size — it is that the array's shape stays a
 *   fact rather than caller input.
 * Direction: upper bound. It is 1 because every method on
 *   `WorkstreamBlockDashboardStorage` takes exactly one options object, except
 *   `latestConfigurationVersionId`, which takes none — so 1 is the protocol
 *   rather than a margin around it.
 * Trips: the request fails Zod parsing and the endpoint answers 400
 *   `invalid_block_dashboard_operation`, the same code an unknown operation
 *   name takes, because both are a malformed request rather than a lost lease.
 * Derive from: the arity of the storage class. An operation needing a second
 *   positional argument changes this number in the same commit, and the
 *   `Exhaustive` guard above is what makes such an addition visible.
 */
export const MAX_BLOCK_DASHBOARD_OPERATION_ARGS = 1;

/**
 * The request envelope.
 *
 * Identity is validated strictly here and re-checked against the object's own
 * identity before anything executes, which is the check that matters: a
 * misrouted stub must fail rather than settle another work stream's blocks.
 * `args` is not re-validated field by field — the caller is this Worker holding
 * a stub for its own object, and the per-argument shapes are enforced at the
 * call site by `BlockDashboardObjectPort`, where a mismatch is a compile error.
 */
export const BlockDashboardOperationRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  operation: z.string().min(1).max(64).refine(isBlockDashboardOperation, {
    message: "unknown_block_dashboard_operation",
  }),
  args: z.array(z.unknown()).max(MAX_BLOCK_DASHBOARD_OPERATION_ARGS),
}).strict();

export type BlockDashboardOperationRequest = z.infer<typeof BlockDashboardOperationRequestSchema>;

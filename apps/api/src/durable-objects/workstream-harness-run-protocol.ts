import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamHarnessRunStorage } from "./workstream-harness-run-storage";
import type { z } from "zod";

/**
 * The wire contract for one work stream's harness runs.
 *
 * The sixth authority on this pattern, and the one the other five have been
 * fencing against: every block-dashboard write, every tool receipt and every
 * scope insert proved its right to write by joining `harness_runs` and checking
 * `lease_owner`. Those joins become this port's own fence.
 */
export type HarnessRunOperation = keyof WorkstreamHarnessRunStorage;

export type HarnessRunObjectPort = ObjectPortOf<WorkstreamHarnessRunStorage>;

const DISPATCHED_OPERATIONS = [
  "run",
  "runsByIds",
  "claimAttempt",
  "heartbeatAttempt",
  "attemptOwnership",
  "recordLifecycleEvent",
  "lifecycleEvent",
  "persistScope",
  "scope",
  "persistPluginActivation",
  "recordInferenceAttempt",
  "inlineChildOwnership",
] as const satisfies readonly HarnessRunOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const HARNESS_RUN_OPERATIONS:
  Exhaustive<HarnessRunOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that change what the sidebar shows about a run.
 *
 * A claim is the one that does: `workstreams.harness_status` was the third
 * statement of the routed claim batch, guarded on the first having landed, and
 * it is the directory's projection of exactly this row. Running the claim
 * inside `commitRuntimeMutation` is what replaces that guard — the projection
 * is committed with the claim rather than after it.
 *
 * A heartbeat is not on this list. It moves a deadline nobody renders.
 */
const RUN_STATE_WRITES = new Set<HarnessRunOperation>(["claimAttempt"]);

export function mutatesRunState(operation: HarnessRunOperation): boolean {
  return RUN_STATE_WRITES.has(operation);
}

export const isHarnessRunOperation = operationGuard(HARNESS_RUN_OPERATIONS);

export const HarnessRunOperationRequestSchema = objectPortRequestSchema(
  isHarnessRunOperation,
  "unknown_harness_run_operation",
);

export type HarnessRunOperationRequest = z.infer<typeof HarnessRunOperationRequestSchema>;

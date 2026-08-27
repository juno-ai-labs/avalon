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
type LocalOnlyHarnessRunOperation =
  | "prepareFinalMessage"
  | "publishPreparedFinalMessage";
export type HarnessRunOperation = Exclude<keyof WorkstreamHarnessRunStorage, LocalOnlyHarnessRunOperation>;

export type HarnessRunObjectPort = ObjectPortOf<Pick<WorkstreamHarnessRunStorage, HarnessRunOperation>>;

const DISPATCHED_OPERATIONS = [
  "run",
  "runsByIds",
  "claimAttempt",
  "heartbeatAttempt",
  "attemptOwnership",
  "recordLifecycleEvent",
  "publishFinalMessage",
  "lifecycleEvent",
  "persistScope",
  "scope",
  "memoryContext",
  "persistMemoryContext",
  "persistPluginActivation",
  "recordInferenceAttempt",
  "inlineChildOwnership",
  "admitInlineChild",
  "heartbeatInlineChild",
  "inlineChildByToolCall",
  "terminalizeInlineChild",
  "cancelDescendants",
  "terminalizeAttempt",
  "terminalizeQueuedRun",
  "admitRun",
  "bindWorkflowInstance",
  "launchRun",
  "recordRunProgress",
  "latestRootRun",
  "runIsActive",
  "triggerPartId",
  "failUnlaunchedRun",
  "residualRepairCandidates",
  "staleLeaseRuns",
  "reapStaleRoot",
  "reapableInlineChildren",
  "reapStaleInlineChild",
  "recordReceiptReconciliation",
] as const satisfies readonly HarnessRunOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const HARNESS_RUN_OPERATIONS:
  Exhaustive<HarnessRunOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that write the work stream's own state row.
 *
 * Exactly the operations whose body reaches `markWorkstreamRunning` or
 * `settleWorkstreamState` — the two ends of a run. Both were guarded statements
 * in a routed batch (`workstreams.harness_status`, written only if the batch's
 * earlier statement had landed), and both are the directory's projection of
 * exactly this row, so running them inside `commitRuntimeMutation` is what
 * replaces that guard.
 *
 * **Membership is expensive to get wrong, and it is not obvious from the name
 * of an operation.** `commitRuntimeMutation(…, true)` builds the directory
 * projection, which reads every active participant and walks the work stream's
 * resource links. Putting a read or a frequent progress write on this list —
 * a usage flush, a reaper scan — makes every one of them pay for a projection
 * that cannot have changed. `harness-run-protocol.test.ts` holds this set to
 * the operations that actually touch the `workstream` table.
 *
 * Not on the list, and each for a reason: a heartbeat moves a deadline nobody
 * renders; `bindWorkflowInstance` and `recordRunProgress` write the run's own
 * bookkeeping; a sub-agent's admission and settlement are a tool call inside
 * the parent's turn, and the work stream stays busy until the parent finishes.
 */
const RUN_STATE_WRITES = new Set<HarnessRunOperation>([
  "claimAttempt",
  "admitRun",
  "launchRun",
  "terminalizeAttempt",
  "terminalizeQueuedRun",
  "failUnlaunchedRun",
  "reapStaleRoot",
  "publishFinalMessage",
]);

export function mutatesRunState(operation: HarnessRunOperation): boolean {
  return RUN_STATE_WRITES.has(operation);
}

export const isHarnessRunOperation = operationGuard(HARNESS_RUN_OPERATIONS);

export const HarnessRunOperationRequestSchema = objectPortRequestSchema(
  isHarnessRunOperation,
  "unknown_harness_run_operation",
);

export type HarnessRunOperationRequest = z.infer<typeof HarnessRunOperationRequestSchema>;

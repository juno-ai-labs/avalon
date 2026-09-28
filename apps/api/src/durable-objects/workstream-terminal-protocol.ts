import { z } from "zod";

import type { WorkstreamTerminalStorage } from "./workstream-terminal-storage";

/**
 * The wire contract for one work stream's Terminal authority.
 *
 * Terminal state is object-local, but every caller — the coordinator, the
 * lifecycle sweeper, the tool runtime, the repository selector — runs in the
 * Worker. This endpoint is how they reach it. It replaces a routed
 * `D1Database` handle that carried D1-shaped SQL to a compatibility view; the
 * operations here name what the caller wants rather than the vocabulary a
 * retired database used.
 *
 * The operation set is derived from `WorkstreamTerminalStorage` rather than
 * restated, so a method added there without a name here is a type error at the
 * `TERMINAL_OPERATIONS` declaration instead of a silent gap.
 */
export type TerminalOperation = keyof WorkstreamTerminalStorage;

type StorageMethods = {
  [K in keyof WorkstreamTerminalStorage]: WorkstreamTerminalStorage[K] extends (
    ...args: infer A
  ) => infer R
    ? { args: A; result: R }
    : never;
};

/** The typed surface a Worker-side caller sees, one round trip per call. */
export type TerminalObjectPort = {
  [K in keyof StorageMethods]: (
    ...args: StorageMethods[K]["args"]
  ) => Promise<StorageMethods[K]["result"]>;
};

/** Stable, participant-safe failures returned by the object authority. */
export const TerminalOperationFailureSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("terminal_operation_not_committed"),
    message: z.string().min(1).max(1_000),
    outcome: z.literal("not_committed"),
    retryable: z.literal(true),
  }),
  z.strictObject({
    code: z.literal("invalid_terminal_operation"),
    message: z.string().min(1).max(1_000),
    outcome: z.literal("rejected"),
    retryable: z.literal(false),
  }),
  z.strictObject({
    code: z.literal("workstream_terminal_identity_mismatch"),
    message: z.string().min(1).max(1_000),
    outcome: z.literal("rejected"),
    retryable: z.literal(false),
  }),
  z.strictObject({
    code: z.literal("terminal_operation_protocol_error"),
    message: z.string().min(1).max(1_000),
    outcome: z.literal("unknown"),
    retryable: z.literal(false),
  }),
]);

export type TerminalOperationFailure = z.infer<typeof TerminalOperationFailureSchema>;

/**
 * Demands that a list of operation names covers the whole key set.
 *
 * `satisfies readonly TerminalOperation[]` alone is one-way: it proves every
 * listed name is a real method, and says nothing about a method with no entry.
 * That gap was not theoretical — `TerminalObjectPort` is mapped over
 * `keyof WorkstreamTerminalStorage`, so an unlisted method still appears on the
 * port's type, while `createTerminalObjectPort` builds its object from this
 * list and casts. A caller would have compiled and then found `undefined` at
 * run time.
 *
 * When a name is missing, the required type becomes a longer tuple and the
 * assignment fails naming the absentee, which is the error a reader can act on.
 */
type Exhaustive<T extends readonly TerminalOperation[]> =
  [Exclude<TerminalOperation, T[number]>] extends [never]
    ? T
    : readonly [...T, Exclude<TerminalOperation, T[number]>];

const DISPATCHED_OPERATIONS = [
  "sandbox",
  "providerObservation",
  "beginProviderObservation",
  "settleProviderObservation",
  "nextProviderObservationAt",
  "republishDeadline",
  "reserveFirstGeneration",
  "claimOperation",
  "releaseOperation",
  "claimYieldedOperationRecovery",
  "settleYieldedOperationRecovery",
  "retireYieldedOperationRecovery",
  "retireMissingSandboxAfterLifecycleClaim",
  "renewLifecycleClaim",
  "attachProviderSandbox",
  "failGeneration",
  "setRunning",
  "refreshDeadlines",
  "setAppliedNetworkRevision",
  "replaceGeneration",
  "resetSandbox",
  "claimLifecycleTransition",
  "failLifecycleClaim",
  "settleLifecycleTransition",
  "finalDiffResourceId",
  "setFinalDiffResourceId",
  "settlePolicyTransition",
  "policyTarget",
  "taskByEffect",
  "unsettledTask",
  "hasLiveTask",
  "unsettledTaskCount",
  "insertTask",
  "renewTaskSubmissionAuthority",
  "markTaskRunning",
  "settleTask",
  "attachTaskOutputResource",
  "cancelTaskAfterProviderCleanup",
  "cancelUnsettledTasks",
  "importedResources",
  "recordImportedResource",
  "completeImportedResource",
  "repository",
  "selectedRepository",
  "replaceRepository",
  "recordRepositoryBootstrap",
  "admitPublicationGrant",
  "latestPublicationGrant",
  "consumePublicationGrant",
  "completedPublication",
  "publicationExists",
  "beginPublication",
  "completePublication",
  "markPublicationAmbiguous",
] as const satisfies readonly TerminalOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const TERMINAL_OPERATIONS: Exhaustive<typeof DISPATCHED_OPERATIONS> =
  DISPATCHED_OPERATIONS;

const TERMINAL_OPERATION_SET = new Set<string>(TERMINAL_OPERATIONS);

export function isTerminalOperation(value: string): value is TerminalOperation {
  return TERMINAL_OPERATION_SET.has(value);
}

/**
 * The request envelope.
 *
 * Identity is validated strictly here and re-checked against the object's own
 * identity before anything executes, which is the check that matters: a
 * misrouted stub must fail rather than write another work stream's Terminal
 * state. `args` is not re-validated field by field. The caller is this
 * Worker holding a stub for its own object, and the operation name is a closed
 * protocol vocabulary. Per-argument shapes are enforced at the call site by
 * `TerminalObjectPort`, where a mismatch is a compile error rather than a
 * runtime rejection.
 */
/**
 * Operations that cannot change what the workspace directory publishes.
 *
 * `channels.next_terminal_action_at` is the only input
 * WorkspaceDO's alarm has for Terminal work, and the `directory_common`
 * regional effect is its only writer. That effect is enqueued from
 * `commitRuntimeMutation`, so an operation that moves a deadline in
 * `terminal_workspace` and does not enqueue one leaves the sweep with nothing
 * to run on — and nothing else ever clears a stale value.
 *
 * Reads are listed because they mutate nothing at all. The task, import, and
 * publication writes are listed because they touch tables the directory
 * projection does not read. Everything else — including any operation added
 * later — is treated as directory-affecting: over-publishing costs an outbox
 * row, under-publishing strands the scheduler, so the default falls the safe
 * way rather than relying on the next author to notice this list.
 */
const NON_DIRECTORY_OPERATIONS = new Set<TerminalOperation>([
  // Reads.
  "sandbox",
  "providerObservation",
  "finalDiffResourceId",
  "policyTarget",
  "taskByEffect",
  "unsettledTask",
  "hasLiveTask",
  "unsettledTaskCount",
  "importedResources",
  "nextProviderObservationAt",
  "repository",
  "selectedRepository",
  "latestPublicationGrant",
  "completedPublication",
  "publicationExists",
  // The operation lease. It moves `operation_run_id`, its conversation, its
  // deadline and `last_command_at`, none of which the directory projects,
  // and it moves once per tool call: projecting on every claim would build
  // the participant and link walk per call for a row that never changes.
  "claimOperation",
  "releaseOperation",
  // Provider observation. Its deadline is the owning object's own alarm, not
  // the directory's, so neither reserving nor settling a read republishes: a
  // check that moved only that deadline used to publish twice, 99% of the
  // directory updates in production.
  "beginProviderObservation",
  "settleProviderObservation",
  // Writes that leave `terminal_workspace` alone.
  "insertTask",
  "renewTaskSubmissionAuthority",
  "markTaskRunning",
  "settleTask",
  "attachTaskOutputResource",
  "cancelTaskAfterProviderCleanup",
  "cancelUnsettledTasks",
  "recordImportedResource",
  "completeImportedResource",
  "recordRepositoryBootstrap",
  "admitPublicationGrant",
  "consumePublicationGrant",
  "beginPublication",
  "completePublication",
  "markPublicationAmbiguous",
]);

/** Whether this operation has to republish the work stream's directory row. */
export function terminalOperationAffectsDirectory(operation: TerminalOperation): boolean {
  return !NON_DIRECTORY_OPERATIONS.has(operation);
}

export const TerminalOperationRequestSchema = z.strictObject({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  /** Which of the parent's conversations; absent means the main one. */
  substreamId: z.union([z.literal("0"), z.string().uuid()]).optional(),
  operation: z.string().min(1).max(64).refine(isTerminalOperation, {
    message: "unknown_terminal_operation",
  }),
  args: z.array(z.unknown()).max(4),
});

export type TerminalOperationRequest = z.infer<typeof TerminalOperationRequestSchema>;

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

/**
 * Every operation the endpoint will dispatch.
 *
 * Typed as the full key set of the storage class, so this list cannot drift
 * from it: dropping a name fails to satisfy `readonly TerminalOperation[]`
 * only if the name is also removed from the class, and adding a name that is
 * not a method fails immediately.
 */
export const TERMINAL_OPERATIONS = [
  "sandbox",
  "reserveFirstGeneration",
  "claimOperation",
  "releaseOperation",
  "attachProviderSandbox",
  "failGeneration",
  "setRunning",
  "refreshDeadlines",
  "setAppliedNetworkRevision",
  "replaceGeneration",
  "deleteSandbox",
  "resetSandbox",
  "claimLifecycleTransition",
  "failLifecycleClaim",
  "settleLifecycleTransition",
  "finalDiffResourceId",
  "setFinalDiffResourceId",
  "settlePolicyTransition",
  "policyTarget",
  "taskByEffect",
  "hasLiveTask",
  "unsettledTaskCount",
  "insertTask",
  "settleTask",
  "cancelUnsettledTasks",
  "importedResources",
  "recordImportedResource",
  "completeImportedResource",
  "repository",
  "selectedRepository",
  "selectRepository",
  "replaceRepository",
  "recordRepositoryBootstrap",
  "clearRepositoryBootstrap",
  "admitPublicationGrant",
  "latestPublicationGrant",
  "consumePublicationGrant",
  "completedPublication",
  "publicationExists",
  "beginPublication",
  "completePublication",
  "markPublicationAmbiguous",
] as const satisfies readonly TerminalOperation[];

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
 * Worker holding a stub for its own object — the same trust boundary that
 * already lets `/internal/runtime-sql` accept arbitrary SQL — and the
 * per-argument shapes are enforced at the call site by `TerminalObjectPort`,
 * where a mismatch is a compile error rather than a runtime rejection.
 */
export const TerminalOperationRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  operation: z.string().min(1).max(64).refine(isTerminalOperation, {
    message: "unknown_terminal_operation",
  }),
  args: z.array(z.unknown()).max(4),
}).strict();

export type TerminalOperationRequest = z.infer<typeof TerminalOperationRequestSchema>;

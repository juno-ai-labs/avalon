import type {
  HarnessRunObjectPort,
  HarnessRunOperation,
} from "../durable-objects/workstream-harness-run-protocol";
import { HARNESS_RUN_OPERATIONS } from "../durable-objects/workstream-harness-run-protocol";
import type { WorkstreamHarnessRunStorage } from "../durable-objects/workstream-harness-run-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one work stream's runs; injected so callers stay testable. */
export type HarnessRunPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => HarnessRunObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamHarnessRunStorage, HarnessRunOperation> = {
  authority: "harnessRun",
  operations: HARNESS_RUN_OPERATIONS,
  dispatch: (stub, request) => stub.executeHarnessRunOperation(request),
  failureCode: "harness_run_operation_failed",
  failureMessage: "Avalon's harness-run authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createHarnessRunPortFactory(
  env: Env,
  localStorage?: WorkstreamHarnessRunStorage,
): HarnessRunPortFactory {
  return (workspaceId, workstreamId) =>
    createHarnessRunObjectPort(env, workspaceId, workstreamId, localStorage);
}

/** A Worker-side handle on one work stream's harness runs. */
export function createHarnessRunObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamHarnessRunStorage,
): HarnessRunObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage);
}

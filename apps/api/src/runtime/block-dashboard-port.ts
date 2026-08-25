import {
  BLOCK_DASHBOARD_OPERATIONS,
  type BlockDashboardObjectPort,
  type BlockDashboardOperation,
} from "../durable-objects/workstream-block-dashboard-protocol";
import type { WorkstreamBlockDashboardStorage } from "../durable-objects/workstream-block-dashboard-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one run's work stream; injected so callers stay testable. */
export type BlockDashboardPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => BlockDashboardObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamBlockDashboardStorage, BlockDashboardOperation> = {
  authority: "blockDashboard",
  operations: BLOCK_DASHBOARD_OPERATIONS,
  dispatch: (stub, request) => stub.executeBlockDashboardOperation(request),
  failureCode: "block_dashboard_operation_failed",
  failureMessage: "Avalon's HyperSight authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createBlockDashboardPortFactory(
  env: Env,
  localStorage?: WorkstreamBlockDashboardStorage,
): BlockDashboardPortFactory {
  return (workspaceId, workstreamId) =>
    createBlockDashboardObjectPort(env, workspaceId, workstreamId, localStorage);
}

/** A Worker-side handle on one work stream's HyperSight block state. */
export function createBlockDashboardObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamBlockDashboardStorage,
): BlockDashboardObjectPort {
  return createObjectPort(
    env,
    workspaceId,
    workstreamId,
    CONTRACT,
    localStorage,
  );
}

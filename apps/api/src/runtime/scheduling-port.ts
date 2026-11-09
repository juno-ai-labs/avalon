import {
  SCHEDULING_OPERATIONS,
  type SchedulingObjectPort,
  type SchedulingOperation,
} from "../durable-objects/workstream-scheduling-protocol";
import type { WorkstreamSchedulingStorage } from "../durable-objects/workstream-scheduling-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one work stream; injected so callers stay testable. */
export type SchedulingPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => SchedulingObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamSchedulingStorage, SchedulingOperation> = {
  authority: "scheduling",
  operations: SCHEDULING_OPERATIONS,
  dispatch: (stub, request) => stub.executeSchedulingOperation(request),
  failureCode: "scheduling_operation_failed",
  failureMessage: "Rally's scheduling authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createSchedulingPortFactory(
  env: Env,
  localStorage?: WorkstreamSchedulingStorage,
): SchedulingPortFactory {
  return (workspaceId, workstreamId) =>
    createSchedulingObjectPort(env, workspaceId, workstreamId, localStorage);
}

/**
 * A Worker-side handle on one work stream's scheduling state.
 *
 * Each method is one round trip to the owning AgentLoopDO, where the whole
 * operation runs synchronously against the object's SQLite. Callers never see
 * SQL, a table name, or a database handle.
 */
export function createSchedulingObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  /** The same in-isolate seam the other durable runtime ports take. */
  localStorage?: WorkstreamSchedulingStorage,
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string,
): SchedulingObjectPort {
  return createObjectPort(
    env,
    workspaceId,
    workstreamId,
    CONTRACT,
    localStorage,
    substreamId,
  );
}

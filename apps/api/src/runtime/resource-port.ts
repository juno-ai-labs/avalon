import type { ResourceObjectPort, ResourceOperation } from "../durable-objects/workstream-resource-protocol";
import { RESOURCE_OPERATIONS } from "../durable-objects/workstream-resource-protocol";
import type { WorkstreamResourceStorage } from "../durable-objects/workstream-resource-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one work stream's attachments; injected so callers stay testable. */
export type ResourcePortFactory = (
  workspaceId: string,
  workstreamId: string,
) => ResourceObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamResourceStorage, ResourceOperation> = {
  authority: "resource",
  operations: RESOURCE_OPERATIONS,
  dispatch: (stub, request) => stub.executeResourceOperation(request),
  failureCode: "resource_operation_failed",
  failureMessage: "Avalon's resource authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createResourcePortFactory(
  env: Env,
  localStorage?: WorkstreamResourceStorage,
): ResourcePortFactory {
  return (workspaceId, workstreamId) =>
    createResourceObjectPort(env, workspaceId, workstreamId, localStorage);
}

/** A Worker-side handle on one work stream's resource attachments. */
export function createResourceObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamResourceStorage,
): ResourceObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage);
}

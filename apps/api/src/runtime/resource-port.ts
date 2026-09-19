import type { ResourceObjectPort, ResourceOperation } from "../durable-objects/workstream-resource-protocol";
import { RESOURCE_OPERATIONS } from "../durable-objects/workstream-resource-protocol";
import type { WorkstreamResourceStorage } from "../durable-objects/workstream-resource-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/**
 * Builds a port for one conversation's attachments; injected so callers stay
 * testable. No substream means the conversation the run executes in; one
 * named is answered locally only by that conversation's own object and goes
 * over the wire from any other, as every object port does.
 */
export type ResourcePortFactory = (
  workspaceId: string,
  workstreamId: string,
  substreamId?: string,
) => ResourceObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamResourceStorage, ResourceOperation> = {
  authority: "resource",
  operations: RESOURCE_OPERATIONS,
  dispatch: (stub, request) => stub.executeResourceOperation(request),
  failureCode: "resource_operation_failed",
  failureMessage: "Rally's resource authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createResourcePortFactory(
  env: Env,
  localStorage?: WorkstreamResourceStorage,
): ResourcePortFactory {
  return (workspaceId, workstreamId, substreamId) =>
    createResourceObjectPort(env, workspaceId, workstreamId, localStorage, substreamId);
}

/** A Worker-side handle on one work stream's resource attachments. */
export function createResourceObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamResourceStorage,
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string,
): ResourceObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage, substreamId);
}

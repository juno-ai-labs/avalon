import type {
  IdentityObjectPort,
  IdentityOperation,
} from "../durable-objects/workstream-identity-protocol";
import { IDENTITY_OPERATIONS } from "../durable-objects/workstream-identity-protocol";
import type { WorkstreamIdentityStorage } from "../durable-objects/workstream-identity-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one work stream's identity; injected so callers stay testable. */
export type IdentityPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => IdentityObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamIdentityStorage, IdentityOperation> = {
  authority: "identity",
  operations: IDENTITY_OPERATIONS,
  dispatch: (stub, request) => stub.executeIdentityOperation(request),
  failureCode: "identity_operation_failed",
  failureMessage: "Avalon's work-stream identity authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createIdentityPortFactory(
  env: Env,
  localStorage?: WorkstreamIdentityStorage,
): IdentityPortFactory {
  return (workspaceId, workstreamId) =>
    createIdentityObjectPort(env, workspaceId, workstreamId, localStorage);
}

/** A Worker-side handle on one work stream's identity and its members. */
export function createIdentityObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamIdentityStorage,
): IdentityObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage);
}

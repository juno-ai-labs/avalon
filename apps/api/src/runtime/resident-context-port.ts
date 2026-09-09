import {
  RESIDENT_CONTEXT_OPERATIONS,
  type ResidentContextObjectPort,
  type ResidentContextOperation,
} from "../durable-objects/workstream-resident-context-protocol";
import type { WorkstreamResidentContextStorage } from "../durable-objects/workstream-resident-context-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/**
 * Builds a port for one conversation's context-residency ledger.
 *
 * The substream is named because residency is a fact about one transcript: a
 * child conversation's ledger is its own, and a port built from inside that
 * child resolves to the child's storage rather than the parent's.
 */
export type ResidentContextPortFactory = (
  workspaceId: string,
  workstreamId: string,
  substreamId: string,
) => ResidentContextObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamResidentContextStorage, ResidentContextOperation> = {
  authority: "residentContext",
  operations: RESIDENT_CONTEXT_OPERATIONS,
  dispatch: (stub, request) => stub.executeResidentContextOperation(request),
  failureCode: "resident_context_operation_failed",
  failureMessage: "Rally's context-residency authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createResidentContextPortFactory(
  env: Env,
  localStorage?: WorkstreamResidentContextStorage,
): ResidentContextPortFactory {
  return (workspaceId, workstreamId, substreamId) =>
    createResidentContextObjectPort(env, workspaceId, workstreamId, localStorage, substreamId);
}

export function createResidentContextObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamResidentContextStorage,
  substreamId: string = "0",
): ResidentContextObjectPort {
  return createObjectPort(
    env,
    workspaceId,
    workstreamId,
    CONTRACT,
    localStorage,
    substreamId,
  );
}

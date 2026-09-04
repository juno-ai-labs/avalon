import {
  MESSAGE_OPERATIONS,
  type MessageObjectPort,
  type MessageOperation,
} from "../durable-objects/workstream-message-protocol";
import type { WorkstreamMessageStorage } from "../durable-objects/workstream-message-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one work stream's transcript; injected so callers stay testable. */
export type MessagePortFactory = (
  workspaceId: string,
  workstreamId: string,
) => MessageObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamMessageStorage, MessageOperation> = {
  authority: "message",
  operations: MESSAGE_OPERATIONS,
  dispatch: (stub, request) => stub.executeMessageOperation(request),
  failureCode: "message_operation_failed",
  failureMessage: "Rally's transcript authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createMessagePortFactory(
  env: Env,
  localStorage?: WorkstreamMessageStorage,
): MessagePortFactory {
  return (workspaceId, workstreamId) =>
    createMessageObjectPort(env, workspaceId, workstreamId, localStorage);
}

/** A Worker-side handle on one work stream's transcript. */
export function createMessageObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamMessageStorage,
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string,
): MessageObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage, substreamId);
}

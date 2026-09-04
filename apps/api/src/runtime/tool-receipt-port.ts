import {
  TOOL_RECEIPT_OPERATIONS,
  type ToolReceiptObjectPort,
  type ToolReceiptOperation,
} from "../durable-objects/workstream-tool-receipt-protocol";
import type { WorkstreamToolReceiptStorage } from "../durable-objects/workstream-tool-receipt-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

/** Builds a port for one run's work stream; injected so callers stay testable. */
export type ToolReceiptPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => ToolReceiptObjectPort;

const CONTRACT: ObjectPortContract<WorkstreamToolReceiptStorage, ToolReceiptOperation> = {
  authority: "toolReceipt",
  operations: TOOL_RECEIPT_OPERATIONS,
  dispatch: (stub, request) => stub.executeToolReceiptOperation(request),
  failureCode: "tool_receipt_operation_failed",
  failureMessage: "Rally's receipt authority rejected an internal request. Retry after the application and service versions are aligned.",
};

export function createToolReceiptPortFactory(
  env: Env,
  localStorage?: WorkstreamToolReceiptStorage,
): ToolReceiptPortFactory {
  return (workspaceId, workstreamId) =>
    createToolReceiptObjectPort(env, workspaceId, workstreamId, localStorage);
}

/** A Worker-side handle on one work stream's durable receipts. */
export function createToolReceiptObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamToolReceiptStorage,
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string,
): ToolReceiptObjectPort {
  return createObjectPort(
    env,
    workspaceId,
    workstreamId,
    CONTRACT,
    localStorage,
    substreamId,
  );
}

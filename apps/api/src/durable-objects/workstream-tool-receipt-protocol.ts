import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamToolReceiptStorage } from "./workstream-tool-receipt-storage";
import type { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

/**
 * The wire contract for one work stream's durable tool receipts.
 *
 * Receipt state is object-local, but the only writer — `harness-run-runtime.ts`
 * — runs in the Worker. This endpoint is how it reaches it. It replaces a routed
 * `D1Database` handle that carried D1-shaped SQL naming `tool_invocations` to a
 * compatibility view, and it replaces *three* round trips per operation with one:
 * the lease fence, the write, and the reconcile now happen inside a single
 * transaction on the object rather than being restated in SQL each trip.
 */
export type ToolReceiptOperation = keyof WorkstreamToolReceiptStorage;

export type ToolReceiptObjectPort = ObjectPortOf<WorkstreamToolReceiptStorage>;

const DISPATCHED_OPERATIONS = [
  "executionAccount",
  "resourceExecutionAccounts",
  "recordExecutionAccount",
  "issuePage",
  "claimPage",
  "admit",
  "checkpoint",
  "complete",
  "fail",
  "settleResidualReceipts",
  "receiptForCall",
  "receiptsForRun",
  "canvaCleanupForRun",
  "canvaTransactionOwned",
  "claimCanvaCleanup",
  "settleCanvaCleanup",
  "receiptsForCapabilities",
  "receiptsByIds",
  "attachmentDependencies",
  "recordAttachmentDependencies",
  "clearAttachmentDependencies",
  "discardReceipt",
  "seedDevelopmentReceipt",
] as const satisfies readonly ToolReceiptOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const TOOL_RECEIPT_OPERATIONS:
  Exhaustive<ToolReceiptOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

export const isToolReceiptOperation = operationGuard(TOOL_RECEIPT_OPERATIONS);

export const ToolReceiptOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isToolReceiptOperation,
  "unknown_tool_receipt_operation",
));

export type ToolReceiptOperationRequest = z.infer<typeof ToolReceiptOperationRequestSchema>;

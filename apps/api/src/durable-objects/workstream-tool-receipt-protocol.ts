import { z } from "zod";

import type { WorkstreamToolReceiptStorage } from "./workstream-tool-receipt-storage";

/**
 * The wire contract for one work stream's durable tool receipts.
 *
 * Receipt state is object-local, but the only writer — `harness-run-runtime.ts`
 * — runs in the Worker. This endpoint is how it reaches it. It replaces a routed
 * `D1Database` handle that carried D1-shaped SQL naming `tool_invocations` to a
 * compatibility view, and it replaces *three* round trips per operation with one:
 * the lease fence, the write, and the reconcile now happen inside a single
 * transaction on the object rather than being restated in SQL each trip.
 *
 * The operation set is derived from `WorkstreamToolReceiptStorage` rather than
 * restated, so a method added there without a name here is a type error at the
 * `TOOL_RECEIPT_OPERATIONS` declaration instead of a silent gap.
 */
export type ToolReceiptOperation = keyof WorkstreamToolReceiptStorage;

type StorageMethods = {
  [K in keyof WorkstreamToolReceiptStorage]: WorkstreamToolReceiptStorage[K] extends (
    ...args: infer A
  ) => infer R
    ? { args: A; result: R }
    : never;
};

/** The typed surface a Worker-side caller sees, one round trip per call. */
export type ToolReceiptObjectPort = {
  [K in keyof StorageMethods]: (
    ...args: StorageMethods[K]["args"]
  ) => Promise<StorageMethods[K]["result"]>;
};

/**
 * Demands that a list of operation names covers the whole key set.
 *
 * `satisfies readonly ToolReceiptOperation[]` alone is one-way: it proves every
 * listed name is a real method and says nothing about a method with no entry.
 * That gap is not theoretical — `ToolReceiptObjectPort` is mapped over
 * `keyof WorkstreamToolReceiptStorage`, so an unlisted method still appears on
 * the port's type while the port object is built from this list, and a caller
 * would compile and then find `undefined` at run time.
 */
type Exhaustive<T extends readonly ToolReceiptOperation[]> =
  [Exclude<ToolReceiptOperation, T[number]>] extends [never]
    ? T
    : readonly [...T, Exclude<ToolReceiptOperation, T[number]>];

const DISPATCHED_OPERATIONS = [
  "admit",
  "checkpoint",
  "complete",
  "fail",
  "settleResidualReceipts",
  "receiptForCall",
  "receiptsByIds",
  "attachmentDependencies",
  "recordAttachmentDependencies",
  "clearAttachmentDependencies",
  "discardReceipt",
] as const satisfies readonly ToolReceiptOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const TOOL_RECEIPT_OPERATIONS: Exhaustive<typeof DISPATCHED_OPERATIONS> =
  DISPATCHED_OPERATIONS;

const TOOL_RECEIPT_OPERATION_SET = new Set<string>(TOOL_RECEIPT_OPERATIONS);

export function isToolReceiptOperation(value: string): value is ToolReceiptOperation {
  return TOOL_RECEIPT_OPERATION_SET.has(value);
}
/**
 * Positional arguments one receipt operation may carry over the wire.
 *
 * Bounds: elements in the `args` array of a `/internal/tool-receipt` request,
 *   before any of them is parsed.
 * Without it: `args` is `z.unknown()`, so an oversized array is held and walked
 *   before dispatch refuses it. The bound is not what makes that cheap — each
 *   element is still unbounded in size — it is what keeps the array's shape a
 *   fact rather than caller input.
 * Direction: upper bound. It is 1 because every method on
 *   `WorkstreamToolReceiptStorage` takes exactly one options object, so 1 is the
 *   protocol rather than a margin around it; the previous 4 was slack with
 *   nothing behind it.
 * Trips: the request fails Zod parsing and the endpoint answers 400
 *   `invalid_tool_receipt_operation` — the same code an unknown operation name
 *   takes, because both are a malformed request rather than a lost lease, and
 *   the port surfaces it as an error rather than an outcome.
 * Derive from: the arity of the storage class. An operation that ever needs a
 *   second positional argument changes this number in the same commit, and the
 *   `Exhaustive` guard above is what makes such an addition visible.
 */
export const MAX_TOOL_RECEIPT_OPERATION_ARGS = 1;

/**
 * The request envelope.
 *
 * Identity is validated strictly here and re-checked against the object's own
 * identity before anything executes, which is the check that matters: a
 * misrouted stub must fail rather than settle another work stream's receipts.
 * `args` is not re-validated field by field — the caller is this Worker holding
 * a stub for its own object, and the per-argument shapes are enforced at the
 * call site by `ToolReceiptObjectPort`, where a mismatch is a compile error.
 */
export const ToolReceiptOperationRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  operation: z.string().min(1).max(64).refine(isToolReceiptOperation, {
    message: "unknown_tool_receipt_operation",
  }),
  args: z.array(z.unknown()).max(MAX_TOOL_RECEIPT_OPERATION_ARGS),
}).strict();

export type ToolReceiptOperationRequest = z.infer<typeof ToolReceiptOperationRequestSchema>;

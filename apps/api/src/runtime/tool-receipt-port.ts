import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import {
  TOOL_RECEIPT_OPERATIONS,
  type ToolReceiptObjectPort,
  type ToolReceiptOperation,
} from "../durable-objects/workstream-tool-receipt-protocol";
import type { WorkstreamToolReceiptStorage } from "../durable-objects/workstream-tool-receipt-storage";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/** Builds a port for one run's work stream; injected so callers stay testable. */
export type ToolReceiptPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => ToolReceiptObjectPort;

/**
 * The object rejected the request itself — a bad protocol or a misrouted stub.
 *
 * Distinct from a lost lease, which is a normal end to a run and is returned in
 * the operation's own result rather than thrown. Anything that reaches here is
 * a defect in the caller or the routing, not a state a run can be in.
 */
export class ToolReceiptPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolReceiptPortError";
  }
}

export function createToolReceiptPortFactory(
  env: Env,
  localStorage?: WorkstreamToolReceiptStorage,
): ToolReceiptPortFactory {
  return (workspaceId, workstreamId) =>
    createToolReceiptObjectPort(env, workspaceId, workstreamId, localStorage);
}

/**
 * A Worker-side handle on one work stream's durable receipts.
 *
 * Each method is one round trip to the owning SubstreamAgent, where the whole
 * operation — fence, write, and reconcile — runs synchronously against the
 * object's SQLite. Callers never see SQL, a table name, or a database handle.
 */
export function createToolReceiptObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  /**
   * Run operations against a storage instance in this isolate instead of
   * dispatching to the object.
   *
   * The same seam the Terminal port takes, for the same reason: the Node suite
   * runs the real schema and the real statements over `node:sqlite`, which is
   * honest coverage of everything except the runtime. What the runtime decides
   * — that the transaction is atomic against a concurrent caller, that the
   * lease cannot lapse mid-operation — belongs in `test-workers/`, where this
   * override is not used.
   */
  localStorage?: WorkstreamToolReceiptStorage,
): ToolReceiptObjectPort {
  const call = async (operation: ToolReceiptOperation, args: unknown[]): Promise<unknown> => {
    if (localStorage) {
      const method = localStorage[operation] as (...rest: unknown[]) => unknown;
      // `?? null` so this path answers exactly as the remote one does. JSON has
      // no `undefined`: over RPC a method returning it arrives as an absent
      // `value`, which the caller below reads as `null`. Dropping the coalesce
      // here would not preserve `undefined` end to end — it would only make the
      // Node suite disagree with production about a method that returned one.
      return method.apply(localStorage, args) ?? null;
    }
    const stub = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      asWorkspaceId(workspaceId),
      substreamAgentName(
        env.AVALON_REGION,
        asWorkspaceId(workspaceId),
        asWorkstreamId(workstreamId),
      ),
    );
    const result = await stub.executeToolReceiptOperation({
      workspaceId,
      workstreamId,
      operation,
      args,
    });
    const body = rpcResultBody(result) as {
      ok?: boolean;
      value?: unknown;
      error?: string;
    } | null;
    if (!body?.ok) {
      throw new ToolReceiptPortError(
        body?.error ?? "tool_receipt_operation_failed",
        "Avalon's receipt authority rejected an internal request. Retry after the application and service versions are aligned.",
      );
    }
    return body.value ?? null;
  };

  // Built from the operation list rather than written out method by method, so
  // a name cannot be forwarded wrong; the mapped type already fixes each
  // signature to its storage counterpart.
  return Object.fromEntries(
    TOOL_RECEIPT_OPERATIONS.map((operation) => [
      operation,
      (...args: unknown[]) => call(operation, args),
    ]),
  ) as ToolReceiptObjectPort;
}

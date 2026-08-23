import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import {
  BLOCK_DASHBOARD_OPERATIONS,
  type BlockDashboardObjectPort,
  type BlockDashboardOperation,
} from "../durable-objects/workstream-block-dashboard-protocol";
import type { WorkstreamBlockDashboardStorage } from "../durable-objects/workstream-block-dashboard-storage";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/** Builds a port for one run's work stream; injected so callers stay testable. */
export type BlockDashboardPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => BlockDashboardObjectPort;

/**
 * The object rejected the request itself — a bad protocol or a misrouted stub.
 *
 * Distinct from a lost lease, which is an ordinary end to a block run and is
 * returned in the operation's own result rather than thrown. Anything reaching
 * here is a defect in the caller or the routing, not a state a run can be in.
 */
export class BlockDashboardPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BlockDashboardPortError";
  }
}

export function createBlockDashboardPortFactory(
  env: Env,
  localStorage?: WorkstreamBlockDashboardStorage,
): BlockDashboardPortFactory {
  return (workspaceId, workstreamId) =>
    createBlockDashboardObjectPort(env, workspaceId, workstreamId, localStorage);
}

/**
 * A Worker-side handle on one work stream's HyperSight block state.
 *
 * Each method is one round trip to the owning SubstreamAgent, where the whole
 * operation — lease fence and write — runs synchronously against the object's
 * SQLite. Callers never see SQL, a table name, or a database handle.
 */
export function createBlockDashboardObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  /**
   * Run operations against a storage instance in this isolate instead of
   * dispatching to the object. The same seam the receipt port takes, for the
   * same reason: the Node suite runs the real schema and the real statements
   * over `node:sqlite`, and what the runtime decides belongs in
   * `test-workers/`, where this override is not used.
   */
  localStorage?: WorkstreamBlockDashboardStorage,
): BlockDashboardObjectPort {
  const call = async (operation: BlockDashboardOperation, args: unknown[]): Promise<unknown> => {
    if (localStorage) {
      const method = localStorage[operation] as (...rest: unknown[]) => unknown;
      // `?? null` so this path answers exactly as the remote one does; see the
      // receipt port, where the same coalesce is explained at length.
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
    const result = await stub.executeBlockDashboardOperation({
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
      throw new BlockDashboardPortError(
        body?.error ?? "block_dashboard_operation_failed",
        "Avalon's HyperSight authority rejected an internal request. Retry after the application and service versions are aligned.",
      );
    }
    return body.value ?? null;
  };

  // Built from the operation list rather than written out method by method, so
  // a name cannot be forwarded wrong; the mapped type already fixes each
  // signature to its storage counterpart.
  return Object.fromEntries(
    BLOCK_DASHBOARD_OPERATIONS.map((operation) => [
      operation,
      (...args: unknown[]) => call(operation, args),
    ]),
  ) as BlockDashboardObjectPort;
}

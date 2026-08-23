import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import {
  SCHEDULING_OPERATIONS,
  type SchedulingObjectPort,
  type SchedulingOperation,
} from "../durable-objects/workstream-scheduling-protocol";
import type { WorkstreamSchedulingStorage } from "../durable-objects/workstream-scheduling-storage";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/** Builds a port for one work stream; injected so callers stay testable. */
export type SchedulingPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => SchedulingObjectPort;

/**
 * The object rejected the request itself — a bad protocol or a misrouted stub.
 *
 * Distinct from a lost claim, which is an ordinary outcome and is returned in
 * the operation's own result rather than thrown.
 */
export class SchedulingPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SchedulingPortError";
  }
}

export function createSchedulingPortFactory(
  env: Env,
  localStorage?: WorkstreamSchedulingStorage,
): SchedulingPortFactory {
  return (workspaceId, workstreamId) =>
    createSchedulingObjectPort(env, workspaceId, workstreamId, localStorage);
}

/**
 * A Worker-side handle on one work stream's scheduling state.
 *
 * Each method is one round trip to the owning SubstreamAgent, where the whole
 * operation runs synchronously against the object's SQLite. Callers never see
 * SQL, a table name, or a database handle.
 */
export function createSchedulingObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  /** The same in-isolate seam the receipt and block-dashboard ports take. */
  localStorage?: WorkstreamSchedulingStorage,
): SchedulingObjectPort {
  const call = async (operation: SchedulingOperation, args: unknown[]): Promise<unknown> => {
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
    const result = await stub.executeSchedulingOperation({
      workspaceId,
      workstreamId,
      operation,
      args,
    });
    const body = rpcResultBody(result) as { ok?: boolean; value?: unknown; error?: string } | null;
    if (!body?.ok) {
      throw new SchedulingPortError(
        body?.error ?? "scheduling_operation_failed",
        "Avalon's scheduling authority rejected an internal request. Retry after the application and service versions are aligned.",
      );
    }
    return body.value ?? null;
  };

  // Built from the operation list rather than method by method, so a name
  // cannot be forwarded wrong; the mapped type fixes each signature already.
  return Object.fromEntries(
    SCHEDULING_OPERATIONS.map((operation) => [
      operation,
      (...args: unknown[]) => call(operation, args),
    ]),
  ) as SchedulingObjectPort;
}

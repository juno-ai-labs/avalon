import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../../durable-objects/names";
import { rpcResultBody } from "../../durable-objects/rpc-result";
import {
  TERMINAL_OPERATIONS,
  type TerminalObjectPort,
  type TerminalOperation,
} from "../../durable-objects/workstream-terminal-protocol";
import type { Env } from "../../env";
import type { WorkstreamTerminalStorage } from "../../durable-objects/workstream-terminal-storage";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";

/** Builds a port for one work stream; injected so callers stay testable. */
export type TerminalPortFactory = (
  workspaceId: string,
  workstreamId: string,
) => TerminalObjectPort;

/**
 * Bind a factory to an environment, optionally to in-isolate storage.
 *
 * Services take the factory rather than an `Env` so the Node suite can hand
 * them a port over `node:sqlite` running the real object schema, and the
 * workerd suite can hand them the real thing, without either needing to know
 * how a stub is resolved.
 */
export function createTerminalPortFactory(
  env: Env,
  localStorage?: WorkstreamTerminalStorage,
): TerminalPortFactory {
  return (workspaceId, workstreamId) =>
    createTerminalObjectPort(env, workspaceId, workstreamId, localStorage);
}

/**
 * A Worker-side handle on one work stream's Terminal authority.
 *
 * Each method is one round trip to the owning SubstreamAgent, where the whole
 * operation runs synchronously against the object's SQLite. Callers never see
 * SQL, a table name, or a database handle: the previous arrangement typed this
 * as `D1Database` and prepared statements naming `workstream_sandboxes`, a
 * table that has not existed in D1 since the legacy product schema was
 * retired, and which inside the object was a compatibility view over
 * `terminal_workspace`.
 *
 * Timestamps are unix milliseconds in both directions, matching the object.
 */
export function createTerminalObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  /**
   * Run operations against a storage instance in this isolate instead of
   * dispatching to the object.
   *
   * The same seam `workstreamRuntimeDatabase` takes for its local executor,
   * and for the same reason: the Node suite runs the real schema and the real
   * statements over `node:sqlite`, which is honest coverage of everything
   * except the runtime itself. What the runtime decides — that the operation
   * is serialized against concurrent callers, that a transaction rolls back,
   * that an alarm sees the committed row — is proved in `test-workers/`
   * against real workerd, where this override is not used.
   */
  localStorage?: WorkstreamTerminalStorage,
): TerminalObjectPort {
  const call = async (operation: TerminalOperation, args: unknown[]): Promise<unknown> => {
    if (localStorage) {
      const method = localStorage[operation] as (...rest: unknown[]) => unknown;
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
    const result = await stub.executeTerminalOperation({
      workspaceId,
      workstreamId,
      operation,
      args,
    });
    const body = rpcResultBody(result) as { ok?: boolean; value?: unknown; error?: string } | null;
    if (!body?.ok) throw new Error(body?.error ?? "terminal_operation_failed");
    return body.value ?? null;
  };

  // Built from the operation list rather than written out method by method: a
  // hand-written facade over forty operations is forty chances for one of them
  // to forward the wrong name, and the mapped type already fixes each
  // signature to its storage counterpart.
  return Object.fromEntries(
    TERMINAL_OPERATIONS.map((operation) => [
      operation,
      (...args: unknown[]) => call(operation, args),
    ]),
  ) as TerminalObjectPort;
}

import { asWorkspaceId, asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../../durable-objects/names";
import { rpcResultBody } from "../../durable-objects/rpc-result";
import {
  TERMINAL_OPERATIONS,
  TerminalOperationFailureSchema,
  type TerminalObjectPort,
  type TerminalOperationFailure,
  type TerminalOperation,
} from "../../durable-objects/workstream-terminal-protocol";
import type { Env } from "../../env";
import { localWorkstreamAuthority } from "../../runtime/local-authorities";
import type { WorkstreamTerminalStorage } from "../../durable-objects/workstream-terminal-storage";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";

/**
 * Builds a port for one conversation's Terminal authority; injected so callers
 * stay testable.
 *
 * `substreamId` names the conversation whose AgentLoopDO owns the sandbox
 * rows. A factory bound at plugin composition already carries the run's
 * authority substream, so its callers omit it; the lifecycle sweep, the
 * settings service, and the Daytona webhook name one explicitly because they
 * address sandboxes that are not their own.
 */
export type TerminalPortFactory = (
  workspaceId: string,
  workstreamId: string,
  substreamId?: string,
) => TerminalObjectPort;

/** Execute one operation without crossing a Durable Object request boundary. */
export type TerminalOperationExecutor = (
  operation: TerminalOperation,
  args: unknown[],
) => Promise<unknown>;

/** A typed failure from the object-local Terminal authority with explicit retry safety. */
export class TerminalObjectPortError extends Error {
  readonly code: TerminalOperationFailure["code"];
  readonly details: {
    operation: TerminalOperation;
    outcome: TerminalOperationFailure["outcome"];
    retryable: TerminalOperationFailure["retryable"];
  };

  constructor(operation: TerminalOperation, failure: TerminalOperationFailure) {
    super(failure.message);
    this.name = "TerminalObjectPortError";
    this.code = failure.code;
    this.details = {
      operation,
      outcome: failure.outcome,
      retryable: failure.retryable,
    };
  }
}

/**
 * Bind a factory to an environment, optionally to in-isolate authority.
 *
 * Services take the factory rather than an `Env` so the Node suite can hand
 * them a port over `node:sqlite` running the real object schema, and the
 * workerd suite can hand them the real thing, without either needing to know
 * how a stub is resolved.
 */
export function createTerminalPortFactory(
  env: Env,
  local?: WorkstreamTerminalStorage | TerminalOperationExecutor,
  /**
   * The conversation every port from this factory addresses unless a call
   * names another. Plugin composition binds the run's Terminal authority here
   * — its own conversation, or the owner's for a background agent — so the
   * coordinator, repository, and publication code below it need no idea that
   * a sandbox can belong to a conversation other than the run's.
   */
  substreamId?: string,
): TerminalPortFactory {
  return (workspaceId, workstreamId, requested = substreamId) =>
    createTerminalObjectPort(env, workspaceId, workstreamId, local, requested);
}

/**
 * A Worker-side handle on one work stream's Terminal authority.
 *
 * Each method is one round trip to the owning AgentLoopDO, where the whole
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
   * Run operations against storage or a complete authority executor in this
   * isolate instead of dispatching to the object.
   *
   * The same local-authority seam the retired work-stream SQL router used,
   * and for the same reason: the Node suite runs the real schema and the real
   * statements over `node:sqlite`, which is honest coverage of everything
   * except the runtime itself. What the runtime decides — that the operation
   * is serialized against concurrent callers, that a transaction rolls back,
   * that an alarm sees the committed row — is proved in `test-workers/`
   * against real workerd. The resident main agent supplies the executor form
   * so it can keep those semantics without RPCing back into its own event.
   */
  localOverride?: WorkstreamTerminalStorage | TerminalOperationExecutor,
  /**
   * Which of the parent's conversations holds the Terminal rows.
   *
   * Left out, the conversation the caller executes in: the main one from a
   * Worker, this object's own inside a conversation object. Given, exactly
   * that conversation — so a background agent's factory bound to its owner's
   * substream dispatches to the owner's object rather than answering out of
   * the agent's own tables, which is what made two conversations of one work
   * stream each believe they owned the same stable sandbox name.
   */
  substreamId?: string,
): TerminalObjectPort {
  // The same seam the eight object ports take through `createObjectPort`:
  // an explicit override for a focused test, otherwise whatever the owning
  // object installed on this environment. Terminal carries an *executor*
  // rather than storage because its object wraps every operation in an alarm
  // and transaction boundary that storage alone would skip.
  const local = localOverride
    ?? localWorkstreamAuthority(env, workspaceId, workstreamId, "terminal", substreamId);
  const call = async (operation: TerminalOperation, args: unknown[]): Promise<unknown> => {
    if (typeof local === "function") {
      return await local(operation, args) ?? null;
    }
    if (local) {
      const method = local[operation] as (...rest: unknown[]) => unknown;
      return method.apply(local, args) ?? null;
    }
    const stub = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      asWorkspaceId(workspaceId),
      conversationObjectName(
        env.AVALON_REGION,
        asWorkspaceId(workspaceId),
        workstreamId,
        substreamId === undefined || substreamId === "0" ? "0" : asSubstreamId(substreamId),
      ),
    );
    const result = await stub.executeTerminalOperation({
      workspaceId,
      workstreamId,
      substreamId: substreamId ?? "0",
      operation,
      args,
    });
    const body = rpcResultBody(result) as {
      ok?: boolean;
      value?: unknown;
      error?: string;
      failure?: TerminalOperationFailure;
    } | null;
    if (!body?.ok) {
      const parsedFailure = TerminalOperationFailureSchema.safeParse(body?.failure);
      const failure: TerminalOperationFailure = parsedFailure.success
        ? parsedFailure.data
        : body?.error === "invalid_terminal_operation"
          ? {
              code: "invalid_terminal_operation",
              message: "Rally's Terminal authority rejected an internal request because its protocol was invalid. Retry after the application and service versions are aligned.",
              outcome: "rejected",
              retryable: false,
            }
          : body?.error === "workstream_terminal_identity_mismatch"
            ? {
                code: "workstream_terminal_identity_mismatch",
                message: "Rally's Terminal authority rejected an internal request because it was routed to the wrong work stream. Retrying the same operation will not repair the route.",
                outcome: "rejected",
                retryable: false,
              }
            : {
                // A missing/malformed failure on a nominal commit rejection is
                // protocol skew, not proof of rollback. Never manufacture the
                // retryable write-safety contract from an untyped envelope.
                code: "terminal_operation_protocol_error",
                message: "Rally's Terminal authority returned an invalid internal response. The operation outcome is unknown; stop and let the run reconcile before attempting more Terminal work.",
                outcome: "unknown",
                retryable: false,
              };
      throw new TerminalObjectPortError(operation, failure);
    }
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

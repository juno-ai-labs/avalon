import { asSubstreamId, asWorkspaceId } from "@rally/contracts";

import { conversationObjectName } from "../durable-objects/names";
import type { SubstreamAgent } from "../durable-objects/substream-agent";
import { rpcResultBody } from "../durable-objects/rpc-result";
import type { DurableObjectRpcResult } from "../durable-objects/rpc-result";
import type { ObjectPortOf } from "../durable-objects/object-port-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { localWorkstreamAuthority, type ObjectPortAuthority } from "./local-authorities";
import { ObjectPortError } from "./object-port-error";

export { ObjectPortError } from "./object-port-error";

/** What distinguishes one object port from another, which is not much. */
export interface ObjectPortContract<TStorage, TOperation extends keyof TStorage & string> {
  /** Every operation the endpoint will dispatch, proven complete by the protocol. */
  operations: readonly TOperation[];
  /**
   * The stub's RPC method for this authority.
   *
   * A callback rather than a method name, so the call stays typed against the
   * agent's own signature instead of reaching through a string index.
   */
  dispatch: (
    stub: DurableObjectStub<SubstreamAgent>,
    request: {
      workspaceId: string;
      workstreamId: string;
      substreamId: string;
      operation: TOperation;
      args: unknown[];
    },
  ) => Promise<DurableObjectRpcResult>;
  /**
   * Which authority this port speaks for.
   *
   * The name an object installs its own storage under, so a port built inside
   * that object answers from it instead of resolving a stub back to the object
   * doing the resolving. See `local-authorities.ts`.
   */
  authority: ObjectPortAuthority;
  /** The code a refusal carries when the object named none of its own. */
  failureCode: string;
  /** What a member is told, if this ever reaches one. */
  failureMessage: string;
}

/**
 * A Worker-side handle on one conversation's object-local state.
 *
 * Each method is one round trip to the owning SubstreamAgent, where the whole
 * operation — its fences and its writes — runs synchronously against the
 * object's SQLite. Callers never see SQL, a table name, or a database handle.
 *
 * `workstreamId` is the conversation parent's id (a work stream or an
 * automation; the name predates typed parents) and `substreamId` picks which
 * of its conversations. Left out, it means the conversation the caller is
 * executing in — the main one from a Worker, this object's own inside a
 * conversation object — so a run reaches its own authorities without a stub
 * whichever substream it is. Given, it names exactly one conversation, and an
 * object that is not that conversation dispatches to the one that is; see
 * `localWorkstreamAuthority`.
 *
 * This was four near-identical files. Their normalized diff was comments.
 */
export function createObjectPort<TStorage, TOperation extends keyof TStorage & string>(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  contract: ObjectPortContract<TStorage, TOperation>,
  /**
   * Run operations against a storage instance in this isolate instead of
   * dispatching to the object.
   *
   * The seam the Node suite takes: it runs the real schema and the real
   * statements over `node:sqlite`, which is honest coverage of everything
   * except the runtime. What the runtime decides — that the transaction is
   * atomic against a concurrent caller, that a lease cannot lapse
   * mid-operation — belongs in `test-workers/`, where this override is unused.
   */
  localStorage?: TStorage,
  substreamId?: string,
): ObjectPortOf<TStorage, TOperation> {
  // The owning object installs its endpoint here, once, for every port built
  // below it — the endpoint and not the storage, because the endpoint is what
  // holds the authority fence, the projection commit, and the alarm re-arm.
  const resident = localWorkstreamAuthority(env, workspaceId, workstreamId, contract.authority, substreamId);
  const call = async (operation: TOperation, args: unknown[]): Promise<unknown> => {
    if (localStorage) {
      const method = localStorage[operation] as (...rest: unknown[]) => unknown;
      // `?? null` so this path answers exactly as the remote one does. JSON has
      // no `undefined`: over RPC a method returning it arrives as an absent
      // `value`, which the caller below reads as `null`. Dropping the coalesce
      // here would not preserve `undefined` end to end — it would only make the
      // Node suite disagree with production about a method that returned one.
      return method.apply(localStorage, args) ?? null;
    }
    if (resident) {
      const body = await resident(operation, args);
      // Interpreted by the same three lines as a dispatched answer below. A
      // second interpretation here is how the two paths would drift.
      if (!body?.ok) {
        throw new ObjectPortError(body?.error ?? contract.failureCode, contract.failureMessage);
      }
      return body.value ?? null;
    }
    const stub = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      asWorkspaceId(workspaceId),
      // Every authority keeps its rows in the conversation object they belong
      // to, and each endpoint refuses a request naming a different substream
      // rather than answering from an empty table.
      conversationObjectName(
        env.AVALON_REGION,
        asWorkspaceId(workspaceId),
        workstreamId,
        substreamId === undefined || substreamId === "0" ? "0" : asSubstreamId(substreamId),
      ),
    );
    const result = await contract.dispatch(stub, {
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
    } | null;
    if (!body?.ok) {
      throw new ObjectPortError(body?.error ?? contract.failureCode, contract.failureMessage);
    }
    return body.value ?? null;
  };

  // Built from the operation list rather than written out method by method, so
  // a name cannot be forwarded wrong; the mapped type already fixes each
  // signature to its storage counterpart.
  return Object.fromEntries(
    contract.operations.map((operation) => [
      operation,
      (...args: unknown[]) => call(operation, args),
    ]),
  ) as ObjectPortOf<TStorage, TOperation>;
}

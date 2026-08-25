import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../durable-objects/names";
import type { SubstreamAgent } from "../durable-objects/substream-agent";
import { rpcResultBody } from "../durable-objects/rpc-result";
import type { DurableObjectRpcResult } from "../durable-objects/rpc-result";
import type { ObjectPortOf } from "../durable-objects/object-port-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { localWorkstreamAuthority, type ObjectPortAuthority } from "./local-authorities";

/**
 * The object rejected the request itself — a bad protocol or a misrouted stub.
 *
 * Distinct from a refused write, which is an ordinary outcome and is returned
 * in the operation's own result rather than thrown. Anything reaching here is a
 * defect in the caller or the routing, not a state the work stream can be in.
 *
 * One class for all four ports. There were four, one per port, and no caller
 * ever caught any of them by type — they existed only to be thrown. The `code`
 * still says which authority refused and why.
 */
export class ObjectPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ObjectPortError";
  }
}

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
 * A Worker-side handle on one work stream's object-local state.
 *
 * Each method is one round trip to the owning SubstreamAgent, where the whole
 * operation — its fences and its writes — runs synchronously against the
 * object's SQLite. Callers never see SQL, a table name, or a database handle.
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
): ObjectPortOf<TStorage> {
  // The owning object installs its endpoint here, once, for every port built
  // below it — the endpoint and not the storage, because the endpoint is what
  // holds the authority fence, the projection commit, and the alarm re-arm.
  const resident = localWorkstreamAuthority(env, workspaceId, workstreamId, contract.authority);
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
      // No substream id, so this resolves to the main child. Every one of these
      // authorities keeps its rows there, and each endpoint refuses a non-main
      // substream rather than answering from an empty table.
      substreamAgentName(
        env.AVALON_REGION,
        asWorkspaceId(workspaceId),
        asWorkstreamId(workstreamId),
      ),
    );
    const result = await contract.dispatch(stub, {
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
  ) as ObjectPortOf<TStorage>;
}

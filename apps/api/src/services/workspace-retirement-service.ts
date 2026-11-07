import {
  asSubstreamId,
  asWorkspaceId,
  type WorkspaceId,
} from "@rally/contracts";
import type { RetirementParentKind } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  conversationObjectName,
  workspaceDOName,
} from "../durable-objects/names";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { settledBatches } from "../lib/settled-batches";
import { markDemoWorkspaceRetired } from "./demo-workspace-register";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { ConversationParentRetirementChildrenResultSchema } from "@rally/contracts";

/**
 * Walking a workspace's object graph and closing every object in it.
 *
 * The order is children before parents, and it is not a preference. A parent's
 * product reads refuse once it is retired; the walk's own read of its children
 * is permitted so a resumed pass can ask again, but a walk that closed the
 * parent first would still leave the child open — holding a socket and an
 * alarm in a workspace nobody can reach — until the pass came back for it.
 *
 * Everything here is resumable because nothing here holds state. The graph, the
 * receipts, and the notion of "finished" all live in WorkspaceDO, which is
 * where an interrupted pass looks when it starts again. This function can be
 * killed at any line and re-run.
 *
 * It is deliberately not the spike's straight-line best-effort walk: a child
 * that fails is left unreceipted, so the operation reports incomplete and the
 * next pass returns to it, rather than the walk logging a warning and calling
 * the workspace closed.
 */

/**
 * How many of one parent's conversations the walk closes at once.
 *
 * Bounds: concurrent `retireObject` calls to cold `SubstreamAgent` objects
 * from one pass. Without it, one at a time: each takes 0.1 to 1.7s, mostly
 * waking the object, and a parent with a few hundred conversations outlived
 * every pass. Set to 10 by the team on 2026-11-09, choosing between 6, 10 and
 * 20. Cloudflare's 6 simultaneous open connections per invocation may or may
 * not count Durable Object calls; if it does, the rest queue rather than fail.
 * A batch waits for its slowest call, so this is about 6 conversations a
 * second. On trip: nothing fails; the next batch starts when this one settles.
 */
export const RETIREMENT_CHILD_CONCURRENCY = 10;

export interface WorkspaceRetirementInput {
  workspaceId: WorkspaceId;
  retiredAt: number;
  operationId: string;
  /**
   * The internal actor retirement is attributed to.
   *
   * Explicitly not the author of whatever is being closed. The spike
   * impersonated an automation's author to make its lifecycle transitions go
   * through, which put a person's name on work they did not do and would have
   * put it in an audit trail.
   */
  actorUserId: string | null;
  reason: string;
  /**
   * The operator who asked, for the log lines this pass writes. Not a user of
   * the workspace and not the tombstone's `actorUserId`, which names a Rally
   * user: the tombstone says the workspace was closed by an operator, and the
   * `workspace_retirement_pass` log says which one.
   */
  operatorId?: string;
  /** Overrides `RETIREMENT_CHILD_CONCURRENCY`; tests set their own. */
  childConcurrency?: number;
}

export interface WorkspaceRetirementReceipt {
  complete: boolean;
  remaining: number;
  /** Every work stream, automation and Space the graph recorded, over all passes. */
  parents: number;
  /** Closed by this pass. A resumed pass closes only what the last one left. */
  retiredParents: number;
  retiredChildren: number;
  /** Effects the closed objects still hold and will never publish. */
  retainedOutbox: number;
  /** Nodes this pass could not finish, by id. The next pass returns to them. */
  failed: { parentKind: RetirementParentKind; parentId: string; error: string }[];
}

export async function retireWorkspaceGraph(
  env: Env,
  input: WorkspaceRetirementInput,
): Promise<WorkspaceRetirementReceipt> {
  // Any workspace. This is an operator tool behind Ace's Access policy, and
  // the decision was made not to gate it on a register of what some feature
  // created: the demo register still records the demos, but it is not an
  // authorization input. Retirement is irreversible, so the confirmation an
  // operator gives before reaching here is the whole of the protection — and
  // it is the caller's to ask for, not this function's to infer.
  //
  // The running Worker's own region, never the caller's. A region taken as a
  // parameter does not cross a region — it builds a regional-shaped *name* and
  // resolves it in the Global jurisdiction, which brings brand-new empty
  // objects into existence, tombstones them, and reports the workspace closed
  // while the real one stays open and serving.
  const region = env.AVALON_REGION;

  // Routed through the shared resolver rather than `idFromName`: a workspace
  // lives in one region with one placement affinity, and addressing its
  // objects directly is how a call ends up in the wrong jurisdiction.
  // Read once and handed to every stub, so a batch of children starts its
  // retires together rather than each waiting on its own lookup.
  const affinity = await workspacePlacementAffinity(env, input.workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(region, input.workspaceId),
    affinity,
  );

  const tombstone = {
    retiredAt: input.retiredAt,
    operationId: input.operationId,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };

  const demo = await env.DB.prepare(
    "SELECT operation_id FROM demo_operations WHERE workspace_id = ?",
  ).bind(input.workspaceId).first<{ operation_id: string }>();

  // Closes the workspace and captures the graph in one call. On a resumed pass
  // this returns what the first pass recorded rather than re-reading directories
  // that now refuse.
  await workspace.beginWorkspaceRetirement({
    ...tombstone,
    ...(demo ? {
      impersonationRevocation: {
        workspaceId: input.workspaceId,
        authorityBasis: `demo:${demo.operation_id}`,
      },
    } : {}),
  });
  const progress = await workspace.workspaceRetirementProgress();

  const receipt: WorkspaceRetirementReceipt = {
    complete: false,
    remaining: progress.remaining,
    parents: progress.nodes.length,
    retiredParents: 0,
    retiredChildren: 0,
    retainedOutbox: 0,
    failed: [],
  };

  for (const node of progress.nodes) {
    if (node.retired) continue;
    try {
      // Every parent, a Canvas, a Sidekick, and a Thread or Channel not yet
      // retired by `retire_threads`, is hosted by
      // this workspace's own object, which is already closed and answers only
      // the retirement read.
      const parent = workspace;

      // Asked before the parent is closed, so its children go first. The read
      // is permitted on a retired parent as well: a pass that died between
      // retiring the parent and writing its receipt has to be able to ask
      // again, or that node stays unreceipted forever.
      //
      // The retirement-specific read, because two of the three outcomes are not
      // failures and neither is decidable from an error message. A parent the
      // directory names but whose object never materialized has no children by
      // construction, and retiring it anyway is the point: the call brings the
      // object into existence holding nothing but a tombstone, which fences an
      // id a late create would otherwise be free to take.
      const listing = ConversationParentRetirementChildrenResultSchema.parse(
        await parent.childrenForRetirement({
          workspaceId: input.workspaceId,
          parentId: node.parentId,
        }),
      );
      // A parent holding a different identity than the row that named it is not
      // this walk's to close: tombstoning it would close the wrong object. It
      // stays unreceipted, so the pass reports incomplete rather than quietly
      // skipping it.
      if (listing.status === "identity_mismatch") throw new Error("conversation_parent_identity_mismatch");
      const children = listing.status === "ok" ? listing.children : [];

      // A batch at a time, and every call in a batch settles before the
      // parent's outcome is decided, so a failure leaves no retire in flight.
      // The first failure stops the parent; the children that closed keep
      // their receipts.
      for await (const batch of settledBatches(
        children,
        input.childConcurrency ?? RETIREMENT_CHILD_CONCURRENCY,
        async (child) => {
          const childName = conversationObjectName(
            region,
            input.workspaceId,
            node.parentId,
            asSubstreamId(child.substreamId),
          );
          const conversation = await durableObjectStubForWorkspace(
            env,
            env.SUBSTREAM_AGENTS,
            input.workspaceId,
            childName,
            affinity,
          );
          const childReceipt = await conversation.retireObject(tombstone);
          receipt.retainedOutbox += childReceipt.retainedOutbox;
          receipt.retiredChildren += 1;
          // Receipted per child so a pass cut off inside a large parent
          // resumes at the next child.
          await workspace.recordRetiredChild({
            parentId: node.parentId,
            substreamId: child.substreamId,
          });
        },
      )) {
        const failure = batch.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      }

      receipt.retiredParents += 1;
      // Written only after the parent and all of its children confirmed. A
      // throw anywhere above leaves the node unreceipted and the walk resumable.
      await workspace.recordRetiredNode({
        parentKind: node.parentKind,
        parentId: node.parentId,
      });
    } catch (error) {
      // Recorded, not swallowed. The node keeps its NULL receipt, so the
      // operation reports incomplete and the next pass returns to exactly this
      // node instead of the walk deciding the workspace is closed.
      // The stable code where one exists, so the receipt carries something an
      // operator can read and a later change can match on, rather than raw
      // runtime text. An error with no message still names the node.
      const reason = diagnosticErrorCode(error, "workspace_retirement_node_failed");
      receipt.failed.push({
        parentKind: node.parentKind,
        parentId: node.parentId,
        error: reason,
      });
      logWarn(env, "workspace_retirement_node_failed", {
        workspace_id: input.workspaceId,
        operation_id: input.operationId,
        operator_id: input.operatorId ?? null,
        parent_kind: node.parentKind,
        parent_id: node.parentId,
        reason,
      });
    }
  }

  const workspaceReceipt = await workspace.retireObject(tombstone);
  receipt.retainedOutbox += workspaceReceipt.retainedOutbox;

  const settled = await workspace.workspaceRetirementProgress();
  receipt.remaining = settled.remaining;
  receipt.complete = settled.complete;

  // The regional shadow of the tombstone, written only once the whole graph is
  // closed. It is what lets the Demos page list what is live without waking a
  // retired object to ask it. A workspace this feature never made has no row,
  // and the update is a no-op for it.
  if (receipt.complete) {
    await markDemoWorkspaceRetired(env.DB, input.workspaceId, new Date(input.retiredAt).toISOString());
  }

  // The region's own record of who closed this workspace. The tombstone names
  // an operator retirement; this line names the operator, and it is the one
  // place in the region that does.
  logInfo(env, "workspace_retirement_pass", {
    workspace_id: input.workspaceId,
    operation_id: input.operationId,
    operator_id: input.operatorId ?? null,
    complete: receipt.complete,
    remaining: receipt.remaining,
    parents: receipt.parents,
    retired_parents: receipt.retiredParents,
    retired_children: receipt.retiredChildren,
    retained_outbox: receipt.retainedOutbox,
    failed_nodes: receipt.failed.length,
  });

  return receipt;
}

/**
 * Retire a workspace on an operator's word, in the region this Worker runs in.
 *
 * The walk itself infers nothing from an id, which is right for the walk and
 * wrong for a door: an id no workspace in this region owns would be "retired"
 * as a set of brand-new empty objects holding tombstones, and the operator told
 * it succeeded while the real workspace, in the other region, stayed open. So
 * the door checks the row first. An abandoned demo whose workspace was never
 * created is closed by the operation, not through here.
 */
export async function retireWorkspaceForOperator(
  env: Env,
  workspaceId: string,
  operator: { operatorId: string },
): Promise<WorkspaceRetirementReceipt> {
  const owned = await env.DB.prepare(
    "SELECT id FROM workspaces WHERE id = ? AND region = ?",
  ).bind(workspaceId, env.AVALON_REGION).first<{ id: string }>();
  if (!owned) throw new ApiError(404, "workspace_not_found", "No workspace with this id in this region");
  // The D1 side of "closed", written before any object is. The objects' gate
  // stops every read and write that reaches them, but authentication, the
  // member list, invitations and the connection list are D1 reads that never
  // reach an object — and `workspaces.abandoned_at` is the fence every one of
  // those already applies (`0098_multiple_workspaces.sql`: "a closed workspace
  // is retained for operator reversal, but every normal authority read fences
  // it"). Without it a retired workspace still admitted sign-in and still sent
  // invitation email. Idempotent, so a resumed pass leaves the first instant.
  const retiredAt = Date.now();
  await env.DB.prepare(
    "UPDATE workspaces SET abandoned_at = ?, updated_at = ? WHERE id = ? AND region = ? AND abandoned_at IS NULL",
  ).bind(new Date(retiredAt).toISOString(), new Date(retiredAt).toISOString(), workspaceId, env.AVALON_REGION).run();
  return retireWorkspaceGraph(env, {
    workspaceId: asWorkspaceId(workspaceId),
    retiredAt,
    operationId: crypto.randomUUID(),
    actorUserId: null,
    reason: "operator_retirement",
    operatorId: operator.operatorId,
  });
}

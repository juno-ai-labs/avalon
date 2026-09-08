import {
  asAutomationId,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkspaceId,
} from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  automationDOName,
  conversationObjectName,
  workspaceDOName,
  workstreamDOName,
} from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import { ConversationParentRetirementChildrenResultSchema } from "@rally/contracts";

/**
 * Walking a workspace's object graph and closing every object in it.
 *
 * The order is children before parents, and it is not a preference. A parent
 * asked to list its children after it has been retired refuses, so a walk that
 * closed the parent first would have no way to find what was underneath it —
 * and the child, still open, would go on holding a socket and an alarm in a
 * workspace nobody can reach.
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
}

export interface WorkspaceRetirementReceipt {
  complete: boolean;
  remaining: number;
  retiredParents: number;
  retiredChildren: number;
  /** Effects the closed objects still hold and will never publish. */
  retainedOutbox: number;
  /** Nodes this pass could not finish, by id. The next pass returns to them. */
  failed: { parentKind: "workstream" | "automation"; parentId: string; error: string }[];
}

export async function retireWorkspaceGraph(
  env: Env,
  input: WorkspaceRetirementInput,
): Promise<WorkspaceRetirementReceipt> {
  // Any workspace. This is an operator tool behind Ace's Access policy, and
  // the decision was made not to gate it on a register of what some feature
  // created. Retirement is irreversible, so the confirmation an operator
  // gives before reaching here is the whole of the protection — and it is the
  // caller's to ask for, not this function's to infer.
  //
  // The running Worker's own region, never the caller's. A region taken as a
  // parameter does not cross a region — it builds an EU-shaped *name* and
  // resolves it in the Global jurisdiction, which brings brand-new empty
  // objects into existence, tombstones them, and reports the workspace closed
  // while the real one stays open and serving.
  const region = env.AVALON_REGION;

  // Routed through the shared resolver rather than `idFromName`: a workspace
  // lives in one region with one placement affinity, and addressing its
  // objects directly is how a call ends up in the wrong jurisdiction.
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(region, input.workspaceId),
  );

  const tombstone = {
    retiredAt: input.retiredAt,
    operationId: input.operationId,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };

  // Closes the workspace and captures the graph in one call. On a resumed pass
  // this returns what the first pass recorded rather than re-reading directories
  // that now refuse.
  await workspace.beginWorkspaceRetirement(tombstone);
  const progress = await workspace.workspaceRetirementProgress();

  const receipt: WorkspaceRetirementReceipt = {
    complete: false,
    remaining: progress.remaining,
    retiredParents: 0,
    retiredChildren: 0,
    retainedOutbox: 0,
    failed: [],
  };

  for (const node of progress.nodes) {
    if (node.retired) continue;
    try {
      // The recorded graph stores ids as text; the branded constructors are the
      // boundary that turns them back into the kind each namespace expects.
      const parentName = node.parentKind === "automation"
        ? automationDOName(region, input.workspaceId, asAutomationId(node.parentId))
        : workstreamDOName(region, input.workspaceId, asWorkstreamId(node.parentId));
      const parent = node.parentKind === "automation"
        ? await durableObjectStubForWorkspace(env, env.AUTOMATION_DOS, input.workspaceId, parentName)
        : await durableObjectStubForWorkspace(env, env.WORKSTREAM_DOS, input.workspaceId, parentName);

      // Asked before the parent is closed. After it, this refuses — which is
      // the whole reason children go first rather than being discovered later.
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

      for (const child of children) {
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
        );
        const childReceipt = await conversation.retireObject(tombstone);
        receipt.retainedOutbox += childReceipt.retainedOutbox;
        receipt.retiredChildren += 1;
      }

      const parentReceipt = await parent.retireObject(tombstone);
      receipt.retainedOutbox += parentReceipt.retainedOutbox;
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
      receipt.failed.push({
        parentKind: node.parentKind,
        parentId: node.parentId,
        error: error instanceof Error ? error.message : String(error),
      });
      logWarn(env, "workspace_retirement_node_failed", {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        parentKind: node.parentKind,
        parentId: node.parentId,
      });
    }
  }

  const workspaceReceipt = await workspace.retireObject(tombstone);
  receipt.retainedOutbox += workspaceReceipt.retainedOutbox;

  const settled = await workspace.workspaceRetirementProgress();
  receipt.remaining = settled.remaining;
  receipt.complete = settled.complete;

  logInfo(env, "workspace_retirement_pass", {
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    complete: receipt.complete,
    remaining: receipt.remaining,
    retiredParents: receipt.retiredParents,
    retiredChildren: receipt.retiredChildren,
    retainedOutbox: receipt.retainedOutbox,
    failedNodes: receipt.failed.length,
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
 * the door checks the row first.
 */
export async function retireWorkspaceForOperator(
  env: Env,
  workspaceId: string,
): Promise<WorkspaceRetirementReceipt> {
  const owned = await env.DB.prepare(
    "SELECT id FROM workspaces WHERE id = ? AND region = ?",
  ).bind(workspaceId, env.AVALON_REGION).first<{ id: string }>();
  if (!owned) throw new ApiError(404, "workspace_not_found", "No workspace with this id in this region");
  return retireWorkspaceGraph(env, {
    workspaceId: asWorkspaceId(workspaceId),
    retiredAt: Date.now(),
    operationId: crypto.randomUUID(),
    actorUserId: null,
    reason: "operator_retirement",
  });
}

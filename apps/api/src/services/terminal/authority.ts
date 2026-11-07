import { createCanvas } from "../canvas-service";
import {
  agentAddressForId,
  agentIdForAddress,
  asSubstreamId,
  asWorkspaceId,
  type AgentId,
  type ConversationParentKind,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";

import { workspaceDOName } from "../../durable-objects/names";
import type { Env } from "../../env";
import { TerminalToolError } from "./tools";
import { logWarn } from "../../observability/logger";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";

/**
 * Which conversation's Terminal a run uses.
 *
 * A sandbox belongs to one conversation of a work stream — the one whose
 * `AgentLoopDO` holds its `terminal_workspace` row — and a run uses the
 * sandbox of the conversation it works *for*. For an ordinary run that is its
 * own conversation. All conversations under one Sidekick use its authoring
 * conversation (substream 0). For a background agent in a work stream it is
 * the conversation of the agent that started it, or of that agent's own owner,
 * up to the first conversation
 * nobody delegated: the agents a conversation spawns share its files, its
 * checkout, and its exclusive mutation lease, rather than each provisioning a
 * sandbox of their own under the same stable name.
 *
 * The run's substream is what every other conversation authority is addressed
 * by, so this is the one place where a run's Terminal address can differ from
 * its own, and the whole difference is decided here, once, when the plugin is
 * composed.
 */
export interface TerminalRunScope {
  /**
   * What the conversation's parent is. A work stream's sandboxes are retired
   * by the workspace's lifecycle sweep; an automation's are not reached by it,
   * so the coordinator hands their retention to the provider at creation.
   */
  parentKind: ConversationParentKind;
  /** Whether this run is a delegated worker, which cannot reset its owner's files. */
  backgroundAgent: boolean;
  /** The conversation this run executes in. */
  runSubstreamId: string;
  /** The conversation whose `AgentLoopDO` owns the sandbox this run uses. */
  authoritySubstreamId: string;
}

export type TerminalRunScopeInput = Pick<
  WorkstreamWorkflowInput,
  "workspaceId" | "parentKind" | "parentId" | "substreamId" | "backgroundAgent"
>;

/** The one ownership read this module makes, so a test can hand it a table. */
export type AgentOwnerLookup = (agentId: AgentId) => Promise<AgentId | null>;

export function workspaceAgentOwnerLookup(env: Env, workspaceId: string): AgentOwnerLookup {
  return async (agentId) => {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      asWorkspaceId(workspaceId),
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
    return (await workspace.agentOwner({ workspaceId, agentId })).agentId;
  };
}

/**
 * Resolve the conversation whose sandbox this run uses.
 *
 * Ownership is walked from the run's own agent id through `agent_delegations`
 * until an agent with no owner: delegation is recorded on the owner's team
 * before the worker receives its first message, so by the time a worker runs
 * its chain is complete. Every link of that chain is a child under the same
 * conversation parent — a worker is reserved under its starter's parent — so
 * the root's substream is one this run's work stream owns. A root under
 * another parent is a routing defect and is refused rather than followed:
 * sharing a sandbox across parents would carry one work stream's files into
 * another's authority boundary.
 *
 * A run that is not a background agent makes no read at all.
 */
export async function resolveTerminalRunScope(
  input: TerminalRunScopeInput,
  ownerOf: AgentOwnerLookup,
): Promise<TerminalRunScope> {
  const runSubstreamId = input.substreamId ?? "0";
  if (!input.backgroundAgent) {
    return {
      parentKind: input.parentKind,
      backgroundAgent: false,
      runSubstreamId,
      authoritySubstreamId: input.parentKind === "automation" ? "0" : runSubstreamId,
    };
  }
  let root: AgentId = agentIdForAddress({
    parentKind: input.parentKind,
    parentId: input.parentId,
    substreamId: asSubstreamId(runSubstreamId),
  });
  // Registration refuses an ownership cycle, so this walk terminates on the
  // rows it can read. The set is a fence against a table that says otherwise:
  // a cycle would otherwise hold the run forever with no error to read.
  const visited = new Set<AgentId>([root]);
  for (let owner = await ownerOf(root); owner !== null; owner = await ownerOf(root)) {
    if (visited.has(owner)) throw new Error("terminal_authority_ownership_cycle");
    visited.add(owner);
    root = owner;
  }
  const address = agentAddressForId(root);
  if (address.parentKind !== input.parentKind || address.parentId !== input.parentId) {
    throw new Error("terminal_authority_parent_mismatch");
  }
  return {
    parentKind: input.parentKind,
    backgroundAgent: true,
    runSubstreamId,
    authoritySubstreamId: input.parentKind === "automation" ? "0" : address.substreamId,
  };
}

/**
 * Where a Sidekick's publication belongs.
 *
 * A run (substream other than `"0"`, whose id is the run's) publishes into a
 * Canvas, the Sidekick's output: the one it was asked to update (`canvas`,
 * which must be a Canvas this Sidekick writes), or the Canvas this run made,
 * which its first publish creates with the Sidekick as writer and the run's
 * principal as creator (`docs/canvases.md#from-a-sidekick-run`). The
 * Sidekick's own conversation has no home to publish into.
 */
export async function resolveTerminalPublicationHome(env: Env, input: Pick<WorkstreamWorkflowInput,
  "workspaceId" | "parentKind" | "parentId" | "substreamId" | "executionPrincipal">,
  request: { canvas?: string | undefined; title?: string | undefined } = {}): Promise<{ parentId: string; substreamId: string } | null> {
  if (input.parentKind !== "automation" || input.executionPrincipal.type !== "user") return null;
  const runId = input.substreamId && input.substreamId !== "0" ? input.substreamId : null;
  if (runId !== null) {
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS,
      asWorkspaceId(input.workspaceId), workspaceDOName(env.AVALON_REGION, input.workspaceId));
    const found = await workspace.canvasForSidekickRun({
      workspaceId: input.workspaceId, sidekickId: input.parentId, runId, canvasId: request.canvas ?? null,
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "canvas_not_written_by_sidekick") {
        throw new TerminalToolError("canvas_not_written_by_sidekick",
          "That Canvas is not one this Sidekick writes. Omit canvas to publish into this run's own Canvas, or name a Canvas this Sidekick made.",
          { field: "canvas" });
      }
      throw error;
    });
    const canvasId = found.canvasId ?? (await createCanvas(env, {
      workspaceId: input.workspaceId, creatorUserId: input.executionPrincipal.userId,
      ...(request.title ? { title: request.title } : {}),
      writer: { sidekickId: input.parentId, runId },
    })).canvasId;
    return { parentId: canvasId, substreamId: "0" };
  }
  if (request.canvas) {
    throw new TerminalToolError("canvas_argument_unsupported", "Only a Sidekick run names a Canvas to publish into; omit canvas.", { field: "canvas" });
  }
  // The Sidekick's own conversation publishes nowhere: its home was a
  // Thread, and Threads are retired.
  return null;
}

/**
 * The note a publish owes a Canvas: a Canvas's Chat publishes into its Canvas
 * as Rally, a Sidekick run into the Canvas it writes as the Sidekick; `null`
 * for a conversation whose publications can land in no Canvas.
 */
export function canvasArtifactNoter(env: Env, input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentKind" | "parentId" | "substreamId">):
  ((target: { parentId: string; substreamId: string }, resourceId: string) => Promise<void>) | null {
  if (input.parentKind !== "canvas" && !(input.parentKind === "automation" && (input.substreamId ?? "0") !== "0")) return null;
  return async (target, resourceId) => {
    if (target.substreamId !== "0") return;
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, asWorkspaceId(input.workspaceId),
      workspaceDOName(env.AVALON_REGION, input.workspaceId));
    const { noted } = await workspace.canvasNoteArtifact({
      workspaceId: input.workspaceId, canvasId: target.parentId, resourceId,
      editor: input.parentKind === "canvas" ? { kind: "rally", id: null } : { kind: "sidekick", id: input.parentId },
    });
    // This run's publications land in a Canvas, so one the Organization does
    // not hold is a defect to see, not a case to pass over.
    if (!noted) {
      logWarn(env, "canvas_artifact_note_failed", {
        workspace_id: input.workspaceId, parent_id: target.parentId, resource_id: resourceId, error_code: "canvas_not_found",
      });
    }
  };
}

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
import { loopAuthority } from "../../lib/loop-authority";
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
    const owner = await workspace.agentOwner({ workspaceId, agentId });
    if (!owner.ok) throw new Error(owner.code);
    return owner.value.agentId;
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
 * Canvas attached to its Sidekick: the one it names (`canvas`), or else the
 * Canvas the Sidekick was made in. It never makes a Canvas
 * (`docs/canvases.md#from-a-sidekick-run`). The Sidekick's own conversation
 * has no home to publish into.
 */
export async function resolveTerminalPublicationHome(env: Env, input: Pick<WorkstreamWorkflowInput,
  "workspaceId" | "parentKind" | "parentId" | "substreamId" | "executionPrincipal">
    & Partial<Pick<WorkstreamWorkflowInput, "automationRun" | "automationDelegation" | "backgroundAgent" | "backgroundAgentRootSubstreamId">>,
  request: { canvas?: string | undefined } = {}): Promise<{ parentId: string; substreamId: string } | null> {
  if (input.parentKind !== "automation") return null;
  // A background agent publishes where its root does (`loopAuthority`): a run's
  // worker into its run's Canvas, a wizard's agent nowhere, as the wizard.
  const authority = loopAuthority(input);
  const runId = authority?.kind === "sidekick_run" ? authority.runId
    : authority?.kind === "sidekick_wizard" ? null
      : input.substreamId && input.substreamId !== "0" ? input.substreamId : null;
  if (runId !== null) {
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS,
      asWorkspaceId(input.workspaceId), workspaceDOName(env.AVALON_REGION, input.workspaceId));
    const found = await workspace.canvasForSidekickRun({
      workspaceId: input.workspaceId, sidekickId: input.parentId, runId, canvasId: request.canvas ?? null,
      // A background agent's conversation is no run: it is held to its own person.
      userId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "canvas_archived") {
        throw new TerminalToolError("canvas_archived", "That Canvas was archived. Name another active Canvas from ATTACHED CANVASES in canvas, or report it in your final message.", { field: "canvas" });
      }
      if ((error as { code?: string }).code === "canvas_access_denied") {
        throw new TerminalToolError("canvas_access_denied",
          "The person this run acts as can no longer open that Canvas, so nothing was published there. Ask for access and wait, or report it in your final message.",
          { field: "canvas" });
      }
      if ((error as { code?: string }).code === "canvas_not_attached_to_sidekick") {
        throw new TerminalToolError("canvas_not_attached_to_sidekick",
          "That Canvas is not attached to this Sidekick. Name a Canvas from ATTACHED CANVASES in canvas, or omit canvas to publish into the Canvas this Sidekick was made in.",
          { field: "canvas" });
      }
      if ((error as { code?: string }).code === "canvas_required") {
        throw new TerminalToolError("canvas_required",
          "This Sidekick was not made in a Canvas, and a Sidekick run never creates one. Name a Canvas from ATTACHED CANVASES in canvas; if none is attached, report it in your final message.",
          { field: "canvas" });
      }
      throw error;
    });
    return { parentId: found.canvasId, substreamId: "0" };
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
export function canvasArtifactNoter(env: Env, input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentKind" | "parentId" | "substreamId">
    & Partial<Pick<WorkstreamWorkflowInput, "automationDelegation">>):
  ((target: { parentId: string; substreamId: string }, resourceId: string, replace: boolean) => Promise<boolean>) | null {
  if (input.parentKind !== "canvas" && !(input.parentKind === "automation" && (input.substreamId ?? "0") !== "0")) return null;
  // Answers whether the resource is now one of a Canvas's artifacts, which is
  // what decides that its publish returns a URL that will serve.
  return async (target, resourceId, replace) => {
    if (target.substreamId !== "0") return false;
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, asWorkspaceId(input.workspaceId),
      workspaceDOName(env.AVALON_REGION, input.workspaceId));
    const { noted, refused } = await workspace.canvasNoteArtifact({
      workspaceId: input.workspaceId, canvasId: target.parentId, resourceId, ...(replace ? { replace } : {}),
      ...(input.parentKind === "canvas"
        ? { editor: { kind: "rally", id: null } }
        // `canvasArtifactNoter` admits only a run of a Sidekick and the agents
        // under it; a run's worker notes as its run, not as its own conversation.
        : { editor: { kind: "sidekick", id: input.parentId }, runId: input.automationDelegation?.runId ?? input.substreamId ?? null }),
    });
    // This run's publications land in a Canvas, so one the Organization does
    // not hold is a defect to see, not a case to pass over.
    if (!noted) {
      logWarn(env, "canvas_artifact_note_failed", {
        workspace_id: input.workspaceId, parent_id: target.parentId, resource_id: resourceId, error_code: refused ?? "canvas_not_found",
      });
    }
    return noted;
  };
}


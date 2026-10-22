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
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";

/**
 * Which conversation's Terminal a run uses.
 *
 * A sandbox belongs to one conversation of a work stream — the one whose
 * `SubstreamAgent` holds its `terminal_workspace` row — and a run uses the
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
  /** The conversation whose `SubstreamAgent` owns the sandbox this run uses. */
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

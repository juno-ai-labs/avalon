import { agentAddressForId, type AgentId } from "@rally/contracts";

/**
 * Whose authority a loop acts with: a Canvas's Chat, a Sidekick's wizard, or a
 * Sidekick run. A background agent acts with the authority of the loop at its
 * root, because it already runs as that loop's principal and does that loop's
 * work: a gate that asked "is this the Chat itself?" only made the agent a
 * Chat delegated to weaker than the Chat, which then had to do the work
 * itself or tell the person it could not. Every tool gate that is about what
 * a loop may do asks this; one about a job only the root does (a run's
 * `report_outcome`) asks the loop's own fields instead.
 * See `docs/agent-loop-types.md#a-background-agent-acts-with-its-roots-authority`.
 *
 * A background agent's root is the one its `background_agent` row records,
 * carried on the input as `backgroundAgentRootSubstreamId`: `"0"` is the
 * Canvas's Chat or the Sidekick's wizard (every turn of a Sidekick's own
 * conversation that runs is the wizard's: `agent-loop-do.ts`,
 * `sharedSidekickConversation`), and a run's worker also carries the run as its
 * `automationDelegation`. An agent with no recorded root gets no authority.
 */
export type LoopAuthority =
  | { kind: "canvas_chat"; canvasId: string }
  | { kind: "sidekick_wizard"; sidekickId: string }
  | { kind: "sidekick_run"; sidekickId: string; runId: string };

export interface LoopAuthorityInput {
  executionPrincipal: { type: string };
  parentKind: string;
  parentId?: string | undefined;
  substreamId?: string | undefined;
  automationRun?: { automationId: string; runId: string } | undefined;
  automationDelegation?: { runId: string; stopGeneration?: number } | undefined;
  backgroundAgent?: boolean | undefined;
  backgroundAgentRootSubstreamId?: string | undefined;
}

export function loopAuthority(input: LoopAuthorityInput): LoopAuthority | null {
  const background = input.backgroundAgent === true;
  // A run acts as whoever it runs as, a person or the Sidekick itself.
  if (input.automationRun) {
    return input.parentKind === "automation" && !background
      ? { kind: "sidekick_run", sidekickId: input.automationRun.automationId, runId: input.automationRun.runId }
      : null;
  }
  if (input.automationDelegation) {
    return input.parentKind === "automation" && background && input.parentId
      ? { kind: "sidekick_run", sidekickId: input.parentId, runId: input.automationDelegation.runId }
      : null;
  }
  // A Chat and a wizard act as the person typing into them, and so do their
  // agents. An agent's root is read, never guessed: one recorded before roots
  // were has none and gets no root's authority, as it had none then.
  if (input.executionPrincipal.type !== "user" || !input.parentId) return null;
  if (background ? input.backgroundAgentRootSubstreamId !== "0" : (input.substreamId ?? "0") !== "0") return null;
  if (input.parentKind === "canvas") return { kind: "canvas_chat", canvasId: input.parentId };
  if (input.parentKind === "automation") return { kind: "sidekick_wizard", sidekickId: input.parentId };
  return null;
}

/** The Canvas a loop acts for as its Chat, or null. */
export function canvasChatAuthority(input: LoopAuthorityInput): string | null {
  const authority = loopAuthority(input);
  return authority?.kind === "canvas_chat" ? authority.canvasId : null;
}

/**
 * Whether a loop acts for the person behind a Canvas's Chat or a Sidekick's
 * wizard, and so may ask people for things in their name: the Chat, the
 * wizard, or a background agent of either. Not a run or its worker, which are
 * handed event content, and not a scheduled self-review or an agent it
 * started, which read runs and which no person started.
 */
export function actsForAPerson(input: LoopAuthorityInput & { reason?: string | undefined; backgroundAgentRootReason?: string | undefined }): boolean {
  const kind = loopAuthority(input)?.kind;
  return (kind === "canvas_chat" || kind === "sidekick_wizard")
    && input.reason !== "sidekick_review" && input.backgroundAgentRootReason !== "sidekick_review";
}

/**
 * Whether a message from this agent may start a turn that asks people for
 * things in a person's name, read from its address alone: a Canvas's Chat or
 * any of its agents (`canvas/…`), or a Sidekick's wizard (`automation/…/0`).
 * Every other Sidekick address is a run, a run's worker or a wizard's agent,
 * which the address cannot tell apart, so none of them may: a run's change
 * request to its wizard carries what the run read.
 */
export function senderActsForAPerson(senderAgentId: AgentId): boolean {
  const sender = agentAddressForId(senderAgentId);
  return sender.parentKind === "canvas" || (sender.parentKind === "automation" && sender.substreamId === "0");
}

/**
 * Whether a loop holds a Sidekick's authoring tools: a turn of the Sidekick's
 * own conversation the claim routed to its wizard (`sidekickWizard`, given
 * only to a principal who manages the Sidekick), or an agent that turn started.
 */
export function actsAsSidekickWizard(input: LoopAuthorityInput & { sidekickWizard?: true | undefined }): boolean {
  return loopAuthority(input)?.kind === "sidekick_wizard"
    && (input.backgroundAgent === true || input.sidekickWizard === true);
}

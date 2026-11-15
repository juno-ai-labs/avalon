import type { WorkstreamWorkflowInput } from "@rally/contracts";

/**
 * Whether a person drove this turn: typed it, answered a question in it,
 * retried it, or scheduled it as a wake-up, in a Canvas's Chat or a
 * Sidekick's wizard.
 *
 * The one answer to "may this turn act in a person's name", asked by every
 * behavior that speaks for the person whose turn it is (a source request). A
 * run, a run's delegation worker, a background agent, a turn another agent's
 * message started and the Sidekick self-review are not: content or Rally
 * started them. A wake-up in a Chat or a wizard is, whichever turn scheduled
 * it: what it may do in a person's name still needs that person or another to
 * approve, so the owner chose not to track who scheduled it.
 * `docs/agent-loop-types.md` owns the catalogue.
 */
export function drivenByPerson(input: Pick<WorkstreamWorkflowInput,
  "automationRun" | "automationDelegation" | "backgroundAgent" | "agentExchange" | "reason">): boolean {
  if (input.automationRun || input.automationDelegation || input.backgroundAgent === true) return false;
  return !input.agentExchange && input.reason !== "sidekick_review";
}

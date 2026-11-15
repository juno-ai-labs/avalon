import type { WorkstreamWorkflowInput } from "@rally/contracts";

/**
 * Whether a person drove this turn: typed it, answered a question in it, or
 * retried it, in a Canvas's Chat or a Sidekick's wizard.
 *
 * The one answer to "may this turn act in a person's name", asked by every
 * behavior that speaks for the person whose turn it is (a source request) and
 * recorded on every wake-up the turn schedules. A run, a run's delegation
 * worker, a background agent, a turn another agent's message started and the
 * Sidekick self-review are not: content or Rally started them. A wake-up
 * continues the loop that scheduled it, so it is a person's exactly when the
 * turn that scheduled it was. `docs/agent-loop-types.md` owns the catalogue.
 */
export function drivenByPerson(input: Pick<WorkstreamWorkflowInput,
  "automationRun" | "automationDelegation" | "backgroundAgent" | "agentExchange" | "reason"
  | "scheduledWakeupId" | "wakeupScheduledByPerson">): boolean {
  if (input.automationRun || input.automationDelegation || input.backgroundAgent === true) return false;
  if (input.agentExchange || input.reason === "sidekick_review") return false;
  return input.scheduledWakeupId === undefined || input.wakeupScheduledByPerson !== false;
}

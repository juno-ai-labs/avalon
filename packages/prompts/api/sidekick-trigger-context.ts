/** The trigger that started this Sidekick run, as host-provided context. */
export function renderSidekickTriggerContextMessage(context: unknown): string {
  return `SIDEKICK TRIGGER:\n${JSON.stringify(context)}`;
}

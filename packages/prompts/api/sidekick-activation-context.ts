/** Which Sidekick, run, revision and trigger this activation is, as host-provided facts. */
export function renderSidekickActivationContextMessage(context: unknown): string {
  return `SIDEKICK ACTIVATION (host-provided execution context):\n${JSON.stringify(context)}`;
}

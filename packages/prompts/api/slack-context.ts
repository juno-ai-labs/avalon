/** The Slack conversation a request came from, as host-provided context. */
export function renderSlackContextMessage(context: unknown): string {
  return `SLACK CONTEXT:\n${JSON.stringify(context)}`;
}

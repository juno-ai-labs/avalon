/** A historical received-email opening, labelled when it is the run's trigger. */
export function renderInboundEmail(content: string): string {
  return `INBOUND EMAIL:\n${content}`;
}

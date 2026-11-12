/** What a Sidekick's wizard or run is told about the Canvases it is attached to. */
export function renderAttachedCanvasesMessage(context: unknown): string {
  return `ATTACHED CANVASES (host-provided):\n${JSON.stringify(context)}`;
}

/** A Canvas's Chat run's host-provided context: the Canvas, its artifacts and Sidekicks, and how to publish to it. */
export function renderCanvasContextMessage(context: unknown): string {
  return `CANVAS CONTEXT (host-provided):\n${JSON.stringify(context)}`;
}

/** The `catch_up` MCP prompt: Summarize what happened in a Rally Canvas: its Chat and its artifacts' latest versions. */
export function renderCatchUpPrompt(canvas: string): string {
  return `Catch me up on the Rally Canvas "${canvas}": find it, read its whole Chat and its artifacts' latest versions, then tell me what changed, what was decided and what is still open.`;
}

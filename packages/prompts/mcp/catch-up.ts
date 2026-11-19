/** The `catch_up` MCP prompt: Summarize what happened in a Rally Canvas: its Chat and its artifact's latest version. */
export function renderCatchUpPrompt(canvas: string): string {
  return `Catch me up on the Rally Canvas "${canvas}": find it, read its whole Chat and its artifact's latest version, then tell me what changed, what was decided and what is still open.`;
}

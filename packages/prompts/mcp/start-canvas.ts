/** The `start_canvas` MCP prompt: Create a Rally Canvas seeded with a summary of this conversation. */
export function renderStartCanvasPrompt(title: string | undefined): string {
  return `Start a Rally Canvas from this conversation${title ? ` titled "${title}"` : ""}: create it with a short summary of what we have done, decided and left open as its first prompt, publish anything we made here into it, and give me the link.`;
}

/** The `publish_to_rally` MCP prompt: Publish what was just made here into a Rally Canvas, exactly as it is. */
export function renderPublishToRallyPrompt(canvas: string | undefined): string {
  return `Publish what we just made to Rally${canvas ? `, in the Canvas "${canvas}"` : ""}. Follow the publishing skill: find ${canvas ? "that" : "the right"} Canvas or create one, publish with publish_file or publish_site in the shape the work already has, and give me the link.`;
}

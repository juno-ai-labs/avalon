/**
 * Whether a loop is a Canvas's Chat itself: the Canvas's conversation `"0"`,
 * and not a background agent working for it. The one answer every surface
 * that treats the Chat specially asks (its Sidekick tools, its data write).
 */
export function isCanvasChat(input: { parentKind: string; substreamId?: string | undefined; backgroundAgent?: boolean | undefined }): boolean {
  return input.parentKind === "canvas" && (input.substreamId ?? "0") === "0" && input.backgroundAgent !== true;
}

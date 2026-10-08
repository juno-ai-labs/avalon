/**
 * An Organization's unique slug: its name, then the last eight hex digits of
 * its id. Workspace ids are UUIDv7, whose leading digits are a timestamp that
 * moves about once a minute, so a slug taken from the front collided for two
 * Organizations of the same name created in the same minute. The tail is random.
 */
export function workspaceSlug(name: string, workspaceId: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "workspace";
  return `${base}-${workspaceId.replaceAll("-", "").slice(-8)}`;
}

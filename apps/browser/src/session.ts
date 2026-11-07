import type { BrowserSession } from "@rally/contracts/browser-session";
import type { CookieClientSession } from "@rally/contracts/client-session";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";
import { parseLinkPathTarget } from "@rally/contracts/links";

/** Adapt server metadata to the shared collaboration view without fake tokens. */
export function cookieClientSession(region: string, session: BrowserSession): CookieClientSession {
  ConfiguredRegionSchema.parse(region);
  if (session.workspace && session.workspace.region !== region) throw new Error("Organization deployment does not match the browser session");
  return {
    authentication: "cookie",
    apiBaseUrl: `/regional/${region}/browser/api/${session.workspace?.id ?? "_"}`,
    expiresAt: session.expiresAt,
    user: { id: session.user.id, name: session.user.name, email: session.user.email,
      timezone: session.user.timezone, ...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}) },
    workspace: session.workspace ? { id: session.workspace.id, name: session.workspace.name,
      region: session.workspace.region, role: session.workspace.role, timezone: session.workspace.timezone,
      ...(session.workspace.accessClass ? { accessClass: session.workspace.accessClass } : {}) } : null,
    ...(session.impersonator ? { impersonator: { id: session.impersonator.id, name: session.impersonator.name,
      email: session.impersonator.email, ...(session.impersonator.avatarUrl ? { avatarUrl: session.impersonator.avatarUrl } : {}) } } : {}),
  };
}

/**
 * Where the shell lands for a path the browser was opened on. The desktop
 * shell routes by hash, so a canonical Canvas or Sidekick link becomes the
 * Organization's path plus the hash the desktop's own deep links navigate to:
 * `#/canvases/:id` (with `?artifact=` when the link opens one of its
 * artifacts) or `#/sidekicks/:id`. Returns null when the path needs no
 * rewrite; a retired Space, Channel, Breakout or Thread path is one of those,
 * and the entry screen says what it named is gone.
 */
export function shellLocation(pathname: string, hash: string): string | null {
  const target = parseLinkPathTarget(pathname);
  if (target) {
    const workspace = `/app/workspaces/${target.region}/${target.workspaceId}`;
    if (target.kind === "sidekick") return `${workspace}#/sidekicks/${target.sidekickId}`;
    return `${workspace}#/canvases/${target.canvasId}${target.artifactId ? `?${new URLSearchParams({ artifact: target.artifactId })}` : ""}`;
  }
  const workspace = /^\/app\/workspaces\/[^/]+\/[^/]+\/?$/u.test(pathname);
  return workspace && !hash ? `${pathname.replace(/\/$/u, "")}#/` : null;
}

/**
 * The hash to set when a link opens in the tab already showing its
 * Organization, so the shell routes in place. Null when the link names another
 * Organization, or none: the tab then loads the link, which switches to it.
 */
export function inPlaceHash(pathname: string, link: string): string | null {
  let target: URL;
  try { target = new URL(link, "https://rally.invalid"); } catch { return null; }
  const next = shellLocation(target.pathname, "");
  if (!next) return null;
  const at = next.indexOf("#");
  return next.slice(0, at) === pathname.replace(/\/$/u, "") ? next.slice(at) : null;
}

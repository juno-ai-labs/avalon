import type { BrowserSession } from "@rally/contracts/browser-session";
import type { CookieClientSession } from "@rally/contracts/client-session";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";
import { parseSidekickLinkPathTarget, parseSpaceLinkPathTarget, parseWorkstreamLinkPathTarget } from "@rally/contracts/workstream-links";

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
 * shell routes by hash, so a canonical Channel, Space or Sidekick link, or an invitation's
 * addressed Channel path, becomes the workspace path plus the hash the
 * desktop's own deep links set. Returns null when the path needs no rewrite.
 */
export function shellLocation(pathname: string, hash: string): string | null {
  // A conversation link names a Canvas now (Threads, Channels and Breakouts
  // are gone from the client), so it opens the Canvas, and a Channel's link
  // opens the Canvases home. The Breakout and artifact in a link are dropped:
  // the Canvas opens its newest artifact itself.
  const workstream = parseWorkstreamLinkPathTarget(pathname);
  if (workstream?.region && workstream.workspaceId) {
    return `/app/workspaces/${workstream.region}/${workstream.workspaceId}#/canvases/${workstream.workstreamId}`;
  }
  const space = parseSpaceLinkPathTarget(pathname);
  if (space) return `/app/workspaces/${space.region}/${space.workspaceId}#/canvases`;
  const sidekick = parseSidekickLinkPathTarget(pathname);
  if (sidekick) return `/app/workspaces/${sidekick.region}/${sidekick.workspaceId}#/sidekicks/${sidekick.sidekickId}`;
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

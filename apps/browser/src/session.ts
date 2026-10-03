import type { BrowserSession } from "@rally/contracts/browser-session";
import type { CookieClientSession } from "@rally/contracts/client-session";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";
import { parseSpaceLinkPathTarget, parseWorkstreamLinkPathTarget } from "@rally/contracts/workstream-links";

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
  };
}

/**
 * Which shell a workspace session mounts. Guests keep the guest collaboration
 * shell; members get the desktop shell. Returning `"guest"` for everyone is the
 * PRD's way to turn the member shell off.
 */
export function browserShellFor(session: Pick<BrowserSession, "workspace">): "guest" | "member" {
  return session.workspace?.accessClass === "guest" ? "guest" : "member";
}

/**
 * Where the member shell lands for a path the browser was opened on. The
 * desktop shell routes by hash, so a canonical Channel or Space link becomes
 * the workspace path plus the hash the desktop's own deep links set. Returns
 * null when the path needs no rewrite.
 */
export function memberShellLocation(pathname: string, hash: string): string | null {
  const workstream = parseWorkstreamLinkPathTarget(pathname);
  if (workstream?.region && workstream.workspaceId) {
    const query = new URLSearchParams();
    if (workstream.substreamId) query.set("substream", workstream.substreamId);
    if ("spaceId" in workstream && workstream.spaceId) query.set("space", workstream.spaceId);
    return `/app/workspaces/${workstream.region}/${workstream.workspaceId}#/workstreams/${workstream.workstreamId}${query.size ? `?${query}` : ""}`;
  }
  const space = parseSpaceLinkPathTarget(pathname);
  if (space) return `/app/workspaces/${space.region}/${space.workspaceId}#/spaces/${space.spaceId}`;
  const workspace = /^\/app\/workspaces\/[^/]+\/[^/]+\/?$/u.test(pathname);
  return workspace && !hash ? `${pathname.replace(/\/$/u, "")}#/` : null;
}

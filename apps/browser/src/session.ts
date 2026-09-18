import type { BrowserSession } from "@rally/contracts/browser-session";
import type { CookieClientSession } from "@rally/contracts/client-session";
import { ConfiguredRegionSchema } from "@rally/contracts/regions";

/** Adapt server metadata to the shared collaboration view without fake tokens. */
export function cookieClientSession(region: string, session: BrowserSession): CookieClientSession {
  ConfiguredRegionSchema.parse(region);
  if (session.workspace && session.workspace.region !== region) throw new Error("Workspace deployment does not match the browser session");
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

import type { Env } from "../env";

export const DEFAULT_NOTION_INGRESS_BASE_URL = "https://notion.rallywith.ai";

/**
 * Host helpers for the shared Notion ingress.
 *
 * The other shared providers keep these beside their routing service. Notion's
 * live in `lib/` because the connector registry has to build the same redirect
 * URI, and a registry that imported the routing service would close a cycle back
 * through `ConnectionService`.
 */
export function notionCallbackUrl(env: Env): string {
  return new URL("/connections/notion/callback", notionIngressBaseUrl(env)).toString();
}

/**
 * Whether this request arrived at the shared ingress rather than at the Worker's
 * own regional API.
 *
 * Two departures from the GitHub, Linear, and Slack equivalents, both forced by
 * the fact that Notion's redirect URI is derived from this same value and so has
 * to name a reachable address in development:
 *
 * - It matches on `host`, not `hostname`, because both local Workers are
 *   `127.0.0.1` and only the port separates them. A production custom domain
 *   carries no port, so the two comparisons are identical there.
 * - A request to the region's **own** `PUBLIC_API_BASE_URL` is never the shared
 *   ingress, even when the two are configured to the same address. The ingress
 *   is a dedicated host precisely so it can be gated down to three routes;
 *   without this, pointing the ingress at the regional API — which is exactly
 *   what a local `.dev.vars` does — would apply that gate to the whole API and
 *   404 every other route.
 */
export function isSharedNotionIngress(env: Env, requestUrl: string | URL): boolean {
  const request = new URL(requestUrl);
  const host = request.host.toLowerCase();
  if (host === regionalApiHost(env)) return false;
  return host === new URL(notionIngressBaseUrl(env)).host.toLowerCase();
}

/**
 * The shared host answers the one callback and the one webhook subscription, and
 * nothing else: it is reachable by anyone who learns the name, while the rest of
 * the Global API is not part of what Notion was given.
 */
export function isAllowedNotionIngressRoute(method: string, pathname: string): boolean {
  return (method === "GET" && pathname === "/connections/notion/callback")
    || (method === "GET" && (pathname === "/health" || pathname === "/health/"))
    || (method === "POST" && pathname === "/ingest/notion");
}

/**
 * Whether the shared ingress is a host other than the one this request arrived
 * at — that is, whether a request landed on a regional host while the single
 * subscription and redirect URI point somewhere else.
 *
 * Distinct from `!isSharedNotionIngress`, which is also true in development
 * where the ingress and the regional API are deliberately the same host.
 */
export function notionIngressUrl(env: Env): string {
  return new URL("/ingest/notion", notionIngressBaseUrl(env)).toString();
}

export function notionIngressIsElsewhere(env: Env, requestUrl: string | URL): boolean {
  return new URL(requestUrl).host.toLowerCase() !== new URL(notionIngressBaseUrl(env)).host.toLowerCase();
}

function notionIngressBaseUrl(env: Env): string {
  return env.NOTION_INGRESS_BASE_URL || DEFAULT_NOTION_INGRESS_BASE_URL;
}

function regionalApiHost(env: Env): string | null {
  if (!env.PUBLIC_API_BASE_URL) return null;
  try {
    return new URL(env.PUBLIC_API_BASE_URL).host.toLowerCase();
  } catch {
    return null;
  }
}

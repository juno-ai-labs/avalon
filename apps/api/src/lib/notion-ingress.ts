import type { Env } from "../env";

export const DEFAULT_NOTION_INGRESS_BASE_URL = "https://notion.with-avalon.com";

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
 * Matches on host rather than hostname alone, unlike the other shared ingresses.
 * They are only ever reached at a public name, but Notion's redirect URI is
 * derived from this same value, so development has to name a local address — and
 * there both regions are `127.0.0.1`, separated only by port. In production the
 * custom domain carries no port and the two comparisons are identical.
 */
export function isSharedNotionIngress(env: Env, requestUrl: string | URL): boolean {
  const configured = new URL(notionIngressBaseUrl(env));
  const request = new URL(requestUrl);
  return request.host.toLowerCase() === configured.host.toLowerCase();
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

function notionIngressBaseUrl(env: Env): string {
  return env.NOTION_INGRESS_BASE_URL || DEFAULT_NOTION_INGRESS_BASE_URL;
}

/**
 * The canonical shareable link to an Avalon work stream, shared by the API, the
 * desktop client, and the public site.
 *
 * `rallywithai://workstreams/<id>` is the protocol the desktop client
 * registers, and it stays the target every surface ultimately opens. It is
 * not, however, a link that survives being pasted somewhere else: Slack emits
 * `link_shared` only for URLs whose registered *domain* matches an unfurl
 * domain, so a custom scheme can never be unfurled; mail clients rarely
 * linkify an unknown scheme at all; and a recipient without the app installed
 * is left with a dead string.
 *
 * The canonical form is therefore an HTTPS URL on the public site that carries
 * the work-stream id in its **path** — where a server reading the shared URL
 * can see it, which a `#fragment` handoff deliberately prevents — and that
 * hands off to the deep link once the browser has it.
 *
 * This module is intentionally free of dependencies (no zod) so the site can
 * import it directly without pulling a validation library into a static page.
 */

import {
  DESKTOP_DEEP_LINK_PROTOCOL,
  isDesktopDeepLinkProtocol,
} from "./desktop-deep-link";

/** Host segment of the desktop deep link: `rallywithai://workstreams/<id>`. */
const DEEP_LINK_HOST = "workstreams";

/** Path prefix of the canonical HTTPS link: `/app/workstreams/<id>`. */
export const WORKSTREAM_LINK_PATH_PREFIX = "/app/workstreams/";

/**
 * Site origins a shared work-stream link may still be on, besides the caller's
 * own. Fixed historical values, like the legacy deep-link scheme: links minted
 * on these are in Slack history and inboxes and cannot be reissued.
 *
 * A caller opts in. Most read one origin at a time — the site really does serve
 * one origin per request — but a caller handed URLs by a third party does not
 * get to choose which domain they arrive on. Slack is the case that matters:
 * its app registers both domains for unfurling, so it delivers `link_shared`
 * for both.
 */
export const LEGACY_WORKSTREAM_LINK_ORIGINS: readonly string[] = Object.freeze([
  "https://with-avalon.com",
  "https://www.with-avalon.com",
]);

/** Legacy handoff still present in Slack and mail history: `/open#target=…`. */
const LEGACY_HANDOFF_PATHS = new Set(["/open", "/open/"]);

const WORKSTREAM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isWorkstreamId(value: string): boolean {
  return WORKSTREAM_ID_PATTERN.test(value);
}

function assertWorkstreamId(workstreamId: string): void {
  if (!isWorkstreamId(workstreamId)) {
    throw new Error("A work-stream link requires a work-stream UUID");
  }
}

/** The desktop deep link every canonical link resolves to. */
export function workstreamDeepLink(workstreamId: string): string {
  assertWorkstreamId(workstreamId);
  return `${DESKTOP_DEEP_LINK_PROTOCOL}//${DEEP_LINK_HOST}/${workstreamId}`;
}

/**
 * The canonical shareable link. This is what every surface emits — copy link,
 * Slack blocks, mention email — so that one URL shape is what circulates.
 */
export function workstreamCanonicalUrl(webBaseUrl: string, workstreamId: string): string {
  assertWorkstreamId(workstreamId);
  return new URL(`${WORKSTREAM_LINK_PATH_PREFIX}${workstreamId}`, webBaseUrl).toString();
}

/** Read the work-stream id out of a canonical link's path, or null. */
export function parseWorkstreamLinkPath(pathname: string): string | null {
  if (!pathname.startsWith(WORKSTREAM_LINK_PATH_PREFIX)) return null;
  const candidate = pathname.slice(WORKSTREAM_LINK_PATH_PREFIX.length).replace(/\/$/u, "");
  return isWorkstreamId(candidate) ? candidate : null;
}

function parseDeepLink(url: URL): string | null {
  if (!isDesktopDeepLinkProtocol(url.protocol) || url.hostname !== DEEP_LINK_HOST) return null;
  if (url.search || url.hash || url.username || url.password || url.port) return null;
  const candidate = url.pathname.slice(1);
  return isWorkstreamId(candidate) ? candidate : null;
}

/**
 * Recognize any Avalon link that identifies a work stream, whichever shape it
 * was minted in. Callers that act on a shared link — the Slack unfurl handler
 * above all — need to accept the links already circulating, not only the ones
 * emitted today.
 *
 * Accepted, in order of preference:
 * - the canonical `<webBaseUrl>/app/workstreams/<id>`
 * - the desktop deep link `rallywithai://workstreams/<id>`, or `avalon://…`
 * - the legacy handoff `<webBaseUrl>/open#target=<either deep link>`
 *
 * Only links on an origin the caller named are read, so a look-alike host
 * cannot borrow the treatment Avalon gives its own links. `webBaseUrl` accepts
 * several origins for a caller that is handed URLs it did not choose the domain
 * of — see `LEGACY_WORKSTREAM_LINK_ORIGINS`.
 */
export function parseWorkstreamLink(
  raw: string,
  options: { webBaseUrl: string | readonly string[] },
): string | null {
  let url: URL;
  let origins: string[];
  try {
    url = new URL(raw);
    const bases = typeof options.webBaseUrl === "string" ? [options.webBaseUrl] : options.webBaseUrl;
    if (bases.length === 0) return null;
    origins = bases.map((base) => new URL(base).origin);
  } catch {
    return null;
  }

  const deepLinkId = parseDeepLink(url);
  if (deepLinkId) return deepLinkId;

  if (!origins.includes(url.origin)) return null;

  if (!url.search) {
    const canonicalId = parseWorkstreamLinkPath(url.pathname);
    if (canonicalId && !url.hash) return canonicalId;
  }

  if (!LEGACY_HANDOFF_PATHS.has(url.pathname) || url.search || !url.hash.startsWith("#")) {
    return null;
  }
  const target = new URLSearchParams(url.hash.slice(1)).get("target");
  if (target === null) return null;
  try {
    return parseDeepLink(new URL(target));
  } catch {
    return null;
  }
}

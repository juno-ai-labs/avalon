/**
 * Canonical shareable work-stream links and their desktop handoff form.
 *
 * Newly emitted links carry `(region, workspaceId)` as routing context. That
 * pair selects an already-authorized desktop workspace and grants no access;
 * the regional API still authorizes every resource read. The earlier ID-only
 * HTTPS and custom-protocol forms remain readable because they already exist
 * in inboxes and Slack history, but no current writer emits them.
 *
 * This module is intentionally dependency-free so the public site can import
 * it directly without pulling a validation library into a static page.
 */

import {
  DESKTOP_DEEP_LINK_PROTOCOL,
  isDesktopDeepLinkProtocol,
} from "./desktop-deep-link";
import {
  addWorkspaceTarget,
  isWorkspaceTarget,
  parseWorkspaceAddressedDeepLink,
  type WorkspaceTarget,
} from "./workspace-target";

const DEEP_LINK_HOST = "workstreams";

/** New canonical prefix: `/app/workspaces/<region>/<workspace>/workstreams/<id>`. */
export const WORKSTREAM_LINK_PATH_PREFIX = "/app/workspaces/";

/** ID-only links already shared before workspace-addressed links shipped. */
export const LEGACY_WORKSTREAM_LINK_PATH_PREFIX = "/app/workstreams/";

export const LEGACY_WORKSTREAM_LINK_ORIGINS: readonly string[] = Object.freeze([
  "https://with-avalon.com",
  "https://www.with-avalon.com",
]);

const LEGACY_HANDOFF_PATHS = new Set(["/open", "/open/"]);

const WORKSTREAM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface WorkstreamLinkTarget extends WorkspaceTarget {
  workstreamId: string;
  substreamId?: string;
}

export type ParsedWorkstreamLinkTarget = WorkstreamLinkTarget | {
  region: null;
  workspaceId: null;
  workstreamId: string;
  substreamId?: string;
};

export function isWorkstreamId(value: string): boolean {
  return WORKSTREAM_ID_PATTERN.test(value);
}

function assertWorkstreamId(workstreamId: string): void {
  if (!isWorkstreamId(workstreamId)) {
    throw new Error("A work-stream link requires a work-stream UUID");
  }
}

function assertWorkstreamLinkTarget(target: WorkstreamLinkTarget): void {
  if (!isWorkspaceTarget(target)) {
    throw new Error("A work-stream link requires a region and workspace UUID");
  }
  assertWorkstreamId(target.workstreamId);
  if (target.substreamId) assertWorkstreamId(target.substreamId);
}

/** The workspace-addressed desktop deep link every new canonical link resolves to. */
export function workstreamDeepLink(target: WorkstreamLinkTarget): string {
  assertWorkstreamLinkTarget(target);
  const deepLink = new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//${DEEP_LINK_HOST}/${target.workstreamId}${target.substreamId ? `/substreams/${target.substreamId}` : ""}`);
  return addWorkspaceTarget(deepLink, target).toString();
}

/**
 * Handoff for a parsed link. The legacy arm exists only so an old HTTPS URL can
 * still reach the current desktop; new writers call `workstreamDeepLink`.
 */
export function workstreamDeepLinkFromParsedTarget(target: ParsedWorkstreamLinkTarget): string {
  if (target.region !== null) return workstreamDeepLink(target);
  assertWorkstreamId(target.workstreamId);
  if (target.substreamId) assertWorkstreamId(target.substreamId);
  return `${DESKTOP_DEEP_LINK_PROTOCOL}//${DEEP_LINK_HOST}/${target.workstreamId}${target.substreamId ? `/substreams/${target.substreamId}` : ""}`;
}

/** The canonical shareable link emitted by every current surface. */
export function workstreamCanonicalUrl(webBaseUrl: string, target: WorkstreamLinkTarget): string {
  assertWorkstreamLinkTarget(target);
  const path = `${WORKSTREAM_LINK_PATH_PREFIX}${target.region}/${target.workspaceId}/workstreams/${target.workstreamId}${target.substreamId ? `/substreams/${target.substreamId}` : ""}`;
  return new URL(path, webBaseUrl).toString();
}

/** Read a work-stream target out of either current or legacy canonical path. */
export function parseWorkstreamLinkPathTarget(pathname: string): ParsedWorkstreamLinkTarget | null {
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const childPath = /^(.*)\/substreams\/([^/]+)$/u.exec(normalized);
  if (childPath) {
    const parent = parseWorkstreamLinkPathTarget(childPath[1]!);
    return parent && !parent.substreamId && isWorkstreamId(childPath[2]!) ? { ...parent, substreamId: childPath[2]! } : null;
  }
  const current = /^\/app\/workspaces\/([a-z][a-z0-9-]*)\/([^/]+)\/workstreams\/([^/]+)$/u.exec(normalized);
  if (current) {
    const [, region, workspaceId, workstreamId] = current;
    if (!region || !workspaceId || !workstreamId) return null;
    const target = { region, workspaceId, workstreamId };
    return isWorkspaceTarget(target) && isWorkstreamId(target.workstreamId)
      ? target as WorkstreamLinkTarget
      : null;
  }
  if (!normalized.startsWith(LEGACY_WORKSTREAM_LINK_PATH_PREFIX)) return null;
  const workstreamId = normalized.slice(LEGACY_WORKSTREAM_LINK_PATH_PREFIX.length);
  return isWorkstreamId(workstreamId) ? { region: null, workspaceId: null, workstreamId } : null;
}

/** Compatibility helper for callers that need only the resource id. */
export function parseWorkstreamLinkPath(pathname: string): string | null {
  return parseWorkstreamLinkPathTarget(pathname)?.workstreamId ?? null;
}

function parseDeepLink(url: URL): ParsedWorkstreamLinkTarget | null {
  if (!isDesktopDeepLinkProtocol(url.protocol)) return null;
  const addressed = parseWorkspaceAddressedDeepLink(url);
  const destination = addressed?.destination ?? url;
  if (destination.hostname !== DEEP_LINK_HOST) return null;
  if (destination.hash || destination.username || destination.password || destination.port) return null;
  const [workstreamId = "", childSegment, substreamId, ...extra] = destination.pathname.slice(1).split("/");
  if (childSegment !== undefined && (childSegment !== "substreams" || !substreamId || !isWorkstreamId(substreamId) || extra.length)) return null;
  if (!isWorkstreamId(workstreamId)) return null;
  if (destination.search) return null;
  return addressed
    ? { ...addressed.target, workstreamId, ...(substreamId ? { substreamId } : {}) }
    : { region: null, workspaceId: null, workstreamId, ...(substreamId ? { substreamId } : {}) };
}

/** Parse any current or already-circulating Rally work-stream link. */
export function parseWorkstreamLinkTarget(
  raw: string,
  options: { webBaseUrl: string | readonly string[] },
): ParsedWorkstreamLinkTarget | null {
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

  const deepLink = parseDeepLink(url);
  if (deepLink) return deepLink;
  if (!origins.includes(url.origin)) return null;

  if (!url.search && !url.hash) {
    const canonical = parseWorkstreamLinkPathTarget(url.pathname);
    if (canonical) return canonical;
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

/** Compatibility helper for link readers that need only the resource id. */
export function parseWorkstreamLink(
  raw: string,
  options: { webBaseUrl: string | readonly string[] },
): string | null {
  return parseWorkstreamLinkTarget(raw, options)?.workstreamId ?? null;
}

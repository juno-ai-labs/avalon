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
import { uuidFromBase58, uuidToBase58 } from "./uuid-base58";

const DEEP_LINK_HOST = "workstreams";

/** Canonical hierarchy: `/app/<region>/<organization>/s/<space>`. */
export const WORKSTREAM_LINK_PATH_PREFIX = "/app/";

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
  spaceId: string;
  workstreamId: string;
  substreamId?: string;
}

export interface SpaceLinkTarget extends WorkspaceTarget {
  spaceId: string;
}

export interface SidekickLinkTarget extends WorkspaceTarget {
  sidekickId: string;
}

export type ParsedWorkstreamLinkTarget = WorkstreamLinkTarget | (WorkspaceTarget & {
  spaceId?: undefined;
  workstreamId: string;
  substreamId?: string;
}) | {
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
  assertWorkstreamId(target.spaceId);
  assertWorkstreamId(target.workstreamId);
  if (target.substreamId) assertWorkstreamId(target.substreamId);
}

/** The workspace-addressed desktop deep link every new canonical link resolves to. */
export function workstreamDeepLink(target: WorkstreamLinkTarget): string {
  assertWorkstreamLinkTarget(target);
  const deepLink = new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//spaces/${uuidToBase58(target.spaceId)}/channels/${uuidToBase58(target.workstreamId)}${target.substreamId ? `/breakouts/${uuidToBase58(target.substreamId)}` : ""}`);
  return addWorkspaceTarget(deepLink, target, { base58: true }).toString();
}

/** The addressed desktop destination for a Space dashboard. */
export function spaceDeepLink(target: SpaceLinkTarget): string {
  if (!isWorkspaceTarget(target) || !isWorkstreamId(target.spaceId)) {
    throw new Error("A Space link requires a region, Organization UUID, and Space UUID");
  }
  return addWorkspaceTarget(
    new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//spaces/${uuidToBase58(target.spaceId)}`),
    target,
    { base58: true },
  ).toString();
}

/**
 * Handoff for a parsed link. The legacy arm exists only so an old HTTPS URL can
 * still reach the current desktop; new writers call `workstreamDeepLink`.
 */
export function workstreamDeepLinkFromParsedTarget(target: ParsedWorkstreamLinkTarget): string {
  if (target.region !== null && target.spaceId) return workstreamDeepLink(target as WorkstreamLinkTarget);
  if (target.region !== null) {
    const deepLink = new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//${DEEP_LINK_HOST}/${target.workstreamId}${target.substreamId ? `/substreams/${target.substreamId}` : ""}`);
    return addWorkspaceTarget(deepLink, target).toString();
  }
  assertWorkstreamId(target.workstreamId);
  if (target.substreamId) assertWorkstreamId(target.substreamId);
  return `${DESKTOP_DEEP_LINK_PROTOCOL}//${DEEP_LINK_HOST}/${target.workstreamId}${target.substreamId ? `/substreams/${target.substreamId}` : ""}`;
}

/** The canonical shareable link emitted by every current surface. */
export function workstreamCanonicalUrl(webBaseUrl: string, target: WorkstreamLinkTarget): string {
  assertWorkstreamLinkTarget(target);
  const path = `${WORKSTREAM_LINK_PATH_PREFIX}${target.region}/${uuidToBase58(target.workspaceId)}/s/${uuidToBase58(target.spaceId)}/c/${uuidToBase58(target.workstreamId)}${target.substreamId ? `/b/${uuidToBase58(target.substreamId)}` : ""}`;
  return new URL(path, webBaseUrl).toString();
}

/** The canonical URL for a Space dashboard. */
export function spaceCanonicalUrl(webBaseUrl: string, target: SpaceLinkTarget): string {
  if (!isWorkspaceTarget(target) || !isWorkstreamId(target.spaceId)) {
    throw new Error("A Space link requires a region, Organization UUID, and Space UUID");
  }
  return new URL(`${WORKSTREAM_LINK_PATH_PREFIX}${target.region}/${uuidToBase58(target.workspaceId)}/s/${uuidToBase58(target.spaceId)}/`, webBaseUrl).toString();
}

function assertSidekickLinkTarget(target: SidekickLinkTarget): void {
  if (!isWorkspaceTarget(target) || !isWorkstreamId(target.sidekickId)) {
    throw new Error("A Sidekick link requires a region, Organization UUID, and Sidekick UUID");
  }
}

/** The addressed desktop destination for a Sidekick's own screen. */
export function sidekickDeepLink(target: SidekickLinkTarget): string {
  assertSidekickLinkTarget(target);
  return addWorkspaceTarget(
    new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//sidekicks/${uuidToBase58(target.sidekickId)}`),
    target,
    { base58: true },
  ).toString();
}

/**
 * The canonical URL for a Sidekick. A Sidekick belongs to the Organization,
 * not to a Space, so it sits directly under the Organization segment.
 */
export function sidekickCanonicalUrl(webBaseUrl: string, target: SidekickLinkTarget): string {
  assertSidekickLinkTarget(target);
  return new URL(`${WORKSTREAM_LINK_PATH_PREFIX}${target.region}/${uuidToBase58(target.workspaceId)}/sk/${uuidToBase58(target.sidekickId)}/`, webBaseUrl).toString();
}

export interface SessionImportLinkTarget extends WorkspaceTarget {
  /** The import agent's hidden conversation: the run a bad import is debugged from. */
  importId: string;
}

/**
 * The address a person copies from the import window to report a bad import.
 * Nothing routes it yet; it carries the Organization and the import's id in
 * the canonical link shape so whoever reads the report can find the run.
 */
export function sessionImportCanonicalUrl(webBaseUrl: string, target: SessionImportLinkTarget): string {
  if (!isWorkspaceTarget(target) || !isWorkstreamId(target.importId)) {
    throw new Error("An import link requires a region, Organization UUID, and import UUID");
  }
  return new URL(`${WORKSTREAM_LINK_PATH_PREFIX}${target.region}/${uuidToBase58(target.workspaceId)}/i/${uuidToBase58(target.importId)}`, webBaseUrl).toString();
}

/** Parse the canonical Sidekick path. */
export function parseSidekickLinkPathTarget(pathname: string): SidekickLinkTarget | null {
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const match = /^\/app\/([a-z][a-z0-9-]*)\/([^/]+)\/sk\/([^/]+)$/u.exec(normalized);
  if (!match) return null;
  const workspaceId = uuidFromBase58(match[2]!);
  const sidekickId = uuidFromBase58(match[3]!);
  const target = { region: match[1]!, workspaceId: workspaceId!, sidekickId: sidekickId! };
  return workspaceId && sidekickId && isWorkspaceTarget(target) ? target as SidekickLinkTarget : null;
}

/** Parse the canonical Space root, without accepting a Channel below it. */
export function parseSpaceLinkPathTarget(pathname: string): SpaceLinkTarget | null {
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const match = /^\/app\/([a-z][a-z0-9-]*)\/([^/]+)\/s\/([^/]+)$/u.exec(normalized);
  if (!match) return null;
  const workspaceId = uuidFromBase58(match[2]!);
  const spaceId = uuidFromBase58(match[3]!);
  const target = { region: match[1]!, workspaceId: workspaceId!, spaceId: spaceId! };
  return workspaceId && spaceId && isWorkspaceTarget(target) ? target as SpaceLinkTarget : null;
}

/** Read a work-stream target out of either current or legacy canonical path. */
export function parseWorkstreamLinkPathTarget(pathname: string): ParsedWorkstreamLinkTarget | null {
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const canonical = /^\/app\/([a-z][a-z0-9-]*)\/([^/]+)\/s\/([^/]+)\/c\/([^/]+)(?:\/b\/([^/]+))?$/u.exec(normalized);
  if (canonical) {
    const [, region, encodedWorkspaceId, encodedSpaceId, encodedWorkstreamId, encodedSubstreamId] = canonical;
    const workspaceId = uuidFromBase58(encodedWorkspaceId!);
    const spaceId = uuidFromBase58(encodedSpaceId!);
    const workstreamId = uuidFromBase58(encodedWorkstreamId!);
    const substreamId = encodedSubstreamId ? uuidFromBase58(encodedSubstreamId) : null;
    const target = { region: region!, workspaceId: workspaceId!, spaceId: spaceId!, workstreamId: workstreamId!,
      ...(substreamId ? { substreamId } : {}) };
    return workspaceId && spaceId && workstreamId && (!encodedSubstreamId || substreamId) && isWorkspaceTarget(target)
      ? target as WorkstreamLinkTarget
      : null;
  }
  const childPath = /^(.*)\/substreams\/([^/]+)$/u.exec(normalized);
  if (childPath) {
    const parent = parseWorkstreamLinkPathTarget(childPath[1]!);
    return parent && !parent.substreamId && isWorkstreamId(childPath[2]!) ? { ...parent, substreamId: childPath[2]! } : null;
  }
  const addressedLegacy = /^\/app\/workspaces\/([a-z][a-z0-9-]*)\/([^/]+)\/workstreams\/([^/]+)$/u.exec(normalized);
  if (addressedLegacy) {
    const [, region, workspaceId, workstreamId] = addressedLegacy;
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
  if (destination.hash || destination.username || destination.password || destination.port) return null;
  if (destination.hostname === "spaces") {
    const [encodedSpaceId = "", channelSegment, encodedWorkstreamId, breakoutSegment, encodedSubstreamId, ...extra] = destination.pathname.slice(1).split("/");
    const spaceId = uuidFromBase58(encodedSpaceId);
    const workstreamId = encodedWorkstreamId ? uuidFromBase58(encodedWorkstreamId) : null;
    const substreamId = encodedSubstreamId ? uuidFromBase58(encodedSubstreamId) : null;
    if (!addressed || !spaceId || channelSegment !== "channels" || !workstreamId || extra.length
      || (breakoutSegment !== undefined && (breakoutSegment !== "breakouts" || !substreamId))) return null;
    return { ...addressed.target, spaceId, workstreamId, ...(substreamId ? { substreamId } : {}) };
  }
  if (destination.hostname !== DEEP_LINK_HOST) return null;
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

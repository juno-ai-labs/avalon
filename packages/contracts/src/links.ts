/**
 * Shareable links to a Canvas or a Sidekick, and their desktop handoff form.
 *
 * Every link carries `(region, workspaceId)` as routing context. That pair
 * selects an already-authorized desktop Organization and grants no access; the
 * regional API still authorizes every read. The Space, Channel, Breakout and
 * Thread forms these replaced are not read here: `isRetiredLinkPath` only
 * recognizes their shapes, so the handoff page can say the thing they named is
 * gone rather than that the link is broken. See `docs/links.md`.
 *
 * This module is intentionally dependency-free so the public site can import
 * it directly without pulling a validation library into a static page.
 */

import { DESKTOP_DEEP_LINK_PROTOCOL, isDesktopDeepLinkProtocol } from "./desktop-deep-link";
import {
  addWorkspaceTarget,
  isWorkspaceTarget,
  parseWorkspaceAddressedDeepLink,
  type WorkspaceTarget,
} from "./workspace-target";
import { uuidFromBase58, uuidToBase58 } from "./uuid-base58";

/** Every canonical link sits under `/app/<region>/<organization>/`. */
export const LINK_PATH_PREFIX = "/app/";

/**
 * The site's domains before the rename. Links minted on them still sit in
 * Slack history and inboxes, so readers that receive URLs from a third party
 * accept them beside the current web base.
 */
export const LEGACY_LINK_ORIGINS: readonly string[] = Object.freeze([
  "https://with-avalon.com",
  "https://www.with-avalon.com",
]);

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CanvasLinkTarget extends WorkspaceTarget {
  canvasId: string;
  /** One of the Canvas's artifacts to open it onto, in the right rail. */
  artifactId?: string;
  /**
   * One message of the Canvas's Chat to open it at: the turn's id, with
   * `sequence`, its transcript sequence. Both or neither, and never beside
   * `artifactId`. A push about a mention or a reply opens here.
   */
  turnId?: string;
  sequence?: number;
}

export interface SidekickLinkTarget extends WorkspaceTarget {
  sidekickId: string;
}

/** What a canonical link or its deep link names. */
export type LinkTarget =
  | ({ kind: "canvas" } & CanvasLinkTarget)
  | ({ kind: "sidekick" } & SidekickLinkTarget);

function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function assertCanvasLinkTarget(target: CanvasLinkTarget): void {
  if (!isWorkspaceTarget(target) || !isId(target.canvasId) || (target.artifactId !== undefined && !isId(target.artifactId))) {
    throw new Error("A Canvas link requires a region, Organization UUID, and Canvas UUID");
  }
  if ((target.turnId === undefined) !== (target.sequence === undefined)
    || (target.turnId !== undefined && (!isId(target.turnId) || !isSequence(target.sequence!) || target.artifactId !== undefined))) {
    throw new Error("A Canvas link's message needs a turn UUID and a positive sequence, and no artifact");
  }
}

function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** `?turn=<turn>&sequence=<n>` for a target that names a message, else the empty string. */
function messageSearch(target: CanvasLinkTarget): string {
  return target.turnId === undefined ? "" : `?${new URLSearchParams({ turn: target.turnId, sequence: String(target.sequence) })}`;
}

/**
 * The message a Canvas link's query names: `turn` (a UUID) and `sequence` (a
 * positive integer), exactly those two keys, once each. `{}` for an empty
 * query; null for any other.
 */
function parseMessageSearch(search: URLSearchParams): { turnId?: string; sequence?: number } | null {
  const keys = [...search.keys()];
  if (keys.length === 0) return {};
  const turnId = search.get("turn");
  const sequence = search.get("sequence");
  if (keys.length !== 2 || turnId === null || sequence === null || !isId(turnId) || !/^[1-9][0-9]*$/u.test(sequence)) return null;
  const parsed = Number(sequence);
  return isSequence(parsed) ? { turnId, sequence: parsed } : null;
}

function assertSidekickLinkTarget(target: SidekickLinkTarget): void {
  if (!isWorkspaceTarget(target) || !isId(target.sidekickId)) {
    throw new Error("A Sidekick link requires a region, Organization UUID, and Sidekick UUID");
  }
}

function organizationPath(target: WorkspaceTarget): string {
  return `${LINK_PATH_PREFIX}${target.region}/${uuidToBase58(target.workspaceId)}`;
}

/**
 * The canonical URL for a Canvas: `/app/<region>/<organization>/cv/<canvas>/`,
 * with `a/<artifact>/` when it opens onto one of its artifacts, or
 * `?turn=<turn>&sequence=<n>` when it opens at one message. A Canvas
 * belongs to the Organization, as a Sidekick does, so it sits directly under
 * the Organization segment.
 */
export function canvasCanonicalUrl(webBaseUrl: string, target: CanvasLinkTarget): string {
  assertCanvasLinkTarget(target);
  const artifact = target.artifactId ? `a/${uuidToBase58(target.artifactId)}/` : "";
  return new URL(`${organizationPath(target)}/cv/${uuidToBase58(target.canvasId)}/${artifact}${messageSearch(target)}`, webBaseUrl).toString();
}

/** The addressed desktop destination for a Canvas, with the message's query when it names one. */
export function canvasDeepLink(target: CanvasLinkTarget): string {
  assertCanvasLinkTarget(target);
  const artifact = target.artifactId ? `/artifacts/${uuidToBase58(target.artifactId)}` : "";
  return addWorkspaceTarget(
    new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//canvases/${uuidToBase58(target.canvasId)}${artifact}${messageSearch(target)}`),
    target,
    { base58: true },
  ).toString();
}

/** The canonical URL for a Sidekick: `/app/<region>/<organization>/sk/<sidekick>/`. */
export function sidekickCanonicalUrl(webBaseUrl: string, target: SidekickLinkTarget): string {
  assertSidekickLinkTarget(target);
  return new URL(`${organizationPath(target)}/sk/${uuidToBase58(target.sidekickId)}/`, webBaseUrl).toString();
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

/** The canonical URL for whichever resource a target names. */
export function linkCanonicalUrl(webBaseUrl: string, target: LinkTarget): string {
  return target.kind === "canvas" ? canvasCanonicalUrl(webBaseUrl, target) : sidekickCanonicalUrl(webBaseUrl, target);
}

/** The desktop deep link for whichever resource a target names. */
export function linkDeepLink(target: LinkTarget): string {
  return target.kind === "canvas" ? canvasDeepLink(target) : sidekickDeepLink(target);
}

const CANONICAL_PATH = /^\/app\/([a-z][a-z0-9-]*)\/([^/]+)\/(cv|sk)\/([^/]+)(?:\/a\/([^/]+))?$/u;

/** Read a canonical Canvas or Sidekick path, with or without its trailing slash. */
export function parseLinkPathTarget(pathname: string): LinkTarget | null {
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const match = CANONICAL_PATH.exec(normalized);
  if (!match) return null;
  const [, region, encodedWorkspaceId, family, encodedId, encodedArtifactId] = match;
  const workspaceId = uuidFromBase58(encodedWorkspaceId!);
  const id = uuidFromBase58(encodedId!);
  if (!workspaceId || !id || !isWorkspaceTarget({ region, workspaceId })) return null;
  const organization = { region: region!, workspaceId };
  if (family === "sk") return encodedArtifactId === undefined ? { kind: "sidekick", ...organization, sidekickId: id } : null;
  if (encodedArtifactId === undefined) return { kind: "canvas", ...organization, canvasId: id };
  const artifactId = uuidFromBase58(encodedArtifactId);
  return artifactId ? { kind: "canvas", ...organization, canvasId: id, artifactId } : null;
}

/** Read a desktop deep link to a Canvas or a Sidekick. */
function parseDeepLink(url: URL): LinkTarget | null {
  if (!isDesktopDeepLinkProtocol(url.protocol)) return null;
  const addressed = parseWorkspaceAddressedDeepLink(url);
  if (!addressed) return null;
  const { destination, target } = addressed;
  if (destination.hash || destination.username || destination.password || destination.port) return null;
  const [encodedId = "", childKind, encodedChildId, ...extra] = destination.pathname.slice(1).split("/");
  const id = uuidFromBase58(encodedId);
  if (!id || extra.length) return null;
  if (destination.hostname === "sidekicks") return childKind === undefined && !destination.search ? { kind: "sidekick", ...target, sidekickId: id } : null;
  if (destination.hostname !== "canvases") return null;
  const message = parseMessageSearch(destination.searchParams);
  if (!message || (destination.search && childKind !== undefined)) return null;
  if (childKind === undefined) return { kind: "canvas", ...target, canvasId: id, ...message };
  const artifactId = childKind === "artifacts" && encodedChildId ? uuidFromBase58(encodedChildId) : null;
  return artifactId ? { kind: "canvas", ...target, canvasId: id, artifactId } : null;
}

/**
 * Read a shared Canvas or Sidekick link: the canonical HTTPS form on one of
 * the origins the caller names, or the desktop deep link. A caller handed URLs
 * by a third party (Slack, an agent's tool argument) names every origin a link
 * could have been minted on; nothing else widens what is read.
 */
export function parseLinkTarget(raw: string, options: { webBaseUrl: string | readonly string[] }): LinkTarget | null {
  let url: URL;
  let origins: string[];
  try {
    url = new URL(raw);
    const bases = typeof options.webBaseUrl === "string" ? [options.webBaseUrl] : options.webBaseUrl;
    origins = bases.map((base) => new URL(base).origin);
  } catch {
    return null;
  }
  const deepLink = parseDeepLink(url);
  if (deepLink) return deepLink;
  if (!origins.includes(url.origin) || url.hash || url.username || url.password) return null;
  const target = parseLinkPathTarget(url.pathname);
  if (!target || !url.search) return target;
  // Only a Canvas link with no artifact takes a query: the message it opens at.
  const message = target.kind === "canvas" && target.artifactId === undefined ? parseMessageSearch(url.searchParams) : null;
  return message ? { ...target, ...message } : null;
}

/** What the web app's Organization URL names: its landing, or a Canvas or Sidekick inside it. */
export type OrganizationShellTarget = LinkTarget | ({ kind: "organization" } & WorkspaceTarget);

const ORGANIZATION_SHELL_PATH = /^\/app\/workspaces\/([a-z][a-z0-9-]*)\/([^/]+)\/?$/u;
const SHELL_HASH = /^#\/(?:(canvases|sidekicks)\/([^/?]+)(?:\?(.*))?)?$/u;

/**
 * Read the web app's own Organization URL,
 * `/app/workspaces/<region>/<organization>`, on one of the origins the caller
 * names, with no hash or `#/` (its landing), `#/canvases/<canvas>` (with
 * `?artifact=<artifact>` and nothing else, or `?turn=<turn>&sequence=<n>`
 * and nothing else) or `#/sidekicks/<sidekick>`. Ids
 * are UUIDs here, as the web app writes them. Any other hash route, query or
 * credential reads as null. `parseLinkTarget` refuses a hash, which is why this
 * reader is separate; it takes no canonical or deep link.
 */
export function parseOrganizationShellTarget(raw: string, options: { webBaseUrl: string | readonly string[] }): OrganizationShellTarget | null {
  let url: URL;
  let origins: string[];
  try {
    url = new URL(raw);
    const bases = typeof options.webBaseUrl === "string" ? [options.webBaseUrl] : options.webBaseUrl;
    origins = bases.map((base) => new URL(base).origin);
  } catch {
    return null;
  }
  if (!origins.includes(url.origin) || url.search || url.username || url.password) return null;
  const path = ORGANIZATION_SHELL_PATH.exec(url.pathname);
  const organization = path ? { region: path[1]!, workspaceId: path[2]! } : null;
  if (!organization || !isWorkspaceTarget(organization)) return null;
  if (!url.hash) return { kind: "organization", ...organization };
  const route = SHELL_HASH.exec(url.hash);
  if (!route) return null;
  const [, family, id, query] = route;
  if (family === undefined) return query === undefined ? { kind: "organization", ...organization } : null;
  if (!isId(id!)) return null;
  if (family === "sidekicks") return query === undefined ? { kind: "sidekick", ...organization, sidekickId: id! } : null;
  if (query === undefined) return { kind: "canvas", ...organization, canvasId: id! };
  const search = new URLSearchParams(query);
  const artifactId = search.get("artifact");
  if (artifactId === null) {
    const message = parseMessageSearch(search);
    return message?.turnId !== undefined ? { kind: "canvas", ...organization, canvasId: id!, ...message } : null;
  }
  return [...search.keys()].length === 1 && isId(artifactId)
    ? { kind: "canvas", ...organization, canvasId: id!, artifactId }
    : null;
}

/**
 * The addressed desktop destination for an Organization shell target: its
 * Canvas or Sidekick, or, for the landing, the Organization's `home`, which
 * opens `#/` as the web app does.
 */
export function organizationShellDeepLink(target: OrganizationShellTarget): string {
  if (target.kind !== "organization") return linkDeepLink(target);
  return addWorkspaceTarget(new URL(`${DESKTOP_DEEP_LINK_PROTOCOL}//home`), { region: target.region, workspaceId: target.workspaceId }, { base58: true }).toString();
}

/**
 * What Rally says, on every host, when it is handed a link to something deleted
 * with Threads: the web app's entry card and the desktop's deep-link error
 * window both show this sentence.
 */
export const RETIRED_LINK_MESSAGE = "This link is to something that no longer exists. Rally replaced Channels, Threads and Breakouts with Canvases.";

/**
 * Whether a path has the shape of a link to something that no longer exists:
 * a Space (later a Channel), a Channel (later a Thread) or a Breakout, in the
 * hierarchical form (`/app/<region>/<organization>/s/...`), the addressed
 * invitation form (`/app/workspaces/<region>/<organization>/workstreams/...`),
 * the ID-only form from before Organizations were addressed
 * (`/app/workstreams/<id>`), or an import's
 * (`/app/<region>/<organization>/i/...`). The web app's own Organization
 * shell, `/app/workspaces/<region>/<organization>`, is not one. Shape only:
 * nothing it names is read, since nothing it named is left to open.
 */
export function isRetiredLinkPath(pathname: string): boolean {
  return /^\/app\/workspaces\/[^/]+\/[^/]+\/workstreams\/./u.test(pathname)
    || /^\/app\/workstreams\/./u.test(pathname)
    || /^\/app\/[a-z][a-z0-9-]*\/[^/]+\/(?:s|i)\/[^/]+/u.test(pathname);
}

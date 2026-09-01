/**
 * The routing coordinates carried by every externally emitted
 * workspace-scoped Rally link.
 *
 * They select which already-authorized workspace session should handle a
 * destination. They are not credentials and never substitute for the target
 * region's membership check.
 *
 * This module stays dependency-free so the public handoff pages can share the
 * exact parser without pulling the complete contracts package into the site.
 */

export type WorkspaceTargetRegion = "global" | "eu";

export interface WorkspaceTarget {
  region: WorkspaceTargetRegion;
  workspaceId: string;
}

const UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
const ADDRESS_HOST = "workspace";
const DESTINATION_HOST_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export interface WorkspaceAddressedDeepLink {
  target: WorkspaceTarget;
  destination: URL;
}

export function isWorkspaceTarget(value: unknown): value is WorkspaceTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceTarget>;
  return (candidate.region === "global" || candidate.region === "eu")
    && typeof candidate.workspaceId === "string"
    && UUID_PATTERN.test(candidate.workspaceId);
}

export function assertWorkspaceTarget(value: unknown): asserts value is WorkspaceTarget {
  if (!isWorkspaceTarget(value)) {
    throw new Error("A workspace link requires a region and workspace UUID");
  }
}

/**
 * Wrap a desktop destination in the versioned workspace-addressed path.
 *
 * The distinct `workspace` host is intentional rollout behavior: desktop
 * builds released before this contract do not recognize it, so they reject the
 * link instead of silently opening its resource relative to the wrong active
 * workspace. Query parameters remain exclusively destination payload.
 */
export function addWorkspaceTarget(url: URL, target: WorkspaceTarget): URL {
  assertWorkspaceTarget(target);
  if (
    url.hostname === ADDRESS_HOST
    || !DESTINATION_HOST_PATTERN.test(url.hostname)
    || url.username
    || url.password
    || url.port
  ) {
    throw new Error("A workspace link requires an unaddressed desktop destination");
  }
  const result = new URL(url.toString());
  result.hostname = ADDRESS_HOST;
  result.pathname = `/${target.region}/${target.workspaceId}/${url.hostname}${url.pathname}`;
  result.searchParams.delete("region");
  result.searchParams.delete("workspace");
  return result;
}

/** Unwrap one exact addressed link into its routing target and destination. */
export function parseWorkspaceAddressedDeepLink(
  input: URL | string,
): WorkspaceAddressedDeepLink | null {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : new URL(input.toString());
  } catch {
    return null;
  }
  if (url.hostname !== ADDRESS_HOST || url.username || url.password || url.port) return null;
  const segments = url.pathname.split("/").slice(1);
  if (segments.length < 4) return null;
  const [region, workspaceId, destinationHost, ...destinationPath] = segments;
  const target = { region, workspaceId };
  if (
    !isWorkspaceTarget(target)
    || !destinationHost
    || !DESTINATION_HOST_PATTERN.test(destinationHost)
    || destinationHost === ADDRESS_HOST
    || destinationPath.some((segment) => segment.length === 0)
  ) return null;
  try {
    const destination = new URL(
      `${url.protocol}//${destinationHost}/${destinationPath.join("/")}${url.search}${url.hash}`,
    );
    return { target, destination };
  } catch {
    return null;
  }
}

/** Read the routing pair from one exact workspace-addressed desktop link. */
export function parseWorkspaceTarget(input: URL | string): WorkspaceTarget | null {
  return parseWorkspaceAddressedDeepLink(input)?.target ?? null;
}

/** Parse routing coordinates carried inside an HTTPS handoff fragment. */
export function parseWorkspaceTargetParameters(parameters: URLSearchParams): WorkspaceTarget | null {
  const region = parameters.get("region");
  const workspaceId = parameters.get("workspace");
  if (
    parameters.getAll("region").length !== 1
    || parameters.getAll("workspace").length !== 1
    || workspaceId === null
  ) return null;
  const target = { region, workspaceId };
  return isWorkspaceTarget(target) ? target : null;
}

export function workspaceTargetsEqual(
  left: WorkspaceTarget | null | undefined,
  right: WorkspaceTarget | null | undefined,
): boolean {
  return Boolean(left && right && left.region === right.region && left.workspaceId === right.workspaceId);
}

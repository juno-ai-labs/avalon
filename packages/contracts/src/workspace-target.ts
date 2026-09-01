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

/** Add the canonical `region` and `workspace` pair without discarding other fields. */
export function addWorkspaceTarget(url: URL, target: WorkspaceTarget): URL {
  assertWorkspaceTarget(target);
  const result = new URL(url.toString());
  result.searchParams.set("region", target.region);
  result.searchParams.set("workspace", target.workspaceId);
  return result;
}

/** Read one exact target pair. Callers remain responsible for their other allowed fields. */
export function parseWorkspaceTarget(parameters: URLSearchParams): WorkspaceTarget | null {
  const region = parameters.get("region");
  const workspaceId = parameters.get("workspace");
  if (
    parameters.getAll("region").length !== 1
    || parameters.getAll("workspace").length !== 1
    || (region !== "global" && region !== "eu")
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

import type { ArtifactId, AutomationId, BlockId, Region, SubstreamId, WorkspaceId, WorkstreamId } from "@rally/contracts";

/** One regional workspace control object. */
export function workspaceDOName(region: Region, workspaceId: WorkspaceId): string {
  return `${region}:${workspaceId}`;
}

/** One canonical lifecycle authority for an automation, from first prompt. */
export function automationAgentName(
  region: Region,
  workspaceId: WorkspaceId,
  automationId: AutomationId,
): string {
  return `${region}:${workspaceId}:automation:${automationId}`;
}

/** One non-agent control object for each work stream. */
export function workstreamDOName(
  region: Region,
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
): string {
  return `${region}:${workspaceId}:${workstreamId}`;
}

/**
 * One agent object per substream.
 *
 * The main substream deliberately retains the historical WorkstreamRoom name.
 * Class rename can preserve an already-jurisdictional object, while the
 * maintenance import populates a new jurisdictional ID when the historical
 * name lived in an unrestricted namespace. Additional substreams receive
 * independent objects.
 */
export function substreamAgentName(
  region: Region,
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
  substreamId: SubstreamId | "0" = "0",
): string {
  const workstreamName = workstreamDOName(region, workspaceId, workstreamId);
  return substreamId === "0" ? workstreamName : `${workstreamName}:${substreamId}`;
}

/**
 * Permanent Bind-loop identity for one substream.
 *
 * It is derived from durable product identity rather than from an activation,
 * message, or executor receipt, so eviction and recovery can never mint a
 * second logical loop for the same substream.
 */
export function substreamLoopId(
  workstreamId: WorkstreamId,
  substreamId: SubstreamId | "0" = "0",
): string {
  return `workstream:${workstreamId}:substream:${substreamId}:loop`;
}

/** One durable Bind-loop owner for each stable HyperSight block. */
export function blockDashboardAgentName(
  region: Region,
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
  blockId: BlockId,
): string {
  return `${workstreamDOName(region, workspaceId, workstreamId)}:block-dashboard:${blockId}`;
}

/** Permanent Bind-loop identity for one HyperSight block across its executions. */
export function blockDashboardLoopId(blockId: BlockId): string {
  return `block-dashboard:${blockId}:loop`;
}

/**
 * One supervisor object per live web artifact.
 *
 * Unlike every other name here this one carries no workspace segment, and that
 * is what makes serving possible at all: the artifact serving Worker holds no
 * D1, so given nothing but a `Host` header it has to reach the right object
 * without a lookup. The artifact id is the hostname label, so the Worker parses
 * the id out of the host and names the object from it — no index, no directory
 * hop, no per-request database read on the hot path. The object itself holds
 * the resource linkage, so which workspace and work stream an artifact belongs
 * to is answered once it is addressed rather than before.
 *
 * Region-wide uniqueness comes free from the id being a UUID, which is why
 * nothing allocates a label. Both segments are in the migration reporter's
 * opaque-name allowlist: a region token and the role word `artifact`, plus a
 * UUID.
 */
export function artifactHostDOName(region: Region, artifactId: ArtifactId): string {
  return `${region}:artifact:${artifactId}`;
}

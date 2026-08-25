import type { BlockId, Region, SubstreamId, WorkspaceId, WorkstreamId } from "@rally/contracts";

/** One regional workspace control object. */
export function workspaceDOName(region: Region, workspaceId: WorkspaceId): string {
  return `${region}:${workspaceId}`;
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

/** One durable Bind-loop owner for each stable HyperSight block. */
export function blockDashboardAgentName(
  region: Region,
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
  blockId: BlockId,
): string {
  return `${workstreamDOName(region, workspaceId, workstreamId)}:block-dashboard:${blockId}`;
}

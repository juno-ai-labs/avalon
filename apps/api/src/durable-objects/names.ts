import type { Region } from "@avalon/contracts";

/** One regional workspace control object. */
export function workspaceDOName(region: Region, workspaceId: string): string {
  return `${region}:${workspaceId}`;
}

/** One non-agent control object for each work stream. */
export function workstreamDOName(region: Region, workspaceId: string, workstreamId: string): string {
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
  workspaceId: string,
  workstreamId: string,
  substreamId = "0",
): string {
  const workstreamName = workstreamDOName(region, workspaceId, workstreamId);
  return substreamId === "0" ? workstreamName : `${workstreamName}:${substreamId}`;
}

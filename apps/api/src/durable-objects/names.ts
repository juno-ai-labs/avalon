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
 * Renaming the class during the maintenance deployment therefore preserves its
 * SQLite database, while additional substreams receive independent objects.
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

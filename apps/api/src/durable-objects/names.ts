import type { ArtifactId, AutomationId, Region, SubstreamId, WorkspaceId, WorkstreamId } from "@rally/contracts";

/** One regional workspace control object. */
export function workspaceDOName(region: Region, workspaceId: WorkspaceId): string {
  return `${region}:${workspaceId}`;
}

/** One automation object: the parent of an automation's conversation and its runs. */
export function automationDOName(
  region: Region,
  workspaceId: WorkspaceId,
  automationId: AutomationId,
): string {
  return `${region}:${workspaceId}:automation:${automationId}`;
}

/** One non-agent control object for each work stream: the parent of its substreams. */
export function workstreamDOName(
  region: Region,
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
): string {
  return `${region}:${workspaceId}:${workstreamId}`;
}

/**
 * One conversation object per substream, named by its parent.
 *
 * `parentId` is a work stream id or an automation id; the kind is not in the
 * name because both are UUIDs and the object records its own kind. The main
 * substream (`"0"`) deliberately retains the historical WorkstreamRoom name, so
 * no deployed object moved when the parent became typed. Additional substreams
 * receive independent objects suffixed by their substream id.
 */
export function conversationObjectName(
  region: Region,
  workspaceId: WorkspaceId,
  parentId: string,
  substreamId: SubstreamId | "0" = "0",
): string {
  const parentName = `${region}:${workspaceId}:${parentId}`;
  return substreamId === "0" ? parentName : `${parentName}:${substreamId}`;
}

/**
 * Permanent Bind-loop identity for one substream.
 *
 * It is derived from durable product identity rather than from an activation,
 * message, or executor receipt, so eviction and recovery can never mint a
 * second logical loop for the same substream.
 */
export function substreamLoopId(
  parentId: string,
  substreamId: SubstreamId | "0" = "0",
): string {
  // The `workstream:` prefix is historical and kept: renaming it would mint a
  // second loop identity for every deployed substream.
  return `workstream:${parentId}:substream:${substreamId}:loop`;
}

/**
 * One supervisor object per live web artifact.
 *
 * Unlike every other name here this one carries no workspace segment, and that
 * keeps the supervisor identity stable when the public name changes. The
 * serving Worker resolves a readable stub through the content-free platform D1
 * index, then names this object from the returned artifact UUID. The object
 * itself holds the resource linkage, so which workspace and work stream an
 * artifact belongs to is answered only after the opaque route has been
 * resolved.
 *
 * Every segment is in the migration reporter's opaque-name allowlist: a region
 * token, the role word `artifact`, and a UUID.
 */
export function artifactHostDOName(region: Region, artifactId: ArtifactId): string {
  return `${region}:artifact:${artifactId}`;
}

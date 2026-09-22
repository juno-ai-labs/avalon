import { asWorkspaceId, asWorkstreamId, workstreamCanonicalUrl, type Region } from "@rally/contracts";

import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { logWarn } from "../observability/logger";

/** Mint a canonical Channel or Breakout URL from the Organization's current placement authority. */
export async function canonicalWorkstreamUrl(
  env: Env,
  input: { region: Region; workspaceId: string; workstreamId: string; substreamId?: string },
): Promise<string> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(input.region, workspaceId),
  );
  const placement = await workspace.canonicalChannelSpace({
    workspaceId,
    workstreamId: asWorkstreamId(input.workstreamId),
  });
  if (!placement.spaceId) {
    // Space bootstrap and placement can lag Channel creation. A link should not
    // turn that transient absence into a lost notification or queued push.
    logWarn(env, "canonical_channel_space_missing", { workspaceId, workstreamId: input.workstreamId });
    return new URL(
      `/app/workspaces/${input.region}/${workspaceId}/workstreams/${input.workstreamId}${input.substreamId ? `/substreams/${input.substreamId}` : ""}`,
      env.PUBLIC_WEB_BASE_URL,
    ).toString();
  }
  return workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, {
    ...input,
    workspaceId,
    spaceId: placement.spaceId,
  });
}

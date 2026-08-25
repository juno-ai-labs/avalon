import {
  WorkspaceSyncTopicSchema,
  asWorkspaceId,
  type WorkspaceSyncTopic,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";

/** Publish one durable, replayable invalidation through the workspace control plane. */
export async function publishWorkspaceSync(
  env: Env,
  workspaceId: string,
  topics: readonly WorkspaceSyncTopic[],
): Promise<number> {
  const unique = [...new Set(topics)].map((topic) => WorkspaceSyncTopicSchema.parse(topic));
  if (unique.length === 0) return 0;
  const placementAffinity = await workspacePlacementAffinity(env, workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
    placementAffinity,
  );
  return workspace.publishSync(unique, workspaceId, placementAffinity);
}

/**
 * Complete workspace-query invalidation map for authenticated desktop writes.
 * Workstream-local detail/feed state is also pushed by WorkstreamDO and
 * SubstreamAgent; the authoritative workspace-directory topic is named here
 * because the sidebar is a WorkspaceDO query owned by neither child socket.
 */
export function workspaceSyncTopicsForMutation(
  method: string,
  pathname: string,
): WorkspaceSyncTopic[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return [];
  if (pathname === "/workspace/me") return ["workspace_profile", "member_directory"];
  if (pathname.startsWith("/workspace/terminal")) return ["terminal_policy"];
  if (pathname.startsWith("/workspace/invitations")) {
    return ["member_directory", "invitation_directory"];
  }
  if (pathname === "/workspace") return ["workspace_profile"];
  if (pathname.startsWith("/connections")) {
    return ["connector_connections", "resources", "automations", "digest_schedule"];
  }
  if (pathname.startsWith("/digest")) return ["digest_schedule"];
  if (
    pathname.startsWith("/automations")
    || pathname.startsWith("/automation-subscriptions")
    || pathname.startsWith("/automation-templates")
  ) return ["automations", "workstream_directory"];
  if (pathname.startsWith("/notes")) return ["notes", "resources"];
  if (pathname.startsWith("/resources")) return ["resources", "workstream_directory"];
  if (pathname.startsWith("/work-opportunities")) {
    return ["work_opportunities", "activity", "workstream_directory"];
  }
  if (pathname.startsWith("/workstreams")) return ["workstream_directory"];
  if (pathname.startsWith("/telemetry/preference")) return ["viewer_preferences"];
  return [];
}

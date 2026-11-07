import {
  WorkspaceSyncTopicSchema,
  asUserId,
  asWorkspaceId,
  type WorkspaceSyncTopic,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";

/**
 * Who a sync event is news to, beyond the whole Organization it goes to by
 * default. `docs/realtime-sockets.md` has the table of which topic is per
 * person.
 */
export interface WorkspaceSyncDetail {
  /** Members a membership change added or removed; each gets its search decisions projected. */
  memberUserIds?: readonly string[];
  /** The only people whose own settings the change moved. */
  audienceUserIds?: readonly string[];
  /** The connection the change was to: its owner hears of it when it is personal, everyone when it is not. */
  connectionId?: string;
}

/** Seat a member who just accepted their invitation in the Spaces that listed its address. */
export async function seatSpaceInvitee(env: Env, workspaceId: string, userId: string, email: string): Promise<string[]> {
  const placementAffinity = await workspacePlacementAffinity(env, workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
    placementAffinity,
  );
  const result = await workspace.seatSpaceInvitee({
    workspaceId: asWorkspaceId(workspaceId), userId: asUserId(userId), email: email.toLowerCase(),
  });
  return result.seatedSpaceIds;
}

/** Publish one durable, replayable invalidation through the workspace control plane. */
export async function publishWorkspaceSync(
  env: Env,
  workspaceId: string,
  topics: readonly WorkspaceSyncTopic[],
  detail?: WorkspaceSyncDetail,
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
  return workspace.publishSync(unique, workspaceId, placementAffinity, detail ? {
    ...(detail.memberUserIds ? { memberUserIds: [...detail.memberUserIds] } : {}),
    ...(detail.audienceUserIds ? { audienceUserIds: [...detail.audienceUserIds] } : {}),
    ...(detail.connectionId !== undefined ? { connectionId: detail.connectionId } : {}),
  } : undefined);
}

/**
 * Everything a change to a connection can move: the connection itself (and
 * the installation, catalog and repository-access reads beside it), the
 * resources its account can reach, and a digest whose destination it is.
 * Sidekicks are not here: no Sidekick read consults a connection, which a
 * Sidekick reads only when one is applied or its principal is claimed, and
 * both of those are Sidekick writes that publish `automations` themselves.
 */
export const CONNECTION_SYNC_TOPICS: readonly WorkspaceSyncTopic[] = [
  "connector_connections",
  "resources",
  "digest_schedule",
];

/**
 * Who one mutation's invalidation is for.
 *
 * - `organization`: every socket in the Organization.
 * - `actor`: the person who made the write — their digest, their onboarding
 *   progress, their telemetry preference, their own OAuth attempt.
 * - `connection`: the audience of the connection the write changed, which
 *   `WorkspaceDO.publishSync` reads from the connection's own row. The id is
 *   the path's; a route that creates a connection names it with
 *   `noteChangedConnection`, and a write that names none is told to everyone.
 *
 * This map is the one publisher of a `/connections` request's own write; the
 * connection service publishes only what no request carries (an OAuth
 * completion, background discovery), so a write is not told twice.
 */
export type WorkspaceSyncAudience =
  | { kind: "organization" }
  | { kind: "actor" }
  | { kind: "connection"; connectionId: string | null };

export interface WorkspaceSyncPublication {
  topics: WorkspaceSyncTopic[];
  audience: WorkspaceSyncAudience;
}

const ORGANIZATION = { kind: "organization" } as const;
const ACTOR = { kind: "actor" } as const;

/** `/connections/<segment>` routes whose segment is a route name rather than a connection id. */
const CONNECTION_COLLECTION_SEGMENTS = new Set([
  "ashby", "canva", "custom-mcp", "fireflies", "github", "google", "granola", "linear", "notion",
  "oauth-attempts", "slack", "webhook", "x", "catalog",
]);

function connectionPublications(pathname: string): WorkspaceSyncPublication[] {
  const [, , first, second, third] = pathname.split("/");
  // Starting an authorization writes only the person's own attempt; the
  // connection changes when it completes, which publishes for itself.
  if (second === "start" || (third === "start" && second === "resource-authorizations") || second === "reconnect") {
    return [{ topics: ["connector_oauth_attempts"], audience: ACTOR }];
  }
  if (first === "slack" && second === "link" && third === "preview") return [];
  // A person's own Slack identity: their connections and their digest's
  // destinations, nobody else's.
  if (first === "slack" && second === "link") {
    return [{ topics: ["connector_connections", "digest_schedule"], audience: ACTOR }];
  }
  // The Canva loopback runs the provider's OAuth completion, which publishes
  // the connection's topics to its audience itself, as every completion does.
  if (first === "canva" && second === "complete") return [];
  // Routes that only ever create an Organization connection.
  if ((first === "x" && second === undefined) || (second === "workspace" && (first === "ashby" || first === "granola"))) {
    return [{ topics: [...CONNECTION_SYNC_TOPICS], audience: ORGANIZATION }];
  }
  const connectionId = first !== undefined && first !== "" && !CONNECTION_COLLECTION_SEGMENTS.has(first) ? first : null;
  return [{ topics: [...CONNECTION_SYNC_TOPICS], audience: { kind: "connection", connectionId } }];
}

/**
 * Complete workspace-query invalidation map for authenticated desktop writes,
 * each with who it is news to. Workstream-local detail/feed state is also
 * pushed by AgentLoopDO; the authoritative workspace-directory topic is
 * named here because the sidebar is a WorkspaceDO query the conversation
 * socket does not own.
 */
export function workspaceSyncPublicationsForMutation(
  method: string,
  pathname: string,
): WorkspaceSyncPublication[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return [];
  const organization = (...topics: WorkspaceSyncTopic[]) => [{ topics, audience: ORGANIZATION }];
  // A person's own onboarding journey; the Organization's profile is
  // `PATCH /workspace`.
  if (pathname === "/workspace/onboarding") return [{ topics: ["workspace_profile"], audience: ACTOR }];
  // A person's own display preferences, for their other windows.
  if (pathname === "/workspace/me/preferences") return [{ topics: ["viewer_preferences"], audience: ACTOR }];
  if (pathname === "/workspace/me") return organization("workspace_profile", "member_directory");
  if (pathname.startsWith("/workspace/terminal")) return organization("terminal_policy");
  if (pathname.startsWith("/workspace/invitations")) {
    return organization("member_directory", "invitation_directory");
  }
  if (pathname === "/workspace") return organization("workspace_profile");
  // Rally access is shown beside the profile, to every administrator.
  if (pathname === "/workspace/support-access") return organization("workspace_profile");
  if (pathname === "/connections" || pathname.startsWith("/connections/")) return connectionPublications(pathname);
  // A digest belongs to one person (`routes/digest.ts`).
  if (
    pathname.startsWith("/automations")
    || pathname.startsWith("/automation-subscriptions")
    || pathname.startsWith("/automation-templates")
  ) return organization("automations", "workstream_directory");
  if (pathname.startsWith("/notes")) return organization("notes", "resources");
  if (pathname.startsWith("/resources")) return organization("resources", "workstream_directory");
  // A person's own analytics choice.
  if (pathname.startsWith("/telemetry/preference")) return [{ topics: ["viewer_preferences"], audience: ACTOR }];
  return [];
}

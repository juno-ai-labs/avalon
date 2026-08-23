import { asWorkspaceId, type WorkspaceId } from "@avalon/contracts";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceConnectorEventSchema } from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

interface EnqueueInput {
  workspaceId: WorkspaceId;
  partitionKey: string;
  audienceScope: "personal" | "workspace";
  audienceUserId: string | null;
  sourceKind: "activity" | "message";
  sourceId: string;
  occurredAt: string;
  inputCharacters: number;
}

async function enqueue(env: Env, input: EnqueueInput): Promise<void> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  await workspace.enqueueOpportunitySource({
    workspaceId: input.workspaceId,
    partitionKey: input.partitionKey,
    audience: { scope: input.audienceScope, userId: input.audienceUserId },
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    occurredAt: input.occurredAt,
    inputCharacters: input.inputCharacters,
  });
}

export async function enqueueActivityOpportunity(
  env: Env,
  activityId: string,
  knownWorkspaceId: WorkspaceId,
): Promise<void> {
  const durableActivity = WorkspaceConnectorEventSchema.nullable().parse(
    await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      knownWorkspaceId,
      workspaceDOName(env.AVALON_REGION, knownWorkspaceId),
    ).then((workspace) => workspace.connectorEvent({ workspaceId: knownWorkspaceId, eventId: activityId })),
  );
  if (!durableActivity) return;
  const activity = {
    workspace_id: durableActivity.activity.workspaceId,
    connection_id: durableActivity.activity.connectionId,
    connection_scope: durableActivity.activity.connectionScope,
    connection_owner_user_id: durableActivity.activity.connectionOwnerUserId,
    occurred_at: durableActivity.activity.occurredAt,
    title: durableActivity.activity.title,
    summary: durableActivity.activity.summary,
    text_snippet: durableActivity.activity.textSnippet,
    actor_json: JSON.stringify(durableActivity.activity.actor),
    subject_json: JSON.stringify(durableActivity.activity.subject),
    visibility_json: JSON.stringify(durableActivity.activity.visibility),
    target_user_ids_json: JSON.stringify(durableActivity.activity.targetUserIds),
  };
  const personal = activity.connection_scope === "personal";
  const ownerId = activity.connection_owner_user_id == null ? null : String(activity.connection_owner_user_id);
  if (personal && !ownerId) return;
  const workspaceId = asWorkspaceId(String(activity.workspace_id));
  const approximateCharacters = [activity.title, activity.summary, activity.text_snippet, activity.actor_json, activity.subject_json]
    .reduce<number>((sum, value) => sum + String(value ?? "").length, 0);
  let restrictedUserIds: string[] = [];
  if (!personal) {
    if (typeof activity.target_user_ids_json === "string") {
      try {
        const parsed: unknown = JSON.parse(activity.target_user_ids_json);
        restrictedUserIds = Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === "string")
          : [];
      } catch {
        restrictedUserIds = [];
      }
    }
  }
  if (!personal && restrictedUserIds.length === 0 && typeof activity.visibility_json === "string") {
    try {
      const visibility = JSON.parse(activity.visibility_json) as Record<string, unknown>;
      const rawIds = visibility.targetUserIds ?? visibility.allowedUserIds;
      if (Array.isArray(rawIds)) {
        restrictedUserIds = [...new Set(rawIds.filter((value): value is string => typeof value === "string"))];
      }
    } catch {
      restrictedUserIds = [];
    }
  }
  if (restrictedUserIds.length > 0) {
    await Promise.all(restrictedUserIds.map((userId) => enqueue(env, {
      workspaceId,
      partitionKey: `restricted:${String(activity.connection_id)}:${userId}`,
      audienceScope: "personal",
      audienceUserId: userId,
      sourceKind: "activity",
      sourceId: activityId,
      occurredAt: String(activity.occurred_at),
      inputCharacters: approximateCharacters,
    })));
    return;
  }
  await enqueue(env, {
    workspaceId,
    partitionKey: personal ? `personal:${ownerId}` : "workspace",
    audienceScope: personal ? "personal" : "workspace",
    audienceUserId: personal ? ownerId : null,
    sourceKind: "activity",
    sourceId: activityId,
    occurredAt: String(activity.occurred_at),
    inputCharacters: approximateCharacters,
  });
}

export async function enqueueMentionOpportunitySnapshot(
  env: Env,
  input: {
    workspaceId: WorkspaceId;
    messageId: string;
    targetUserIds: string[];
    occurredAt: string;
    inputCharacters: number;
  },
): Promise<void> {
  await Promise.all([...new Set(input.targetUserIds)].map((userId) => enqueue(env, {
    workspaceId: input.workspaceId,
    partitionKey: `mention:${userId}`,
    audienceScope: "personal",
    audienceUserId: userId,
    sourceKind: "message",
    sourceId: input.messageId,
    occurredAt: input.occurredAt,
    inputCharacters: input.inputCharacters,
  })));
}

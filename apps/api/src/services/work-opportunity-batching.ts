import { asWorkspaceId, type WorkspaceId } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceConnectorEventSchema } from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

const DEBOUNCE_MS = 10 * 60_000;
const MAX_DELAY_MS = 60 * 60_000;

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

function processAfter(firstEventAt: string, lastEventAt: string): string {
  return new Date(Math.min(
    Date.parse(lastEventAt) + DEBOUNCE_MS,
    Date.parse(firstEventAt) + MAX_DELAY_MS,
  )).toISOString();
}

async function enqueue(env: Env, input: EnqueueInput): Promise<void> {
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase === "durable_object_open") {
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
    return;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const at = nowIso();
    let window = await env.DB.prepare(
      `SELECT id, first_event_at FROM opportunity_batch_windows
       WHERE workspace_id = ? AND partition_key = ? AND status = 'queued' LIMIT 1`,
    ).bind(input.workspaceId, input.partitionKey).first<{ id: string; first_event_at: string }>();

    if (!window) {
      const id = newId();
      try {
        await env.DB.prepare(
          `INSERT INTO opportunity_batch_windows
           (id, workspace_id, partition_key, audience_scope, audience_user_id,
            first_event_at, last_event_at, process_after, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).bind(
          id,
          input.workspaceId,
          input.partitionKey,
          input.audienceScope,
          input.audienceUserId,
          at,
          at,
          processAfter(at, at),
          at,
          at,
        ).run();
        window = { id, first_event_at: at };
      } catch {
        window = await env.DB.prepare(
          `SELECT id, first_event_at FROM opportunity_batch_windows
           WHERE workspace_id = ? AND partition_key = ? AND status = 'queued' LIMIT 1`,
        ).bind(input.workspaceId, input.partitionKey).first<{ id: string; first_event_at: string }>();
        if (!window) continue;
      }
    }

    const due = processAfter(window.first_event_at, at);
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE opportunity_batch_windows
         SET last_event_at = MAX(last_event_at, ?), process_after = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).bind(at, due, at, window.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO opportunity_batch_events
         (id, workspace_id, window_id, partition_key, source_kind, source_id,
          occurred_at, input_characters, status, created_at, updated_at)
         SELECT ?, ?, id, ?, ?, ?, ?, ?, 'pending', ?, ?
         FROM opportunity_batch_windows WHERE id = ? AND status = 'queued'`,
      ).bind(
        newId(), input.workspaceId, input.partitionKey, input.sourceKind,
        input.sourceId, input.occurredAt, Math.max(0, input.inputCharacters), at, at,
        window.id,
      ),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) === 1) return;

    const alreadyQueued = await env.DB.prepare(
      `SELECT 1 FROM opportunity_batch_events
       WHERE workspace_id = ? AND partition_key = ? AND source_kind = ? AND source_id = ? LIMIT 1`,
    ).bind(input.workspaceId, input.partitionKey, input.sourceKind, input.sourceId).first();
    if (alreadyQueued) return;
  }

  throw new Error("Opportunity aggregation event could not be queued");
}

export async function enqueueActivityOpportunity(
  env: Env,
  activityId: string,
  knownWorkspaceId?: WorkspaceId,
): Promise<void> {
  const authority = await readWorkstreamAuthorityControl(env);
  const durableActivity = authority.phase === "durable_object_open" && knownWorkspaceId
    ? WorkspaceConnectorEventSchema.nullable().parse(await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      knownWorkspaceId,
      workspaceDOName(env.AVALON_REGION, knownWorkspaceId),
    ).then((workspace) => workspace.connectorEvent({ workspaceId: knownWorkspaceId, eventId: activityId })))
    : null;
  const activity = durableActivity ? {
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
  } : await env.DB.prepare(
    `SELECT a.workspace_id, a.connection_id, a.connection_scope, a.connection_owner_user_id, a.occurred_at,
            a.title, a.summary, a.text_snippet, a.actor_json, a.subject_json,
            a.visibility_json, a.target_user_ids_json
     FROM activities a WHERE a.id = ? LIMIT 1`,
  ).bind(activityId).first<Record<string, unknown>>();
  if (!activity) return;
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

export async function enqueueMentionOpportunities(
  env: Env,
  workspaceId: WorkspaceId,
  messageId: string,
  targetUserIds: string[],
): Promise<void> {
  if (targetUserIds.length === 0) return;
  const message = await env.DB.prepare(
    "SELECT created_at, text_content FROM messages WHERE id = ? AND workspace_id = ? LIMIT 1",
  ).bind(messageId, workspaceId).first<{ created_at: string; text_content: string }>();
  if (!message) return;
  await enqueueMentionOpportunitySnapshot(env, {
    workspaceId,
    messageId,
    targetUserIds,
    occurredAt: message.created_at,
    inputCharacters: message.text_content.length,
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

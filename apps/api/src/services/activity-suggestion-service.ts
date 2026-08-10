import { newId, nowIso } from "@avalon/db";
import { workstreamRoomName } from "../durable-objects/workstream-room";
import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";

interface CreateActivitySuggestionInput {
  region: "global" | "eu";
  workspaceId: string;
  activityId: string;
  activityTitle: string;
  activitySummary: string;
  workstreamId: string;
  confidence: number;
  reason: string;
  matchedEntities: string[];
}

export async function publishWorkstreamRoomEvent(
  env: Env,
  region: "global" | "eu",
  workspaceId: string,
  workstreamId: string,
  event: unknown,
): Promise<void> {
  const rooms = durableObjectNamespaceForRegion(env.WORKSTREAM_ROOMS, region, env.APP_ENV);
  const id = rooms.idFromName(workstreamRoomName(region, workspaceId, workstreamId));
  const response = await rooms.get(id).fetch(
    "https://workstream-room/internal/events",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    },
  );
  if (!response.ok) throw new Error(`workstream_event_rejected:${response.status}`);
}

export async function createActivitySuggestion(
  env: Env,
  input: CreateActivitySuggestionInput,
): Promise<boolean> {
  const id = newId();
  const createdAt = nowIso();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO activity_suggestions (
       id, workspace_id, activity_id, workstream_id, confidence, reason,
       matched_entities_json, status, created_at, resolved_at, resolved_by_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
  ).bind(
    id,
    input.workspaceId,
    input.activityId,
    input.workstreamId,
    Math.max(0, Math.min(1, input.confidence)),
    input.reason.slice(0, 4_000),
    JSON.stringify(input.matchedEntities.slice(0, 100)),
    createdAt,
  ).run();
  if (Number(inserted.meta.changes ?? 0) === 0) return false;

  await publishWorkstreamRoomEvent(env, input.region, input.workspaceId, input.workstreamId, {
    type: "activity_suggestion_created",
    suggestion: {
      id,
      activityId: input.activityId,
      workstreamId: input.workstreamId,
      title: input.activityTitle,
      summary: input.activitySummary,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      reason: input.reason.slice(0, 4_000),
      status: "pending",
      createdAt,
      resolvedAt: null,
    },
  });
  return true;
}

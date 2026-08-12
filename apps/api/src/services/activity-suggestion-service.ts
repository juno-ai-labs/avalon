import { newId, nowIso } from "@avalon/db";
import { workstreamRoomName } from "../durable-objects/workstream-room";
import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";

/**
 * Which decision produced this card.
 *
 * Required rather than defaulted, because the two producers write rows that are
 * identical in the transcript and are resolved by the same endpoint, and the
 * routing feedback in `activity-routing-feedback.ts` reads a resolution as
 * evidence about *the producer that made it*. A new producer that forgets to say
 * who it is would silently donate its dismissals to contextual routing's gates.
 */
export type ActivitySuggestionSource = "contextual_routing" | "suggested_work";

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
  source: ActivitySuggestionSource;
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
  const title = truncateUtf16Safe(input.activityTitle, 300);
  const summary = truncateUtf16Safe(input.activitySummary, 2_000);
  const reason = truncateUtf16Safe(input.reason, 1_200);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO activity_suggestions (
       id, workspace_id, activity_id, workstream_id, confidence, reason,
       matched_entities_json, status, created_at, resolved_at, resolved_by_user_id, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?)`,
  ).bind(
    id,
    input.workspaceId,
    input.activityId,
    input.workstreamId,
    Math.max(0, Math.min(1, input.confidence)),
    reason,
    JSON.stringify(input.matchedEntities.slice(0, 100)),
    createdAt,
    input.source,
  ).run();
  if (Number(inserted.meta.changes ?? 0) === 0) return false;

  await publishWorkstreamRoomEvent(env, input.region, input.workspaceId, input.workstreamId, {
    type: "activity_suggestion_created",
    suggestion: {
      id,
      activityId: input.activityId,
      workstreamId: input.workstreamId,
      title,
      summary,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      reason,
      status: "pending",
      createdAt,
      resolvedAt: null,
    },
  });
  return true;
}

import {
  ActivityQueueMessageSchema,
  NormalizedActivitySchema,
  type NormalizedActivity,
} from "@rally/contracts";
import { newId } from "@rally/db";
import type { Env } from "../env";
import { enqueueWorkspaceConnectorEvent } from "./workspace-connector-event-ingress";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

const NormalizedActivityInputSchema = NormalizedActivitySchema.omit({ id: true });

/**
 * Persists one already-verified connector activity and schedules its canonical
 * row. Provider transports retain ownership of signature checks and routing;
 * this helper owns the shared idempotent activity-to-queue handoff.
 */
export async function persistNormalizedActivity(
  env: Env,
  input: Omit<NormalizedActivity, "id">,
  knownConnectorType?: string,
): Promise<{ activityId: string; duplicate: boolean }> {
  const activity = NormalizedActivityInputSchema.parse(input);
  const proposedId = newId();
  if (env.WORKSPACE_DOS) {
    let connectorType = knownConnectorType;
    if (!connectorType) {
      const workspaceEnv = withWorkspaceRuntimeDatabase(env, activity.workspaceId);
      const connection = await workspaceEnv.DB.prepare(
        `SELECT connector_type FROM connector_connections
          WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
      ).bind(activity.connectionId, activity.workspaceId).first<{ connector_type: string }>();
      if (!connection) throw new Error("Connector connection is unavailable");
      connectorType = connection.connector_type;
    }
    await enqueueWorkspaceConnectorEvent(env, {
      connectorType,
      activity: { id: proposedId, ...activity },
    });
    // WorkspaceDO resolves provider/dedupe uniqueness when the Queue delivers.
    // The HTTP/Slack/Workflow caller needs the handoff identity, not a second
    // synchronous cross-object round trip to predict the canonical event ID.
    return { activityId: proposedId, duplicate: false };
  }
  const inserted = await env.DB.prepare(
    `INSERT INTO activities
     (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
      provider, provider_event_id, event_type, resource_type, provider_resource_id,
      actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet,
      payload_ref, visibility_json, entity_keys_json, dedupe_key, raw_content_hash,
      target_user_ids_json, external_people_json, processing_status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT DO NOTHING RETURNING id`,
  ).bind(
    proposedId,
    activity.workspaceId,
    activity.connectionId,
    activity.connectionScope,
    activity.connectionOwnerUserId,
    activity.provider,
    activity.providerEventId,
    activity.eventType,
    activity.resourceType,
    activity.providerResourceId,
    JSON.stringify(activity.actor),
    JSON.stringify(activity.subject),
    activity.occurredAt,
    activity.receivedAt,
    activity.title,
    activity.summary,
    activity.textSnippet,
    activity.payloadRef,
    JSON.stringify(activity.visibility),
    JSON.stringify(activity.entityKeys),
    activity.dedupeKey,
    activity.rawContentHash,
    JSON.stringify(activity.targetUserIds),
    JSON.stringify(activity.externalPeople ?? []),
    JSON.stringify(activity.metadata),
  ).first<{ id: string }>();

  let canonical = inserted;
  if (!canonical) {
    canonical = await env.DB.prepare(
      `SELECT id FROM activities
       WHERE workspace_id = ? AND connection_id = ?
         AND ((provider_event_id = ? AND event_type = ?) OR dedupe_key = ?)
         AND processing_status IN ('pending', 'failed')
       ORDER BY received_at ASC LIMIT 1`,
    ).bind(
      activity.workspaceId,
      activity.connectionId,
      activity.providerEventId,
      activity.eventType,
      activity.dedupeKey,
    ).first<{ id: string }>();
  }

  if (!canonical) {
    const processed = await env.DB.prepare(
      `SELECT id FROM activities
       WHERE workspace_id = ? AND connection_id = ?
         AND ((provider_event_id = ? AND event_type = ?) OR dedupe_key = ?)
       ORDER BY received_at ASC LIMIT 1`,
    ).bind(
      activity.workspaceId,
      activity.connectionId,
      activity.providerEventId,
      activity.eventType,
      activity.dedupeKey,
    ).first<{ id: string }>();
    if (!processed) throw new Error("Canonical connector activity could not be resolved");
    return { activityId: processed.id, duplicate: true };
  }

  await env.ACTIVITY_QUEUE.send(ActivityQueueMessageSchema.parse({
    region: activity.region,
    workspaceId: activity.workspaceId,
    activityId: canonical.id,
    attempt: 0,
  }));
  return { activityId: canonical.id, duplicate: !inserted };
}


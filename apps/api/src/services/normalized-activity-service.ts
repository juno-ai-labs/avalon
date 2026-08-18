import {
  ActivityQueueMessageSchema,
  NormalizedActivitySchema,
  type NormalizedActivity,
} from "@avalon/contracts";
import { newId } from "@avalon/db";
import type { Env } from "../env";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

const NormalizedActivityInputSchema = NormalizedActivitySchema.omit({ id: true });
const D1_ACTIVITY_PAYLOAD_RETENTION_HOURS = 24;

/**
 * Persists one already-verified connector activity and schedules its canonical
 * row. Provider transports retain ownership of signature checks and routing;
 * this helper owns the shared idempotent activity-to-queue handoff.
 */
export async function persistNormalizedActivity(
  env: Env,
  input: Omit<NormalizedActivity, "id">,
): Promise<{ activityId: string; duplicate: boolean }> {
  const activity = NormalizedActivityInputSchema.parse(input);
  const proposedId = newId();
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

/**
 * Remove normalized connector content from the regional D1 handoff row after
 * downstream consumers have had a bounded compatibility window.
 *
 * WorkspaceDO remains the durable event authority. The retained D1 columns are
 * only provider/dedupe identity, processing state, and the pointer to that
 * authority. Before cutover, pending legacy suggestions and opportunity batches
 * fence redaction until their snapshot has been materialized. After cutover the
 * WorkspaceDO source is sufficient and frozen D1 product rows cannot extend
 * handoff retention.
 */
export async function reapProcessedActivityPayloads(env: Env, limit = 500): Promise<number> {
  const cutoff = new Date(
    Date.now() - D1_ACTIVITY_PAYLOAD_RETENTION_HOURS * 60 * 60_000,
  ).toISOString();
  const authority = await readWorkstreamAuthorityControl(env);
  const legacyProductFences = authority.phase === "durable_object_open" ? "" : `
           AND NOT EXISTS (
             SELECT 1 FROM activity_suggestions suggestion
              WHERE suggestion.activity_id = activity.id AND suggestion.status = 'pending'
           )
           AND NOT EXISTS (
             SELECT 1 FROM opportunity_batch_events batch_event
              WHERE batch_event.workspace_id = activity.workspace_id
                AND batch_event.source_kind = 'activity'
                AND batch_event.source_id = activity.id
                AND batch_event.status IN ('pending', 'processing')
           )`;
  const result = await env.DB.prepare(
    `UPDATE activities
        SET actor_json = '{}',
            subject_json = '{}',
            title = '',
            summary = '',
            text_snippet = '',
            payload_ref = NULL,
            visibility_json = '{}',
            target_user_ids_json = '[]',
            entity_keys_json = '[]',
            external_people_json = '[]',
            metadata_json = json_object(
              '_workspace_do_event_id', json_extract(metadata_json, '$._workspace_do_event_id'),
              '_connector_event_workflow_id', json_extract(metadata_json, '$._connector_event_workflow_id'),
              '_connector_event_attempt', json_extract(metadata_json, '$._connector_event_attempt')
            )
      WHERE id IN (
        SELECT activity.id
          FROM activities activity
         WHERE activity.processing_status = 'processed'
           AND activity.received_at < ?
           AND json_extract(activity.metadata_json, '$._workspace_do_event_id') IS NOT NULL
           AND (activity.title <> '' OR activity.payload_ref IS NOT NULL OR activity.actor_json <> '{}')
           ${legacyProductFences}
         ORDER BY activity.received_at, activity.id
         LIMIT ?
      )`,
  ).bind(cutoff, Math.max(1, Math.min(limit, 500))).run();
  return result.meta.changes ?? 0;
}

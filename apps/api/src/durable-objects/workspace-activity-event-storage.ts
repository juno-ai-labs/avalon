
import { uuidV7 } from "../lib/uuid-v7";
import { epoch, iso } from "./workspace-projection";
import {
  WorkspaceActivityEventListResultSchema,
  WorkspaceActivityEventSourceSchema,
  type WorkspaceActivityEventInput,
  type WorkspaceActivityEventListRequest,
  type WorkspaceActivityEventListResult,
  type WorkspaceActivityEventSourceRequest,
} from "./workspace-activity-event-protocol";

/**
 * The workspace's first-party activity log: the append, the reader's
 * visibility-filtered window, and the retention sweep.
 *
 * Apart from the RPC class because the three are one design. The append is
 * idempotent on `dedupe_key` and writes the event and its target edges in one
 * transaction; the read joins those edges back to answer "is this mine"; and the
 * sweep bounds the table by the same retention window the alarm derivation
 * reads. A change to any of the three has to be checked against the other two.
 */

/** How long a workspace keeps its activity events before the sweep reclaims them. */
export const ACTIVITY_EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;


/**
 * Append one activity-log event and all of its target edges atomically.
 *
 * Returns the canonical event id, which is the proposed one on a first write and
 * the already-stored one when `dedupe_key` matches an earlier append.
 */
export function recordWorkspaceActivityEvent(
  storage: DurableObjectStorage,
  request: WorkspaceActivityEventInput,
): string {
const now = Date.now();
const proposedId = request.eventId ?? uuidV7(now);
const eventId = storage.transactionSync(() => {
  storage.sql.exec(
    `INSERT OR IGNORE INTO workspace_activity_events (
      event_id, event_type, subject_type, subject_id, subject_sequence_number,
      actor_type, actor_user_id, actor_label, title, body, canonical_url,
      audience_kind, audience_user_id, audience_workstream_id, digestible,
      occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    proposedId,
    request.eventType,
    request.subjectType,
    request.subjectId,
    request.subjectSequenceNumber ?? null,
    request.actorType,
    request.actorUserId ?? null,
    request.actorLabel,
    request.title,
    request.body ?? "",
    request.canonicalUrl ?? null,
    request.audience.kind,
    request.audience.kind === "user" ? request.audience.userId : null,
    request.audience.kind === "workstream" ? request.audience.workstreamId : null,
    request.digestible ? 1 : 0,
    epoch(request.occurredAt),
    now,
    request.sourceKind,
    request.sourceId ?? null,
    request.dedupeKey,
    JSON.stringify(request.metadata ?? {}),
  );
  const canonical = storage.sql.exec<{ event_id: string }>(
    `SELECT event_id FROM workspace_activity_events WHERE dedupe_key = ?`,
    request.dedupeKey,
  ).one().event_id;
  for (const target of request.targets ?? []) {
    storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_activity_event_targets
         (event_id, user_id, relation, created_at) VALUES (?, ?, ?, ?)`,
      canonical,
      target.userId,
      target.relation,
      now,
    );
  }
  return canonical;
});
  return eventId;
}

/** One reader's visibility-filtered, insertion-ordered activity window. */
export function listWorkspaceActivityEvents(
  storage: DurableObjectStorage,
  request: WorkspaceActivityEventListRequest,
): WorkspaceActivityEventListResult {
const rows = storage.sql.exec<{
  event_sequence: number;
  event_id: string;
  event_type: string;
  subject_type: string;
  subject_id: string | null;
  subject_sequence_number: number | null;
  actor_type: string;
  actor_user_id: string | null;
  actor_label: string;
  title: string;
  body: string;
  canonical_url: string | null;
  occurred_at: number;
  created_at: number;
  metadata_json: string;
  is_target: number;
  target_relations: string | null;
}>(
  `SELECT event.event_sequence, event.event_id, event.event_type,
          event.subject_type, event.subject_id, event.subject_sequence_number,
          event.actor_type, event.actor_user_id, event.actor_label,
          event.title, event.body, event.canonical_url, event.occurred_at,
          event.created_at, event.metadata_json,
          CASE WHEN target.user_id IS NULL THEN 0 ELSE 1 END AS is_target,
          target.relations AS target_relations
     FROM workspace_activity_events event
     LEFT JOIN (
       SELECT event_id, user_id, group_concat(relation) AS relations
         FROM workspace_activity_event_targets
        WHERE user_id = ? GROUP BY event_id, user_id
     ) target ON target.event_id = event.event_id
    WHERE (? IS NULL OR event.event_sequence > ?)
      AND event.event_sequence <= ?
      AND (? IS NULL OR event.created_at >= ?)
      AND (? = 0 OR event.digestible = 1)
      AND (
        event.audience_kind = 'workspace'
        OR (event.audience_kind = 'user' AND event.audience_user_id = ?)
        OR (event.audience_kind = 'workstream' AND EXISTS (
          SELECT 1 FROM workspace_workstream_directory directory
          JOIN workspace_workstream_viewers viewer
            ON viewer.workstream_id = directory.workstream_id
           AND viewer.authority_generation = directory.authority_generation
           AND viewer.user_id = ?
         WHERE directory.workstream_id = event.audience_workstream_id
           AND directory.archived_at IS NULL AND directory.system_kind IS NULL
           AND viewer.is_participant = 1
        ))
      )
    ORDER BY event.event_sequence LIMIT ?`,
  request.userId,
  request.from ?? null,
  request.from ?? null,
  request.through,
  epoch(request.notBefore ?? null),
  epoch(request.notBefore ?? null),
  request.digestibleOnly ? 1 : 0,
  request.userId,
  request.userId,
  request.limit,
).toArray();
return WorkspaceActivityEventListResultSchema.parse({
  items: rows.map((row) => ({
    sequence: Number(row.event_sequence),
    id: row.event_id,
    eventType: row.event_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectSequenceNumber: row.subject_sequence_number,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    title: row.title,
    body: row.body,
    canonicalUrl: row.canonical_url,
    occurredAt: iso(row.occurred_at),
    createdAt: iso(row.created_at),
    metadata: JSON.parse(row.metadata_json) as unknown,
    isTarget: row.is_target === 1,
    targetRelations: row.target_relations?.split(",").filter(Boolean) ?? [],
  })),
});
}

/** The highest event sequence this workspace has appended. */
export function latestWorkspaceActivityEventCursor(storage: DurableObjectStorage): number {
return Number(storage.sql.exec<{ sequence: number | null }>(
  `SELECT MAX(event_sequence) AS sequence FROM workspace_activity_events`,
).one().sequence ?? 0);
}

/** The originating record behind one activity event, or null. */
export function workspaceActivityEventSource(
  storage: DurableObjectStorage,
  request: WorkspaceActivityEventSourceRequest,
) {
const row = storage.sql.exec<{
  event_id: string;
  source_id: string;
  title: string;
  body: string;
  actor_user_id: string | null;
  actor_label: string;
  audience_workstream_id: string | null;
  occurred_at: number;
}>(
  `SELECT event_id, source_id, title, body, actor_user_id, actor_label,
          audience_workstream_id, occurred_at
     FROM workspace_activity_events
    WHERE source_kind = ? AND source_id = ? LIMIT 1`,
  request.sourceKind,
  request.sourceId,
).toArray()[0];
return row ? WorkspaceActivityEventSourceSchema.parse({
  id: row.event_id,
  sourceId: row.source_id,
  title: row.title,
  body: row.body,
  actorUserId: row.actor_user_id,
  actorLabel: row.actor_label,
  audienceWorkstreamId: row.audience_workstream_id,
  occurredAt: iso(row.occurred_at),
}) : null;
}

/**
 * Reclaim one bounded page of expired activity events.
 *
 * Capped per call rather than deleting the whole expired set: this runs inside
 * an alarm that has other work to do, and the alarm comes back.
 */
export function reapExpiredWorkspaceActivityEvents(
  storage: DurableObjectStorage,
  now: number,
): void {
storage.sql.exec(
  `DELETE FROM workspace_activity_events
    WHERE event_sequence IN (
      SELECT event_sequence FROM workspace_activity_events
       WHERE created_at < ? ORDER BY event_sequence LIMIT 500
    )`,
  now - ACTIVITY_EVENT_RETENTION_MS,
);
}

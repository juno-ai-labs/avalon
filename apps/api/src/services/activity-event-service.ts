import { newId, nowIso } from "@avalon/db";

import type { Env } from "../env";
import { logWarn } from "../observability/logger";

/**
 * The first-party activity log: what happened in Avalon, for whoever should
 * hear about it.
 *
 * This is deliberately not the `activities` table. That one is provider ingest —
 * keyed by connection and provider event id, written before anyone has decided
 * what an event means. This one is the product's own record: a work-stream
 * message, a mention, a connector event that has finished processing. Every
 * surface that asks "what happened for this person since this instant" reads
 * here, so a new surface costs a query rather than a fan-out of joins across
 * `messages`, `message_mentions`, `activities` and their visibility rules.
 *
 * Two properties make it expandable. `event_type` and `subject_type` are open
 * strings, so a producer adds a value and no consumer needs to enumerate them —
 * an unrecognized event still renders, because `title` and `body` are written by
 * whoever knew what happened. And audience is stored as a rule, not a
 * materialized recipient list, so a work stream gaining a participant
 * retroactively gains them its history rather than freezing them out.
 */

/** Who is allowed to read an event. Resolved against the reader at read time. */
export type ActivityEventAudience =
  /** Everyone with an active membership in the workspace. */
  | { kind: "workspace" }
  /** Exactly one person — a personal connection's activity, for instance. */
  | { kind: "user"; userId: string }
  /** Whoever is currently an active participant of the work stream. */
  | { kind: "workstream"; workstreamId: string };

export interface ActivityEventInput {
  workspaceId: string;
  /** Dotted past-tense verb, e.g. `workstream.message.posted`. */
  eventType: string;
  subjectType: string;
  subjectId: string | null;
  /** Ordering inside the subject; a message's sequence number, or null. */
  subjectSequenceNumber?: number | null;
  actorType: "user" | "agent" | "system" | "external";
  actorUserId?: string | null;
  actorLabel: string;
  title: string;
  body?: string;
  canonicalUrl?: string | null;
  audience: ActivityEventAudience;
  /**
   * Whether a person should be told about this in their digest.
   *
   * Required, and deliberately not defaulted. Audience answers who *may* hear
   * about an event; this answers whether anybody *wants* to. Most of what a
   * connector reports is machinery — a check run, an autosave, a reaction — and
   * a producer that has not decided which kind it is writing should not get the
   * benefit of the doubt in somebody's inbox. A connector producer resolves
   * this from its manifest; a first-party producer knows at the call site.
   */
  digestible: boolean;
  occurredAt: string;
  sourceKind: string;
  sourceId?: string | null;
  /** Stable per workspace, so a retried producer writes one row, not two. */
  dedupeKey: string;
  metadata?: Record<string, unknown>;
  /**
   * People the event is *about*, as opposed to people allowed to see it. A
   * digest leads with these rather than burying them among everything that
   * moved. Users outside the audience are stored anyway: the target set records
   * involvement, and the read query still filters by audience.
   */
  targets?: Array<{ userId: string; relation: string }>;
}

export interface ActivityEventRow {
  log_sequence: number;
  id: string;
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
  occurred_at: string;
  created_at: string;
  metadata_json: string;
  /** 1 when the reader is a named target of the event, 0 otherwise. */
  is_target: number;
  target_relations: string | null;
}

/**
 * A position in the insertion-ordered log, as an `activity_events.log_sequence`.
 *
 * A single integer rather than a timestamp pair, because the sequence is the
 * only total order an insert can only extend — see the column's own comment.
 */
export type ActivityEventCursor = number;

/**
 * Records one event. Never throws into its caller's critical path: an event log
 * that can fail a message post is worse than one that occasionally misses a row,
 * so failures are logged and swallowed. Callers that genuinely need the write to
 * land use `recordActivityEventOrThrow`.
 */
export async function recordActivityEvent(
  env: Env,
  input: ActivityEventInput,
): Promise<string | null> {
  try {
    return await recordActivityEventOrThrow(env, input);
  } catch (error) {
    logWarn(env, "activity_event_record_failed", {
      workspace_id: input.workspaceId,
      event_type: input.eventType,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

export async function recordActivityEventOrThrow(
  env: Env,
  input: ActivityEventInput,
): Promise<string> {
  const at = nowIso();
  const proposedId = newId();
  const audienceUserId = input.audience.kind === "user" ? input.audience.userId : null;
  const audienceWorkstreamId = input.audience.kind === "workstream" ? input.audience.workstreamId : null;

  const inserted = await env.DB.prepare(
    `INSERT INTO activity_events
       (id, workspace_id, event_type, subject_type, subject_id, subject_sequence_number,
        actor_type, actor_user_id, actor_label, title, body, canonical_url,
        audience_kind, audience_user_id, audience_workstream_id,
        occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json,
        digestible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
  ).bind(
    proposedId,
    input.workspaceId,
    input.eventType,
    input.subjectType,
    input.subjectId,
    input.subjectSequenceNumber ?? null,
    input.actorType,
    input.actorUserId ?? null,
    input.actorLabel,
    input.title,
    input.body ?? "",
    input.canonicalUrl ?? null,
    input.audience.kind,
    audienceUserId,
    audienceWorkstreamId,
    input.occurredAt,
    at,
    input.sourceKind,
    input.sourceId ?? null,
    input.dedupeKey,
    JSON.stringify(input.metadata ?? {}),
    input.digestible ? 1 : 0,
  ).first<{ id: string }>();

  // A conflict means an earlier attempt already wrote this event, and its id is
  // the canonical one. The targets are still written: the event row and its
  // targets are two statements, so an attempt that died between them would
  // otherwise leave the event permanently untargeted, and nothing would ever
  // fix it because every later attempt would take this same branch.
  // `INSERT OR IGNORE` below makes rewriting them free.
  const eventId = inserted?.id ?? (await env.DB.prepare(
    "SELECT id FROM activity_events WHERE workspace_id = ? AND dedupe_key = ?",
  ).bind(input.workspaceId, input.dedupeKey).first<{ id: string }>())?.id;
  if (!eventId) throw new Error("Activity event could not be resolved after insert");

  const targets = input.targets ?? [];
  if (targets.length > 0) {
    await env.DB.batch(targets.map((target) => env.DB.prepare(
      `INSERT OR IGNORE INTO activity_event_targets
         (event_id, workspace_id, user_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventId, input.workspaceId, target.userId, target.relation, at)));
  }
  return eventId;
}

/**
 * Reads one person's slice of the log, oldest first, as a half-open window over
 * insertion order.
 *
 * Visibility is enforced here and nowhere else, which is the point of the
 * table: a workspace event reaches every active member, a user event reaches
 * only its subject, and a work-stream event reaches its current active
 * participants. Hidden system work streams are excluded — the digest's own
 * machinery must never appear inside a digest.
 */
export async function listActivityEventsForUser(
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    /** Exclusive lower bound. Omit for "from the beginning of the window". */
    from?: ActivityEventCursor | null;
    /** Inclusive upper bound, so a run's window cannot drift while it executes. */
    through: ActivityEventCursor;
    /**
     * Hard floor on `created_at`, so a first-ever read gets a look-back window
     * rather than all history.
     *
     * Insertion time, not `occurred_at`, deliberately: the cursor axis is
     * insertion order, and flooring on the provider's timestamp would let a
     * connector poll's older-but-newly-inserted events fall outside a window
     * that has already advanced past them. A caller's "last 72 hours" therefore
     * means 72 hours of Avalon learning about things, which can include a
     * provider event that is older than that.
     */
    notBefore?: string | null;
    /**
     * Whether to return only what a person should be *told* about, as opposed
     * to everything that happened and they may see.
     *
     * Required rather than defaulted, because the two readings are both
     * legitimate and the wrong one is invisible: a surface showing an activity
     * feed wants all of it, and a surface that interrupts somebody wants the
     * subset. A new consumer has to say which it is instead of inheriting
     * whichever answer the digest happened to need.
     */
    digestibleOnly: boolean;
    limit: number;
  },
): Promise<ActivityEventRow[]> {
  const from = input.from ?? null;
  const result = await env.DB.prepare(
    `SELECT e.log_sequence, e.id, e.event_type, e.subject_type, e.subject_id, e.subject_sequence_number,
            e.actor_type, e.actor_user_id, e.actor_label, e.title, e.body, e.canonical_url,
            e.occurred_at, e.created_at, e.metadata_json,
            CASE WHEN t.user_id IS NULL THEN 0 ELSE 1 END AS is_target,
            t.relations AS target_relations
       FROM activity_events e
       LEFT JOIN (
         SELECT event_id, user_id, group_concat(relation) AS relations
           FROM activity_event_targets
          WHERE workspace_id = ?1 AND user_id = ?2
          GROUP BY event_id, user_id
       ) t ON t.event_id = e.id
      WHERE e.workspace_id = ?1
        AND (?3 IS NULL OR e.log_sequence > ?3)
        AND e.log_sequence <= ?4
        AND (?5 IS NULL OR e.created_at >= ?5)
        AND (?7 = 0 OR e.digestible = 1)
        AND (
          e.audience_kind = 'workspace'
          OR (e.audience_kind = 'user' AND e.audience_user_id = ?2)
          OR (e.audience_kind = 'workstream' AND EXISTS (
                SELECT 1
                  FROM workstream_authority_control authority
                 WHERE authority.id = 1 AND (
                   (authority.phase = 'durable_object_open' AND EXISTS (
                     SELECT 1 FROM workstream_directory_user_projections viewer
                      JOIN workstream_directory_projections common
                        ON common.workstream_id = viewer.workstream_id
                       AND common.workspace_id = viewer.workspace_id
                      WHERE viewer.workstream_id = e.audience_workstream_id
                        AND viewer.user_id = ?2
                        AND viewer.is_participant = 1
                        -- Machinery never feeds a digest, even for its own
                        -- participant: a digest must not summarize itself.
                        AND common.system_kind IS NULL
                   ))
                   OR (authority.phase != 'durable_object_open' AND EXISTS (
                     SELECT 1
                       FROM workstream_participants participant
                       JOIN workstreams workstream ON workstream.id = participant.workstream_id
                      WHERE participant.workstream_id = e.audience_workstream_id
                        AND participant.user_id = ?2
                        AND participant.removed_at IS NULL
                        AND workstream.system_kind IS NULL
                   ))
                 )
              ))
        )
        -- The reader must still be a member. A revoked membership stops the log
        -- at once rather than at the next configuration change.
        AND EXISTS (
          SELECT 1 FROM workspace_members m
           WHERE m.workspace_id = ?1 AND m.user_id = ?2 AND m.status = 'active'
        )
      ORDER BY e.log_sequence ASC
      LIMIT ?6`,
  ).bind(
    input.workspaceId,
    input.userId,
    from,
    input.through,
    input.notBefore ?? null,
    input.limit,
    input.digestibleOnly ? 1 : 0,
  ).all<ActivityEventRow>();
  return result.results ?? [];
}

/**
 * How long an event stays readable. Ninety days is far longer than anything
 * reads: a digest's first run looks back 72 hours and every run after that
 * starts from its own cursor, so the window only has to survive a schedule
 * being paused and resumed. It is a retention decision rather than a technical
 * one — the log is append-only and would otherwise grow with the workspace
 * forever.
 */
const ACTIVITY_EVENT_RETENTION_DAYS = 90;
const ACTIVITY_EVENT_REAP_BATCH = 500;
const ACTIVITY_EVENT_REAP_MAX_BATCHES = 10;

/**
 * Drops events past the retention window, oldest first.
 *
 * Deleting a row does not disturb a cursor: cursors are `log_sequence` values,
 * an expired one is below every live cursor, and a window that no longer
 * contains its rows simply reads as empty. `activity_event_targets` follows
 * through its cascade.
 *
 * Insertion order and insertion time agree, so the batch scans from the bottom
 * of the primary key and stops at the first row young enough to keep. The batch
 * cap bounds one tick's work; whatever is left waits for the next.
 */
export async function reapExpiredActivityEvents(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - ACTIVITY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  let reaped = 0;
  for (let batch = 0; batch < ACTIVITY_EVENT_REAP_MAX_BATCHES; batch += 1) {
    const result = await env.DB.prepare(
      `DELETE FROM activity_events
        WHERE log_sequence IN (
          SELECT log_sequence FROM activity_events
           WHERE created_at < ?
           ORDER BY log_sequence ASC
           LIMIT ?
        )`,
    ).bind(cutoff, ACTIVITY_EVENT_REAP_BATCH).run();
    const changes = result.meta?.changes ?? 0;
    reaped += changes;
    if (changes < ACTIVITY_EVENT_REAP_BATCH) break;
  }
  return reaped;
}

/** The newest event in a workspace, which is what a run freezes as its window's top. */
export async function latestActivityEventCursor(
  env: Env,
  workspaceId: string,
): Promise<ActivityEventCursor> {
  const row = await env.DB.prepare(
    "SELECT MAX(log_sequence) AS log_sequence FROM activity_events WHERE workspace_id = ?",
  ).bind(workspaceId).first<{ log_sequence: number | null }>();
  // An empty workspace still yields a well-formed window: it ends at 0 and
  // contains nothing, so the cursor advances and the next digest starts here.
  return Number(row?.log_sequence ?? 0);
}

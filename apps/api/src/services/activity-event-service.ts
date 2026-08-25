import type { WorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceActivityEventListResultSchema } from "../durable-objects/workspace-activity-event-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
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
  workspaceId: WorkspaceId;
  /** Stable producer identity when a durable upstream fact already owns one. */
  eventId?: string;
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
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  return workspace.recordActivityEvent(input);
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
    workspaceId: WorkspaceId;
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
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  const result = WorkspaceActivityEventListResultSchema.parse(await workspace.listActivityEvents({
    workspaceId: input.workspaceId,
    userId: input.userId,
    from,
    through: input.through,
    notBefore: input.notBefore ?? null,
    digestibleOnly: input.digestibleOnly,
    limit: input.limit,
  }));
  return result.items.map((item) => ({
    log_sequence: item.sequence,
    id: item.id,
    event_type: item.eventType,
    subject_type: item.subjectType,
    subject_id: item.subjectId,
    subject_sequence_number: item.subjectSequenceNumber,
    actor_type: item.actorType,
    actor_user_id: item.actorUserId,
    actor_label: item.actorLabel,
    title: item.title,
    body: item.body,
    canonical_url: item.canonicalUrl,
    occurred_at: item.occurredAt,
    created_at: item.createdAt,
    metadata_json: JSON.stringify(item.metadata),
    is_target: item.isTarget ? 1 : 0,
    target_relations: item.targetRelations.length > 0 ? item.targetRelations.join(",") : null,
  }));
}

/** The newest event in a workspace, which is what a run freezes as its window's top. */
export async function latestActivityEventCursor(
  env: Env,
  workspaceId: WorkspaceId,
): Promise<ActivityEventCursor> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
  );
  return workspace.latestActivityEventCursor({ workspaceId });
}

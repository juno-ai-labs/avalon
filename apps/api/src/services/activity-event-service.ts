import type { WorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
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

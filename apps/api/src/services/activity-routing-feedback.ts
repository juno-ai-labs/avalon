import type { Env } from "../env";

/**
 * What a workspace's own accept and dismiss decisions say about suggesting
 * again.
 *
 * Contextual routing's only quality control used to be a constant: the model
 * scored its own match and anything at or above 0.8 became a card. Nothing read
 * the resolution back, so a workspace could dismiss the same kind of suggestion
 * every day and the next one arrived with identical odds. These two reads are
 * the feedback that was missing, and `activity_suggestions` is already the
 * labelled data for both — a row is written at the moment the card is published,
 * so every row was seen, and `status` is the label.
 *
 * Both reads are windowed. A suppression rule that blocks the only mechanism
 * that could produce positive evidence is permanent by construction: a
 * suppressed event type can never earn the acceptance that would unsuppress it.
 * Letting old dismissals age out is what makes suppression a decaying opinion
 * rather than a life sentence, at the cost of one card when a window expires.
 *
 * The rest of contextual routing is in `docs/contextual-routing.md`.
 */

/**
 * Dismissals in a row that take a work stream out of the candidate pool.
 *
 * Three rather than one because a single dismissal is as likely to be a person
 * clearing a card they had already dealt with elsewhere as it is a judgement
 * about the match, and a run is the cheapest signal that separates the two.
 */
export const DISMISSAL_RUN_LIMIT = 3;

/**
 * How long a dismissal counts toward a work stream's run.
 *
 * Shorter than the event-type window because a work stream is a shorter-lived
 * thing than an event type: what a work stream is about drifts as the work
 * moves, and a run of dismissals from a month ago says little about what
 * belongs in it today.
 */
const DISMISSAL_RUN_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** How long a resolution counts toward its event type's score. */
const EVENT_TYPE_WINDOW_MS = 90 * 24 * 60 * 60_000;

/**
 * Resolutions before an event type's accept rate is allowed to decide anything.
 *
 * Below this the rate is noise — one dismissal out of one would suppress a type
 * outright — so the base floor stands and the type keeps producing the cards
 * that are the only way it can earn a score at all.
 */
const EVENT_TYPE_SAMPLE_MINIMUM = 4;

/** The floor an event type with no usable history is held to. */
export const BASE_CONFIDENCE_FLOOR = 0.8;

/**
 * The highest floor an accept rate may raise the bar to.
 *
 * A floor of 1.0 is not a high bar, it is an unreachable one wearing a number,
 * and it would make the outright-suppression rule below unreachable code. An
 * event type bad enough to deserve that is suppressed instead, where the
 * decision is legible in a log line rather than hidden in arithmetic.
 */
const MAXIMUM_CONFIDENCE_FLOOR = 0.95;

/**
 * The oldest dismissal that still counts toward a candidate work stream's run.
 *
 * Exported as a bare timestamp rather than a query because the run is evaluated
 * inside the candidate selection itself — filtering after `LIMIT 12` would let a
 * suppressed work stream consume one of the twelve slots and hand the model a
 * shorter list, rather than being replaced by the next eligible one.
 */
export function dismissalRunCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - DISMISSAL_RUN_WINDOW_MS).toISOString();
}

export interface SuggestionAdmission {
  /** No confidence produces a card for this event type in this workspace. */
  suppressed: boolean;
  /** The confidence a suggestion must reach, at or above `BASE_CONFIDENCE_FLOOR`. */
  confidenceFloor: number;
  accepted: number;
  dismissed: number;
}

/**
 * Whether this workspace still wants suggestions for this event type, and how
 * confident one has to be.
 *
 * Scored per `(workspace, provider, event type)` rather than per workspace: a
 * workspace that finds review requests useful and check runs useless is the
 * normal case, and a single workspace-wide rate would average the two into a
 * number that describes neither.
 */
export async function suggestionAdmission(
  env: Env,
  input: { workspaceId: string; provider: string; eventType: string },
  now: Date = new Date(),
): Promise<SuggestionAdmission> {
  const since = new Date(now.getTime() - EVENT_TYPE_WINDOW_MS).toISOString();
  // Driven from `activity_suggestions` and joined outward: the workspace's
  // resolved suggestions are few and indexed, where `activities` holds every
  // event the workspace has ever ingested and filtering that by event type
  // first would read most of it.
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN s.status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
            COALESCE(SUM(CASE WHEN s.status = 'dismissed' THEN 1 ELSE 0 END), 0) AS dismissed
       FROM activity_suggestions s
       JOIN activities a ON a.id = s.activity_id
      WHERE s.workspace_id = ?1
        AND s.status IN ('accepted', 'dismissed')
        AND s.resolved_at >= ?2
        AND a.provider = ?3
        AND a.event_type = ?4`,
  ).bind(input.workspaceId, since, input.provider, input.eventType).first<{
    accepted: number;
    dismissed: number;
  }>();

  const accepted = Number(row?.accepted ?? 0);
  const dismissed = Number(row?.dismissed ?? 0);
  const resolved = accepted + dismissed;
  if (resolved < EVENT_TYPE_SAMPLE_MINIMUM) {
    return { suppressed: false, confidenceFloor: BASE_CONFIDENCE_FLOOR, accepted, dismissed };
  }
  // Never once useful, with enough decisions behind it to mean something. The
  // model's confidence is not evidence against this: it is the same model that
  // scored every one of the dismissed suggestions highly enough to create them.
  if (accepted === 0) {
    return { suppressed: true, confidenceFloor: MAXIMUM_CONFIDENCE_FLOOR, accepted, dismissed };
  }
  const acceptRate = accepted / resolved;
  return {
    suppressed: false,
    // Linear between the two floors, so a type that is usually right keeps
    // today's bar and one that is usually wrong has to be nearly certain. A
    // step would put a cliff somewhere the data does not have one.
    confidenceFloor: Math.min(
      MAXIMUM_CONFIDENCE_FLOOR,
      BASE_CONFIDENCE_FLOOR + (MAXIMUM_CONFIDENCE_FLOOR - BASE_CONFIDENCE_FLOOR) * (1 - acceptRate),
    ),
    accepted,
    dismissed,
  };
}

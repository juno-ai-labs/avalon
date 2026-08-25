import type { WorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/**
 * What a workspace's own accept and dismiss decisions say about suggesting
 * again.
 *
 * Contextual routing's only quality control used to be a constant: the model
 * scored its own match and anything at or above 0.8 became a card. Nothing read
 * the resolution back, so a workspace could dismiss the same kind of suggestion
 * every day and the next one arrived with identical odds. These two reads are
 * the feedback that was missing. After cutover the action stays with its
 * SubstreamAgent and its resolved label is indexed in WorkspaceDO; the legacy
 * D1 row supplies the same evidence before cutover.
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

/**
 * Distinct people whose dismissals it takes to turn an event type off for the
 * whole workspace.
 *
 * A card sits in a shared transcript and anybody may resolve it, so a
 * workspace-wide decision made on one person's clicking is a decision one
 * person made for everybody. Corroboration is the cheapest guard.
 */
const EVENT_TYPE_SUPPRESSION_DISMISSERS = 2;

/** The floor an event type with no usable history is held to. */
export const BASE_CONFIDENCE_FLOOR = 0.8;

/**
 * The floor for an event type its own connector put on the operational side of
 * a line it actually drew.
 *
 * A prior, not a veto. `digestible` answers "should this be read back to
 * somebody on a schedule", and three different noes are spelled the same way:
 * *not news* (a check run finishing), *would render badly in a digest* (the
 * generic webhook, whose payload Avalon cannot parse), and *too many events per
 * piece of news* (Drive's change feed reporting every save). Only the first says
 * anything about whether the activity is relevant to a work stream — a Google
 * Doc being edited is prime context and a poor digest line — so the declaration
 * raises the bar rather than closing the door, and the workspace's own record
 * overrules it in either direction once there is one.
 */
export const OPERATIONAL_CONFIDENCE_FLOOR = 0.9;

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
  /** Distinct people whose dismissals are behind `dismissed`. */
  dismissers: number;
}

/**
 * Whether this workspace still wants suggestions for this event type, and how
 * confident one has to be.
 *
 * Scored per `(workspace, provider, event type)` rather than per workspace: a
 * workspace that finds review requests useful and check runs useless is the
 * normal case, and a single workspace-wide rate would average the two into a
 * number that describes neither.
 *
 * `declaredFloor` is where the type starts, from its connector's own
 * declaration. Observed resolutions replace it rather than adding to it — in
 * both directions — because a workspace that has accepted a type it was told is
 * machinery has said something the manifest cannot know.
 */
export async function suggestionAdmission(
  env: Env,
  input: { workspaceId: WorkspaceId; provider: string; eventType: string; declaredFloor: number },
  now: Date = new Date(),
): Promise<SuggestionAdmission> {
  const since = new Date(now.getTime() - EVENT_TYPE_WINDOW_MS).toISOString();
  let accepted = 0;
  let dismissed = 0;
  const dismissingUsers = new Set<string>();
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  const feedback = await workspace.suggestionFeedback({
    workspaceId: input.workspaceId,
    source: "contextual_routing",
    since,
    provider: input.provider,
    eventType: input.eventType,
  });
  for (const item of feedback.items) {
    if (item.status === "accepted") accepted += 1;
    else {
      dismissed += 1;
      if (item.resolvedByUserId) dismissingUsers.add(item.resolvedByUserId);
    }
  }

  const dismissers = dismissingUsers.size;
  const resolved = accepted + dismissed;
  if (resolved < EVENT_TYPE_SAMPLE_MINIMUM) {
    return { suppressed: false, confidenceFloor: input.declaredFloor, accepted, dismissed, dismissers };
  }
  if (accepted === 0) {
    // Never once useful, with enough decisions behind it to mean something —
    // but turning a type off for everybody is a workspace-wide act, and one
    // person clearing four cards in an afternoon is as likely to be somebody
    // tidying a transcript they had already dealt with elsewhere. One person's
    // dismissals raise the bar to its maximum; it takes a second person's
    // agreement to close the door, and until then the type can still earn the
    // acceptance that would reopen it.
    return {
      suppressed: dismissers >= EVENT_TYPE_SUPPRESSION_DISMISSERS,
      confidenceFloor: MAXIMUM_CONFIDENCE_FLOOR,
      accepted,
      dismissed,
      dismissers,
    };
  }
  const acceptRate = accepted / resolved;
  return {
    suppressed: false,
    // Linear between the two floors, so a type that is usually right keeps the
    // base bar and one that is usually wrong has to be nearly certain. A step
    // would put a cliff somewhere the data does not have one.
    confidenceFloor: Math.min(
      MAXIMUM_CONFIDENCE_FLOOR,
      BASE_CONFIDENCE_FLOOR + (MAXIMUM_CONFIDENCE_FLOOR - BASE_CONFIDENCE_FLOOR) * (1 - acceptRate),
    ),
    accepted,
    dismissed,
    dismissers,
  };
}

import type { ChannelAccessSources, SpaceId, UserId, WorkspaceId } from "@rally/contracts";

import type {
  ObservedChannel,
  SpaceAccessApplication,
  SpaceAccessRetraction,
} from "../durable-objects/workstream-access-protocol";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { publishAccessRevocation } from "./access-revocation";
import type { WorkstreamObjectClient } from "./workstream-object-client";

/** The readers one remaining Space supplies among a retraction's survivors. */
export interface SurvivorAttribution {
  spaceId: SpaceId;
  userIds: UserId[];
}

/**
 * An application whose canonical operations stopped part way.
 *
 * `seated` is who this attempt had already seated, which is what a rollback
 * has to attribute and withdraw; `cause` is the conversation's own refusal.
 */
export class SpaceSourceApplicationInterrupted extends Error {
  constructor(readonly seated: readonly UserId[], cause: unknown) {
    super("space_source_application_interrupted", { cause });
  }
}

/**
 * Apply one Space's source through the Channel's canonical operations.
 *
 * The widening and the seating are mutually exclusive by construction: a plan
 * that widens seats nobody, because everybody can read afterwards. Returns the
 * readers seated, in order, for the confirmation to attribute.
 */
export async function runSpaceSourceApplication(
  client: WorkstreamObjectClient,
  spaceId: SpaceId,
  plan: SpaceAccessApplication,
): Promise<UserId[]> {
  const seated: UserId[] = [];
  try {
    if (plan.widenScope) await client.update({ scope: "workspace" });
    for (const userId of plan.seatUserIds) {
      await client.addParticipant(userId, { spaceSourceId: spaceId });
      seated.push(userId);
    }
  } catch (error) {
    throw new SpaceSourceApplicationInterrupted(seated, error);
  }
  return seated;
}

/**
 * Which remaining Space supplies each survivor a retraction seats.
 *
 * A survivor several Spaces list is attributed to each of them, because
 * access is the live union and any one of them departing must leave the
 * others' claim standing. A survivor none of them lists is the direct
 * source's and is attributed to nobody.
 */
export function survivorAttributions(
  plan: SpaceAccessRetraction,
  remaining: ChannelAccessSources["spaces"],
): SurvivorAttribution[] {
  return remaining.flatMap((space) => {
    const userIds = plan.seatUserIds.filter((userId) => space.participantUserIds.includes(userId));
    return userIds.length === 0 ? [] : [{ spaceId: space.spaceId, userIds }];
  });
}

/**
 * The Channel as it will be observed once a retraction's operations have run.
 *
 * What an application planned in the same breath as a retraction has to be a
 * delta against: seats added, removals taken out, and the scope personal if the
 * retraction narrows it.
 */
export function observedAfterRetraction(
  observed: ObservedChannel,
  plan: SpaceAccessRetraction,
): ObservedChannel {
  const removed = new Set<string>(plan.removeUserIds);
  const participantUserIds = [...new Set([...observed.participantUserIds, ...plan.seatUserIds])]
    .filter((userId) => !removed.has(userId));
  const personal = plan.narrowScope || observed.readers.scope === "personal";
  return {
    readers: personal ? { scope: "personal", userIds: participantUserIds } : { scope: "workspace" },
    participantUserIds,
  };
}

/**
 * Withdraw one Space's source through the Channel's canonical operations.
 *
 * Seat, then narrow, then remove. Seating first is what keeps
 * a narrowing from revoking access a surviving source still provides (the
 * readers it supplies were never seated while everybody could read), and
 * removing last means nobody is taken out of an audience that is still about
 * to change.
 *
 * A survivor is seated under a Space that **remains**, never under the one
 * leaving: its source row is already gone, so an attribution to it could not
 * commit, and the Space that really supplies the reader would later retract
 * with no provenance for them.
 *
 * The attributions are recorded by the caller in the transaction that plans
 * the retraction, before anybody is seated.
 *
 * The narrowing's announcement is kept until the removals are done. A
 * narrowing that was not announced leaves every non-participant reader's
 * socket open until they reconnect, and every caller of a retraction has a
 * `space_intents` row behind it, so failing the step leaves that intent
 * unsettled for the alarm to finish. The throw is last because the removals
 * are the access changes themselves: giving up before them would leave a
 * reader who should have lost the Channel holding it until the resume.
 */
export async function runSpaceSourceRetraction(input: {
  env: Env;
  workspaceId: WorkspaceId;
  workstreamId: string;
  client: WorkstreamObjectClient;
  spaceId: SpaceId;
  plan: SpaceAccessRetraction;
  remaining: ChannelAccessSources["spaces"];
}): Promise<void> {
  const { client, plan } = input;
  for (const userId of plan.seatUserIds) {
    const supplier = input.remaining.find((space) => space.participantUserIds.includes(userId));
    await client.addParticipant(userId, supplier ? { spaceSourceId: supplier.spaceId } : {});
  }
  let announced = true;
  if (plan.narrowScope) {
    await client.update({ scope: "personal" });
    announced = await publishChannelNarrowing(input.env, input.workspaceId, input.workstreamId);
  }
  for (const userId of plan.removeUserIds) {
    await client.removeParticipant(userId, { spaceSourceId: input.spaceId });
    // The room closes its own sockets for somebody it removed. The automations
    // it owns admitted them through the room and nothing there reaches those
    // objects, so whoever writes the fact publishes it, in the same request,
    // exactly as `WorkstreamService.removeParticipant` does.
    await publishAccessRevocation(input.env, {
      reason: "workstream_participant_removed",
      workspaceId: input.workspaceId,
      userId,
      sessionId: null,
      target: { scope: "workstream_automations", workstreamId: input.workstreamId },
    });
  }
  if (!announced) {
    throw new ApiError(503, "channel_narrowing_publish_failed",
      "The Channel's narrowing could not be announced; it will be retried");
  }
}

/**
 * Announce that a Channel stopped admitting the whole Organization.
 *
 * The narrowing counterpart of the removal every participant write already
 * publishes, and it exists for the same reason: the room closes sockets for
 * somebody it was *told* about, and nothing tells it that the audience it just
 * took no longer covers whoever is reading. Whoever writes the fact publishes
 * it, in the same request.
 *
 * It names nobody. The readers a narrowing drops are every member who is not a
 * participant, which is the Organization; the hop asks the room which of them
 * still has a socket open, which is the only part of that set anybody can act
 * on. Shared by both narrowings (a Space's retraction and the Channel's own
 * scope change) so there is one announcement rather than two that can drift.
 *
 * Returns whether the message went out, and every caller reads it.
 * `publishAccessRevocation` is deliberately not fatal to its own caller (the
 * fact it announces has already committed), so the flag is the only signal a
 * caller that *can* still retry ever gets, and dropping it records a retraction
 * as delivered when nothing was sent.
 */
export async function publishChannelNarrowing(
  env: Env,
  workspaceId: WorkspaceId,
  workstreamId: string,
): Promise<boolean> {
  return publishAccessRevocation(env, {
    reason: "workstream_participant_removed",
    workspaceId,
    userId: null,
    sessionId: null,
    target: { scope: "workstream_audience_narrowed", workstreamId },
  });
}

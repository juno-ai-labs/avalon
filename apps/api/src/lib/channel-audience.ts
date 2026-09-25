import { asUserId, type Scope, type SpaceSummary, type UserId } from "@rally/contracts";

import type { WorkstreamReaderAudience } from "./audience-containment";

/**
 * How a Channel's readers are derived from the sources that supply them.
 *
 * A Channel has one **direct** source — its own scope and its own participants
 * — and zero or more **named** sources, each of which is something outside the
 * Channel that currently reaches it. Today every named source is a Space; the
 * functions below never say so. They are written over `sourceId` because the
 * composition rule is the interesting part and it does not depend on what the
 * source is: a source widens, it never narrows, and it stops supplying the
 * moment it stops existing. A second kind of source composes here by being
 * passed in, not by adding a branch.
 *
 * Everything in this module is pure, and it validates nothing: its inputs have
 * already crossed a schema at the RPC boundary, and every user id it handles is
 * a {@link UserId} in and out.
 *
 * There is one audience shape here, {@link AudienceSource}, and it is closed
 * under the composition below: the union of the sources that reach a Channel is
 * itself an audience, and can be handed straight back in as somebody's
 * `direct`. What a Channel's readers *currently are* is not that — it is an
 * observation of the main conversation, it says `workspace` with no roster, and
 * it arrives here as the `WorkstreamReaderAudience` that conversation reports.
 * Those are the two, and they are different on purpose.
 *
 * The provenance that says *which* sources currently
 * reach a Channel is WorkstreamDO's
 * (`durable-objects/workstream-access-storage.ts`), and applying what these
 * functions plan is the Channel's canonical scope and participant operations' —
 * which is where the retained-content containment preflight runs. This is only
 * the arithmetic between the two.
 */

/**
 * One audience: who it admits, and who it lists.
 *
 * `workspace` admits the Organization and its roster is not consulted — a
 * `workspace` audience with participants listed is normal, because a Space
 * keeps its members whether or not its scope currently makes them the reason
 * anybody can read.
 */
export interface AudienceSource {
  scope: "personal" | "workspace";
  participantUserIds: readonly UserId[];
}

/** An audience supplied by something outside the Channel, under its own id. */
export interface NamedAudienceSource extends AudienceSource {
  sourceId: string;
}

/**
 * Who may read the Channel, given its direct source and every named source
 * that currently reaches it.
 *
 * A source can only widen: `workspace` anywhere makes the whole audience
 * Organization-wide, and otherwise the readers are the union of every source's
 * participants. There is deliberately no way for one source to remove a reader
 * another supplies — that is what makes a Space's audience safe to change
 * without auditing every other Space a Channel belongs to.
 */
export function effectiveChannelAudience(input: {
  direct: AudienceSource;
  sources: readonly NamedAudienceSource[];
}): AudienceSource {
  if (input.direct.scope === "workspace" || input.sources.some((source) => source.scope === "workspace")) {
    return { scope: "workspace", participantUserIds: [] };
  }
  return {
    scope: "personal",
    participantUserIds: [...new Set([
      ...input.direct.participantUserIds,
      ...input.sources.flatMap((source) => [...source.participantUserIds]),
    ])],
  };
}

/** What applying one source asks the Channel's canonical operations to do. */
export interface AudienceSourceApplication {
  /** Whether the Channel has to become Organization-wide. */
  widenScope: boolean;
  /** Readers this source adds who cannot already read the Channel. */
  seatUserIds: UserId[];
}

/**
 * The audience change one source's arrival asks for, against what the Channel's
 * readers are right now.
 *
 * `current` is the *observed* reader audience — what the main conversation
 * answers — rather than a recomputation, because it is the thing the
 * application has to be a delta against: a reader seated for an unrelated
 * reason is already covered, and seating them again would claim this source
 * supplied them.
 *
 * An Organization-wide result seats nobody. Both a `workspace` source and a
 * Channel that is already `workspace` admit every member, so a participant row
 * would add no access and would have to be withdrawn later as though it had.
 */
export function audienceSourceApplicationPlan(input: {
  current: WorkstreamReaderAudience;
  source: AudienceSource;
}): AudienceSourceApplication {
  const widenScope = input.source.scope === "workspace" && input.current.scope !== "workspace";
  if (widenScope || input.current.scope === "workspace") return { widenScope, seatUserIds: [] };
  const readers = new Set(input.current.userIds);
  return {
    widenScope: false,
    seatUserIds: [...new Set(input.source.participantUserIds)].filter((userId) => !readers.has(userId)),
  };
}

/** What withdrawing one source asks the Channel's canonical operations to do. */
export interface AudienceSourceRetraction {
  /** Whether the Channel stops being Organization-wide. */
  narrowScope: boolean;
  /**
   * Readers a surviving source supplies who are not seated yet.
   *
   * Usually only when {@link AudienceSourceRetraction.narrowScope} is set: a
   * source applied while the Channel was Organization-wide seated nobody —
   * everybody could already read — so the readers it supplies exist only as
   * its own participant list until the audience stops being Organization-wide.
   * Seating them is what keeps a narrowing from revoking access that another
   * source still provides.
   *
   * But **not only then**, and deliberately. Access is the live union of the
   * sources that reach the Channel, so a reader a surviving source still lists
   * is a reader, whatever the roster currently says — including somebody a
   * direct removal took out while their Space went on supplying them. That
   * source's roster re-asserts itself here rather than a direct removal
   * narrowing it, because narrowing a Space's audience from one Channel is
   * exactly what "sources compose without one narrowing another" rules out;
   * the way to take that reader out is to take them out of the Space.
   */
  seatUserIds: UserId[];
  /** Readers only the departing source supplied. */
  removeUserIds: UserId[];
}

/**
 * The audience change one source's departure asks for.
 *
 * `suppliedByDeparting` is the provenance, and it is what keeps this from
 * removing somebody the departing source merely *listed*: a reader who is a
 * participant because they were added directly, or because they were named in
 * a message, was never supplied by this source and is not withdrawn with it.
 *
 * Everything else is derived from the sources that remain, so a reader the
 * direct source or another source still supplies stays, and the scope narrows
 * only when nothing left is Organization-wide.
 */
export function audienceSourceRetractionPlan(input: {
  direct: AudienceSource;
  remainingSources: readonly NamedAudienceSource[];
  currentReaders: WorkstreamReaderAudience;
  suppliedByDeparting: readonly UserId[];
}): AudienceSourceRetraction {
  const remaining = effectiveChannelAudience({ direct: input.direct, sources: input.remainingSources });
  if (remaining.scope === "workspace") {
    return { narrowScope: false, seatUserIds: [], removeUserIds: [] };
  }
  const retained = new Set(remaining.participantUserIds);
  // Nothing is provably seated while the Channel is Organization-wide: the
  // reader audience reports the scope and no roster, so a surviving source's
  // participants are re-seated rather than assumed. The canonical add is
  // idempotent, which is what makes re-seating cheap enough to be the rule.
  const seated = input.currentReaders.scope === "workspace"
    ? new Set<string>()
    : new Set(input.currentReaders.userIds);
  return {
    narrowScope: input.currentReaders.scope === "workspace",
    seatUserIds: remaining.participantUserIds.filter((userId) => !seated.has(userId)),
    removeUserIds: [...new Set(input.suppliedByDeparting)].filter((userId) => !retained.has(userId)),
  };
}

/**
 * The audience and the defaults a Channel is born with, given the Spaces it is
 * born in.
 *
 * Every Channel has at least one Space (General when nothing named another),
 * so this runs on every create rather than on the ones that chose a
 * destination. The arithmetic is {@link effectiveChannelAudience}: a source
 * only ever widens, so an Organization-wide Space makes the Channel
 * Organization-wide and personal Spaces contribute their rosters. Computing it
 * before the Channel exists is what lets `initialize` open the conversation
 * with its real audience in one write, instead of a private Channel that
 * becomes public a round trip later.
 *
 * Two callers compute it from the same Spaces and must agree:
 * `WorkspaceDO.reserveChannelInSpaces`, which writes the provisional directory
 * row with this scope, and the creation coordinator, which opens the
 * conversation with it. It is pure, so they do.
 *
 * A direct participant may sit outside every personal Space roster. Their
 * Channel access grants associative visibility of the containing Spaces'
 * presentation metadata; it does not make them a Space participant.
 */
export function resolveSpaceWorkstreamStart(input: {
  spaces: readonly SpaceSummary[];
  scope: Scope;
  requestedParticipantUserIds: readonly string[];
  originResourceIds?: readonly string[];
}): { scope: Scope; participantUserIds: string[]; originResourceIds: string[] } {
  const requested = [...new Set(input.requestedParticipantUserIds)];
  const sources = input.spaces.map((space) => ({
    sourceId: space.id as string,
    scope: space.scope,
    participantUserIds: space.participants.map((participant) => participant.userId),
  }));
  const audience = effectiveChannelAudience({
    direct: { scope: input.scope, participantUserIds: requested.map(asUserId) },
    sources,
  });
  return {
    scope: audience.scope,
    // An Organization-wide Channel keeps the roster the caller asked for: the
    // union reports no participants for a `workspace` audience because it does
    // not need any to decide who may read, and dropping them here would lose
    // the people a connector resolved out of its conversation.
    participantUserIds: audience.scope === "workspace"
      ? requested
      : [...audience.participantUserIds],
    // Caller resources precede Space defaults; both are deduplicated. Only
    // resources, because only a resource is something the opening run can read:
    // a Sidekick recommendation arrives through the ordinary staged delivery
    // the placement stages for every new member.
    originResourceIds: [...new Set([
      ...(input.originResourceIds ?? []),
      ...input.spaces.flatMap((space) => space.defaultResourceIds),
    ])],
  };
}

/** A Channel as a Space source observes it: its readers and its seated participants. */
export interface ObservedBirthChannel {
  readers: WorkstreamReaderAudience;
  participantUserIds: UserId[];
}

/**
 * The Channel the next Space source observes at birth, after this one.
 *
 * Each source's plan is a delta against the Channel as it was *before* that
 * source, so the observation is threaded from the requested audience through
 * each Space in turn. The Channel cannot answer this itself: once it opens,
 * every source's readers are seated and indistinguishable.
 */
export function observedAfterBirthSource(
  born: ObservedBirthChannel,
  source: NamedAudienceSource,
  seatUserIds: readonly UserId[],
): ObservedBirthChannel {
  const next = effectiveChannelAudience({
    direct: { scope: born.readers.scope, participantUserIds: born.participantUserIds },
    sources: [source],
  });
  return {
    readers: next.scope === "workspace"
      ? { scope: "workspace" }
      : { scope: "personal", userIds: [...next.participantUserIds] },
    participantUserIds: [...new Set([...born.participantUserIds, ...seatUserIds])],
  };
}

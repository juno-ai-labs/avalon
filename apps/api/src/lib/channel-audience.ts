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
 * already crossed a schema at the RPC boundary, and the user-id type travels
 * through so a branded caller gets branded answers back. The provenance that
 * says *which* sources currently reach a Channel is WorkstreamDO's
 * (`durable-objects/workstream-access-storage.ts`), and applying what these
 * functions plan is the Channel's canonical scope and participant operations' —
 * which is where the retained-content containment preflight runs. This is only
 * the arithmetic between the two.
 */

/** One audience, as a source states it. */
export interface AudienceSource<TUser extends string = string> {
  scope: "personal" | "workspace";
  participantUserIds: readonly TUser[];
}

/** An audience supplied by something outside the Channel, under its own id. */
export interface NamedAudienceSource<TUser extends string = string> extends AudienceSource<TUser> {
  sourceId: string;
}

export type ChannelAudience<TUser extends string = string> =
  | { scope: "workspace" }
  | { scope: "personal"; userIds: TUser[] };

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
export function effectiveChannelAudience<TUser extends string>(input: {
  direct: AudienceSource<TUser>;
  sources: readonly NamedAudienceSource<TUser>[];
}): ChannelAudience<TUser> {
  if (input.direct.scope === "workspace" || input.sources.some((source) => source.scope === "workspace")) {
    return { scope: "workspace" };
  }
  return {
    scope: "personal",
    userIds: [...new Set([
      ...input.direct.participantUserIds,
      ...input.sources.flatMap((source) => [...source.participantUserIds]),
    ])],
  };
}

/** What applying one source asks the Channel's canonical operations to do. */
export interface AudienceSourceApplication<TUser extends string = string> {
  /** Whether the Channel has to become Organization-wide. */
  widenScope: boolean;
  /** Readers this source adds who cannot already read the Channel. */
  seatUserIds: TUser[];
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
export function audienceSourceApplicationPlan<TUser extends string>(input: {
  current: WorkstreamReaderAudience;
  source: AudienceSource<TUser>;
}): AudienceSourceApplication<TUser> {
  const widenScope = input.source.scope === "workspace" && input.current.scope !== "workspace";
  if (widenScope || input.current.scope === "workspace") return { widenScope, seatUserIds: [] };
  const readers = new Set<string>(input.current.userIds);
  return {
    widenScope: false,
    seatUserIds: [...new Set(input.source.participantUserIds)].filter((userId) => !readers.has(userId)),
  };
}

/** What withdrawing one source asks the Channel's canonical operations to do. */
export interface AudienceSourceRetraction<TUser extends string = string> {
  /** Whether the Channel stops being Organization-wide. */
  narrowScope: boolean;
  /**
   * Readers a surviving source supplies who are not provably seated yet.
   *
   * Empty except when {@link AudienceSourceRetraction.narrowScope} is set. A
   * source applied while the Channel was Organization-wide seated nobody —
   * everybody could already read — so the readers it supplies exist only as
   * its own participant list until the audience stops being Organization-wide.
   * Seating them is what keeps a narrowing from revoking access that another
   * source still provides.
   */
  seatUserIds: TUser[];
  /** Readers only the departing source supplied. */
  removeUserIds: TUser[];
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
export function audienceSourceRetractionPlan<TUser extends string>(input: {
  direct: AudienceSource<TUser>;
  remainingSources: readonly NamedAudienceSource<TUser>[];
  currentReaders: WorkstreamReaderAudience;
  suppliedByDeparting: readonly TUser[];
}): AudienceSourceRetraction<TUser> {
  const remaining = effectiveChannelAudience({ direct: input.direct, sources: input.remainingSources });
  if (remaining.scope === "workspace") {
    return { narrowScope: false, seatUserIds: [], removeUserIds: [] };
  }
  const retained = new Set<string>(remaining.userIds);
  // Nothing is provably seated while the Channel is Organization-wide: the
  // reader audience reports the scope and no roster, so a surviving source's
  // participants are re-seated rather than assumed. The canonical add is
  // idempotent, which is what makes re-seating cheap enough to be the rule.
  const seated = input.currentReaders.scope === "workspace"
    ? new Set<string>()
    : new Set<string>(input.currentReaders.userIds);
  return {
    narrowScope: input.currentReaders.scope === "workspace",
    seatUserIds: remaining.userIds.filter((userId) => !seated.has(userId)),
    removeUserIds: [...new Set(input.suppliedByDeparting)].filter((userId) => !retained.has(userId)),
  };
}

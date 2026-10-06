import type { Scope, SpaceSummary, UserId } from "@rally/contracts";

/**
 * How a Space's placement of a Channel bears on the Channel's readers: it
 * does not.
 *
 * Every Space is Organization-wide, as a product decision, so a Space that
 * granted its audience to its Channels would make every Channel public. A
 * Channel's readers are therefore its own scope and participants and nothing
 * else; a Space supplies placement, defaults and listing, never access. The
 * plans below are what joining and leaving a Space ask of the Channel's
 * canonical operations, and both ask nothing. They keep their shape because
 * `SpaceChannelAccess` runs whatever a plan says, so the rule lives here once
 * rather than as a branch in every walk.
 *
 * Space sources are still recorded on the Channel's hosted parent
 * (`durable-objects/workstream-access-storage.ts`): they are the provenance a
 * membership walk fences on. Readers a private Space seated before WorkspaceDO
 * migration 93 stay seated, as the Channel's own; nothing withdraws them when
 * the Channel leaves that Space.
 */

/** One audience: who it admits, and who it lists. */
export interface AudienceSource {
  scope: "personal" | "workspace";
  participantUserIds: readonly UserId[];
}

/** An audience recorded for something outside the Channel, under its own id. */
export interface NamedAudienceSource extends AudienceSource {
  sourceId: string;
}

/** What applying one source asks the Channel's canonical operations to do. */
export interface AudienceSourceApplication {
  /** Whether the Channel has to become Organization-wide. */
  widenScope: boolean;
  /** Readers this source adds who cannot already read the Channel. */
  seatUserIds: UserId[];
}

/** What a Space joining a Channel asks of it: nothing. */
export function audienceSourceApplicationPlan(): AudienceSourceApplication {
  return { widenScope: false, seatUserIds: [] };
}

/** What withdrawing one source asks the Channel's canonical operations to do. */
export interface AudienceSourceRetraction {
  /** Whether the Channel stops being Organization-wide. */
  narrowScope: boolean;
  /** Readers a surviving source supplies who are not seated yet. */
  seatUserIds: UserId[];
  /** Readers only the departing source supplied. */
  removeUserIds: UserId[];
}

/** What a Space leaving a Channel asks of it: nothing. */
export function audienceSourceRetractionPlan(): AudienceSourceRetraction {
  return { narrowScope: false, seatUserIds: [], removeUserIds: [] };
}

/**
 * The audience and the defaults a Channel is born with, given the Spaces it is
 * born in.
 *
 * The audience is the one the caller asked for: a Space grants none (see the
 * top of this module). The Spaces contribute their default resources.
 *
 * Two callers compute it from the same Spaces and must agree:
 * `WorkspaceDO.reserveChannelInSpaces`, which writes the provisional directory
 * row with this scope, and the creation coordinator, which opens the
 * conversation with it. It is pure, so they do.
 */
export function resolveSpaceWorkstreamStart(input: {
  spaces: readonly SpaceSummary[];
  scope: Scope;
  requestedParticipantUserIds: readonly string[];
  originResourceIds?: readonly string[];
}): { scope: Scope; participantUserIds: string[]; originResourceIds: string[] } {
  return {
    scope: input.scope,
    participantUserIds: [...new Set(input.requestedParticipantUserIds)],
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

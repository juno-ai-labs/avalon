import type { Scope, SpaceSummary } from "@rally/contracts";

/**
 * The audience and the defaults a Channel is born with, given the Spaces it is
 * born in.
 *
 * The audience is the one the caller asked for. When a person starts the
 * thread from a Channel (`narrowInPrivateSpaces`), it is narrowed to private
 * if any Space it is born in is private: a thread started in a private
 * Channel is visible only to the person who started it and whoever they
 * named (`docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`). A
 * connector ingress resolved its audience from the room it came from (a
 * public Slack channel is Organization-wide), so its audience is never
 * narrowed: that would leave the room's members a thread none of them can
 * open. A Space still grants no reader. The Spaces contribute their default
 * resources.
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
  narrowInPrivateSpaces?: boolean;
}): { scope: Scope; participantUserIds: string[]; originResourceIds: string[] } {
  return {
    // Private is any Channel that is not Organization-wide: a private Channel
    // or a Personal Channel (`individual`).
    scope: input.narrowInPrivateSpaces === true && input.spaces.some((space) => space.scope !== "workspace")
      ? "personal"
      : input.scope,
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

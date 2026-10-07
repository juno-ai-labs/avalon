import type { Scope, SpaceSummary } from "@rally/contracts";

/**
 * The audience and the defaults a Channel is born with, given the Spaces it is
 * born in.
 *
 * The audience is the one the caller asked for: a Space grants none
 * (`docs/spaces.md#every-space-is-organization-wide`). The Spaces contribute
 * their default resources.
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

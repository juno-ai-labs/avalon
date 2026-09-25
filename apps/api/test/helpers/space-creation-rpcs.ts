import { asSpaceId } from "@rally/contracts";
import { vi } from "vitest";

/**
 * The Space half of a create, for a Node suite whose subject is something else.
 *
 * Every Channel is born in a Space. The ordinary create
 * (`workstream-object-creation-service.ts`) places and reserves it with one
 * WorkspaceDO call, `reserveChannelInSpaces`; a Channel added to a Space after
 * it exists (the connector placement, a replayed create) goes through the staged
 * membership RPCs and the Channel's plan-then-confirm source RPCs, because its
 * audience is widened between the two. Both are doubled here, because this
 * helper serves both.
 *
 * These doubles answer the *steady* case: the Space already exists, so nothing
 * provisions its parent, and every step succeeds. That is deliberate. What a
 * Space does to a creation is proved against real storage in
 * `test-workers/space-creation.test.ts` and as arithmetic in
 * `test/workstream-space-start.test.ts`; re-implementing any of it here would
 * put the behaviour under test inside the fixture, where the object is free to
 * drift from it. Files that use this are asserting on what the creation did
 * *around* the Space, and this is what keeps that reachable.
 *
 * Two Spaces, because a creation's audience is the union of its own request and
 * every Space it lands in. General is Organization-wide, so a Channel that
 * names no Space is Organization-wide; a test whose subject is the caller's own
 * audience has to name a Space that supplies none, which is what
 * {@link PERSONAL_SPACE_ID} is for.
 */

/** The Organization's General, already open, so `ensureGeneral` provisions nothing. */
export const GENERAL_SPACE_ID = asSpaceId("00000000-0000-7000-8000-00000000fe11");

/** A Space with an empty roster: it widens nothing and seats nobody. */
export const PERSONAL_SPACE_ID = asSpaceId("00000000-0000-7000-8000-00000000fe12");

function summary(spaceId: string) {
  const general = spaceId === GENERAL_SPACE_ID;
  return {
    id: spaceId,
    name: general ? "General" : "Private",
    iconKey: "briefcase",
    colorKey: "blue",
    scope: general ? ("workspace" as const) : ("personal" as const),
    status: "active" as const,
    systemRole: general ? ("general" as const) : null,
    revision: 1,
    reach: "participant" as const,
    participants: [],
    channelCount: 0,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

/** WorkspaceDO's side: the Space, its staged membership, and its settlement. */
export function spaceCreationWorkspaceRpcs() {
  return {
    // A replayed create re-adds the Channel through the full `addChannel`,
    // which asks the Organization whether the Channel is one this caller can
    // see before it stages anything. Idempotent in production; here it is one
    // more RPC a replay case has to get past.
    canReadWorkstream: vi.fn(async () => true),
    // The create's one Organization-side call. The input is declared so a
    // caller can read what the creation asked for, which is the direct half of
    // the audience an Organization-wide Space widens past on its way to
    // `initialize`.
    reserveChannelInSpaces: vi.fn(async (input: {
      spaceIds: string[];
      requestedScope: string;
      authorityGeneration: number;
    }) => ({
      status: "reserved" as const,
      authorityGeneration: input.authorityGeneration,
      spaces: (input.spaceIds.length > 0 ? input.spaceIds : [GENERAL_SPACE_ID]).map(summary),
    })),
    ensureGeneralSpace: vi.fn(async () => ({
      ok: true as const,
      created: false as const,
      space: summary(GENERAL_SPACE_ID),
    })),
    prepareSpaceMembership: vi.fn(async (input: { spaceId: string }) => ({
      ok: true as const,
      space: summary(input.spaceId),
      membershipGeneration: 1,
    })),
    finalizeSpaceMembership: vi.fn(async (input: { spaceId: string }) => ({
      ok: true as const,
      space: summary(input.spaceId),
    })),
    cancelSpaceMembership: vi.fn(async (input: { spaceId: string }) => ({
      ok: true as const,
      space: summary(input.spaceId),
    })),
  };
}

/**
 * The Channel's side of a placement into an existing Channel: the source the
 * Space supplies, planned and then confirmed.
 *
 * `seatUserIds` is empty because neither Space here has a roster — General
 * seats nobody individually, and the personal one is empty by construction.
 */
export function spaceCreationRoomRpcs() {
  return {
    applySpaceAccessSource: vi.fn(async () => ({ ok: true as const, plan: { seatUserIds: [] as string[] } })),
    confirmSpaceAccessSource: vi.fn(async () => ({ ok: true as const })),
  };
}

import { asSpaceId } from "@rally/contracts";
import { vi } from "vitest";

/**
 * The Space half of a create, for a Node suite whose subject is something else.
 *
 * Every Channel is born in a Space. The ordinary create
 * (`workstream-object-creation-service.ts`) places and reserves it with one
 * WorkspaceDO call, `reserveChannelInSpaces`; a Channel added to a Space after
 * it exists goes through `addSpaceChannel`, one call in which WorkspaceDO widens
 * its audience through its conversation (a replayed create), or through the
 * staged membership RPCs and the Channel's plan-then-confirm source RPCs (the
 * connector placement). All of them are doubled here, because this helper
 * serves each.
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
  /** Where each Channel was placed, as the reservation and `addSpaceChannel` left it. */
  const placements = new Map<string, Set<string>>();
  const place = (workstreamId: string, spaceIds: readonly string[]) => {
    const placed = placements.get(workstreamId) ?? new Set<string>();
    for (const spaceId of spaceIds) placed.add(spaceId);
    placements.set(workstreamId, placed);
  };
  return {
    // A replayed create re-adds the Channel through the full `addChannel`,
    // which is one WorkspaceDO call, for a placement it does not find.
    addSpaceChannel: vi.fn(async (input: { spaceId: string; workstreamId: string }) => {
      place(input.workstreamId, [input.spaceId]);
      return { ok: true as const, space: summary(input.spaceId) };
    }),
    // What a replay asks first: the Spaces the Channel already sits in.
    channelSpaces: vi.fn(async (input: { workstreamId: string }) => ({
      spaceIds: [...placements.get(input.workstreamId) ?? []],
    })),
    // The create's one Organization-side call. The input is declared so a
    // caller can read what the creation asked for, which is the direct half of
    // the audience an Organization-wide Space widens past on its way to
    // `initialize`.
    reserveChannelInSpaces: vi.fn(async (input: {
      workstreamId: string;
      spaceIds: string[];
      requestedScope: string;
      authorityGeneration: number;
    }) => {
      const spaceIds = input.spaceIds.length > 0 ? input.spaceIds : [GENERAL_SPACE_ID];
      place(input.workstreamId, spaceIds);
      return {
        status: "reserved" as const,
        authorityGeneration: input.authorityGeneration,
        spaces: spaceIds.map(summary),
      };
    }),
    openGeneralSpace: vi.fn(async () => ({
      ok: true as const,
      created: false as const,
      space: summary(GENERAL_SPACE_ID),
    })),
    // The connector path's placement of a Channel it provisioned itself.
    placeChannelInGeneral: vi.fn(async () => ({
      ok: true as const,
      space: summary(GENERAL_SPACE_ID),
    })),
  };
}

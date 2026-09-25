import { asSpaceId } from "@rally/contracts";
import { vi } from "vitest";

/**
 * The Space half of a create, for a Node suite whose subject is something else.
 *
 * Every Channel is born in a Space — `workstream-object-creation-service.ts`
 * stages a membership, records the source on the Channel's own authority, and
 * settles the membership before the conversation is reserved — so a test about
 * Slack assignment, origin attachment or the audience a create asks for now
 * passes through three WorkspaceDO RPCs and, on the Channel's room (which that
 * same WorkspaceDO hosts), either one or two. One is the ordinary create, which records the source in the birth
 * mode because the conversation opened with that audience already written; two
 * is the connector placement, which widens an existing Channel between the plan
 * and the commit. Both are doubled here, because this helper serves both.
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

/**
 * What the creation observed the Channel as before this source was applied.
 *
 * Declared so a caller can read the direct half of the audience off the spy:
 * once an Organization-wide Space has widened it, this is the only place the
 * scope the caller asked for is still visible.
 */
interface SpaceSourceApplication {
  channel: { readers: { scope: string } };
  /** The birth mode: this call commits the source, and no confirmation follows. */
  bornWithSourceApplied?: boolean;
}

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
 * The Channel's side: the source the Space supplies, applied and confirmed.
 *
 * `seatUserIds` is empty because neither Space here has a roster — General
 * seats nobody individually, and the personal one is empty by construction —
 * so the observation handed back is the one the caller passed in.
 */
export function spaceCreationRoomRpcs() {
  return {
    // The input is declared so a caller can read what the creation observed the
    // Channel as — the direct half of the audience, which an Organization-wide
    // Space widens past on its way to `initialize`.
    applySpaceAccessSource: vi.fn<(input: SpaceSourceApplication) => Promise<{
      ok: true;
      plan: { seatUserIds: string[] };
      suppliedUserIds?: string[];
    }>>(async (input) => (input.bornWithSourceApplied
      ? { ok: true, plan: { seatUserIds: [] }, suppliedUserIds: [] }
      : { ok: true, plan: { seatUserIds: [] } })),
    confirmSpaceAccessSource: vi.fn(async () => ({ ok: true as const })),
  };
}

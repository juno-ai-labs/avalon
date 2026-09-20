import { describe, expect, it } from "vitest";

import {
  PROJECT_COLOR_KEYS,
  PROJECT_COLOR_KEYS_STORABLE,
  PROJECT_ICON_KEYS,
} from "./projects";
import {
  ChannelAccessSourcesSchema,
  ContainerOrderSchema,
  CreateSpaceRequestSchema,
  OrderedContainerKindSchema,
  PersonalOrderSchema,
  PALETTE_INK,
  PALETTE_KEYS,
  PALETTE_RETIRED,
  SPACE_COLOR_KEYS,
  SPACE_COLOR_KEYS_STORABLE,
  SPACE_ICON_KEYS,
  SpaceColorKeySchema,
  SpaceErrorCodeSchema,
  SpaceSnapshotSchema,
  SpaceSummarySchema,
  UpdateSpaceAudienceRequestSchema,
} from "./spaces";

const SPACE_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000002";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000003";

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SPACE_ID,
    name: "Hiring",
    iconKey: "briefcase",
    colorKey: "blue",
    scope: "personal",
    status: "active",
    systemRole: null,
    revision: 1,
    reach: "participant",
    participants: [{ userId: USER_ID }],
    channelCount: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("space contracts", () => {
  it("given the appearance registry, when the Project aliases are read, then they are the same arrays", () => {
    // The stored appearance vocabulary kept its old names deliberately, so the
    // alias has to be the *value* rather than a copy that could drift from it.
    expect(PROJECT_ICON_KEYS).toBe(SPACE_ICON_KEYS);
    expect(PROJECT_COLOR_KEYS).toBe(SPACE_COLOR_KEYS);
    expect(PROJECT_COLOR_KEYS_STORABLE).toBe(SPACE_COLOR_KEYS_STORABLE);
  });

  it("given the V1 picker, when its registries are read, then it offers exactly 25 icons and 14 colours", () => {
    // The stored vocabulary, pinned. A key that leaves this list is a value
    // somebody's Space already holds and a read that starts throwing on it.
    expect(SPACE_ICON_KEYS).toEqual([
      "briefcase", "target", "calendar-days", "list-checks", "clipboard-list",
      "file-text", "folder", "lightbulb", "star", "flag", "rocket",
      "chart-no-axes-combined", "calculator", "coins", "users", "user-search",
      "handshake", "megaphone", "palette", "image", "pen-tool", "package",
      "building-2", "globe-2", "heart",
    ]);
    expect(SPACE_COLOR_KEYS).toEqual([
      "rose", "red", "orange", "amber", "lime", "green", "emerald", "cyan",
      "blue", "indigo", "violet", "purple", "fuchsia", "pink",
    ]);
  });

  it("given a colour retired from the picker, when a stored appearance is parsed, then it still reads", () => {
    for (const retired of PALETTE_RETIRED) {
      expect(SpaceColorKeySchema.safeParse(retired).success).toBe(true);
      expect((SPACE_COLOR_KEYS as readonly string[]).includes(retired)).toBe(false);
    }
    expect([...SPACE_COLOR_KEYS_STORABLE]).toEqual([...PALETTE_KEYS]);
    expect(Object.keys(PALETTE_INK).sort()).toEqual([...PALETTE_KEYS].sort());
  });

  it("given custom presentation values, when Space creation is parsed, then the closed contract refuses them", () => {
    const base = { name: "Hiring", iconKey: "briefcase", colorKey: "blue", scope: "personal" };

    expect(CreateSpaceRequestSchema.safeParse(base).success).toBe(true);
    expect(CreateSpaceRequestSchema.safeParse({ ...base, iconKey: "code" }).success).toBe(false);
    expect(CreateSpaceRequestSchema.safeParse({ ...base, colorKey: "#123456" }).success).toBe(false);
    expect(CreateSpaceRequestSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(CreateSpaceRequestSchema.safeParse({ ...base, scope: "organization" }).success).toBe(false);
    expect(CreateSpaceRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("given a Space response, when unknown server fields arrive, then the client contract fails closed", () => {
    expect(SpaceSummarySchema.safeParse(summary()).success).toBe(true);
    expect(SpaceSummarySchema.safeParse(summary({ unexpected: "drift" })).success).toBe(false);
    // `workstreamIds` is what a Project carried. A Space paginates its member
    // Channels instead, and a server that nested them here would grow the
    // socket's opening payload with the Organization.
    expect(SpaceSummarySchema.safeParse(summary({ workstreamIds: [CHANNEL_ID] })).success).toBe(false);
  });

  it("given the Space summary, when its counters are parsed, then only a live revision and a real count pass", () => {
    expect(SpaceSummarySchema.safeParse(summary({ revision: 0 })).success).toBe(false);
    expect(SpaceSummarySchema.safeParse(summary({ channelCount: -1 })).success).toBe(false);
    expect(SpaceSummarySchema.safeParse(summary({ channelCount: 1.5 })).success).toBe(false);
    expect(SpaceSummarySchema.safeParse(summary({ systemRole: "general" })).success).toBe(true);
    expect(SpaceSummarySchema.safeParse(summary({ systemRole: "inbox" })).success).toBe(false);
    // Four Project lifecycle states have no Space equivalent: an archive is
    // refused outright rather than observed mid-flight.
    expect(SpaceSummarySchema.safeParse(summary({ status: "archiving" })).success).toBe(false);
    const parsed = SpaceSummarySchema.parse(summary());
    expect(parsed.defaultResourceIds).toEqual([]);
    expect(parsed.defaultSidekickIds).toEqual([]);
  });

  it("given the Space summary, when its reach is parsed, then only the three relationships pass", () => {
    for (const reach of ["participant", "organization", "through_channel"]) {
      expect(SpaceSummarySchema.safeParse(summary({ reach })).success).toBe(true);
    }
    // Closed, because it is what every surface decides from: a value a reader
    // does not know would be read as one it does, and the one it would be read
    // as is the permissive one.
    expect(SpaceSummarySchema.safeParse(summary({ reach: "guest" })).success).toBe(false);
    // Required rather than defaulted. A default here is a server that forgot
    // to say, answered with the relationship that draws every control.
    const withoutReach = summary();
    delete withoutReach["reach"];
    expect(SpaceSummarySchema.safeParse(withoutReach).success).toBe(false);
  });

  it("given one Space authority snapshot, when active and inactive waterlines differ, then it is rejected", () => {
    expect(SpaceSnapshotSchema.safeParse({
      active: { waterline: 2, items: [] },
      inactive: { waterline: 1, items: [] },
    }).success).toBe(false);
    expect(SpaceSnapshotSchema.safeParse({
      active: { waterline: 2, items: [] },
      inactive: { waterline: 2, items: [] },
    }).success).toBe(true);
  });

  it("given an audience change, when it names nobody, then it is refused", () => {
    expect(UpdateSpaceAudienceRequestSchema.safeParse({
      scope: "workspace", participantUserIds: [USER_ID],
    }).success).toBe(true);
    expect(UpdateSpaceAudienceRequestSchema.safeParse({
      scope: "workspace", participantUserIds: [],
    }).success).toBe(false);
  });

  it("given a Channel's access sources, when they are parsed, then the shape stays closed", () => {
    expect(ChannelAccessSourcesSchema.safeParse({
      direct: { scope: "personal", participantUserIds: [USER_ID] },
      spaces: [{ spaceId: SPACE_ID, scope: "workspace", participantUserIds: [USER_ID] }],
    }).success).toBe(true);
    // A merged audience cannot answer whether removing one source is legal, so
    // the shape refuses to collapse the two.
    expect(ChannelAccessSourcesSchema.safeParse({
      direct: { scope: "personal", participantUserIds: [USER_ID] },
      spaces: [{ scope: "workspace", participantUserIds: [USER_ID] }],
    }).success).toBe(false);
  });

  it("given one container's order, when it is parsed, then the container names both halves of its address", () => {
    expect(ContainerOrderSchema.safeParse({
      container: { kind: "space", id: SPACE_ID },
      itemIds: [CHANNEL_ID],
    }).success).toBe(true);
    // The kind alone is not an address for these two: a request that named only
    // the kind could not say *which* Space's Channels it was arranging.
    expect(ContainerOrderSchema.safeParse({ container: { kind: "space" }, itemIds: [] }).success)
      .toBe(false);
    expect(ContainerOrderSchema.safeParse({ container: { kind: "channel" }, itemIds: [] }).success)
      .toBe(false);
    // And for the Organization the kind *is* the whole address: a request is
    // already addressed to one Organization, so an id here would be a second
    // answer to a settled question — one the authority ignored on the way in
    // and echoed on the way out, which is what sent the desktop's cache to a
    // key nothing would read back.
    expect(ContainerOrderSchema.safeParse({ container: { kind: "organization" }, itemIds: [] }).success)
      .toBe(true);
    expect(ContainerOrderSchema.safeParse({
      container: { kind: "organization", id: SPACE_ID },
      itemIds: [],
    }).success).toBe(false);
    // Exactly the three lists the product lets a person arrange.
    expect([...OrderedContainerKindSchema.options])
      .toEqual(["organization", "space", "channel"]);
    expect(ContainerOrderSchema.safeParse({
      container: { kind: "workstream", id: SPACE_ID },
      itemIds: [],
    }).success).toBe(false);
    // An empty list is a person who dragged every item out of an order, not a
    // malformed request: it is how the last stored arrangement is cleared.
    expect(ContainerOrderSchema.safeParse({
      container: { kind: "channel", id: CHANNEL_ID },
      itemIds: [],
    }).success).toBe(true);
  });

  it("given a person's whole ordering, when it is parsed, then each entry carries its own container", () => {
    expect(PersonalOrderSchema.safeParse([
      { container: { kind: "organization" }, itemIds: [SPACE_ID] },
      { container: { kind: "space", id: SPACE_ID }, itemIds: [CHANNEL_ID] },
    ]).success).toBe(true);
    // A list rather than a map keyed by container, because the key is a pair
    // wherever a kind has an id: a map would have to encode it into a string
    // each reader parses back.
    expect(PersonalOrderSchema.safeParse({ [SPACE_ID]: [CHANNEL_ID] }).success).toBe(false);
  });

  it("given the refusal vocabulary, when a code is read, then it is one of the fourteen the authority can produce", () => {
    // Two narrowings that read alike and are not: `space_audience_incompatible`
    // is a *membership* removal that would strand a reader with no Space left
    // to discover the Channel through, and `channel_scope_locked_by_space` is
    // the Channel's own scope refusing to go private while a Space still makes
    // it Organization-wide. One is fixed by adding a Space, the other by
    // leaving one, so a single code would send an operator the wrong way.
    expect([...SpaceErrorCodeSchema.options]).toEqual([
      "space_access_denied",
      "space_not_found",
      "space_protected",
      "space_membership_final",
      "space_audience_incompatible",
      "channel_scope_locked_by_space",
      "space_membership_content_fence",
      "space_default_audience_mismatch",
      "space_revision_conflict",
      "space_bootstrap_pending",
      "space_conversation_unreachable",
      "space_authority_unreachable",
      "space_audience_self_excluded",
      "space_cursor_invalid",
    ]);
    expect(SpaceErrorCodeSchema.safeParse("space_error").success).toBe(false);
  });
});

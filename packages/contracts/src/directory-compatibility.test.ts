import { describe, expect, it } from "vitest";
import { WorkstreamDirectoryCommonEffectSchema, WorkstreamDirectoryUserEffectSchema } from "./conversation-effects";

const common = {
  kind: "directory_common", title: "Channel", description: "", preview: "",
  scope: "workspace", state: "idle", systemKind: null,
  lastActivityAt: "2026-10-23T00:00:00.000Z", completedAt: null, archivedAt: null,
};

describe("directory compatibility", () => {
  it("strips obsolete common and viewer fields without accepting invalid declared fields", () => {
    expect(WorkstreamDirectoryCommonEffectSchema.parse({ ...common,
      originType: "automation", automationSubscriptionId: "old", automationRunId: "old", plannedFor: null,
      resourceLinks: [{ resourceId: "00000000-0000-4000-8000-000000000001", watchEnabled: true,
        relationshipType: "attachment", obsolete: true }],
    })).toEqual({ ...common, resourceLinks: [{ resourceId: "00000000-0000-4000-8000-000000000001",
      watchEnabled: true, relationshipType: "attachment" }] });
    const viewer = { kind: "directory_user", userId: "00000000-0000-4000-8000-000000000002",
      isParticipant: true, unreadCount: 0, youAreMentioned: false, listable: true };
    expect(WorkstreamDirectoryUserEffectSchema.parse({ ...viewer, obsolete: "discard" })).toEqual(viewer);
    expect(WorkstreamDirectoryCommonEffectSchema.safeParse({ ...common, title: 12 }).success).toBe(false);
  });
});

import { asSpaceId, asUserId, asWorkstreamId, SpaceSummarySchema } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileReplayedSpaceMembership,
  resolveSpaceWorkstreamStart,
} from "../src/services/workstream-object-creation-service";

/**
 * What a Channel is born as, given the Spaces it is born in.
 *
 * Pure arithmetic over `SpaceSummary`, so it belongs in the Node suite rather
 * than on workerd: what needs real storage is that the membership settles and
 * the directory row carries it, which `test-workers/space-creation.test.ts`
 * proves.
 */

const creatorId = asUserId("00000000-0000-7000-8000-000000000201");
const participantId = asUserId("00000000-0000-7000-8000-000000000202");
const outsiderId = asUserId("00000000-0000-7000-8000-000000000203");
const defaultResourceId = "00000000-0000-7000-8000-000000000207";

function space(overrides: Partial<{
  id: string;
  scope: "personal" | "workspace" | "individual";
  participantUserIds: string[];
  defaultResourceIds: string[];
  systemRole: "general" | null;
}> = {}) {
  return SpaceSummarySchema.parse({
    id: asSpaceId(overrides.id ?? "00000000-0000-7000-8000-000000000204"),
    name: "Hiring",
    iconKey: "briefcase",
    colorKey: "blue",
    scope: overrides.scope ?? "personal",
    status: "active",
    systemRole: overrides.systemRole ?? null,
    revision: 1,
    reach: "participant" as const,
    participants: (overrides.participantUserIds ?? [creatorId, participantId])
      .map((userId) => ({ userId })),
    channelCount: 0,
    defaultResourceIds: overrides.defaultResourceIds ?? [defaultResourceId],
    defaultSidekickIds: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
}

describe("starting a Channel inside a Space", () => {
  it("given a private request in an Organization-wide Space, when creation resolves its start, then the Channel stays private to whom it named", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "workspace" })],
      scope: "personal",
      requestedParticipantUserIds: [participantId, participantId],
    })).toEqual({
      scope: "personal",
      participantUserIds: [participantId],
      originResourceIds: [defaultResourceId],
    });
  });

  it("given a Space with participants, when creation resolves its start, then none of them is seated", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "workspace", participantUserIds: [creatorId] })],
      scope: "personal",
      requestedParticipantUserIds: [outsiderId],
    }).participantUserIds).toEqual([outsiderId]);
  });

  it("given an Organization-wide request, when creation resolves its start, then the Channel is Organization-wide with its requested roster", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "workspace" })],
      scope: "workspace",
      requestedParticipantUserIds: [participantId],
    })).toEqual({
      scope: "workspace",
      participantUserIds: [participantId],
      originResourceIds: [defaultResourceId],
    });
  });

  it("given a person starting an Organization-wide thread in a private Space, when creation resolves its start, then the thread starts private to whom it named", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "workspace" }), space({ id: "00000000-0000-7000-8000-00000000020c", scope: "personal" })],
      scope: "workspace",
      requestedParticipantUserIds: [participantId],
      narrowInPrivateSpaces: true,
    })).toMatchObject({ scope: "personal", participantUserIds: [participantId] });
  });

  it("given a thread started in a Personal Channel, when creation resolves its start, then it is private", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "individual", participantUserIds: [creatorId] })],
      scope: "workspace",
      requestedParticipantUserIds: [],
      narrowInPrivateSpaces: true,
    }).scope).toBe("personal");
  });

  it("given a connector's Organization-wide thread in a private Space, when creation resolves its start, then the audience it resolved stands", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "personal" })],
      scope: "workspace",
      requestedParticipantUserIds: [],
    }).scope).toBe("workspace");
  });

  it("given two Spaces, when creation resolves its start, then the origin resources are both Spaces' defaults", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [
        space({ scope: "workspace" }),
        space({
          id: "00000000-0000-7000-8000-00000000020a",
          scope: "workspace",
          defaultResourceIds: ["00000000-0000-7000-8000-00000000020b"],
        }),
      ],
      scope: "personal",
      requestedParticipantUserIds: [],
    }).originResourceIds).toEqual([defaultResourceId, "00000000-0000-7000-8000-00000000020b"]);
  });

  it("given an origin resource that is also a Space default, when creation resolves its start, then it deduplicates", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space()],
      scope: "personal",
      requestedParticipantUserIds: [participantId],
      originResourceIds: [defaultResourceId],
    }).originResourceIds).toEqual([defaultResourceId]);
  });
});

describe("reconciling a replayed create's placement", () => {
  const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000206");

  it("given a create that named Spaces, when its receipt replays, then each placement is settled again", async () => {
    const addChannel = vi.fn().mockResolvedValue(undefined);
    const ensureGeneral = vi.fn();
    const first = asSpaceId("00000000-0000-7000-8000-000000000204");
    const second = asSpaceId("00000000-0000-7000-8000-00000000020a");
    await reconcileReplayedSpaceMembership({
      spaces: { ensureGeneral, addChannel, channelSpaceIds: vi.fn().mockResolvedValue([]) },
      spaceIds: [first, second],
      workstreamId,
    });
    expect(ensureGeneral).not.toHaveBeenCalled();
    expect(addChannel.mock.calls).toEqual([[first, workstreamId], [second, workstreamId]]);
  });

  it("given a create that named none, when its receipt replays, then the Channel is placed in General", async () => {
    const addChannel = vi.fn().mockResolvedValue(undefined);
    const general = space({ id: "00000000-0000-7000-8000-00000000020c", scope: "workspace", systemRole: "general" });
    await reconcileReplayedSpaceMembership({
      spaces: { ensureGeneral: vi.fn().mockResolvedValue(general), addChannel, channelSpaceIds: vi.fn().mockResolvedValue([]) },
      spaceIds: [],
      workstreamId,
    });
    expect(addChannel.mock.calls).toEqual([[general.id, workstreamId]]);
  });

  it("given a placement already there, when its receipt replays, then only the missing one is written", async () => {
    const addChannel = vi.fn().mockResolvedValue(undefined);
    const placed = asSpaceId("00000000-0000-7000-8000-000000000204");
    const missing = asSpaceId("00000000-0000-7000-8000-00000000020a");
    await reconcileReplayedSpaceMembership({
      spaces: { ensureGeneral: vi.fn(), addChannel, channelSpaceIds: vi.fn().mockResolvedValue([placed]) },
      spaceIds: [placed, missing],
      workstreamId,
    });
    expect(addChannel.mock.calls).toEqual([[missing, workstreamId]]);
  });

  it("given a create that named none and a thread with a home, when its receipt replays, then nothing is written", async () => {
    const addChannel = vi.fn();
    const ensureGeneral = vi.fn();
    await reconcileReplayedSpaceMembership({
      spaces: { ensureGeneral, addChannel,
        channelSpaceIds: vi.fn().mockResolvedValue(["00000000-0000-7000-8000-000000000204"]) },
      spaceIds: [],
      workstreamId,
    });
    expect(ensureGeneral).not.toHaveBeenCalled();
    expect(addChannel).not.toHaveBeenCalled();
  });

  it("given a placement that refuses, when its receipt replays, then the refusal reaches the caller", async () => {
    const addChannel = vi.fn()
      .mockRejectedValueOnce(new Error("workspace_temporarily_unavailable"))
      .mockResolvedValueOnce(undefined);
    const input = {
      spaces: { ensureGeneral: vi.fn(), addChannel, channelSpaceIds: vi.fn().mockResolvedValue([]) },
      spaceIds: [asSpaceId("00000000-0000-7000-8000-000000000204")],
      workstreamId,
    };
    await expect(reconcileReplayedSpaceMembership(input)).rejects.toThrow("workspace_temporarily_unavailable");
    await expect(reconcileReplayedSpaceMembership(input)).resolves.toBeUndefined();
  });
});

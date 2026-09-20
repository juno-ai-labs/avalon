import { asSpaceId, asUserId, asWorkstreamId, SpaceSummarySchema } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api-error";
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
  scope: "personal" | "workspace";
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
  it("given one personal Space, when creation resolves its start, then it seats that Space's roster", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space()],
      scope: "personal",
      requestedParticipantUserIds: [participantId],
    })).toEqual({
      scope: "personal",
      participantUserIds: [participantId, creatorId],
      originResourceIds: [defaultResourceId],
    });
  });

  it("given two personal Spaces, when creation resolves its start, then the audience is their union", () => {
    const otherParticipant = asUserId("00000000-0000-7000-8000-000000000209");
    expect(resolveSpaceWorkstreamStart({
      spaces: [
        space({ participantUserIds: [creatorId] }),
        space({
          id: "00000000-0000-7000-8000-00000000020a",
          participantUserIds: [otherParticipant],
          defaultResourceIds: ["00000000-0000-7000-8000-00000000020b"],
        }),
      ],
      scope: "personal",
      requestedParticipantUserIds: [],
    })).toEqual({
      scope: "personal",
      participantUserIds: [creatorId, otherParticipant],
      originResourceIds: [defaultResourceId, "00000000-0000-7000-8000-00000000020b"],
    });
  });

  it("given one Organization-wide Space among several, when creation resolves its start, then the Channel is Organization-wide", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [
        space({ participantUserIds: [creatorId] }),
        space({ id: "00000000-0000-7000-8000-00000000020a", scope: "workspace" }),
      ],
      scope: "personal",
      requestedParticipantUserIds: [participantId],
    })).toEqual({
      scope: "workspace",
      // Kept rather than dropped: a connector's resolved roster is the people
      // the conversation contains, and an Organization-wide audience does not
      // consult a roster to decide who may read.
      participantUserIds: [participantId],
      originResourceIds: [defaultResourceId],
    });
  });

  it("given a requested participant outside every personal Space, when creation resolves its start, then it is refused", () => {
    const start = (): unknown => resolveSpaceWorkstreamStart({
      spaces: [space()],
      scope: "personal",
      requestedParticipantUserIds: [outsiderId],
    });
    expect(start).toThrowError(ApiError);
    expect(start).toThrow("Add that person to the space before starting this channel");
  });

  it("given an Organization-wide Space, when a requested participant is outside its roster, then nothing is refused", () => {
    expect(resolveSpaceWorkstreamStart({
      spaces: [space({ scope: "workspace", participantUserIds: [creatorId] })],
      scope: "personal",
      requestedParticipantUserIds: [outsiderId],
    }).participantUserIds).toEqual([outsiderId]);
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
      spaces: { ensureGeneral, addChannel },
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
      spaces: { ensureGeneral: vi.fn().mockResolvedValue(general), addChannel },
      spaceIds: [],
      workstreamId,
    });
    expect(addChannel.mock.calls).toEqual([[general.id, workstreamId]]);
  });

  it("given a placement that refuses, when its receipt replays, then the refusal reaches the caller", async () => {
    const addChannel = vi.fn()
      .mockRejectedValueOnce(new Error("workspace_temporarily_unavailable"))
      .mockResolvedValueOnce(undefined);
    const input = {
      spaces: { ensureGeneral: vi.fn(), addChannel },
      spaceIds: [asSpaceId("00000000-0000-7000-8000-000000000204")],
      workstreamId,
    };
    await expect(reconcileReplayedSpaceMembership(input)).rejects.toThrow("workspace_temporarily_unavailable");
    await expect(reconcileReplayedSpaceMembership(input)).resolves.toBeUndefined();
  });
});

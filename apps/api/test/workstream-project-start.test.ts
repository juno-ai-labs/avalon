import { asProjectId, asUserId, asWorkspaceId, asWorkstreamId, ProjectSummarySchema } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api-error";
import {
  reconcileReplayedProjectMembership,
  resolveProjectWorkstreamAudience,
  resolveProjectWorkstreamStart,
} from "../src/services/workstream-object-creation-service";

const creatorId = asUserId("00000000-0000-7000-8000-000000000201");
const participantId = asUserId("00000000-0000-7000-8000-000000000202");
const outsiderId = asUserId("00000000-0000-7000-8000-000000000203");

const personalProject = ProjectSummarySchema.parse({
  id: asProjectId("00000000-0000-7000-8000-000000000204"),
  name: "Hiring",
  iconKey: "briefcase",
  colorKey: "blue",
  scope: "personal",
  status: "active",
  presentationRevision: 1,
  audienceGeneration: 1,
  lifecycleGeneration: 1,
  participants: [
    { userId: creatorId, state: "active", generation: 1 },
    { userId: participantId, state: "active", generation: 1 },
  ],
  defaultResourceIds: ["00000000-0000-7000-8000-000000000207"],
  workstreamIds: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
});

describe("starting a work stream inside a personal project", () => {
  it("given only project participants, when creation resolves its audience, then it uses the full project roster", () => {
    expect(resolveProjectWorkstreamAudience(personalProject, [participantId])).toEqual({
      scope: "personal",
      participantUserIds: [creatorId, participantId],
    });
  });

  it("given a caller-selected outsider, when creation resolves its audience, then it refuses the broader roster", () => {
    expect(() => resolveProjectWorkstreamAudience(personalProject, [outsiderId])).toThrowError(ApiError);
    expect(() => resolveProjectWorkstreamAudience(personalProject, [outsiderId])).toThrow(
      "Add that person to the project before starting this work stream",
    );
  });

  it("given no caller-selected participants, when creation resolves its audience, then it still seats the full project roster", () => {
    expect(resolveProjectWorkstreamAudience(personalProject, [])).toEqual({
      scope: "personal",
      participantUserIds: [creatorId, participantId],
    });
  });

  it("given a workspace project, when creation resolves its audience, then it uses workspace scope", () => {
    const workspaceProject = ProjectSummarySchema.parse({
      ...personalProject,
      scope: "workspace",
    });
    expect(resolveProjectWorkstreamAudience(workspaceProject, [participantId])).toEqual({
      scope: "workspace",
      participantUserIds: [participantId],
    });
  });

  it("given current project defaults, when creation resolves its start, then it attaches those resources before the first run", () => {
    const defaultResourceId = "00000000-0000-7000-8000-000000000207";
    const existingOriginId = "00000000-0000-7000-8000-000000000208";
    expect(resolveProjectWorkstreamStart(personalProject, [participantId], [existingOriginId])).toEqual({
      scope: "personal",
      participantUserIds: [creatorId, participantId],
      originResourceIds: [existingOriginId, defaultResourceId],
    });
  });

  it("given initialization completed before project finalization failed, when the receipt replays, then membership is reconciled", async () => {
    const finalizeProjectMembership = vi.fn()
      .mockRejectedValueOnce(new Error("workspace_temporarily_unavailable"))
      .mockResolvedValueOnce({ ok: true, project: personalProject });
    const cancelProjectMembership = vi.fn().mockResolvedValue({ ok: true, project: personalProject });
    const workspace = {
      prepareProjectMembership: vi.fn().mockResolvedValue({
        ok: true,
        project: { ...personalProject, defaultResourceIds: ["00000000-0000-7000-8000-000000000207"] },
        sourceProjectId: null,
        sourceDetached: false,
        membershipGeneration: 1,
      }),
      finalizeProjectMembership,
      cancelProjectMembership,
    };
    const client = {
      update: vi.fn(),
      addParticipant: vi.fn().mockResolvedValue(undefined),
      attachResource: vi.fn().mockResolvedValue(undefined),
    };
    const input = {
      workspace,
      client,
      auth: {
        sessionId: "session",
        userId: creatorId,
        workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000205"),
        region: "global" as const,
        role: "owner" as const,
      },
      projectId: personalProject.id,
      workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000206"),
      workstream: {
        scope: "personal" as const,
        participants: [{ user: { id: creatorId } }],
      },
    };

    await expect(reconcileReplayedProjectMembership(input)).rejects.toThrow("workspace_temporarily_unavailable");
    await expect(reconcileReplayedProjectMembership(input)).resolves.toBeUndefined();
    expect(finalizeProjectMembership).toHaveBeenCalledTimes(2);
    expect(cancelProjectMembership).toHaveBeenCalledTimes(1);
    expect(client.addParticipant).toHaveBeenCalledWith(participantId);
    expect(client.attachResource).toHaveBeenCalledWith("00000000-0000-7000-8000-000000000207");
  });
});

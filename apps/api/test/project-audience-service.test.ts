import {
  asProjectId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  ProjectSummarySchema,
  type ProjectSummary,
  type WorkstreamDetail,
} from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import type { ApiError } from "../src/lib/api-error";
import { ProjectService } from "../src/services/project-service";
import { WorkstreamService } from "../src/services/workstream-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const ownerId = asUserId("00000000-0000-7000-8000-000000000102");
const memberId = asUserId("00000000-0000-7000-8000-000000000103");
const outsiderId = asUserId("00000000-0000-7000-8000-000000000104");
const projectId = asProjectId("00000000-0000-7000-8000-000000000105");
const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000106");

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return ProjectSummarySchema.parse({
    id: projectId,
    name: "Hiring",
    iconKey: "briefcase",
    colorKey: "blue",
    scope: "personal",
    status: "active",
    presentationRevision: 1,
    audienceGeneration: 1,
    lifecycleGeneration: 1,
    participants: [
      { userId: ownerId, state: "active", generation: 1 },
      { userId: memberId, state: "active", generation: 1 },
    ],
    defaultResourceIds: [],
    workstreamIds: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  });
}

function environment(
  current: ProjectSummary,
  calls: string[] = [],
  // What the authority holds, which is not what the summary shows: archived
  // members are absent from `workstreamIds` and still in the membership.
  members: string[] = current.workstreamIds,
): Env {
  const stub = {
    listProjects: async () => ({ ok: true, directory: { items: [current], waterline: 1 } }),
    listProjectMembers: async () => ({ ok: true, workstreamIds: members }),
    canReadWorkstream: async () => true,
    updateProjectAudience: async (input: { audience: { scope: "personal" | "workspace"; participantUserIds: string[] } }) => {
      calls.push("project:update-audience");
      return {
        ok: true,
        project: project({
          scope: input.audience.scope,
          participants: input.audience.participantUserIds.map((userId) => ({
            userId,
            state: "active" as const,
            generation: 2,
          })),
        }),
      };
    },
    prepareProjectMembership: async () => {
      calls.push("project:prepare-membership");
      return {
        ok: true,
        project: current,
        sourceProjectId: null,
        sourceDetached: false,
        membershipGeneration: 1,
      };
    },
    finalizeProjectMembership: async () => {
      calls.push("project:finalize-membership");
      return { ok: true, project: { ...current, workstreamIds: [workstreamId] } };
    },
    cancelProjectMembership: async () => ({ ok: true, project: current }),
  };
  const namespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
  });
  const database = createTestD1Database({
    prepare: () => createTestD1PreparedStatement({
      bind: () => createTestD1PreparedStatement({
        first: async () => ({ placement_affinity: "wnam" }),
      }),
    }),
  });
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: database,
    WORKSPACE_DOS: namespace,
  });
}

function detail(scope: "personal" | "workspace", participantIds: string[]): WorkstreamDetail {
  return {
    scope,
    participants: participantIds.map((id) => ({ user: { id }, participationReason: "explicit", joinedAt: "2026-08-27T00:00:00.000Z" })),
  } as WorkstreamDetail;
}

afterEach(() => vi.restoreAllMocks());

describe("project audience changes", () => {
  it("given a regular participant, when they remove somebody else, then the project refuses the mutation", async () => {
    const service = new ProjectService(environment(project()), {
      sessionId: "session",
      userId: memberId,
      workspaceId,
      region: "global",
      role: "member",
    });

    await expect(service.updateAudience(projectId, {
      scope: "personal",
      participantUserIds: [memberId],
    })).rejects.toMatchObject({
      status: 403,
      code: "participant_removal_denied",
    } satisfies Partial<ApiError>);
  });

  it("given an owner removes a participant, when the project changes, then every member work stream loses that participant first", async () => {
    const calls: string[] = [];
    const current = project({ workstreamIds: [workstreamId] });
    vi.spyOn(WorkstreamService.prototype, "removeParticipant").mockImplementation(async () => {
      calls.push("workstream:remove-participant");
    });
    const service = new ProjectService(environment(current, calls), {
      sessionId: "session",
      userId: ownerId,
      workspaceId,
      region: "global",
      role: "owner",
    });

    await service.updateAudience(projectId, {
      scope: "personal",
      participantUserIds: [ownerId],
    });

    expect(WorkstreamService.prototype.removeParticipant).toHaveBeenCalledWith(
      workstreamId,
      memberId,
      { projectEffect: true },
    );
    expect(calls).toEqual(["workstream:remove-participant", "project:update-audience"]);
  });

  it("given a member work stream that is archived, when a participant is removed, then it loses them too", async () => {
    const calls: string[] = [];
    // Absent from `workstreamIds` because no surface can list it, and still a
    // member: an audience is who may read the work stream, and an archived one
    // can be unarchived.
    const current = project({ workstreamIds: [] });
    vi.spyOn(WorkstreamService.prototype, "removeParticipant").mockImplementation(async () => {
      calls.push("workstream:remove-participant");
    });
    const service = new ProjectService(environment(current, calls, [workstreamId]), {
      sessionId: "session",
      userId: ownerId,
      workspaceId,
      region: "global",
      role: "owner",
    });

    await service.updateAudience(projectId, {
      scope: "personal",
      participantUserIds: [ownerId],
    });

    expect(WorkstreamService.prototype.removeParticipant).toHaveBeenCalledWith(
      workstreamId,
      memberId,
      { projectEffect: true },
    );
  });
});

describe("personal-project work-stream admission", () => {
  it("given a workspace-scoped work stream, when it is added to a personal project, then membership never starts", async () => {
    const calls: string[] = [];
    vi.spyOn(WorkstreamService.prototype, "get").mockResolvedValue(detail("workspace", [ownerId, memberId]));
    const service = new ProjectService(environment(project(), calls), {
      sessionId: "session",
      userId: ownerId,
      workspaceId,
      region: "global",
      role: "owner",
    });

    await expect(service.addWorkstream(projectId, workstreamId)).rejects.toMatchObject({
      status: 409,
      code: "project_workstream_audience_mismatch",
    } satisfies Partial<ApiError>);
    expect(calls).not.toContain("project:prepare-membership");
  });

  it("given a personal work stream with an extra reader, when it is added to a personal project, then membership never starts", async () => {
    const calls: string[] = [];
    vi.spyOn(WorkstreamService.prototype, "get").mockResolvedValue(detail("personal", [ownerId, memberId, outsiderId]));
    const service = new ProjectService(environment(project(), calls), {
      sessionId: "session",
      userId: ownerId,
      workspaceId,
      region: "global",
      role: "owner",
    });

    await expect(service.addWorkstream(projectId, workstreamId)).rejects.toMatchObject({
      status: 409,
      code: "project_workstream_audience_mismatch",
    } satisfies Partial<ApiError>);
    expect(calls).not.toContain("project:prepare-membership");
  });
});

import {
  asUserId,
  ProjectDirectorySchema,
  ProjectSummarySchema,
  type CreateProjectRequest,
  type ProjectDirectory,
  type ProjectId,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type UpdateProjectPresentationRequest,
  type UpdateProjectAudienceRequest,
  type WorkstreamId,
} from "@rally/contracts";

import {
  WorkspaceProjectDirectoryResultSchema,
  WorkspaceProjectDefaultResultSchema,
  WorkspaceProjectMembersResultSchema,
  WorkspaceProjectMutationResultSchema,
  type WorkspaceProjectErrorCode,
} from "../durable-objects/workspace-project-protocol";
import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { WorkstreamService } from "./workstream-service";
import { ResourceService } from "./resource-service";

function projectError(code: WorkspaceProjectErrorCode): ApiError {
  if (code === "project_access_denied") {
    return new ApiError(403, code, "You no longer have access to this workspace");
  }
  if (code === "project_restore_conflict") {
    return new ApiError(409, code, "Resolve the work-stream project conflict before restoring this project");
  }
  return new ApiError(404, code, "Project not found");
}

/** Authenticated regional facade over WorkspaceDO's project authority. */
export class ProjectService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async list(): Promise<ProjectDirectory> {
    const result = WorkspaceProjectDirectoryResultSchema.parse(await (await this.workspace()).listProjects({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
    }));
    if (!result.ok) throw projectError(result.code);
    return ProjectDirectorySchema.parse(result.directory);
  }

  async listInactive(): Promise<ProjectDirectory> {
    const result = WorkspaceProjectDirectoryResultSchema.parse(
      await (await this.workspace()).listInactiveProjects({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return ProjectDirectorySchema.parse(result.directory);
  }

  async archive(projectId: ProjectId): Promise<ProjectSummary> {
    const result = WorkspaceProjectMutationResultSchema.parse(
      await (await this.workspace()).archiveProject({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.project;
  }

  async restore(projectId: ProjectId): Promise<ProjectSummary> {
    const result = WorkspaceProjectDefaultResultSchema.parse(
      await (await this.workspace()).restoreProject({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.project;
  }

  async create(input: CreateProjectRequest): Promise<ProjectSummary> {
    const result = WorkspaceProjectMutationResultSchema.parse(await (await this.workspace()).createProject({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      project: input,
    }));
    if (!result.ok) throw projectError(result.code);
    return ProjectSummarySchema.parse(result.project);
  }

  async update(projectId: ProjectId, input: UpdateProjectPresentationRequest): Promise<ProjectSummary> {
    const result = WorkspaceProjectMutationResultSchema.parse(
      await (await this.workspace()).updateProjectPresentation({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
        presentation: input,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return ProjectSummarySchema.parse(result.project);
  }

  async updateAudience(projectId: ProjectId, input: UpdateProjectAudienceRequest): Promise<ProjectSummary> {
    const directory = await this.list();
    const current = directory.items.find((project) => project.id === projectId);
    if (!current) throw projectError("project_not_found");
    const currentParticipants = new Set(current.participants
      .filter((participant) => participant.state === "active")
      .map((participant) => participant.userId));
    const requestedParticipants = new Set(input.participantUserIds);
    const removedParticipantIds = [...currentParticipants]
      .filter((userId) => !requestedParticipants.has(userId));
    if (removedParticipantIds.some((userId) => userId !== this.auth.userId)
      && this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "participant_removal_denied", "Only a workspace owner or admin can remove another project participant");
    }
    await this.assertResourcesAudience(
      current.defaultResourceIds,
      input.scope,
      [...requestedParticipants],
    );
    const workstreams = new WorkstreamService(this.env, this.auth);
    // The membership, not `current.workstreamIds`: that field is the members a
    // surface can list, and an archived one is not among them. An audience is
    // who may read the work stream, so a fan-out that skipped the archived
    // members would leave a removed participant reading whatever is unarchived
    // afterwards.
    for (const workstreamId of await this.memberWorkstreamIds(projectId)) {
      if (input.scope === "workspace") {
        await workstreams.update(workstreamId, { scope: "workspace" });
      } else {
        for (const userId of requestedParticipants) {
          if (!currentParticipants.has(userId)) await workstreams.addParticipant(workstreamId, userId);
        }
        for (const userId of removedParticipantIds) {
          await workstreams.removeParticipant(workstreamId, userId, { projectEffect: true });
        }
      }
    }
    const result = WorkspaceProjectMutationResultSchema.parse(
      await (await this.workspace()).updateProjectAudience({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
        audience: input,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.project;
  }

  async reorder(input: ReorderProjectsRequest): Promise<ProjectDirectory> {
    const result = WorkspaceProjectDirectoryResultSchema.parse(await (await this.workspace()).reorderProjects({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      order: input,
    }));
    if (!result.ok) throw projectError(result.code);
    return ProjectDirectorySchema.parse(result.directory);
  }

  async addWorkstream(projectId: ProjectId, workstreamId: WorkstreamId): Promise<ProjectSummary> {
    if (!await new WorkstreamDirectoryService(this.env, this.auth).visible(workstreamId)) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    const current = (await this.list()).items.find((project) => project.id === projectId);
    if (!current) throw projectError("project_not_found");
    if (current.workstreamIds.includes(workstreamId)) return current;
    const workstreams = new WorkstreamService(this.env, this.auth);
    const workstream = current.scope === "personal" ? await workstreams.get(workstreamId) : null;
    if (workstream) this.assertPersonalProjectWorkstreamAudience(current, workstream);
    const workspace = await this.workspace();
    const plan = await workspace.prepareProjectMembership({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      projectId,
      workstreamId,
    });
    if (!plan.ok) throw projectError(plan.code);
    if (plan.project.workstreamIds.includes(workstreamId)) return plan.project;
    const settle = {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      projectId,
      workstreamId,
      membershipGeneration: plan.membershipGeneration,
      sourceProjectId: plan.sourceProjectId,
      sourceDetached: plan.sourceDetached,
    };
    try {
      if (workstream && plan.project.scope === "personal") {
        this.assertPersonalProjectWorkstreamAudience(plan.project, workstream);
      }
      if (plan.project.scope === "workspace") {
        await workstreams.update(workstreamId, { scope: "workspace" });
      } else {
        for (const participant of plan.project.participants) {
          if (participant.state === "active") await workstreams.addParticipant(workstreamId, participant.userId);
        }
      }
      for (const resourceId of plan.project.defaultResourceIds) {
        await workstreams.attachResource(workstreamId, resourceId);
      }
      const result = WorkspaceProjectMutationResultSchema.parse(
        await workspace.finalizeProjectMembership(settle),
      );
      if (!result.ok) throw projectError(result.code);
      return result.project;
    } catch (error) {
      await workspace.cancelProjectMembership(settle).catch(() => undefined);
      throw error;
    }
  }

  async addDefaultResource(projectId: ProjectId, resourceId: string): Promise<ProjectSummary> {
    await new ResourceService(this.env, this.auth).get(resourceId);
    const project = (await this.list()).items.find((candidate) => candidate.id === projectId);
    if (!project) throw projectError("project_not_found");
    await this.assertResourcesAudience(
      [resourceId],
      project.scope,
      project.participants.filter((participant) => participant.state === "active").map((participant) => participant.userId),
    );
    const result = WorkspaceProjectDefaultResultSchema.parse(
      await (await this.workspace()).addProjectDefaultResource({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
        resourceId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.project;
  }

  async removeDefaultResource(projectId: ProjectId, resourceId: string): Promise<ProjectSummary> {
    const result = WorkspaceProjectMutationResultSchema.parse(
      await (await this.workspace()).removeProjectDefaultResource({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
        resourceId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.project;
  }

  async removeWorkstream(projectId: ProjectId, workstreamId: WorkstreamId): Promise<ProjectSummary> {
    const result = WorkspaceProjectMutationResultSchema.parse(
      await (await this.workspace()).removeProjectMembership({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
        workstreamId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.project;
  }

  private async assertResourcesAudience(
    resourceIds: readonly string[],
    scope: "personal" | "workspace",
    participantUserIds: string[],
  ): Promise<void> {
    const readerIds = scope === "workspace"
      ? (await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' ORDER BY user_id`,
      ).bind(this.auth.workspaceId).all<{ user_id: string }>()).results.map((row) => row.user_id)
      : participantUserIds;
    const uniqueReaderIds = [...new Set(readerIds)];
    const readers = uniqueReaderIds.map((userId) => new ResourceService(this.env, { ...this.auth, userId: asUserId(userId) }));
    for (const resourceId of resourceIds) {
      for (const reader of readers) {
        try {
          // ResourceService routes product reads through WorkspaceDO and applies
          // every connector, note, upload, and inbound-email visibility rule.
          // Reusing it avoids a parallel audience model and any query of the
          // retired D1 product tables.
          await reader.get(resourceId);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          throw new ApiError(422, "project_resource_audience_mismatch", "Every project participant must be able to read a default resource");
        }
      }
    }
  }

  private assertPersonalProjectWorkstreamAudience(
    project: ProjectSummary,
    workstream: Awaited<ReturnType<WorkstreamService["get"]>>,
  ): void {
    const projectParticipantIds = new Set(project.participants
      .filter((participant) => participant.state === "active")
      .map((participant) => participant.userId));
    const hasExtraReader = workstream.participants
      .some((participant) => !projectParticipantIds.has(participant.user.id));
    if (workstream.scope !== "personal" || hasExtraReader) {
      throw new ApiError(
        409,
        "project_workstream_audience_mismatch",
        "Make the work stream personal and add each of its participants to the project first",
      );
    }
  }

  /**
   * Every work stream the project holds, archived ones included.
   *
   * Work streams, not participants. `ProjectSummary.workstreamIds` is the
   * members a surface can list, so
   * anything acting on the project's behalf asks the authority instead of
   * reading the shape built for a screen.
   */
  private async memberWorkstreamIds(projectId: ProjectId): Promise<WorkstreamId[]> {
    const result = WorkspaceProjectMembersResultSchema.parse(
      await (await this.workspace()).listProjectMembers({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        projectId,
      }),
    );
    if (!result.ok) throw projectError(result.code);
    return result.workstreamIds;
  }

  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }
}

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
  ProjectDefaultResourceQueueMessageSchema,
  WorkspaceProjectDefaultResultSchema,
  WorkspaceProjectMutationResultSchema,
  type WorkspaceProjectDefaultTarget,
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
  if (code === "project_name_conflict") {
    return new ApiError(409, code, "A project with that name already exists");
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
    await this.publishDefaultTargets(result.targets);
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
    for (const resourceId of current.defaultResourceIds) {
      await this.assertResourceAudience(resourceId, input.scope, [...requestedParticipants]);
    }
    const workstreams = new WorkstreamService(this.env, this.auth);
    for (const workstreamId of current.workstreamIds) {
      if (input.scope === "workspace") {
        await workstreams.update(workstreamId, { scope: "workspace" });
      } else {
        for (const userId of requestedParticipants) {
          if (!currentParticipants.has(userId)) await workstreams.addParticipant(workstreamId, userId);
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
      const workstreams = new WorkstreamService(this.env, this.auth);
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
    await this.assertResourceAudience(
      resourceId,
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
    await this.publishDefaultTargets(result.targets);
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

  private async assertResourceAudience(
    resourceId: string,
    scope: "personal" | "workspace",
    participantUserIds: string[],
  ): Promise<void> {
    const readerIds = scope === "workspace"
      ? (await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' ORDER BY user_id`,
      ).bind(this.auth.workspaceId).all<{ user_id: string }>()).results.map((row) => row.user_id)
      : participantUserIds;
    for (const userId of new Set(readerIds)) {
      try {
        // ResourceService routes product reads through WorkspaceDO and applies
        // every connector, note, upload, and inbound-email visibility rule.
        // Reusing it avoids a parallel audience model and any query of the
        // retired D1 product tables.
        await new ResourceService(this.env, { ...this.auth, userId: asUserId(userId) }).get(resourceId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        throw new ApiError(422, "project_resource_audience_mismatch", "Every project participant must be able to read a default resource");
      }
    }
  }

  private async publishDefaultTargets(
    targets: WorkspaceProjectDefaultTarget[],
  ): Promise<void> {
    for (let index = 0; index < targets.length; index += 100) {
      await this.env.ACTIVITY_QUEUE.sendBatch(targets.slice(index, index + 100).map((target) => ({
        body: ProjectDefaultResourceQueueMessageSchema.parse({
          type: "project_default_resource",
          region: this.env.AVALON_REGION,
          workspaceId: this.auth.workspaceId,
          requestedByUserId: this.auth.userId,
          ...target,
        }),
      })));
    }
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


import { WorkspaceDoAutomation } from "./workspace-do-automation";
import { uuidV7 } from "../lib/uuid-v7";
import {
  WorkspaceProjectCreateRequestSchema,
  WorkspaceProjectAudienceRequestSchema,
  ProjectDefaultResourceQueueMessageSchema,
  WorkspaceProjectDefaultResourceRequestSchema,
  WorkspaceProjectDefaultResultSchema,
  WorkspaceProjectDirectoryResultSchema,
  WorkspaceProjectListRequestSchema,
  WorkspaceProjectLifecycleRequestSchema,
  WorkspaceProjectMembershipPlanResultSchema,
  WorkspaceProjectMembershipPrepareRequestSchema,
  WorkspaceProjectMembershipSettleRequestSchema,
  WorkspaceProjectMutationResultSchema,
  WorkspaceProjectReorderRequestSchema,
  WorkspaceProjectUpdateRequestSchema,
  WorkspaceProjectWorkstreamConstraintRequestSchema,
  WorkspaceProjectWorkstreamConstraintResultSchema,
  type WorkspaceProjectCreateRequest,
  type WorkspaceProjectAudienceRequest,
  type ProjectDefaultResourceQueueMessage,
  type WorkspaceProjectDefaultResourceRequest,
  type WorkspaceProjectDefaultResult,
  type WorkspaceProjectDirectoryResult,
  type WorkspaceProjectListRequest,
  type WorkspaceProjectLifecycleRequest,
  type WorkspaceProjectMembershipPlanResult,
  type WorkspaceProjectMembershipPrepareRequest,
  type WorkspaceProjectMembershipSettleRequest,
  type WorkspaceProjectMutationResult,
  type WorkspaceProjectReorderRequest,
  type WorkspaceProjectUpdateRequest,
  type WorkspaceProjectWorkstreamConstraintRequest,
  type WorkspaceProjectWorkstreamConstraintResult,
} from "./workspace-project-protocol";

/**
 * `WorkspaceDO`'s project surface: identity, presentation, audience, membership,
 * ordering, lifecycle, and default resources.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoProjects extends WorkspaceDoAutomation {

  async createProject(input: WorkspaceProjectCreateRequest): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectCreateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().create(request, uuidV7());
    this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse({ ok: true, project });
  }

  async listProjects(input: WorkspaceProjectListRequest): Promise<WorkspaceProjectDirectoryResult> {
    await this.initialized;
    const request = WorkspaceProjectListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    return WorkspaceProjectDirectoryResultSchema.parse({
      ok: true,
      directory: this.projectStorage().list(request.userId),
    });
  }

  async listInactiveProjects(input: WorkspaceProjectListRequest): Promise<WorkspaceProjectDirectoryResult> {
    await this.initialized;
    const request = WorkspaceProjectListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    return WorkspaceProjectDirectoryResultSchema.parse({
      ok: true,
      directory: this.projectStorage().listInactive(request.userId),
    });
  }

  async archiveProject(input: WorkspaceProjectLifecycleRequest): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectLifecycleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().archive(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async restoreProject(input: WorkspaceProjectLifecycleRequest): Promise<WorkspaceProjectDefaultResult> {
    await this.initialized;
    const request = WorkspaceProjectLifecycleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().restore(request);
    const result = WorkspaceProjectDefaultResultSchema.parse(project === "conflict"
      ? { ok: false, code: "project_restore_conflict" }
      : project
        ? { ok: true, project: project.project, targets: project.targets }
        : { ok: false, code: "project_not_found" });
    if (result.ok) this.publishProjectSnapshot();
    if (result.ok && result.targets.length > 0) await this.armNextAlarm();
    return result;
  }

  async reorderProjects(
    input: WorkspaceProjectReorderRequest,
  ): Promise<WorkspaceProjectDirectoryResult> {
    await this.initialized;
    const request = WorkspaceProjectReorderRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const result = WorkspaceProjectDirectoryResultSchema.parse({
      ok: true,
      directory: this.projectStorage().reorder(request.userId, request.order.projectIds),
    });
    this.publishProjectSnapshot();
    return result;
  }

  async updateProjectPresentation(
    input: WorkspaceProjectUpdateRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectUpdateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().updatePresentation(request);
    if (project !== false) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project === false
      ? { ok: false, code: "project_not_found" }
      : { ok: true, project });
  }

  async updateProjectAudience(input: WorkspaceProjectAudienceRequest): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectAudienceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const activeMemberIds = await Promise.all(request.audience.participantUserIds.map(async (userId) => (
      await this.activeWorkspaceMember(request.workspaceId, userId) ? userId : null
    )));
    if (activeMemberIds.some((userId) => userId === null)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().updateAudience(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async prepareProjectMembership(
    input: WorkspaceProjectMembershipPrepareRequest,
  ): Promise<WorkspaceProjectMembershipPlanResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipPrepareRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const result = WorkspaceProjectMembershipPlanResultSchema.parse(
      this.projectStorage().prepareMembership(request),
    );
    if (result.ok) this.publishProjectSnapshot();
    return result;
  }

  async projectWorkstreamConstraints(
    input: WorkspaceProjectWorkstreamConstraintRequest,
  ): Promise<WorkspaceProjectWorkstreamConstraintResult> {
    await this.initialized;
    const request = WorkspaceProjectWorkstreamConstraintRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return WorkspaceProjectWorkstreamConstraintResultSchema.parse({
        activeProject: false,
        requiresWorkspaceScope: false,
      });
    }
    return WorkspaceProjectWorkstreamConstraintResultSchema.parse(
      this.projectStorage().workstreamConstraints(request.workstreamId),
    );
  }

  async finalizeProjectMembership(
    input: WorkspaceProjectMembershipSettleRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().finalizeMembership(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async cancelProjectMembership(
    input: WorkspaceProjectMembershipSettleRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().cancelMembership(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async removeProjectMembership(
    input: WorkspaceProjectMembershipPrepareRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipPrepareRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().removeMembership(
      request.userId,
      request.projectId,
      request.workstreamId,
    );
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async addProjectDefaultResource(
    input: WorkspaceProjectDefaultResourceRequest,
  ): Promise<WorkspaceProjectDefaultResult> {
    await this.initialized;
    const request = WorkspaceProjectDefaultResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const result = WorkspaceProjectDefaultResultSchema.parse(
      this.projectStorage().addDefaultResource(request),
    );
    if (result.ok) this.publishProjectSnapshot();
    if (result.ok && result.targets.length > 0) await this.armNextAlarm();
    return result;
  }

  async removeProjectDefaultResource(
    input: WorkspaceProjectDefaultResourceRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectDefaultResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().removeDefaultResource(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async projectDefaultTargetCurrent(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().defaultTargetCurrent(request);
  }

  async projectDefaultTargetActors(input: ProjectDefaultResourceQueueMessage): Promise<string[]> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().defaultTargetActors(request);
  }

  async completeProjectDefaultTarget(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().completeDefaultTarget(request);
  }

  async recordProjectDefaultTargetFailure(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().recordDefaultTargetFailure(request, "resource_attach_failed");
  }

  async failProjectDefaultTarget(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().failDefaultTarget(request, "project_no_active_participant");
  }
}

import {
  ProjectDirectorySchema,
  ProjectSummarySchema,
  type CreateProjectRequest,
  type ProjectDirectory,
  type ProjectId,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type UpdateProjectPresentationRequest,
} from "@rally/contracts";

import {
  WorkspaceProjectDirectoryResultSchema,
  WorkspaceProjectMutationResultSchema,
  type WorkspaceProjectErrorCode,
} from "../durable-objects/workspace-project-protocol";
import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

function projectError(code: WorkspaceProjectErrorCode): ApiError {
  if (code === "project_access_denied") {
    return new ApiError(403, code, "You no longer have access to this workspace");
  }
  if (code === "project_name_conflict") {
    return new ApiError(409, code, "A project with that name already exists");
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

  async reorder(input: ReorderProjectsRequest): Promise<ProjectDirectory> {
    const result = WorkspaceProjectDirectoryResultSchema.parse(await (await this.workspace()).reorderProjects({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      order: input,
    }));
    if (!result.ok) throw projectError(result.code);
    return ProjectDirectorySchema.parse(result.directory);
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

import {
  CreateProjectRequestSchema,
  ProjectDirectorySchema,
  ProjectIdSchema,
  ProjectSummarySchema,
  ReorderProjectsRequestSchema,
  UpdateProjectPresentationRequestSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@rally/contracts";
import { z } from "zod";

export const WorkspaceProjectErrorCodeSchema = z.enum([
  "project_access_denied",
  "project_name_conflict",
  "project_not_found",
]);
export type WorkspaceProjectErrorCode = z.infer<typeof WorkspaceProjectErrorCodeSchema>;

const WorkspaceProjectActorSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
}).strict();

export const WorkspaceProjectCreateRequestSchema = WorkspaceProjectActorSchema.extend({
  project: CreateProjectRequestSchema,
}).strict();
export type WorkspaceProjectCreateRequest = z.infer<typeof WorkspaceProjectCreateRequestSchema>;

export const WorkspaceProjectListRequestSchema = WorkspaceProjectActorSchema;
export type WorkspaceProjectListRequest = z.infer<typeof WorkspaceProjectListRequestSchema>;

export const WorkspaceProjectUpdateRequestSchema = WorkspaceProjectActorSchema.extend({
  projectId: ProjectIdSchema,
  presentation: UpdateProjectPresentationRequestSchema,
}).strict();
export type WorkspaceProjectUpdateRequest = z.infer<typeof WorkspaceProjectUpdateRequestSchema>;

export const WorkspaceProjectReorderRequestSchema = WorkspaceProjectActorSchema.extend({
  order: ReorderProjectsRequestSchema,
}).strict();
export type WorkspaceProjectReorderRequest = z.infer<typeof WorkspaceProjectReorderRequestSchema>;

const WorkspaceProjectFailureSchema = z.object({
  ok: z.literal(false),
  code: WorkspaceProjectErrorCodeSchema,
}).strict();

export const WorkspaceProjectMutationResultSchema = z.union([
  z.object({ ok: z.literal(true), project: ProjectSummarySchema }).strict(),
  WorkspaceProjectFailureSchema,
]);
export type WorkspaceProjectMutationResult = z.infer<typeof WorkspaceProjectMutationResultSchema>;

export const WorkspaceProjectDirectoryResultSchema = z.union([
  z.object({ ok: z.literal(true), directory: ProjectDirectorySchema }).strict(),
  WorkspaceProjectFailureSchema,
]);
export type WorkspaceProjectDirectoryResult = z.infer<typeof WorkspaceProjectDirectoryResultSchema>;

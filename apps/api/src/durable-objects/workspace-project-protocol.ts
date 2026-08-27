import {
  CreateProjectRequestSchema,
  IdSchema,
  ProjectDirectorySchema,
  ProjectIdSchema,
  ProjectSummarySchema,
  ReorderProjectsRequestSchema,
  UpdateProjectPresentationRequestSchema,
  UpdateProjectAudienceRequestSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { z } from "zod";

export const WorkspaceProjectErrorCodeSchema = z.enum([
  "project_access_denied",
  "project_name_conflict",
  "project_not_found",
  "project_restore_conflict",
]);
export type WorkspaceProjectErrorCode = z.infer<typeof WorkspaceProjectErrorCodeSchema>;

const WorkspaceProjectFailureSchema = z.object({
  ok: z.literal(false),
  code: WorkspaceProjectErrorCodeSchema,
}).strict();

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

export const WorkspaceProjectLifecycleRequestSchema = WorkspaceProjectActorSchema.extend({
  projectId: ProjectIdSchema,
}).strict();
export type WorkspaceProjectLifecycleRequest = z.infer<typeof WorkspaceProjectLifecycleRequestSchema>;

export const WorkspaceProjectUpdateRequestSchema = WorkspaceProjectActorSchema.extend({
  projectId: ProjectIdSchema,
  presentation: UpdateProjectPresentationRequestSchema,
}).strict();
export type WorkspaceProjectUpdateRequest = z.infer<typeof WorkspaceProjectUpdateRequestSchema>;

export const WorkspaceProjectAudienceRequestSchema = WorkspaceProjectActorSchema.extend({
  projectId: ProjectIdSchema,
  audience: UpdateProjectAudienceRequestSchema,
}).strict();
export type WorkspaceProjectAudienceRequest = z.infer<typeof WorkspaceProjectAudienceRequestSchema>;

export const WorkspaceProjectReorderRequestSchema = WorkspaceProjectActorSchema.extend({
  order: ReorderProjectsRequestSchema,
}).strict();
export type WorkspaceProjectReorderRequest = z.infer<typeof WorkspaceProjectReorderRequestSchema>;

export const WorkspaceProjectMembershipPrepareRequestSchema = WorkspaceProjectActorSchema.extend({
  projectId: ProjectIdSchema,
  workstreamId: WorkstreamIdSchema,
}).strict();
export type WorkspaceProjectMembershipPrepareRequest = z.infer<typeof WorkspaceProjectMembershipPrepareRequestSchema>;

export const WorkspaceProjectWorkstreamConstraintRequestSchema = WorkspaceProjectActorSchema.extend({
  workstreamId: WorkstreamIdSchema,
}).strict();
export type WorkspaceProjectWorkstreamConstraintRequest = z.infer<typeof WorkspaceProjectWorkstreamConstraintRequestSchema>;
export const WorkspaceProjectWorkstreamConstraintResultSchema = z.object({
  activeProject: z.boolean(),
  requiresWorkspaceScope: z.boolean(),
}).strict();
export type WorkspaceProjectWorkstreamConstraintResult = z.infer<typeof WorkspaceProjectWorkstreamConstraintResultSchema>;

export const WorkspaceProjectMembershipSettleRequestSchema = WorkspaceProjectMembershipPrepareRequestSchema.extend({
  membershipGeneration: z.number().int().positive(),
  sourceProjectId: ProjectIdSchema.nullable(),
  sourceDetached: z.boolean(),
}).strict();
export type WorkspaceProjectMembershipSettleRequest = z.infer<typeof WorkspaceProjectMembershipSettleRequestSchema>;

export const WorkspaceProjectMembershipPlanSchema = z.object({
  ok: z.literal(true),
  project: ProjectSummarySchema,
  sourceProjectId: ProjectIdSchema.nullable(),
  sourceDetached: z.boolean(),
  membershipGeneration: z.number().int().positive(),
}).strict();
export const WorkspaceProjectMembershipPlanResultSchema = z.union([
  WorkspaceProjectMembershipPlanSchema,
  WorkspaceProjectFailureSchema,
]);
export type WorkspaceProjectMembershipPlanResult = z.infer<typeof WorkspaceProjectMembershipPlanResultSchema>;

export const WorkspaceProjectDefaultResourceRequestSchema = WorkspaceProjectActorSchema.extend({
  projectId: ProjectIdSchema,
  resourceId: IdSchema,
}).strict();
export type WorkspaceProjectDefaultResourceRequest = z.infer<typeof WorkspaceProjectDefaultResourceRequestSchema>;

export const WorkspaceProjectDefaultTargetSchema = z.object({
  projectId: ProjectIdSchema,
  resourceId: IdSchema,
  defaultGeneration: z.number().int().positive(),
  workstreamId: WorkstreamIdSchema,
  membershipGeneration: z.number().int().positive(),
}).strict();
export type WorkspaceProjectDefaultTarget = z.infer<typeof WorkspaceProjectDefaultTargetSchema>;

export const WorkspaceProjectDefaultResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    project: ProjectSummarySchema,
    targets: z.array(WorkspaceProjectDefaultTargetSchema),
  }).strict(),
  WorkspaceProjectFailureSchema,
]);
export type WorkspaceProjectDefaultResult = z.infer<typeof WorkspaceProjectDefaultResultSchema>;

export const ProjectDefaultResourceQueueMessageSchema = WorkspaceProjectDefaultTargetSchema.extend({
  type: z.literal("project_default_resource"),
  region: z.enum(["global", "eu"]),
  workspaceId: WorkspaceIdSchema,
  requestedByUserId: UserIdSchema,
}).strict();
export type ProjectDefaultResourceQueueMessage = z.infer<typeof ProjectDefaultResourceQueueMessageSchema>;

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

import { OffsetDateTimeSchema } from "./schema-runtime";
import { STRICT_UUID_PATTERN } from "./uuid-validation";
import { z } from "zod/v3";

export const PROJECT_ICON_KEYS = [
  "briefcase",
  "target",
  "calendar-days",
  "list-checks",
  "clipboard-list",
  "file-text",
  "folder",
  "lightbulb",
  "star",
  "flag",
  "rocket",
  "chart-no-axes-combined",
  "calculator",
  "coins",
  "users",
  "user-search",
  "handshake",
  "megaphone",
  "palette",
  "image",
  "pen-tool",
  "package",
  "building-2",
  "globe-2",
  "heart",
] as const;

export const PROJECT_COLOR_KEYS = [
  "gray",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;

export const ProjectIdSchema = z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID").brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const asProjectId = (value: string): ProjectId => ProjectIdSchema.parse(value);

export const ProjectIconKeySchema = z.enum(PROJECT_ICON_KEYS);
export type ProjectIconKey = z.infer<typeof ProjectIconKeySchema>;
export const ProjectColorKeySchema = z.enum(PROJECT_COLOR_KEYS);
export type ProjectColorKey = z.infer<typeof ProjectColorKeySchema>;
export const ProjectScopeSchema = z.enum(["personal", "workspace"]);
export type ProjectScope = z.infer<typeof ProjectScopeSchema>;
export const ProjectStatusSchema = z.enum([
  "active",
  "archiving",
  "archived",
  "restoring",
  "cancelling_restore",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export const ProjectParticipantStateSchema = z.enum(["adding", "active", "removing", "removed"]);

export const ProjectParticipantSchema = z.object({
  userId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  state: ProjectParticipantStateSchema,
  generation: z.number().int().safe().positive(),
}).strict();
export type ProjectParticipant = z.infer<typeof ProjectParticipantSchema>;

export const ProjectSummarySchema = z.object({
  id: ProjectIdSchema,
  name: z.string().trim().min(1),
  iconKey: ProjectIconKeySchema,
  colorKey: ProjectColorKeySchema,
  scope: ProjectScopeSchema,
  status: ProjectStatusSchema,
  presentationRevision: z.number().int().safe().positive(),
  audienceGeneration: z.number().int().safe().positive(),
  lifecycleGeneration: z.number().int().safe().positive(),
  participants: z.array(ProjectParticipantSchema),
  workstreamIds: z.array(z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID")).default([]),
  defaultResourceIds: z.array(z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID")).default([]),
  createdAt: OffsetDateTimeSchema,
  updatedAt: OffsetDateTimeSchema,
}).strict();
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const CreateProjectRequestSchema = z.object({
  name: z.string().trim().min(1),
  iconKey: ProjectIconKeySchema,
  colorKey: ProjectColorKeySchema,
  scope: ProjectScopeSchema,
}).strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectPresentationRequestSchema = z.object({
  name: z.string().trim().min(1),
  iconKey: ProjectIconKeySchema,
  colorKey: ProjectColorKeySchema,
}).strict();
export type UpdateProjectPresentationRequest = z.infer<typeof UpdateProjectPresentationRequestSchema>;

export const UpdateProjectAudienceRequestSchema = z.object({
  scope: ProjectScopeSchema,
  participantUserIds: z.array(z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID")).min(1),
}).strict();
export type UpdateProjectAudienceRequest = z.infer<typeof UpdateProjectAudienceRequestSchema>;

export const ReorderProjectsRequestSchema = z.object({
  projectIds: z.array(ProjectIdSchema),
}).strict();
export type ReorderProjectsRequest = z.infer<typeof ReorderProjectsRequestSchema>;

export const ProjectDirectorySchema = z.object({
  waterline: z.number().int().safe().nonnegative(),
  items: z.array(ProjectSummarySchema),
}).strict();
export type ProjectDirectory = z.infer<typeof ProjectDirectorySchema>;

export const ProjectSnapshotSchema = z.object({
  active: ProjectDirectorySchema,
  inactive: ProjectDirectorySchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.active.waterline !== snapshot.inactive.waterline) {
    context.addIssue({
      code: "custom",
      path: ["inactive", "waterline"],
      message: "must match the active project directory waterline",
    });
  }
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

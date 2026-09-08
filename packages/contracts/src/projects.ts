import { z } from "zod";

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

/**
 * Colors a picker may offer. `orange` stays in `PROJECT_COLOR_KEYS` so stored
 * appearances remain valid; it is not selectable because its neon-yellow paint
 * fails contrast on chips. `paintProjectColor` maps leftover `orange` to gold.
 */
export const PROJECT_COLOR_CHOICES = [
  "gray",
  "brown",
  "red",
  "yellow",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;

export const ProjectIdSchema = z.string().uuid().brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const asProjectId = (value: string): ProjectId => ProjectIdSchema.parse(value);

export const ProjectIconKeySchema = z.enum(PROJECT_ICON_KEYS);
export type ProjectIconKey = z.infer<typeof ProjectIconKeySchema>;
export const ProjectColorKeySchema = z.enum(PROJECT_COLOR_KEYS);
export type ProjectColorKey = z.infer<typeof ProjectColorKeySchema>;
export type ProjectColorChoice = (typeof PROJECT_COLOR_CHOICES)[number];

/** Resolve a stored identity key to the token a chip may paint. */
export function paintProjectColor(key: ProjectColorKey): ProjectColorChoice {
  return key === "orange" ? "yellow" : key;
}
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

export const ProjectParticipantSchema = z.strictObject({
  userId: z.string().uuid(),
  state: ProjectParticipantStateSchema,
  generation: z.number().int().positive(),
});
export type ProjectParticipant = z.infer<typeof ProjectParticipantSchema>;

export const ProjectSummarySchema = z.strictObject({
  id: ProjectIdSchema,
  name: z.string().trim().min(1),
  iconKey: ProjectIconKeySchema,
  colorKey: ProjectColorKeySchema,
  scope: ProjectScopeSchema,
  status: ProjectStatusSchema,
  presentationRevision: z.number().int().positive(),
  audienceGeneration: z.number().int().positive(),
  lifecycleGeneration: z.number().int().positive(),
  participants: z.array(ProjectParticipantSchema),
  /**
   * Members a surface can show: an active membership whose work stream is not
   * archived.
   *
   * Not every membership. Archiving a work stream leaves its membership alone
   * — that row is what returns it to this project if it is unarchived — while
   * every list of work streams filters archived ones out, so a project that
   * counted them claimed members no screen could render: one whose work
   * streams had been archived sat on "Showing 1 of 4" pointing at a **load
   * more** that could never produce the other three. The whole membership,
   * archived rows included, stays inside WorkspaceDO, served by its
   * `listProjectMembers` RPC to the things that act on a project's behalf — an
   * audience change reaches every member, listable or not. Nothing on the wire carries it, deliberately: a field added here
   * is an unknown key to a desktop build that shipped before it, and this
   * object is nested in the socket's opening sidebar payload, which such a
   * build would then drop whole.
   */
  workstreamIds: z.array(z.string().uuid()).default([]),
  defaultResourceIds: z.array(z.string().uuid()).default([]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const CreateProjectRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  iconKey: ProjectIconKeySchema,
  colorKey: ProjectColorKeySchema,
  scope: ProjectScopeSchema,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectPresentationRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  iconKey: ProjectIconKeySchema,
  colorKey: ProjectColorKeySchema,
});
export type UpdateProjectPresentationRequest = z.infer<typeof UpdateProjectPresentationRequestSchema>;

export const UpdateProjectAudienceRequestSchema = z.strictObject({
  scope: ProjectScopeSchema,
  participantUserIds: z.array(z.string().uuid()).min(1),
});
export type UpdateProjectAudienceRequest = z.infer<typeof UpdateProjectAudienceRequestSchema>;

export const ReorderProjectsRequestSchema = z.strictObject({
  projectIds: z.array(ProjectIdSchema),
});
export type ReorderProjectsRequest = z.infer<typeof ReorderProjectsRequestSchema>;

export const ProjectDirectorySchema = z.strictObject({
  waterline: z.number().int().nonnegative(),
  items: z.array(ProjectSummarySchema),
});
export type ProjectDirectory = z.infer<typeof ProjectDirectorySchema>;

export const ProjectSnapshotSchema = z.strictObject({
  active: ProjectDirectorySchema,
  inactive: ProjectDirectorySchema,
}).superRefine((snapshot, context) => {
  if (snapshot.active.waterline !== snapshot.inactive.waterline) {
    context.addIssue({
      code: "custom",
      path: ["inactive", "waterline"],
      message: "must match the active project directory waterline",
    });
  }
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

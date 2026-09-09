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

/**
 * The hue ring: fourteen colours in wheel order, `pink` adjacent to `rose` so
 * the sequence closes on itself.
 *
 * The pickers rely on that — each runs its first row left to right and its
 * second right to left, so both seams of the ring meet rather than jumping back
 * across the grid. Reordering this list reorders the swatches and breaks a seam;
 * add a hue where it belongs on the wheel, not at the end.
 */
export const PALETTE_RING = [
  "rose",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "emerald",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;

/**
 * Keys retired when the palette became the ring. Rows written before that still
 * hold them, and a stored value has to survive a read —
 * `WorkstreamAppearanceSchema.parse` runs on every work-stream read and throws
 * rather than degrading — so they stay storable, keep their design tokens, and
 * keep rendering exactly as they did. Nothing recolours under anyone; the
 * colour simply cannot be chosen again.
 */
export const PALETTE_RETIRED = [
  "gray",
  "brown",
  "yellow",
  "teal",
] as const;

/**
 * Every colour the design system defines a token for: the ring, the `black`
 * neutral, and the retired keys still being rendered for whoever holds one.
 *
 * This is the vocabulary, not a menu. What a *project* may be and what a
 * *person* may be are narrower lists below, and they are deliberately different
 * — `black` is the account accent's alone.
 */
export const PALETTE_KEYS = [...PALETTE_RING, "black", ...PALETTE_RETIRED] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

/**
 * What the picker offers for a project or work stream: the ring, and nothing
 * else.
 *
 * `black` is left out on purpose. It reads as an absence of colour rather than a
 * colour, which is the wrong signal for an object sitting in a list beside
 * thirteen others it is meant to be told apart from; it belongs to a person,
 * where only one is on screen at a time.
 *
 * Left out of the *menu*, not out of the vocabulary — see
 * `PROJECT_COLOR_KEYS_STORABLE`. Narrowing what can be stored is how a colour
 * somebody already holds turns into a failed read.
 */
export const PROJECT_COLOR_KEYS = PALETTE_RING;

/**
 * What a stored project colour may legally hold: every colour the palette
 * defines, which is deliberately wider than the menu.
 *
 * This is the vocabulary for schemas and for the SQLite CHECK constraint. It
 * carries the retired keys and `black` alike — a value that is no longer
 * offered still has to parse and still has to render, whether it stopped being
 * offered because it was retired or because it was reserved for accounts.
 */
export const PROJECT_COLOR_KEYS_STORABLE = PALETTE_KEYS;

/** Retained name for the ring; a derived colour has never included the neutral. */
export const PROJECT_COLOR_RING = PALETTE_RING;

/**
 * Which ink reads on each fill, decided by WCAG contrast rather than by eye:
 * for every key the winner beats 4.5:1, so there is no marginal case to argue
 * about. On this palette black wins almost everywhere, which is what adopting a
 * light ramp costs — only `black` and the two darkest retired keys take white.
 * Checked in rather than computed at render so a value change that flips an ink
 * has to be a visible edit, and `palette.css.node.test.ts` recomputes it from
 * the tokens in both appearances.
 */
export const PALETTE_INK = {
  rose: "black",
  red: "black",
  orange: "black",
  amber: "black",
  lime: "black",
  green: "black",
  emerald: "black",
  cyan: "black",
  blue: "black",
  indigo: "black",
  violet: "black",
  purple: "black",
  fuchsia: "black",
  pink: "black",
  black: "white",
  gray: "white",
  brown: "white",
  yellow: "black",
  teal: "black",
} as const satisfies Record<PaletteKey, "white" | "black">;

export const ProjectIdSchema = z.string().uuid().brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const asProjectId = (value: string): ProjectId => ProjectIdSchema.parse(value);

export const ProjectIconKeySchema = z.enum(PROJECT_ICON_KEYS);
export type ProjectIconKey = z.infer<typeof ProjectIconKeySchema>;
export const ProjectColorKeySchema = z.enum(PROJECT_COLOR_KEYS_STORABLE);
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

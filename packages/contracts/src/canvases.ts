import { z } from "zod";

import { IdSchema, UserIdSchema, WorkstreamIdSchema } from "./identifiers";

/**
 * A Canvas is a conversation first: its id is the parent id of its
 * `canvas`-kind conversation (the `WorkstreamId` brand, the conversation-parent
 * coordinate every conversation object is named by), and substream `"0"` is
 * its Chat. The artifacts it generates are resources linked to that
 * conversation. `docs/canvases.md` owns the model.
 */
export const CanvasIdSchema = WorkstreamIdSchema;
export type CanvasId = z.infer<typeof CanvasIdSchema>;

/**
 * Who can open a Canvas: its creator alone, its creator and its participants,
 * or every member of the Organization (and its participants, who may be
 * guests). A guest is admitted only from the participant list.
 */
export const CanvasVisibilitySchema = z.enum(["creator", "participants", "workspace"]);
export type CanvasVisibility = z.infer<typeof CanvasVisibilitySchema>;

/** Who last changed a Canvas: a person (their id), Rally, or a Sidekick (its id). */
export const CanvasEditorSchema = z.strictObject({
  kind: z.enum(["person", "rally", "sidekick"]),
  id: IdSchema.nullable(),
});
export type CanvasEditor = z.infer<typeof CanvasEditorSchema>;

/**
 * A change to who can open a Canvas. `userIds` is the whole participant list
 * besides the creator; a `creator` Canvas has none and a `participants` one
 * names at least one person.
 */
export const CanvasAudienceUpdateSchema = z.strictObject({
  visibility: CanvasVisibilitySchema,
  userIds: z.array(UserIdSchema).default([]),
}).superRefine((update, context) => {
  if (update.visibility === "creator" && update.userIds.length > 0) {
    context.addIssue({ code: "custom", path: ["userIds"], message: "must be empty when only the creator can open it" });
  }
  if (update.visibility === "participants" && update.userIds.length === 0) {
    context.addIssue({ code: "custom", path: ["userIds"], message: "must name someone when participants can open it" });
  }
});
export type CanvasAudienceUpdate = z.infer<typeof CanvasAudienceUpdateSchema>;

const TimestampSchema = z.string().datetime({ offset: true });

/** One Canvas's directory row, as every reader of it sees it. */
export const CanvasSummarySchema = z.object({
  id: CanvasIdSchema,
  title: z.string().max(300),
  createdByUserId: UserIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastEditor: CanvasEditorSchema.nullable(),
  /** The Sidekick that writes this Canvas, when a run made it. */
  writerSidekickId: IdSchema.nullable(),
  visibility: CanvasVisibilitySchema,
});
export type CanvasSummary = z.infer<typeof CanvasSummarySchema>;

/** What one of a Canvas's artifacts is: a file of any type, a site Rally serves, or an archive. */
export const CanvasArtifactKindSchema = z.enum(["file", "site", "archive"]);
export type CanvasArtifactKind = z.infer<typeof CanvasArtifactKindSchema>;

/** One artifact a Canvas's conversation generated, at its current version. */
export const CanvasArtifactSchema = z.object({
  resourceId: IdSchema,
  title: z.string(),
  mimeType: z.string().nullable(),
  kind: CanvasArtifactKindSchema,
  version: z.number().int().positive(),
  updatedAt: TimestampSchema,
});
export type CanvasArtifact = z.infer<typeof CanvasArtifactSchema>;

/** A Canvas as the person opening it sees it: its row, who it is shared with, and its artifacts newest first. */
export const CanvasDetailSchema = CanvasSummarySchema.extend({
  /** Everyone on the participant list besides the creator, guests among them. */
  participantUserIds: z.array(UserIdSchema),
  artifacts: z.array(CanvasArtifactSchema),
  /** This viewer may change who can open it (`canvasManages`). */
  canManage: z.boolean(),
});
export type CanvasDetail = z.infer<typeof CanvasDetailSchema>;

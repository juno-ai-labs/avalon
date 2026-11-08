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
  /**
   * `naming` while a Canvas made with no title waits for the title its
   * opening message gives it; `settled` after, or once a person retitles it.
   * Absent from an older Worker, and reads as `settled`.
   */
  titleStatus: z.enum(["naming", "settled"]).optional(),
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
  /**
   * The requests to open it that wait on a decision, oldest first. Present
   * only for a viewer who decides them (`canManage`); absent for everyone
   * else, and from a server older than access requests.
   */
  pendingAccessRequests: z.array(z.object({
    userId: IdSchema,
    name: z.string(),
    message: z.string().nullable(),
    requestedAt: TimestampSchema,
  })).optional(),
});
export type CanvasDetail = z.infer<typeof CanvasDetailSchema>;

/**
 * One Canvas's row in a viewer's sidebar: its summary, what its newest
 * artifact is, whether it holds something this viewer has not read (its
 * Chat's read state, or an artifact version made since they last read it),
 * who is in it now, where the viewer pinned it, and whether it is in their
 * list only because someone shared it with them. The home page's groups are
 * these fields: live now (`presentUserIds`), from Sidekicks
 * (`writerSidekickId`), shared with me (`sharedWithMe`), made by me
 * (`createdByUserId`).
 */
export const CanvasSidebarRowSchema = CanvasSummarySchema.extend({
  artifactKind: CanvasArtifactKindSchema.nullable(),
  unread: z.boolean(),
  presentUserIds: z.array(UserIdSchema),
  /** Its place in the viewer's Pinned group; null when it is not pinned. */
  pinnedPosition: z.number().int().nonnegative().nullable(),
  sharedWithMe: z.boolean(),
});
export type CanvasSidebarRow = z.infer<typeof CanvasSidebarRowSchema>;

/** The Canvas list as one viewer sees it, at the list's waterline, most recently active first. */
export const CanvasSidebarListSchema = z.strictObject({
  waterline: z.number().int().nonnegative(),
  items: z.array(CanvasSidebarRowSchema).max(250),
});
export type CanvasSidebarList = z.infer<typeof CanvasSidebarListSchema>;

/**
 * The workspace socket's push of a viewer's Canvas list after something in it
 * moved. Its own event type rather than a third member of
 * `WorkspaceSidebarListEventSchema`, because a released client fails a
 * discriminator value it does not know but ignores an event type it does not
 * know (`isUnknownSocketEvent`).
 */
export const WorkspaceCanvasListEventSchema = z.strictObject({
  type: z.literal("workspace_canvas_list"),
  occurredAt: TimestampSchema,
  waterline: z.number().int().positive(),
  items: z.array(CanvasSidebarRowSchema).max(250),
});
export type WorkspaceCanvasListEvent = z.infer<typeof WorkspaceCanvasListEventSchema>;

/**
 * `POST /canvases`: a new Canvas with no artifacts. `canvasId` is an id the
 * caller minted: a retried create that names it again answers the Canvas the
 * first made, for its creator only (`canvas_id_unavailable` otherwise, or when
 * another conversation has the id). Without one each create makes a Canvas.
 * `prompt` is the "Start from a prompt" card's first message, sent to its
 * Chat as the creator's; `clientMessageId` makes a retry into the same Canvas
 * send it once.
 */
export const CreateCanvasRequestSchema = z.strictObject({
  canvasId: CanvasIdSchema.optional(),
  title: z.string().trim().max(300).optional(),
  prompt: z.strictObject({
    text: z.string().trim().min(1),
    clientMessageId: z.string().min(1).max(120),
  }).optional(),
});
export type CreateCanvasRequest = z.infer<typeof CreateCanvasRequestSchema>;

export const CreatedCanvasSchema = z.object({
  canvasId: CanvasIdSchema,
  /** The prompt's turn in the Chat, when one was sent. */
  turnId: z.string().nullable(),
});
export type CreatedCanvas = z.infer<typeof CreatedCanvasSchema>;

/** `POST /canvases/:id/pin` and `POST /automations/:id/pin`: pin in, or out of, the list's Pinned group. */
export const SidebarPinRequestSchema = z.strictObject({ pinned: z.boolean() });

/**
 * `PUT /workspace/pinned-order`: one viewer's order for one list's Pinned
 * group, first to last. Ids not pinned in that list are ignored, and pins the
 * request leaves out keep their order after the ones it names.
 */
export const SidebarPinOrderRequestSchema = z.strictObject({
  kind: z.enum(["canvas", "sidekick"]),
  itemIds: z.array(IdSchema),
});
export type SidebarPinOrderRequest = z.infer<typeof SidebarPinOrderRequestSchema>;

/** `PATCH /canvases/:id`: the Canvas's title. */
export const CanvasRenameRequestSchema = z.strictObject({ title: z.string().trim().min(1).max(300) });
export type CanvasRenameRequest = z.infer<typeof CanvasRenameRequestSchema>;

/**
 * `GET /canvases/:id/access` for a Canvas the caller cannot open: it exists
 * in their Organization and they may ask to be let in. Never its title.
 * `request` is their own latest request, if any: a pending one, or a denied
 * one (which allows a new request). An id that names no Canvas of theirs is
 * `404 canvas_not_found` instead.
 */
export const CanvasAccessSchema = z.strictObject({
  access: z.literal("requestable"),
  title: z.null(),
  request: z.strictObject({
    state: z.enum(["pending", "denied"]),
    requestedAt: TimestampSchema,
  }).nullable(),
});
export type CanvasAccess = z.infer<typeof CanvasAccessSchema>;

/** `POST /canvases/:id/access-requests`: an optional one-line message for whoever decides. */
export const CanvasAccessRequestSchema = z.strictObject({ message: z.string().optional() });
export type CanvasAccessRequest = z.infer<typeof CanvasAccessRequestSchema>;

/**
 * What asking did: `pending`, a request now waits (a second ask while one
 * waits answers the same), or `already_participant`, the Canvas already
 * admits the caller.
 */
export const CanvasAccessRequestResultSchema = z.strictObject({
  status: z.enum(["pending", "already_participant"]),
});
export type CanvasAccessRequestResult = z.infer<typeof CanvasAccessRequestResultSchema>;

/** `POST /canvases/:id/access-requests/:userId/decision`, from a person who decides on the Canvas's participants. */
export const CanvasAccessDecisionRequestSchema = z.strictObject({ decision: z.enum(["approve", "deny"]) });
export type CanvasAccessDecisionRequest = z.infer<typeof CanvasAccessDecisionRequestSchema>;

/** The request's state after the decision; a request someone already settled answers `canvas_access_request_settled`. */
export const CanvasAccessDecisionSchema = z.strictObject({
  state: z.enum(["approved", "denied"]),
});
export type CanvasAccessDecision = z.infer<typeof CanvasAccessDecisionSchema>;

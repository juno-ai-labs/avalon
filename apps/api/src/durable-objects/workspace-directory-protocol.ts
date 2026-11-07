import {
  IdSchema,
  MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER,
  SpaceIdSchema,
  WorkspaceAttentionSchema,
  WorkspaceWorkstreamCursorSchema,
  WorkspaceWorkstreamStateVersionSchema,
  WorkstreamBatchFilterSchema,
  WorkstreamBatchUpdateSchema,
  WorkstreamSchema,
} from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";

const TimestampSchema = z.string().datetime({ offset: true });
const UuidV7Schema = IdSchema.refine((value) => value[14] === "7", "must be UUIDv7");

export const WorkspaceAttentionRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  /** Decides which conversations `readerAttentionCount` may count, as the sidebar's listing does. */
  accessClass: z.enum(["member", "guest"]).optional(),
}));

export const WorkspaceAttentionResultSchema = deferredZodSchema(() => WorkspaceAttentionSchema.strict());

export const WorkspaceDirectoryListRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  limit: z.number().int().min(1).max(250),
  before: WorkspaceWorkstreamCursorSchema.optional(),
  includeSystem: z.boolean(),
}));

export const WorkspaceDirectoryPageSchema = deferredZodSchema(() => z.strictObject({
  // Pins and running connection targets are returned in addition to the
  // requested recent-work page. They remain available without consuming its
  // infinite-scroll cursor budget. Pins have their own product limit, while
  // running rows are intentionally complete rather than hidden behind an
  // invented transport cap, so the combined response has no independent max.
  items: z.array(WorkstreamSchema),
  stateVersions: z.array(WorkspaceWorkstreamStateVersionSchema),
  nextCursor: WorkspaceWorkstreamCursorSchema.nullable(),
  directoryWaterline: z.number().int().nonnegative(),
}).superRefine((page, context) => {
  const itemIds = new Set(page.items.map((item) => item.id));
  const versionIds = new Set(page.stateVersions.map((version) => version.workstreamId));
  if (itemIds.size !== page.items.length
    || versionIds.size !== page.stateVersions.length
    || itemIds.size !== versionIds.size
    || [...itemIds].some((id) => !versionIds.has(id))) {
    context.addIssue({
      code: "custom",
      path: ["stateVersions"],
      message: "must contain exactly one state version for every work stream item",
    });
  }
}));

export const WorkspaceDirectoryVisibilityRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamId: IdSchema,
}));

export const WorkspaceDirectoryReadableIdsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamIds: z.array(IdSchema).min(1).max(100),
}));

/** Complete search prefilter; the bounded readable-ID request is a different RPC. */
export const WorkspaceDirectorySearchableIdsResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(IdSchema),
}));

export const WorkspaceDirectoryReadableIdsResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(IdSchema).max(100),
}));

export const WorkspaceDirectoryBatchTargetsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  filter: WorkstreamBatchFilterSchema,
}));

export const WorkspaceDirectoryBatchTargetsResultSchema = deferredZodSchema(() => z.strictObject({
  // Intentionally uncapped: the public filter may legitimately select the
  // whole sidebar. The regional Worker chunks these ids into 50-message Queue
  // calls, below the platform's 100-message sendBatch maximum, instead of
  // truncating them.
  items: z.array(IdSchema),
  // The notes the same filter selects, resolved here rather than in a second
  // round trip: both sets live in this object, and a preview that fetched them
  // separately would show two counts read at two different instants.
  //
  // Only `archive` applies to these, so a `mark_read` caller reads the field
  // and ignores it. The alternative — teaching this read which update it is
  // for — would make one filter resolution answer differently depending on a
  // mutation it does not perform.
  noteIds: z.array(IdSchema),
}));

const WorkstreamBatchRequestHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);

/** Freeze one generic filtered batch so transport retries cannot widen its target set. */
export const WorkspaceBatchDispatchBeginRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  operationId: IdSchema,
  requestHash: WorkstreamBatchRequestHashSchema,
  filter: WorkstreamBatchFilterSchema,
  /**
   * Which mutation this operation is, so the freeze knows whether the note half
   * has a target set at all. Only `archive` reaches notes.
   */
  update: WorkstreamBatchUpdateSchema,
}));

export const WorkspaceBatchDispatchBeginResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(IdSchema),
  targetCount: z.number().int().nonnegative(),
}));

/** Record one successfully published Queue chunk for a frozen generic batch. */
export const WorkspaceBatchDispatchAdvanceRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  operationId: IdSchema,
  requestHash: WorkstreamBatchRequestHashSchema,
  workstreamIds: z.array(IdSchema).min(1).max(100),
}));

export const WorkspaceBatchDispatchAdvanceResultSchema = deferredZodSchema(() => z.strictObject({
  remainingCount: z.number().int().nonnegative(),
}));

/**
 * Archive the notes one frozen batch selected, in the object that owns them.
 *
 * Notes take no Queue trip because they are not separate authorities: the rows
 * are in this database, so the whole set is one transaction rather than one
 * event per row. What they do share with the work-stream half is the operation:
 * the dispatch row frozen by `beginWorkstreamBatchDispatch` is the fence, so
 * this must be called after it and a retry of the same operation converges on
 * the count the first call archived rather than sweeping in whatever has since
 * entered the range.
 */
export const WorkspaceBatchNoteArchiveRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  operationId: IdSchema,
  requestHash: WorkstreamBatchRequestHashSchema,
  at: TimestampSchema,
}));

export const WorkspaceBatchNoteArchiveResultSchema = deferredZodSchema(() => z.strictObject({
  archivedNoteCount: z.number().int().nonnegative(),
  /** True when the receipt already existed, so this call archived nothing. */
  replayed: z.boolean(),
}));

export const WorkspaceDirectoryVisibleIdsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  includeSystem: z.boolean(),
  participantsOnly: z.boolean(),
  after: IdSchema.optional(),
  limit: z.number().int().min(1).max(250),
}));

export const WorkspaceDirectoryVisibleIdsPageSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(IdSchema).max(250),
  nextCursor: IdSchema.nullable(),
}));

export const WorkspaceDirectoryPinRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  workstreamId: IdSchema,
  spaceId: SpaceIdSchema,
}));

export const WorkspaceDirectoryReorderPinsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  spaceId: SpaceIdSchema,
  workstreamIds: z.array(IdSchema).max(MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER),
}));

export const WorkspaceDirectoryNotificationRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  userId: IdSchema,
}));

export const WorkspaceDirectoryNotificationStateSchema = deferredZodSchema(() => z.strictObject({
  authorityGeneration: z.number().int().positive(),
  listable: z.boolean(),
  title: z.string().min(1).max(500),
  emailAddress: z.string().email().max(254).nullable(),
}));

export const WorkspaceDirectoryResourceRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  watchedOnly: z.boolean(),
}));

export const WorkspaceDirectoryResourceResultSchema = deferredZodSchema(() => z.strictObject({
  workstreamIds: z.array(IdSchema).max(10_000),
}));

export const WorkspaceDirectoryInternalItemSchema = deferredZodSchema(() => z.strictObject({
  workstreamId: IdSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(10_000),
  scope: z.enum(["personal", "workspace"]),
  state: z.string().min(1).max(80),
  systemKind: z.enum(["digest"]).nullable(),
  lastActivityAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  createdByUserId: IdSchema.nullable(),
}));

export const WorkspaceDirectoryLookupRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  workstreamIds: z.array(IdSchema).min(1).max(250),
}));

export const WorkspaceDirectoryLookupResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(WorkspaceDirectoryInternalItemSchema).max(250),
}));

/**
 * The one resource a shared link names, for the public handoff page's heading.
 * A Breakout names its Channel too, because breakouts are keyed by both.
 */
export const WorkspaceLinkTitleRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("canvas"), canvasId: IdSchema }),
    z.strictObject({ kind: z.literal("sidekick"), sidekickId: IdSchema }),
  ]),
}));
export type WorkspaceLinkTitleRequest = z.infer<typeof WorkspaceLinkTitleRequestSchema>;

export const WorkspaceDirectoryAudienceSchema = deferredZodSchema(() => z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("workspace") }),
  z.strictObject({ scope: z.literal("user"), userId: IdSchema }),
]));

export const WorkspaceDirectoryRecentRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  audience: WorkspaceDirectoryAudienceSchema,
  includeSystem: z.boolean(),
  participantsOnly: z.boolean(),
  limit: z.number().int().min(1).max(250),
}));

export const WorkspaceDirectoryDueRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  kind: z.enum(["terminal", "wakeup"]),
  through: TimestampSchema,
  limit: z.number().int().min(1).max(250),
}));

export const WorkspaceDirectoryScheduleTargetsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
}));

export const WorkspaceDirectoryScheduleTargetsResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    kind: z.enum(["wakeup", "terminal"]),
    workstreamId: IdSchema,
    dueAt: TimestampSchema,
  })).max(20_000),
}));

export const WorkspaceDirectoryResourceAccessRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  userId: IdSchema,
}));

export const WorkspaceDirectoryResourceAccessResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    workstreamId: IdSchema,
    scope: z.enum(["personal", "workspace"]),
    createdByUserId: IdSchema.nullable(),
    isParticipant: z.boolean(),
  })).max(10_000),
}));

/**
 * The most directory envelopes one apply RPC accepts. Its callers (the Queue
 * consumer and the outbox drain's legacy rows) send one at a time; a hosted
 * parent's own effects never take this path.
 */
export const MAX_DIRECTORY_APPLY_ENVELOPES = 25;

export const WorkspaceDirectoryApplyRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  envelopes: z.array(ParentEffectEnvelopeSchema).min(1).max(MAX_DIRECTORY_APPLY_ENVELOPES),
}).superRefine((request, context) => {
  for (const [index, envelope] of request.envelopes.entries()) {
    if (envelope.workspaceId !== request.workspaceId) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "workspaceId"],
        message: "Workspace directory effects must target their owning workspace",
      });
    }
    // Two issues, not one. They were a single `||` while there were only two
    // parent kinds and the wrong one could not reach this handoff; a Space
    // publishes the same two directory effects as a Channel, so a refusal that
    // pointed at `effect.kind` would name a field that was correct and send
    // whoever read the log looking at the effect rather than at the parent.
    //
    // `space` is admitted beside `workstream` because both publish the same two
    // effects and WorkspaceDO now has somewhere to put each: the Channel
    // directory and the Space directory. `automation` is not — a Sidekick has
    // its own handoff and its own directory effect.
    if (envelope.parentKind !== "workstream" && envelope.parentKind !== "space") {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "parentKind"],
        message: "Only a work stream's or Space's directory effects may use the WorkspaceDO handoff",
      });
    }
    if (!["directory_common", "directory_user"].includes(envelope.effect.kind)) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "effect", "kind"],
        message: "Only directory effects may use the WorkspaceDO handoff",
      });
    }
    // A breakout's own projection names the breakout; a Channel's aggregate
    // names nothing, because it already *is* the conversation the row is
    // about. `"0"` is the main conversation, whose projection is exactly what
    // the aggregate is built from — an envelope carrying it would be asking
    // the Organization to store the Channel twice, once as a Channel and once
    // as its own breakout. A Space has no breakout anything draws, so its
    // handoff carries no substream id either.
    if (envelope.substreamId !== undefined
      && (envelope.parentKind !== "workstream" || envelope.substreamId === "0")) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "substreamId"],
        message: "Only a Channel's non-main conversation may name itself on the WorkspaceDO handoff",
      });
    }
    if ((envelope.effect.kind === "directory_common" || envelope.effect.kind === "directory_user")
      && !UuidV7Schema.safeParse(envelope.messageId).success) {
      context.addIssue({
        code: "custom",
        path: ["envelopes", index, "messageId"],
        message: "Directory state source identities must be UUIDv7",
      });
    }
  }
}));

export const WorkspaceDirectoryApplyResultSchema = deferredZodSchema(() => z.strictObject({
  accepted: z.array(z.strictObject({
    messageId: z.string().min(1).max(500),
    payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  })).max(25),
  directoryChanged: z.boolean(),
}));

/**
 * One Channel or Space parent's activity/mention effect, applied with its receipt in a
 * single WorkspaceDO transaction. Current member/user identity crosses the
 * boundary as data: the regional caller resolves it from D1 and the object
 * commits only what it was handed, so the effect and its idempotency receipt
 * can never land in different authorities.
 */
export const WorkspaceRegionalEffectApplyRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  envelope: ParentEffectEnvelopeSchema,
  actorUserId: IdSchema.nullable(),
  targetUserIds: z.array(IdSchema).max(100),
  recipientIsActiveMember: z.boolean(),
}).superRefine((request, context) => {
  if (request.envelope.workspaceId !== request.workspaceId) {
    context.addIssue({
      code: "custom",
      path: ["envelope", "workspaceId"],
      message: "Workstream regional effects must target their owning workspace",
    });
  }
  if (!["activity_event", "mention_notification", "participant_notification"]
    .includes(request.envelope.effect.kind)) {
    context.addIssue({
      code: "custom",
      path: ["envelope", "effect", "kind"],
      message: "Only activity and person-notification effects may use the regional apply handoff",
    });
  }
}));

export const WorkspaceRegionalEffectApplyResultSchema = deferredZodSchema(() => z.strictObject({
  replayed: z.boolean(),
  notificationIntentId: z.string().min(1).max(300).nullable(),
}));

export type WorkspaceDirectoryListRequest = z.infer<typeof WorkspaceDirectoryListRequestSchema>;
export type WorkspaceAttentionRequest = z.infer<typeof WorkspaceAttentionRequestSchema>;
export type WorkspaceAttentionResult = z.infer<typeof WorkspaceAttentionResultSchema>;
export type WorkspaceDirectoryPage = z.infer<typeof WorkspaceDirectoryPageSchema>;
export type WorkspaceDirectoryVisibilityRequest = z.infer<typeof WorkspaceDirectoryVisibilityRequestSchema>;
export type WorkspaceDirectoryReadableIdsRequest = z.infer<typeof WorkspaceDirectoryReadableIdsRequestSchema>;
export type WorkspaceDirectoryBatchTargetsRequest = z.infer<typeof WorkspaceDirectoryBatchTargetsRequestSchema>;
export type WorkspaceBatchDispatchBeginRequest = z.infer<typeof WorkspaceBatchDispatchBeginRequestSchema>;
export type WorkspaceBatchDispatchAdvanceRequest = z.infer<typeof WorkspaceBatchDispatchAdvanceRequestSchema>;
export type WorkspaceBatchNoteArchiveRequest = z.infer<typeof WorkspaceBatchNoteArchiveRequestSchema>;
export type WorkspaceBatchNoteArchiveResult = z.infer<typeof WorkspaceBatchNoteArchiveResultSchema>;
export type WorkspaceDirectoryReadableIdsResult = z.infer<typeof WorkspaceDirectoryReadableIdsResultSchema>;
export type WorkspaceDirectoryVisibleIdsRequest = z.infer<typeof WorkspaceDirectoryVisibleIdsRequestSchema>;
export type WorkspaceDirectoryVisibleIdsPage = z.infer<typeof WorkspaceDirectoryVisibleIdsPageSchema>;
export type WorkspaceDirectoryPinRequest = z.infer<typeof WorkspaceDirectoryPinRequestSchema>;
export type WorkspaceDirectoryReorderPinsRequest = z.infer<typeof WorkspaceDirectoryReorderPinsRequestSchema>;
export type WorkspaceDirectoryNotificationRequest = z.infer<typeof WorkspaceDirectoryNotificationRequestSchema>;
export type WorkspaceDirectoryNotificationState = z.infer<typeof WorkspaceDirectoryNotificationStateSchema>;
export type WorkspaceDirectoryResourceRequest = z.infer<typeof WorkspaceDirectoryResourceRequestSchema>;
export type WorkspaceDirectoryResourceResult = z.infer<typeof WorkspaceDirectoryResourceResultSchema>;
export type WorkspaceDirectoryLookupRequest = z.infer<typeof WorkspaceDirectoryLookupRequestSchema>;
export type WorkspaceDirectoryLookupResult = z.infer<typeof WorkspaceDirectoryLookupResultSchema>;
export type WorkspaceDirectoryRecentRequest = z.infer<typeof WorkspaceDirectoryRecentRequestSchema>;
export type WorkspaceDirectoryDueRequest = z.infer<typeof WorkspaceDirectoryDueRequestSchema>;
export type WorkspaceDirectoryScheduleTargetsRequest = z.infer<typeof WorkspaceDirectoryScheduleTargetsRequestSchema>;
export type WorkspaceDirectoryScheduleTargetsResult = z.infer<typeof WorkspaceDirectoryScheduleTargetsResultSchema>;
export type WorkspaceDirectoryResourceAccessRequest = z.infer<typeof WorkspaceDirectoryResourceAccessRequestSchema>;
export type WorkspaceDirectoryResourceAccessResult = z.infer<typeof WorkspaceDirectoryResourceAccessResultSchema>;
export type WorkspaceDirectoryApplyRequest = z.infer<typeof WorkspaceDirectoryApplyRequestSchema>;
export type WorkspaceDirectoryApplyResult = z.infer<typeof WorkspaceDirectoryApplyResultSchema>;
export type WorkspaceRegionalEffectApplyRequest = z.infer<typeof WorkspaceRegionalEffectApplyRequestSchema>;
export type WorkspaceRegionalEffectApplyResult = z.infer<typeof WorkspaceRegionalEffectApplyResultSchema>;

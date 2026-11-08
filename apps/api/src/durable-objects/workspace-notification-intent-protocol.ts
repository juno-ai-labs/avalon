import { UserIdSchema, WorkspaceIdSchema, WorkstreamIdSchema } from "@rally/contracts";
import { z } from "zod";

const NotificationIntentIdSchema = z.string().min(1).max(300);

export const WorkspaceNotificationIntentKindSchema = z.enum(["mention", "participant_added", "needs_input", "run_finished",
  "new_message", "artifact_updated", "access_request", "access_granted"]);

/**
 * What a hosted parent's own notice stores on its intent: everything the push
 * renders, captured when it was recorded, so a later rename or a newer reply
 * does not rewrite a notice already queued. Each one is about a Canvas or a
 * Sidekick (`parentId`), which the push links to and the consumer checks the
 * recipient may still open. `docs/push-notifications.md` owns the kinds.
 */
export const ParentNoticeSchema = z.discriminatedUnion("kind", [
  /** A person's message in a Canvas's Chat or a Sidekick's shared conversation, the newest of a batch. */
  z.strictObject({
    kind: z.literal("new_message"),
    parentId: z.string().min(1),
    parentTitle: z.string(),
    messageId: z.string().min(1),
    authorName: z.string(),
    text: z.string(),
  }),
  /** A new version of an artifact in a Canvas the recipient pinned. */
  z.strictObject({
    kind: z.literal("artifact_updated"),
    parentId: z.string().min(1),
    parentTitle: z.string(),
    resourceId: z.string().min(1),
    artifactTitle: z.string(),
    authorName: z.string(),
  }),
  /** Somebody asked to open a Canvas the recipient decides on. */
  z.strictObject({
    kind: z.literal("access_request"),
    parentId: z.string().min(1),
    parentTitle: z.string(),
    requestId: z.string().min(1),
    requesterName: z.string(),
    message: z.string().nullable(),
  }),
  /** The recipient's request to open a Canvas was let in. */
  z.strictObject({
    kind: z.literal("access_granted"),
    parentId: z.string().min(1),
    parentTitle: z.string(),
    requestId: z.string().min(1),
    deciderName: z.string(),
  }),
]);
export type ParentNotice = z.infer<typeof ParentNoticeSchema>;
export const WorkspaceNotificationIntentStateSchema = z.enum([
  "pending",
  "processing",
  "delivered",
  "skipped",
  "failed",
]);

export const WorkspaceNotificationIntentRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  intentId: NotificationIntentIdSchema,
});

const WorkspaceNotificationIntentSummarySchema = z.strictObject({
  intentId: NotificationIntentIdSchema,
  workstreamId: WorkstreamIdSchema,
  recipientUserId: UserIdSchema,
  notificationKind: WorkspaceNotificationIntentKindSchema,
  state: WorkspaceNotificationIntentStateSchema,
});

export const WorkspaceNotificationIntentClaimedSchema = WorkspaceNotificationIntentSummarySchema.extend({
  workspaceId: WorkspaceIdSchema,
  sourceGeneration: z.number().int().positive(),
  payloadJson: z.string().min(1),
  state: z.literal("processing"),
}).strict();

export const WorkspaceNotificationIntentDeliverySchema = WorkspaceNotificationIntentClaimedSchema.omit({ state: true });
export type WorkspaceNotificationIntentDelivery = z.infer<typeof WorkspaceNotificationIntentDeliverySchema>;

export const WorkspaceNotificationIntentClaimResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    leaseId: z.string().uuid(),
    intent: WorkspaceNotificationIntentClaimedSchema,
  }),
  z.strictObject({
    outcome: z.literal("terminal"),
    intent: WorkspaceNotificationIntentSummarySchema.extend({
      state: z.enum(["delivered", "skipped"]),
    }).strict(),
  }),
  z.strictObject({
    outcome: z.literal("busy"),
    intent: WorkspaceNotificationIntentSummarySchema,
  }),
  z.strictObject({ outcome: z.literal("missing") }),
]);

const WorkspaceNotificationIntentTransitionBaseSchema = WorkspaceNotificationIntentRequestSchema.extend({
  leaseId: z.string().uuid(),
}).strict();

export const WorkspaceNotificationIntentTransitionRequestSchema = z.discriminatedUnion(
  "transition",
  [
    WorkspaceNotificationIntentTransitionBaseSchema.extend({
      transition: z.literal("defer"),
      errorCode: z.string().min(1).max(200),
    }).strict(),
    WorkspaceNotificationIntentTransitionBaseSchema.extend({
      transition: z.literal("fail"),
      errorCode: z.string().min(1).max(200),
    }).strict(),
    WorkspaceNotificationIntentTransitionBaseSchema.extend({
      transition: z.literal("settle"),
      retainPayload: z.boolean().optional(),
      state: z.enum(["delivered", "skipped"]),
    }).strict(),
  ],
);

export const WorkspaceNotificationIntentTransitionResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("applied"), intentId: NotificationIntentIdSchema }),
  z.strictObject({ outcome: z.literal("missing") }),
  z.strictObject({
    outcome: z.literal("lease_lost"),
    state: WorkspaceNotificationIntentStateSchema,
  }),
]);

export const WorkspaceNotificationIntentMaintenanceRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
});

export const WorkspaceNotificationIntentMaintenanceTargetSchema = z.strictObject({
  dueAt: z.string().datetime().nullable(),
});

export const WorkspaceNotificationIntentReapRequestSchema =
  WorkspaceNotificationIntentMaintenanceRequestSchema.extend({
    limit: z.number().int().min(1).max(1_000).default(500),
  }).strict();

export const WorkspaceNotificationIntentReapResultSchema = z.strictObject({
  reapedIntentIds: z.array(NotificationIntentIdSchema),
});

export type WorkspaceNotificationIntentRequest = z.infer<
  typeof WorkspaceNotificationIntentRequestSchema
>;
export type WorkspaceNotificationIntentClaimResult = z.infer<
  typeof WorkspaceNotificationIntentClaimResultSchema
>;
export type WorkspaceNotificationIntentTransitionRequest = z.infer<
  typeof WorkspaceNotificationIntentTransitionRequestSchema
>;
export type WorkspaceNotificationIntentTransitionResult = z.infer<
  typeof WorkspaceNotificationIntentTransitionResultSchema
>;
export type WorkspaceNotificationIntentMaintenanceRequest = z.infer<
  typeof WorkspaceNotificationIntentMaintenanceRequestSchema
>;
export type WorkspaceNotificationIntentMaintenanceTarget = z.infer<
  typeof WorkspaceNotificationIntentMaintenanceTargetSchema
>;
export type WorkspaceNotificationIntentReapRequest = z.infer<
  typeof WorkspaceNotificationIntentReapRequestSchema
>;
export type WorkspaceNotificationIntentReapResult = z.infer<
  typeof WorkspaceNotificationIntentReapResultSchema
>;

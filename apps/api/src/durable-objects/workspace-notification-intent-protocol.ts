import { UserIdSchema, WorkspaceIdSchema, WorkstreamIdSchema } from "@rally/contracts";
import { z } from "zod";

const NotificationIntentIdSchema = z.string().min(1).max(300);

export const WorkspaceNotificationIntentKindSchema = z.enum(["mention", "participant_added", "needs_input", "run_finished"]);
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
  requiredDirectoryVersion: z.number().int().positive(),
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

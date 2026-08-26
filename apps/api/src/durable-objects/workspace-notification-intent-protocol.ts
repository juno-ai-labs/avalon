import { UserIdSchema, WorkspaceIdSchema, WorkstreamIdSchema } from "@rally/contracts";
import { z } from "zod";

const NotificationIntentIdSchema = z.string().min(1).max(300);

export const WorkspaceNotificationIntentKindSchema = z.enum(["mention", "participant_added"]);
export const WorkspaceNotificationIntentStateSchema = z.enum([
  "pending",
  "processing",
  "delivered",
  "skipped",
  "failed",
]);

export const WorkspaceNotificationIntentRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  intentId: NotificationIntentIdSchema,
}).strict();

const WorkspaceNotificationIntentSummarySchema = z.object({
  intentId: NotificationIntentIdSchema,
  workstreamId: WorkstreamIdSchema,
  recipientUserId: UserIdSchema,
  notificationKind: WorkspaceNotificationIntentKindSchema,
  state: WorkspaceNotificationIntentStateSchema,
}).strict();

const WorkspaceNotificationIntentClaimedSchema = WorkspaceNotificationIntentSummarySchema.extend({
  workspaceId: WorkspaceIdSchema,
  sourceGeneration: z.number().int().positive(),
  requiredDirectoryVersion: z.number().int().positive(),
  payloadJson: z.string().min(1),
}).strict();

export const WorkspaceNotificationIntentClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    leaseId: z.string().uuid(),
    intent: WorkspaceNotificationIntentClaimedSchema,
  }).strict(),
  z.object({
    outcome: z.literal("terminal"),
    intent: WorkspaceNotificationIntentSummarySchema.extend({
      state: z.enum(["delivered", "skipped"]),
    }).strict(),
  }).strict(),
  z.object({
    outcome: z.literal("busy"),
    intent: WorkspaceNotificationIntentSummarySchema,
  }).strict(),
  z.object({ outcome: z.literal("missing") }).strict(),
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
      state: z.enum(["delivered", "skipped"]),
    }).strict(),
  ],
);

export const WorkspaceNotificationIntentTransitionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("applied"), intentId: NotificationIntentIdSchema }).strict(),
  z.object({ outcome: z.literal("missing") }).strict(),
  z.object({
    outcome: z.literal("lease_lost"),
    state: WorkspaceNotificationIntentStateSchema,
  }).strict(),
]);

export const WorkspaceNotificationIntentMaintenanceRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
}).strict();

export const WorkspaceNotificationIntentMaintenanceTargetSchema = z.object({
  dueAt: z.string().datetime().nullable(),
}).strict();

export const WorkspaceNotificationIntentReapRequestSchema =
  WorkspaceNotificationIntentMaintenanceRequestSchema.extend({
    limit: z.number().int().min(1).max(1_000).default(500),
  }).strict();

export const WorkspaceNotificationIntentReapResultSchema = z.object({
  reapedIntentIds: z.array(NotificationIntentIdSchema),
}).strict();

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

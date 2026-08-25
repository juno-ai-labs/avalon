import { IdSchema, NormalizedActivitySchema, RegionSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

export const WorkspaceConnectorEventSchema = z.object({
  connectorType: z.string().min(1).max(120),
  activity: NormalizedActivitySchema,
}).strict();

export const WorkspaceConnectorEventIngestRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  ingressEventId: IdSchema,
  payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  event: WorkspaceConnectorEventSchema,
}).strict().superRefine((value, context) => {
  if (value.event.activity.id !== value.ingressEventId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The ingress event identity must match the activity identity",
      path: ["ingressEventId"],
    });
  }
  if (value.event.activity.workspaceId !== value.workspaceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The event must belong to the target workspace",
      path: ["workspaceId"],
    });
  }
});

/**
 * Queue handoff used after WorkspaceDO cutover. The normalized event travels
 * with the message; regional D1 is not an event-body staging database.
 */
export const WorkspaceConnectorEventQueueMessageSchema = z.object({
  kind: z.literal("workspace_connector_event"),
  region: RegionSchema,
  attempt: z.number().int().min(0).max(5).default(0),
  request: WorkspaceConnectorEventIngestRequestSchema,
}).strict();

export const WorkspaceConnectorEventIngestResultSchema = z.object({
  eventId: IdSchema,
  duplicate: z.boolean(),
  processingStatus: z.enum(["pending", "processing", "processed", "failed"]),
  processingAttempt: z.number().int().min(-1).max(5),
}).strict();

export const WorkspaceConnectorEventRequestSchema = z.object({
  workspaceId: IdSchema,
  eventId: IdSchema,
}).strict();

export const WorkspaceConnectorEventClaimRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  workflowInstanceId: z.string().min(1).max(100),
  attempt: z.number().int().min(0).max(5),
}).strict();

export const WorkspaceConnectorEventClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    event: WorkspaceConnectorEventSchema,
  }).strict(),
  z.object({ outcome: z.literal("processed") }).strict(),
  z.object({ outcome: z.literal("busy") }).strict(),
]);

export const WorkspaceConnectorEventSettleRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  workflowInstanceId: z.string().min(1).max(100),
  outcome: z.enum(["processed", "failed"]),
  error: z.string().max(1_000).nullable(),
}).strict();

export const ConnectorEventWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  eventId: IdSchema,
  workflowInstanceId: z.string().min(1).max(100),
  attempt: z.number().int().min(0).max(5),
}).strict();

export type WorkspaceConnectorEvent = z.infer<typeof WorkspaceConnectorEventSchema>;
export type WorkspaceConnectorEventIngestRequest = z.infer<typeof WorkspaceConnectorEventIngestRequestSchema>;
export type WorkspaceConnectorEventIngestResult = z.infer<typeof WorkspaceConnectorEventIngestResultSchema>;
export type WorkspaceConnectorEventQueueMessage = z.infer<typeof WorkspaceConnectorEventQueueMessageSchema>;
export type WorkspaceConnectorEventRequest = z.infer<typeof WorkspaceConnectorEventRequestSchema>;
export type WorkspaceConnectorEventClaimRequest = z.infer<typeof WorkspaceConnectorEventClaimRequestSchema>;
export type WorkspaceConnectorEventClaimResult = z.infer<typeof WorkspaceConnectorEventClaimResultSchema>;
export type WorkspaceConnectorEventSettleRequest = z.infer<typeof WorkspaceConnectorEventSettleRequestSchema>;
export type ConnectorEventWorkflowInput = z.infer<typeof ConnectorEventWorkflowInputSchema>;

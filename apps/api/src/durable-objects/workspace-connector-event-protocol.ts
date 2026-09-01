import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { IdSchema, NormalizedActivitySchema, RegionSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod/v3";

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
 * Connector processing deliberately uses two message shapes on the same Queue.
 * This ingress shape carries the bounded normalized event exactly until
 * WorkspaceDO commits it; regional D1 is not an event-body staging database.
 * After that commit, retries use the content-free process shape below and load
 * the canonical event through the claim RPC. Do not add another event copy to
 * that shape: it would be stale or non-authoritative, would save no object RPC,
 * and would retain provider content through processing retries and in the DLQ.
 */
export const WorkspaceConnectorEventQueueMessageSchema = z.object({
  kind: z.literal("workspace_connector_event"),
  region: RegionSchema,
  attempt: z.number().int().safe().min(0).max(5).default(0),
  request: WorkspaceConnectorEventIngestRequestSchema,
}).strict();

/** Content-free processing wake-up; see the two-stage authority contract above. */
export const WorkspaceConnectorEventProcessQueueMessageSchema = z.object({
  kind: z.literal("connector_event_process"),
  schemaVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  eventId: IdSchema,
  processingOwnerId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  processingAttempt: z.number().int().safe().min(0).max(5),
}).strict();

export const WorkspaceConnectorEventIngestResultSchema = z.object({
  eventId: IdSchema,
  duplicate: z.boolean(),
  processingStatus: z.enum(["pending", "processing", "processed", "failed"]),
  processingAttempt: z.number().int().safe().min(-1).max(5),
}).strict();

export const WorkspaceConnectorEventRequestSchema = z.object({
  workspaceId: IdSchema,
  eventId: IdSchema,
}).strict();

export const WorkspaceConnectorEventClaimRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  processingOwnerId: z.string().min(1).max(100),
  attempt: z.number().int().safe().min(0).max(5),
  orchestrator: z.enum(["queue", "workflow"]).default("workflow"),
}).strict();

/**
 * Frozen wire shape emitted by ConnectorEventWorkflow versions deployed before
 * Queue-native processing. Keep it distinct from the current RPC contract: an
 * old Workflow also strictly parses the smaller legacy response below.
 */
export const LegacyWorkspaceConnectorEventClaimRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  workflowInstanceId: z.string().min(1).max(100),
  attempt: z.number().int().safe().min(0).max(5),
}).strict();

export const WorkspaceConnectorEventClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    event: WorkspaceConnectorEventSchema,
    processingLeaseId: z.string().min(1).max(100),
    processingLeaseExpiresAt: z.number().int().safe().nonnegative().nullable(),
  }).strict(),
  z.object({ outcome: z.literal("processed") }).strict(),
  z.object({
    outcome: z.literal("busy"),
    reason: z.enum([
      "active_lease_not_expired",
      "legacy_workflow_active",
      "failed_attempt_not_advanced",
    ]),
    retryAt: z.number().int().safe().nonnegative().nullable(),
  }).strict(),
]);

export const LegacyWorkspaceConnectorEventClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    event: WorkspaceConnectorEventSchema,
  }).strict(),
  z.object({ outcome: z.literal("processed") }).strict(),
  z.object({ outcome: z.literal("busy") }).strict(),
]);

export const WorkspaceConnectorEventClaimRpcRequestSchema = z.union([
  WorkspaceConnectorEventClaimRequestSchema,
  LegacyWorkspaceConnectorEventClaimRequestSchema,
]);

export const WorkspaceConnectorEventSettleRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  processingOwnerId: z.string().min(1).max(100),
  // Optional only for Workflow instances whose persisted claim step predates
  // Queue leases. New Queue and Workflow callers always send the returned lease.
  processingLeaseId: z.string().min(1).max(100).optional(),
  outcome: z.enum(["processed", "failed"]),
  error: z.string().max(1_000).nullable(),
}).strict();

export const LegacyWorkspaceConnectorEventSettleRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  workflowInstanceId: z.string().min(1).max(100),
  outcome: z.enum(["processed", "failed"]),
  error: z.string().max(1_000).nullable(),
}).strict();

export const WorkspaceConnectorEventSettleRpcRequestSchema = z.union([
  WorkspaceConnectorEventSettleRequestSchema,
  LegacyWorkspaceConnectorEventSettleRequestSchema,
]);

export const ConnectorEventWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  eventId: IdSchema,
  workflowInstanceId: z.string().min(1).max(100),
  attempt: z.number().int().safe().min(0).max(5),
}).strict();

export type WorkspaceConnectorEvent = z.infer<typeof WorkspaceConnectorEventSchema>;
export type WorkspaceConnectorEventIngestRequest = z.infer<typeof WorkspaceConnectorEventIngestRequestSchema>;
export type WorkspaceConnectorEventIngestResult = z.infer<typeof WorkspaceConnectorEventIngestResultSchema>;
export type WorkspaceConnectorEventQueueMessage = z.infer<typeof WorkspaceConnectorEventQueueMessageSchema>;
export type WorkspaceConnectorEventProcessQueueMessage = z.infer<
  typeof WorkspaceConnectorEventProcessQueueMessageSchema
>;
export type WorkspaceConnectorEventRequest = z.infer<typeof WorkspaceConnectorEventRequestSchema>;
export type WorkspaceConnectorEventClaimRequest = z.infer<typeof WorkspaceConnectorEventClaimRequestSchema>;
export type WorkspaceConnectorEventClaimResult = z.infer<typeof WorkspaceConnectorEventClaimResultSchema>;
export type LegacyWorkspaceConnectorEventClaimRequest = z.infer<
  typeof LegacyWorkspaceConnectorEventClaimRequestSchema
>;
export type LegacyWorkspaceConnectorEventClaimResult = z.infer<
  typeof LegacyWorkspaceConnectorEventClaimResultSchema
>;
export type WorkspaceConnectorEventClaimRpcRequest = z.infer<
  typeof WorkspaceConnectorEventClaimRpcRequestSchema
>;
export type WorkspaceConnectorEventClaimRpcResult =
  | WorkspaceConnectorEventClaimResult
  | LegacyWorkspaceConnectorEventClaimResult;
export type WorkspaceConnectorEventSettleRequest = z.infer<typeof WorkspaceConnectorEventSettleRequestSchema>;
export type LegacyWorkspaceConnectorEventSettleRequest = z.infer<
  typeof LegacyWorkspaceConnectorEventSettleRequestSchema
>;
export type WorkspaceConnectorEventSettleRpcRequest = z.infer<
  typeof WorkspaceConnectorEventSettleRpcRequestSchema
>;
export type ConnectorEventWorkflowInput = z.infer<typeof ConnectorEventWorkflowInputSchema>;

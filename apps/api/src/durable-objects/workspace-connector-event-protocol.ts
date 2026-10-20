import { IdSchema, NormalizedActivitySchema, RegionSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

export const WorkspaceConnectorEventSchema = z.strictObject({
  connectorType: z.string().min(1).max(120),
  activity: NormalizedActivitySchema.superRefine((activity, context) => {
    // Mirror existing canonical SQLite column constraints before Queue acceptance.
    // These are storage limits, not a new connector payload policy.
    const fields = {
      actor: [JSON.stringify(activity.actor), 262144],
      subject: [JSON.stringify(activity.subject), 262144],
      metadata: [JSON.stringify(activity.metadata), 524288],
      summary: [activity.summary, 65536],
      visibility: [JSON.stringify(activity.visibility), 262144],
      targetUserIds: [JSON.stringify(activity.targetUserIds), 262144],
      entityKeys: [JSON.stringify(activity.entityKeys), 262144],
    } as const;
    for (const [field, [value, maximum]] of Object.entries(fields)) {
      // SQLite length counts Unicode code points rather than UTF-16 units.
      if ([...value].length > maximum) context.addIssue({
        code: "too_big", origin: "string", maximum, inclusive: true, path: [field],
      });
    }
  }),
});

export const WorkspaceConnectorEventIngestRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  ingressEventId: IdSchema,
  payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  event: WorkspaceConnectorEventSchema,
}).superRefine((value, context) => {
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
export const WorkspaceConnectorEventQueueMessageSchema = z.strictObject({
  kind: z.literal("workspace_connector_event"),
  region: RegionSchema,
  attempt: z.number().int().min(0).max(5).default(0),
  request: WorkspaceConnectorEventIngestRequestSchema,
});

/** Content-free processing wake-up; see the two-stage authority contract above. */
export const WorkspaceConnectorEventProcessQueueMessageSchema = z.strictObject({
  kind: z.literal("connector_event_process"),
  schemaVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  eventId: IdSchema,
  processingOwnerId: z.string().uuid(),
  processingAttempt: z.number().int().min(0).max(5),
});

export const WorkspaceConnectorEventIngestResultSchema = z.strictObject({
  eventId: IdSchema,
  duplicate: z.boolean(),
  processingStatus: z.enum(["pending", "processing", "processed", "failed"]),
  processingAttempt: z.number().int().min(-1).max(5),
  // Present when the event said nothing its resource's latest event had not:
  // `eventId` is that earlier event, whose own admission owns its processing.
  unchangedContent: z.literal(true).optional(),
  // A dropped repeat this late, different event showed to be news, stored now
  // as its own event and still to be processed.
  restoredEventId: IdSchema.optional(),
});

export const WorkspaceConnectorEventRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  eventId: IdSchema,
});

export const WorkspaceConnectorEventClaimRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  processingOwnerId: z.string().min(1).max(100),
  attempt: z.number().int().min(0).max(5),
  orchestrator: z.enum(["queue", "workflow"]).default("workflow"),
}).strict();

/**
 * Frozen wire shape emitted by ConnectorEventWorkflow versions deployed before
 * Queue-native processing. Keep it distinct from the current RPC contract: an
 * old Workflow also strictly parses the smaller legacy response below.
 */
export const LegacyWorkspaceConnectorEventClaimRequestSchema = WorkspaceConnectorEventRequestSchema.extend({
  workflowInstanceId: z.string().min(1).max(100),
  attempt: z.number().int().min(0).max(5),
}).strict();

export const WorkspaceConnectorEventClaimResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    event: WorkspaceConnectorEventSchema,
    processingLeaseId: z.string().min(1).max(100),
    processingLeaseExpiresAt: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({ outcome: z.literal("processed") }),
  z.strictObject({
    outcome: z.literal("busy"),
    reason: z.enum([
      "active_lease_not_expired",
      "legacy_workflow_active",
      "failed_attempt_not_advanced",
    ]),
    retryAt: z.number().int().nonnegative().nullable(),
  }),
]);

export const LegacyWorkspaceConnectorEventClaimResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    event: WorkspaceConnectorEventSchema,
  }),
  z.strictObject({ outcome: z.literal("processed") }),
  z.strictObject({ outcome: z.literal("busy") }),
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
  // The code the settler derived from its failure, for the terminal row.
  // `error` is the message a person reads and may quote the provider; this
  // is what `diagnosticErrorCode` reduced it to, and it is what the row
  // indexes.
  errorCode: z.string().regex(/^[A-Za-z0-9_:.-]{1,120}$/u).optional(),
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

export const ConnectorEventWorkflowInputSchema = z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  eventId: IdSchema,
  workflowInstanceId: z.string().min(1).max(100),
  attempt: z.number().int().min(0).max(5),
});

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

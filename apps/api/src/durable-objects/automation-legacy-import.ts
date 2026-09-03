import {
  ActivitySourcePluginIdsSchema,
  AgentModelOverrideSchema,
  AutomationDraftSchema,
  ModelPluginIdSchema,
  ScopeSchema,
} from "@rally/contracts";
import { z } from "zod";

/** The strict payload accepted by AutomationAgent's one-time legacy import. */
export const AutomationLegacyImportSourceSchema = z.strictObject({
  definition: AutomationDraftSchema,
  status: z.enum(["active", "paused", "error"]),
  scope: ScopeSchema,
  unsupportedTrigger: z.boolean(),
  defaultPluginIds: z.array(ModelPluginIdSchema),
  activitySourcePluginIds: ActivitySourcePluginIdsSchema,
  connectorBindings: z.record(z.string(), z.string()),
  emailAddress: z.string().email().nullable(),
  modelOverride: AgentModelOverrideSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  schedules: z.array(z.strictObject({
    scheduleId: z.string().min(1),
    kind: z.enum(["calendar", "interval"]),
    definition: z.record(z.string(), z.unknown()),
    nextDueAt: z.number().int().nonnegative().nullable(),
  })),
  runs: z.array(z.strictObject({
    runId: z.string().uuid(),
    workstreamId: z.string().uuid(),
    triggerType: z.string().min(1),
    plannedFor: z.number().int().nonnegative().nullable(),
    status: z.enum(["scheduled", "running", "needs_input", "completed", "failed"]),
    workflowInstanceId: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })),
  memoryRecords: z.array(z.strictObject({
    kind: z.enum([
      "scope",
      "item",
      "mutation",
      "index_receipt",
      "table",
      "table_column",
      "table_row",
      "table_cell",
      "table_mutation",
    ]),
    recordId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })),
  /** The pre-cutover inbound-email dedupe ledger and its hourly windows. */
  inboundEmailReceipts: z.array(z.strictObject({
    resendEmailId: z.string().min(1),
    svixId: z.string().min(1),
    payloadRef: z.string().min(1).nullable(),
    workstreamId: z.string().uuid().nullable(),
    runId: z.string().uuid().nullable(),
    receivedAt: z.number().int().nonnegative(),
    refused: z.boolean(),
  })).optional(),
  inboundEmailRateWindows: z.array(z.strictObject({
    windowStartedAt: z.number().int().nonnegative(),
    acceptedCount: z.number().int().nonnegative(),
  })).optional(),
});

export const AutomationLegacyImportRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  region: z.enum(["global", "eu"]),
  sourceHash: z.string().min(1),
  source: AutomationLegacyImportSourceSchema,
});

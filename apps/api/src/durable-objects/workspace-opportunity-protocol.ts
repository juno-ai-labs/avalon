import { MAX_EXTERNAL_PEOPLE, deduplicateExternalPeople } from "@rally/contracts";
import { IdSchema, RegionSchema, UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { TELEMETRY_CONNECTOR_TYPES } from "@rally/contracts/telemetry";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

import { WorkspaceConnectorEventSchema } from "./workspace-connector-event-protocol";

export const OpportunityAudienceSchema = deferredZodSchema(() => z.strictObject({
  scope: z.enum(["personal", "workspace"]),
  userId: IdSchema.nullable(),
}).superRefine((value, context) => {
  if ((value.scope === "personal") !== (value.userId !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Opportunity audience is inconsistent" });
  }
}));

export const WorkspaceOpportunityEnqueueRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  partitionKey: z.string().min(1).max(500),
  audience: OpportunityAudienceSchema,
  sourceKind: z.enum(["activity", "message"]),
  sourceId: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  inputCharacters: z.number().int().nonnegative(),
}));

export const WorkspaceOpportunityEnqueueResultSchema = deferredZodSchema(() => z.strictObject({
  windowId: IdSchema,
  processAfter: z.string().datetime(),
  inserted: z.boolean(),
}));

export const WorkspaceOpportunityWorkflowInputSchema = deferredZodSchema(() => z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("admission"),
    region: RegionSchema,
    workspaceId: WorkspaceIdSchema,
    windowId: IdSchema,
    leaseId: IdSchema,
    attempt: z.number().int().min(0).max(5),
  }),
  z.strictObject({
    kind: z.literal("ranking"),
    region: RegionSchema,
    workspaceId: WorkspaceIdSchema,
    userId: UserIdSchema,
    requestSeq: z.number().int().nonnegative(),
    leaseId: IdSchema,
  }),
]));

export const WorkspaceOpportunityWindowRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  windowId: IdSchema,
  leaseId: IdSchema,
}));

export const WorkspaceOpportunityWindowSchema = deferredZodSchema(() => z.strictObject({
  id: IdSchema,
  partitionKey: z.string(),
  audience: OpportunityAudienceSchema,
  firstEventAt: z.string().datetime(),
  lastEventAt: z.string().datetime(),
  events: z.array(z.strictObject({
    id: IdSchema,
    sourceKind: z.enum(["activity", "message"]),
    sourceId: z.string(),
    occurredAt: z.string().datetime(),
    inputCharacters: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
  })).max(5_000),
}));

export const WorkspaceOpportunityBatchEventsRequestSchema = deferredZodSchema(() => WorkspaceOpportunityWindowRequestSchema.unwrap().extend({
  eventIds: z.array(IdSchema).min(1).max(100),
  outcome: z.enum(["processing", "completed", "failed", "missing"]),
  error: z.string().max(1_000).nullable(),
}).strict());

export const WorkspaceOpportunityWindowSettleRequestSchema = deferredZodSchema(() => WorkspaceOpportunityWindowRequestSchema.unwrap().extend({
  retryDelayMs: z.number().int().min(1_000).max(60 * 60_000),
}).strict());

export const WorkspaceOpportunityExistingRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  audience: OpportunityAudienceSchema,
  now: z.string().datetime(),
  limit: z.number().int().min(1).max(100),
}));

export const WorkspaceOpportunitySourceSchema = deferredZodSchema(() => z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(["activity", "message"]),
  provider: z.string().min(1).max(120),
  providerTenantId: z.string().max(500).nullable(),
  connectionId: IdSchema.nullable(),
  title: z.string().max(1_000),
  summary: z.string().max(3_000),
  text: z.string().max(8_000),
  actor: z.record(z.string(), z.unknown()),
  subject: z.record(z.string(), z.unknown()),
  externalPeople: z.array(z.unknown()).transform(deduplicateExternalPeople).pipe(z.array(z.unknown()).max(MAX_EXTERNAL_PEOPLE)),
  entityKeys: z.array(z.string().max(200)).max(20),
  canonicalUrl: z.string().max(2_000).nullable(),
  workstreamId: IdSchema.nullable(),
  occurredAt: z.string().datetime(),
}));

export const WorkspaceOpportunityPersistLinkSchema = deferredZodSchema(() => z.strictObject({
  id: IdSchema,
  sourceId: z.string().min(1).max(200),
  userId: IdSchema.nullable(),
  role: z.string().min(1).max(80),
  resolution: z.enum(["verified", "inferred", "ambiguous", "unresolved"]),
  reasoning: z.string().max(4_000),
  sourceText: z.string().max(1_000),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().positive().nullable(),
  verifiedIdentity: z.strictObject({
    id: IdSchema,
    provider: z.string().max(120),
    providerTenantId: z.string().max(500),
  }).nullable(),
}));

export const WorkspaceOpportunityPersistRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  audience: OpportunityAudienceSchema,
  proposedId: IdSchema,
  existingTargetId: IdSchema.nullable(),
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  displayPrompt: z.string().min(1).max(180),
  executionPrompt: z.string().min(1).max(20_000),
  admissionReasoning: z.string().min(1).max(20_000),
  providerIcon: z.string().min(1).max(80),
  sourceLabel: z.string().min(1).max(180),
  displayPromptHash: z.string().regex(/^[0-9a-f]{64}$/u),
  executionPromptHash: z.string().regex(/^[0-9a-f]{64}$/u),
  expiresAt: z.string().datetime(),
  sources: z.array(WorkspaceOpportunitySourceSchema).min(1).max(16),
  links: z.array(WorkspaceOpportunityPersistLinkSchema).max(30),
  rankUserIds: z.array(IdSchema).max(10_000),
  eagerUserIds: z.array(IdSchema).max(30),
  rankDueAt: z.string().datetime(),
}));

export const WorkspaceOpportunityPersistResultSchema = deferredZodSchema(() => z.strictObject({
  opportunityId: IdSchema,
  version: z.number().int().positive(),
  eagerUserIds: z.array(IdSchema),
}));

export const WorkspaceOpportunityUserRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
}));

export const WorkspaceOpportunityRankingCandidatesRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  now: z.string().datetime(),
}).strict());

export const WorkspaceOpportunityRankingStateSchema = deferredZodSchema(() => z.strictObject({
  candidateFingerprint: z.string(),
  opportunityIds: z.array(IdSchema),
  status: z.enum(["stale", "ready", "failed"]),
}).nullable());

export const WorkspaceOpportunityRankingRoundRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  roundId: IdSchema,
  candidateIds: z.array(IdSchema).max(60),
  selectedIds: z.array(IdSchema).max(4),
  reasoning: z.string().max(20_000),
  model: z.string().max(200).nullable(),
  roundNumber: z.number().int().nonnegative(),
}).strict());

export const WorkspaceOpportunityStoreRankingRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  candidateFingerprint: z.string().max(64),
  opportunityIds: z.array(IdSchema).max(4),
  reasoning: z.string().max(20_000),
  model: z.string().max(200).nullable(),
  status: z.enum(["ready", "failed"]),
}).strict());

export const WorkspaceOpportunityRankingSettleRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  leaseId: IdSchema,
  requestSeq: z.number().int().nonnegative(),
  outcome: z.enum(["completed", "failed"]),
  retryAt: z.string().datetime().nullable(),
}).strict());

export const WorkspaceOpportunityListRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  now: z.string().datetime(),
  limit: z.number().int().min(1).max(4),
  scheduleAt: z.string().datetime(),
}).strict());

export const WorkspaceOpportunityPublicSchema = deferredZodSchema(() => z.strictObject({
  id: IdSchema,
  version: z.number().int().positive(),
  displayPrompt: z.string(),
  icon: z.string(),
  sourceLabel: z.string(),
}));

export const WorkspaceOpportunityRankingCandidatesResultSchema = deferredZodSchema(() => z.array(z.strictObject({
  id: IdSchema,
  version: z.number().int().positive(),
  displayPrompt: z.string(),
  admissionReasoning: z.string(),
  linkedUsers: z.array(z.looseObject({
    user_id: IdSchema.nullable(),
    role: z.string(),
    resolution: z.string(),
    reasoning: z.string(),
  })),
  provenance: z.array(z.looseObject({
    id: IdSchema,
    kind: z.string(),
    label: z.string(),
    provider: z.string().nullable(),
    occurredAt: z.string().datetime().nullable(),
    canonicalUrl: z.string().nullable(),
    relationship: z.string().optional(),
    parentNodeId: IdSchema.optional(),
    depth: z.number().int().nonnegative(),
    locator: z.string(),
  })),
  age: z.strictObject({
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  impressions: z.strictObject({
    count: z.number().int().nonnegative(),
    firstAt: z.string().datetime().nullable(),
    lastAt: z.string().datetime().nullable(),
  }),
  currentlySuggested: z.boolean(),
  public: WorkspaceOpportunityPublicSchema,
})));

export const WorkspaceOpportunityListResultSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(WorkspaceOpportunityPublicSchema).max(4),
}));

export const WorkspaceOpportunityImpressionsRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  opportunityIds: z.array(IdSchema).max(4),
  now: z.string().datetime(),
  rerankBefore: z.string().datetime(),
}).strict());

export const WorkspaceOpportunityTelemetryContextSchema = deferredZodSchema(() => z.strictObject({
  opportunityId: IdSchema,
  version: z.number().int().positive(),
  audienceScope: z.enum(["personal", "workspace"]),
  createdAt: z.string().datetime(),
  impressionCount: z.number().int().nonnegative(),
  firstImpressedAt: z.string().datetime().nullable(),
  connectorTypes: z.array(z.enum(TELEMETRY_CONNECTOR_TYPES)).max(TELEMETRY_CONNECTOR_TYPES.length),
}));

export const WorkspaceOpportunityTelemetryContextsSchema = deferredZodSchema(() => z.array(
  WorkspaceOpportunityTelemetryContextSchema,
).max(4));

export const WorkspaceOpportunityDismissResultSchema = deferredZodSchema(() => z.strictObject({
  dismissed: z.boolean(),
  telemetryContext: WorkspaceOpportunityTelemetryContextSchema.nullable(),
}));

export const WorkspaceOpportunityDismissRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  opportunityId: IdSchema,
  now: z.string().datetime(),
}).strict());

export const WorkspaceOpportunityGetRequestSchema = deferredZodSchema(() => WorkspaceOpportunityUserRequestSchema.unwrap().extend({
  opportunityId: IdSchema,
  now: z.string().datetime(),
}).strict());

export const WorkspaceOpportunityOriginEventsRequestSchema = deferredZodSchema(() => WorkspaceOpportunityGetRequestSchema.unwrap().extend({
  limit: z.number().int().min(1).max(8).default(8),
}).strict());

export const WorkspaceOpportunityOriginEventsResultSchema = deferredZodSchema(() => z.array(
  WorkspaceConnectorEventSchema,
).max(8));

export const WorkspaceOpportunityClaimStartRequestSchema = deferredZodSchema(() => WorkspaceOpportunityGetRequestSchema.unwrap().extend({
  version: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
}).strict());

export const WorkspaceOpportunityClaimStartResultSchema = deferredZodSchema(() => z.strictObject({
  outcome: z.enum(["not_found", "stale", "claimed", "busy", "replay"]),
  opportunity: z.record(z.string(), z.unknown()).nullable(),
  telemetryContext: WorkspaceOpportunityTelemetryContextSchema.nullable(),
}));

export const WorkspaceOpportunityReleaseStartRequestSchema = WorkspaceOpportunityClaimStartRequestSchema;

export const WorkspaceOpportunityCompleteStartRequestSchema = deferredZodSchema(() => WorkspaceOpportunityClaimStartRequestSchema.unwrap().extend({
  workstreamId: IdSchema,
  messageId: IdSchema,
  snapshotId: IdSchema,
}).strict());

export type WorkspaceOpportunityEnqueueRequest = z.infer<typeof WorkspaceOpportunityEnqueueRequestSchema>;
export type WorkspaceOpportunityWorkflowInput = z.infer<typeof WorkspaceOpportunityWorkflowInputSchema>;
export type WorkspaceOpportunityWindowRequest = z.infer<typeof WorkspaceOpportunityWindowRequestSchema>;
export type WorkspaceOpportunityBatchEventsRequest = z.infer<typeof WorkspaceOpportunityBatchEventsRequestSchema>;
export type WorkspaceOpportunityWindowSettleRequest = z.infer<typeof WorkspaceOpportunityWindowSettleRequestSchema>;
export type WorkspaceOpportunityExistingRequest = z.infer<typeof WorkspaceOpportunityExistingRequestSchema>;
export type WorkspaceOpportunitySource = z.infer<typeof WorkspaceOpportunitySourceSchema>;
export type WorkspaceOpportunityPersistRequest = z.infer<typeof WorkspaceOpportunityPersistRequestSchema>;
export type WorkspaceOpportunityRankingCandidatesRequest = z.infer<typeof WorkspaceOpportunityRankingCandidatesRequestSchema>;
export type WorkspaceOpportunityRankingRoundRequest = z.infer<typeof WorkspaceOpportunityRankingRoundRequestSchema>;
export type WorkspaceOpportunityStoreRankingRequest = z.infer<typeof WorkspaceOpportunityStoreRankingRequestSchema>;
export type WorkspaceOpportunityRankingSettleRequest = z.infer<typeof WorkspaceOpportunityRankingSettleRequestSchema>;
export type WorkspaceOpportunityListRequest = z.infer<typeof WorkspaceOpportunityListRequestSchema>;
export type WorkspaceOpportunityImpressionsRequest = z.infer<typeof WorkspaceOpportunityImpressionsRequestSchema>;
export type WorkspaceOpportunityTelemetryContext = z.infer<typeof WorkspaceOpportunityTelemetryContextSchema>;
export type WorkspaceOpportunityDismissRequest = z.infer<typeof WorkspaceOpportunityDismissRequestSchema>;
export type WorkspaceOpportunityGetRequest = z.infer<typeof WorkspaceOpportunityGetRequestSchema>;
export type WorkspaceOpportunityOriginEventsRequest = z.infer<
  typeof WorkspaceOpportunityOriginEventsRequestSchema
>;
export type WorkspaceOpportunityClaimStartRequest = z.infer<typeof WorkspaceOpportunityClaimStartRequestSchema>;
export type WorkspaceOpportunityCompleteStartRequest = z.infer<typeof WorkspaceOpportunityCompleteStartRequestSchema>;

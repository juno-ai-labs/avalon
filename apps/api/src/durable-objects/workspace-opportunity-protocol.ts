import { IdSchema, RegionSchema, UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { TELEMETRY_CONNECTOR_TYPES } from "@rally/contracts/telemetry";
import { z } from "zod";

import { WorkspaceConnectorEventSchema } from "./workspace-connector-event-protocol";

export const OpportunityAudienceSchema = z.object({
  scope: z.enum(["personal", "workspace"]),
  userId: IdSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.scope === "personal") !== (value.userId !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Opportunity audience is inconsistent" });
  }
});

export const WorkspaceOpportunityEnqueueRequestSchema = z.object({
  workspaceId: IdSchema,
  partitionKey: z.string().min(1).max(500),
  audience: OpportunityAudienceSchema,
  sourceKind: z.enum(["activity", "message"]),
  sourceId: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  inputCharacters: z.number().int().nonnegative(),
}).strict();

export const WorkspaceOpportunityEnqueueResultSchema = z.object({
  windowId: IdSchema,
  processAfter: z.string().datetime(),
  inserted: z.boolean(),
}).strict();

export const WorkspaceOpportunityWorkflowInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("admission"),
    region: RegionSchema,
    workspaceId: WorkspaceIdSchema,
    windowId: IdSchema,
    leaseId: IdSchema,
    attempt: z.number().int().min(0).max(5),
  }).strict(),
  z.object({
    kind: z.literal("ranking"),
    region: RegionSchema,
    workspaceId: WorkspaceIdSchema,
    userId: UserIdSchema,
    requestSeq: z.number().int().nonnegative(),
    leaseId: IdSchema,
  }).strict(),
]);

export const WorkspaceOpportunityWindowRequestSchema = z.object({
  workspaceId: IdSchema,
  windowId: IdSchema,
  leaseId: IdSchema,
}).strict();

export const WorkspaceOpportunityWindowSchema = z.object({
  id: IdSchema,
  partitionKey: z.string(),
  audience: OpportunityAudienceSchema,
  firstEventAt: z.string().datetime(),
  lastEventAt: z.string().datetime(),
  events: z.array(z.object({
    id: IdSchema,
    sourceKind: z.enum(["activity", "message"]),
    sourceId: z.string(),
    occurredAt: z.string().datetime(),
    inputCharacters: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
  }).strict()).max(5_000),
}).strict();

export const WorkspaceOpportunityBatchEventsRequestSchema = WorkspaceOpportunityWindowRequestSchema.extend({
  eventIds: z.array(IdSchema).min(1).max(100),
  outcome: z.enum(["processing", "completed", "failed", "missing"]),
  error: z.string().max(1_000).nullable(),
}).strict();

export const WorkspaceOpportunityWindowSettleRequestSchema = WorkspaceOpportunityWindowRequestSchema.extend({
  retryDelayMs: z.number().int().min(1_000).max(60 * 60_000),
}).strict();

export const WorkspaceOpportunityExistingRequestSchema = z.object({
  workspaceId: IdSchema,
  audience: OpportunityAudienceSchema,
  now: z.string().datetime(),
  limit: z.number().int().min(1).max(100),
}).strict();

export const WorkspaceOpportunitySourceSchema = z.object({
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
  externalPeople: z.array(z.unknown()).max(100),
  entityKeys: z.array(z.string().max(200)).max(20),
  canonicalUrl: z.string().max(2_000).nullable(),
  workstreamId: IdSchema.nullable(),
  occurredAt: z.string().datetime(),
}).strict();

export const WorkspaceOpportunityPersistLinkSchema = z.object({
  id: IdSchema,
  sourceId: z.string().min(1).max(200),
  userId: IdSchema.nullable(),
  role: z.string().min(1).max(80),
  resolution: z.enum(["verified", "inferred", "ambiguous", "unresolved"]),
  reasoning: z.string().max(4_000),
  sourceText: z.string().max(1_000),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().positive().nullable(),
  verifiedIdentity: z.object({
    id: IdSchema,
    provider: z.string().max(120),
    providerTenantId: z.string().max(500),
  }).strict().nullable(),
}).strict();

export const WorkspaceOpportunityPersistRequestSchema = z.object({
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
}).strict();

export const WorkspaceOpportunityPersistResultSchema = z.object({
  opportunityId: IdSchema,
  version: z.number().int().positive(),
  eagerUserIds: z.array(IdSchema),
}).strict();

export const WorkspaceOpportunityUserRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
}).strict();

export const WorkspaceOpportunityRankingCandidatesRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  now: z.string().datetime(),
}).strict();

export const WorkspaceOpportunityRankingStateSchema = z.object({
  candidateFingerprint: z.string(),
  opportunityIds: z.array(IdSchema),
  status: z.enum(["stale", "ready", "failed"]),
}).strict().nullable();

export const WorkspaceOpportunityRankingRoundRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  roundId: IdSchema,
  candidateIds: z.array(IdSchema).max(60),
  selectedIds: z.array(IdSchema).max(4),
  reasoning: z.string().max(20_000),
  model: z.string().max(200).nullable(),
  roundNumber: z.number().int().nonnegative(),
}).strict();

export const WorkspaceOpportunityStoreRankingRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  candidateFingerprint: z.string().max(64),
  opportunityIds: z.array(IdSchema).max(4),
  reasoning: z.string().max(20_000),
  model: z.string().max(200).nullable(),
  status: z.enum(["ready", "failed"]),
}).strict();

export const WorkspaceOpportunityRankingSettleRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  leaseId: IdSchema,
  requestSeq: z.number().int().nonnegative(),
  outcome: z.enum(["completed", "failed"]),
  retryAt: z.string().datetime().nullable(),
}).strict();

export const WorkspaceOpportunityListRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  now: z.string().datetime(),
  limit: z.number().int().min(1).max(4),
  scheduleAt: z.string().datetime(),
}).strict();

export const WorkspaceOpportunityPublicSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  displayPrompt: z.string(),
  icon: z.string(),
  sourceLabel: z.string(),
}).strict();

export const WorkspaceOpportunityRankingCandidatesResultSchema = z.array(z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  displayPrompt: z.string(),
  admissionReasoning: z.string(),
  linkedUsers: z.array(z.object({
    user_id: IdSchema.nullable(),
    role: z.string(),
    resolution: z.string(),
    reasoning: z.string(),
  }).passthrough()),
  provenance: z.array(z.object({
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
  }).passthrough()),
  age: z.object({
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
  impressions: z.object({
    count: z.number().int().nonnegative(),
    firstAt: z.string().datetime().nullable(),
    lastAt: z.string().datetime().nullable(),
  }).strict(),
  currentlySuggested: z.boolean(),
  public: WorkspaceOpportunityPublicSchema,
}).strict());

export const WorkspaceOpportunityListResultSchema = z.object({
  items: z.array(WorkspaceOpportunityPublicSchema).max(4),
}).strict();

export const WorkspaceOpportunityImpressionsRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  opportunityIds: z.array(IdSchema).max(4),
  now: z.string().datetime(),
  rerankBefore: z.string().datetime(),
}).strict();

export const WorkspaceOpportunityTelemetryContextSchema = z.object({
  opportunityId: IdSchema,
  version: z.number().int().positive(),
  audienceScope: z.enum(["personal", "workspace"]),
  createdAt: z.string().datetime(),
  impressionCount: z.number().int().nonnegative(),
  firstImpressedAt: z.string().datetime().nullable(),
  connectorTypes: z.array(z.enum(TELEMETRY_CONNECTOR_TYPES)).max(TELEMETRY_CONNECTOR_TYPES.length),
}).strict();

export const WorkspaceOpportunityTelemetryContextsSchema = z.array(
  WorkspaceOpportunityTelemetryContextSchema,
).max(4);

export const WorkspaceOpportunityDismissResultSchema = z.object({
  dismissed: z.boolean(),
  telemetryContext: WorkspaceOpportunityTelemetryContextSchema.nullable(),
}).strict();

export const WorkspaceOpportunityDismissRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  opportunityId: IdSchema,
  now: z.string().datetime(),
}).strict();

export const WorkspaceOpportunityGetRequestSchema = WorkspaceOpportunityUserRequestSchema.extend({
  opportunityId: IdSchema,
  now: z.string().datetime(),
}).strict();

export const WorkspaceOpportunityOriginEventsRequestSchema = WorkspaceOpportunityGetRequestSchema.extend({
  limit: z.number().int().min(1).max(8).default(8),
}).strict();

export const WorkspaceOpportunityOriginEventsResultSchema = z.array(
  WorkspaceConnectorEventSchema,
).max(8);

export const WorkspaceOpportunityClaimStartRequestSchema = WorkspaceOpportunityGetRequestSchema.extend({
  version: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
}).strict();

export const WorkspaceOpportunityClaimStartResultSchema = z.object({
  outcome: z.enum(["not_found", "stale", "claimed", "busy", "replay"]),
  opportunity: z.record(z.string(), z.unknown()).nullable(),
  telemetryContext: WorkspaceOpportunityTelemetryContextSchema.nullable(),
}).strict();

export const WorkspaceOpportunityReleaseStartRequestSchema = WorkspaceOpportunityClaimStartRequestSchema;

export const WorkspaceOpportunityCompleteStartRequestSchema = WorkspaceOpportunityClaimStartRequestSchema.extend({
  workstreamId: IdSchema,
  messageId: IdSchema,
  snapshotId: IdSchema,
}).strict();

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

import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The workspace's resource inventory, as questions rather than SQL.
 *
 * `resources`, its version history, watches, upload-draft reservations, the
 * object-deletion outbox and the inbound-email receipts are WorkspaceDO
 * tables that services reached as statements through the workspace runtime
 * facade — the router that classifies SQL by the table names in it and sends
 * anything it does not recognise to the regional database. A typed method
 * cannot be routed to the wrong database, because its tables are named inside
 * the object that has them.
 *
 * Refusals travel as outcomes, not throws: a thrown RPC error arrives at the
 * caller as a bare message with the HTTP status lost, so the object names the
 * outcome and the service maps it to its `ApiError`.
 */

const TimestampSchema = z.string().datetime({ offset: true });

/** One `resources` row, in the columns the cross-authority readers consume. */
export const WorkspaceResourceDescriptorSchema = z.object({
  id: IdSchema,
  connection_id: z.string().nullable(),
  resource_type: z.string(),
  provider: z.string(),
  provider_resource_id: z.string().nullable(),
  title: z.string(),
  mime_type: z.string().nullable(),
  content_ref: z.string().nullable(),
  content_sha256: z.string().nullable(),
  canonical_url: z.string().nullable(),
  metadata_json: z.string(),
  model_content_ref: z.string().nullable(),
  model_mime_type: z.string().nullable(),
  model_content_sha256: z.string().nullable(),
  model_metadata_json: z.string().nullable(),
  model_content_status: z.enum(["pending", "processing", "ready", "failed", "unsupported"]).nullable(),
  model_content_extractor_version: z.string().nullable(),
  model_content_error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const WorkspaceResourceDescriptorsRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceIds: z.array(IdSchema),
  /**
   * When set, only this member's own unsent upload drafts are returned. The
   * work-stream input gate uses it so somebody else's draft — or an already
   * sent one — cannot be attached by id.
   */
  draftUploadedByUserId: IdSchema.nullable(),
}).strict();

export const WorkspaceResourceDescriptorListSchema = z.object({
  items: z.array(WorkspaceResourceDescriptorSchema),
}).strict();

export const WorkspaceResourceExistsRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
}).strict();

export const WorkspaceResourceExistsResultSchema = z.object({
  exists: z.boolean(),
}).strict();

export const WorkspaceUploadDraftCreateRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  title: z.string(),
  mimeType: z.string(),
  contentRef: z.string(),
  contentSha256: z.string(),
  metadataJson: z.string(),
  uploadedByUserId: IdSchema,
  at: TimestampSchema,
}).strict();

/**
 * `draft_exists` is a typed answer rather than a constraint error: two
 * concurrent uploads of the same draft id used to race a separate existence
 * check, and whichever lost the insert surfaced as a bare SQLite primary-key
 * failure — a 500 — instead of the 409 the check was there to produce.
 */
export const WorkspaceUploadDraftCreateResultSchema = z.object({
  outcome: z.enum(["created", "draft_exists"]),
}).strict();

export const WorkspaceUploadDraftDeleteRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  userId: IdSchema,
}).strict();

export const WorkspaceUploadDraftDeleteResultSchema = z.object({
  outcome: z.enum(["deleted", "not_found"]),
}).strict();

export const WorkspaceConnectorResourceResolveRequestSchema = z.object({
  workspaceId: IdSchema,
  /** The id the row gets if no canonical row exists yet. */
  candidateResourceId: IdSchema,
  connectionId: IdSchema,
  provider: z.string(),
  providerResourceId: z.string(),
  resourceType: z.string(),
  title: z.string(),
  canonicalUrl: z.string().nullable(),
  at: TimestampSchema,
}).strict();

export const WorkspaceConnectorResourceResolveResultSchema = z.object({
  resourceId: IdSchema,
  outcome: z.enum(["created", "existing"]),
}).strict();

/** One `resource_versions` row, in the columns the history readers consume. */
export const WorkspaceResourceVersionSchema = z.object({
  resource_id: IdSchema,
  version: z.number().int().positive(),
  author_kind: z.string().nullable(),
  author_run_id: z.string().nullable(),
  author_user_id: z.string().nullable(),
  author_connection_id: z.string().nullable(),
  cause: z.string().nullable(),
  storage_kind: z.string(),
  title: z.string(),
  resource_type: z.string(),
  provider: z.string(),
  provider_resource_id: z.string().nullable(),
  mime_type: z.string().nullable(),
  canonical_url: z.string().nullable(),
  last_hydrated_at: z.string().nullable(),
  captured_at: z.string(),
  content_ref: z.string().nullable(),
  model_content_ref: z.string().nullable(),
  metadata_json: z.string(),
}).strict();

export const WorkspaceResourceVersionListRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  /** One version rather than the whole history, when set. */
  version: z.number().int().positive().nullable(),
}).strict();

export const WorkspaceResourceVersionListSchema = z.object({
  items: z.array(WorkspaceResourceVersionSchema),
}).strict();

/**
 * Both hydration writes are compare-and-swaps against the content the caller
 * read, so a concurrent hydration or upload cannot be silently overwritten.
 * `updated: false` means the fence refused the write, and the caller releases
 * whatever object it staged for it.
 */
export const WorkspaceResourceHydrationRefreshRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  connectionId: IdSchema,
  expectedContentRef: z.string().nullable(),
  expectedContentSha256: z.string().nullable(),
  at: TimestampSchema,
}).strict();

export const WorkspaceResourceHydrationPublishRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  connectionId: IdSchema,
  contentRef: z.string(),
  contentSha256: z.string(),
  expectedContentRef: z.string().nullable(),
  expectedContentSha256: z.string().nullable(),
  at: TimestampSchema,
}).strict();

export const WorkspaceResourceHydrationResultSchema = z.object({
  updated: z.boolean(),
}).strict();

export const WorkspaceResourceWatchEnableRequestSchema = z.object({
  workspaceId: IdSchema,
  watchId: IdSchema,
  workstreamId: IdSchema,
  resourceId: IdSchema,
  connectionId: IdSchema,
  watchType: z.enum(["incremental", "webhook"]),
  nextPollAt: TimestampSchema.nullable(),
  at: TimestampSchema,
}).strict();

export const WorkspaceResourceWatchDisableRequestSchema = z.object({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  resourceId: IdSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceResourceObjectRefRequestSchema = z.object({
  workspaceId: IdSchema,
  objectRef: z.string(),
}).strict();

export const WorkspaceReapableResourceObjectListRequestSchema = z.object({
  workspaceId: IdSchema,
}).strict();

export const WorkspaceReapableResourceObjectSchema = z.object({
  object_ref: z.string(),
  resource_id: z.string(),
  object_kind: z.enum(["original", "derivative", "receipt"]),
}).strict();

export const WorkspaceReapableResourceObjectListSchema = z.object({
  items: z.array(WorkspaceReapableResourceObjectSchema),
}).strict();

/**
 * What one outbox row wants from the reaper, decided in one critical section.
 *
 * `retired` — a live resource or version still names the object, so the
 * staging row was removed and the bytes stay. The reference check and the
 * delete used to be two round trips, guarded by re-stating the check inside
 * the delete; one transaction has no window to guard.
 * `awaiting_publisher` — a writer registered the object and has neither
 * committed a pointer nor released it, so the bytes are not the reaper's yet.
 * `removable` — delete the bytes, then retire the row.
 * `missing` — the row was retired since it was listed.
 */
export const WorkspaceResourceObjectRemovalResultSchema = z.object({
  outcome: z.enum(["retired", "awaiting_publisher", "removable", "missing"]),
}).strict();

export const WorkspaceResourceObjectRetireResultSchema = z.object({
  retired: z.boolean(),
}).strict();

export const WorkspaceResourceObjectFailureRequestSchema = z.object({
  workspaceId: IdSchema,
  objectRef: z.string(),
  errorCode: z.string(),
  at: TimestampSchema,
}).strict();

export const WorkspaceExpiredDraftReapRequestSchema = z.object({
  workspaceId: IdSchema,
}).strict();

export const WorkspaceExpiredDraftReapResultSchema = z.object({
  removed: z.number().int().nonnegative(),
}).strict();

export const WorkspaceResourceSlugClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  candidate: z.string(),
}).strict();

/**
 * `candidate_taken` sends the allocator to its next attempt: the partial
 * unique index on `slug` refused the candidate because another row holds it,
 * while this row still has none.
 */
export const WorkspaceResourceSlugClaimResultSchema = z.object({
  outcome: z.enum(["allocated", "already_named", "candidate_taken", "missing"]),
  slug: z.string().nullable(),
}).strict();

export const WorkspaceResourceSlugBacklogRequestSchema = z.object({
  workspaceId: IdSchema,
}).strict();

export const WorkspaceResourceSlugBacklogSchema = z.object({
  items: z.array(IdSchema),
}).strict();

export const WorkspaceInboundEmailClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  resendEmailId: z.string(),
  workstreamId: IdSchema,
  svixId: z.string(),
  receivedAt: TimestampSchema,
  /**
   * The caller's, because the length is an environment-configured limit the
   * object has no reading of. The token that fences the lease is the
   * object's, minted inside the claim and returned.
   */
  leaseExpiresAt: TimestampSchema,
}).strict();

/**
 * `claimed` carries the lease token every later transition must present.
 * `already_processed` is the replay answer; `in_progress` means another
 * delivery holds a live lease. The insert, the duplicate read and the expired
 * -lease takeover used to be three separate round trips.
 */
export const WorkspaceInboundEmailClaimResultSchema = z.object({
  outcome: z.enum(["claimed", "already_processed", "in_progress"]),
  leaseToken: z.string().nullable(),
}).strict();

export const WorkspaceInboundEmailLeaseRequestSchema = z.object({
  workspaceId: IdSchema,
  resendEmailId: z.string(),
  workstreamId: IdSchema,
  leaseToken: z.string(),
  leaseExpiresAt: TimestampSchema,
}).strict();

export const WorkspaceInboundEmailLeaseResultSchema = z.object({
  outcome: z.enum(["renewed", "lease_lost"]),
}).strict();

export const WorkspaceInboundEmailSettleRequestSchema = z.object({
  workspaceId: IdSchema,
  resendEmailId: z.string(),
  workstreamId: IdSchema,
  leaseToken: z.string(),
  payloadRef: z.string(),
  processedAt: TimestampSchema,
}).strict();

export const WorkspaceInboundEmailSettleResultSchema = z.object({
  outcome: z.enum(["processed", "lease_lost"]),
}).strict();

export const WorkspaceInboundEmailFailureRequestSchema = z.object({
  workspaceId: IdSchema,
  resendEmailId: z.string(),
  workstreamId: IdSchema,
  leaseToken: z.string(),
  errorCode: z.string(),
}).strict();

export const WorkspaceInboundEmailResourceRequestSchema = z.object({
  workspaceId: IdSchema,
  /** The id the row gets if this email has no resource yet. */
  candidateResourceId: IdSchema,
  resendEmailId: z.string(),
  title: z.string(),
  contentRef: z.string(),
  metadataJson: z.string(),
  at: TimestampSchema,
}).strict();

export const WorkspaceInboundEmailResourceResultSchema = z.object({
  resourceId: IdSchema,
}).strict();

export const WorkspaceDiscoveredResourceSchema = z.object({
  id: IdSchema,
  resourceType: z.string(),
  providerResourceId: z.string(),
  title: z.string(),
  canonicalUrl: z.string().nullable(),
  metadataJson: z.string(),
}).strict();

export const WorkspaceDiscoveredResourcesRequestSchema = z.object({
  workspaceId: IdSchema,
  connectionId: IdSchema,
  provider: z.string(),
  resources: z.array(WorkspaceDiscoveredResourceSchema),
  at: TimestampSchema,
}).strict();

export type WorkspaceResourceDescriptor = z.infer<typeof WorkspaceResourceDescriptorSchema>;
export type WorkspaceResourceDescriptorsRequest = z.infer<
  typeof WorkspaceResourceDescriptorsRequestSchema
>;
export type WorkspaceResourceDescriptorList = z.infer<typeof WorkspaceResourceDescriptorListSchema>;
export type WorkspaceResourceExistsRequest = z.infer<typeof WorkspaceResourceExistsRequestSchema>;
export type WorkspaceResourceExistsResult = z.infer<typeof WorkspaceResourceExistsResultSchema>;
export type WorkspaceUploadDraftCreateRequest = z.infer<
  typeof WorkspaceUploadDraftCreateRequestSchema
>;
export type WorkspaceUploadDraftCreateResult = z.infer<
  typeof WorkspaceUploadDraftCreateResultSchema
>;
export type WorkspaceUploadDraftDeleteRequest = z.infer<
  typeof WorkspaceUploadDraftDeleteRequestSchema
>;
export type WorkspaceUploadDraftDeleteResult = z.infer<
  typeof WorkspaceUploadDraftDeleteResultSchema
>;
export type WorkspaceConnectorResourceResolveRequest = z.infer<
  typeof WorkspaceConnectorResourceResolveRequestSchema
>;
export type WorkspaceConnectorResourceResolveResult = z.infer<
  typeof WorkspaceConnectorResourceResolveResultSchema
>;
export type WorkspaceResourceVersion = z.infer<typeof WorkspaceResourceVersionSchema>;
export type WorkspaceResourceVersionListRequest = z.infer<
  typeof WorkspaceResourceVersionListRequestSchema
>;
export type WorkspaceResourceVersionList = z.infer<typeof WorkspaceResourceVersionListSchema>;
export type WorkspaceResourceHydrationRefreshRequest = z.infer<
  typeof WorkspaceResourceHydrationRefreshRequestSchema
>;
export type WorkspaceResourceHydrationPublishRequest = z.infer<
  typeof WorkspaceResourceHydrationPublishRequestSchema
>;
export type WorkspaceResourceHydrationResult = z.infer<
  typeof WorkspaceResourceHydrationResultSchema
>;
export type WorkspaceResourceWatchEnableRequest = z.infer<
  typeof WorkspaceResourceWatchEnableRequestSchema
>;
export type WorkspaceResourceWatchDisableRequest = z.infer<
  typeof WorkspaceResourceWatchDisableRequestSchema
>;
export type WorkspaceResourceObjectRefRequest = z.infer<
  typeof WorkspaceResourceObjectRefRequestSchema
>;
export type WorkspaceReapableResourceObjectListRequest = z.infer<
  typeof WorkspaceReapableResourceObjectListRequestSchema
>;
export type WorkspaceReapableResourceObjectList = z.infer<
  typeof WorkspaceReapableResourceObjectListSchema
>;
export type WorkspaceResourceObjectRemovalResult = z.infer<
  typeof WorkspaceResourceObjectRemovalResultSchema
>;
export type WorkspaceResourceObjectRetireResult = z.infer<
  typeof WorkspaceResourceObjectRetireResultSchema
>;
export type WorkspaceResourceObjectFailureRequest = z.infer<
  typeof WorkspaceResourceObjectFailureRequestSchema
>;
export type WorkspaceExpiredDraftReapRequest = z.infer<
  typeof WorkspaceExpiredDraftReapRequestSchema
>;
export type WorkspaceExpiredDraftReapResult = z.infer<
  typeof WorkspaceExpiredDraftReapResultSchema
>;
export type WorkspaceResourceSlugClaimRequest = z.infer<
  typeof WorkspaceResourceSlugClaimRequestSchema
>;
export type WorkspaceResourceSlugClaimResult = z.infer<
  typeof WorkspaceResourceSlugClaimResultSchema
>;
export type WorkspaceResourceSlugBacklogRequest = z.infer<
  typeof WorkspaceResourceSlugBacklogRequestSchema
>;
export type WorkspaceResourceSlugBacklog = z.infer<typeof WorkspaceResourceSlugBacklogSchema>;
export type WorkspaceInboundEmailClaimRequest = z.infer<
  typeof WorkspaceInboundEmailClaimRequestSchema
>;
export type WorkspaceInboundEmailClaimResult = z.infer<
  typeof WorkspaceInboundEmailClaimResultSchema
>;
export type WorkspaceInboundEmailLeaseRequest = z.infer<
  typeof WorkspaceInboundEmailLeaseRequestSchema
>;
export type WorkspaceInboundEmailLeaseResult = z.infer<
  typeof WorkspaceInboundEmailLeaseResultSchema
>;
export type WorkspaceInboundEmailSettleRequest = z.infer<
  typeof WorkspaceInboundEmailSettleRequestSchema
>;
export type WorkspaceInboundEmailSettleResult = z.infer<
  typeof WorkspaceInboundEmailSettleResultSchema
>;
export type WorkspaceInboundEmailFailureRequest = z.infer<
  typeof WorkspaceInboundEmailFailureRequestSchema
>;
export type WorkspaceInboundEmailResourceRequest = z.infer<
  typeof WorkspaceInboundEmailResourceRequestSchema
>;
export type WorkspaceInboundEmailResourceResult = z.infer<
  typeof WorkspaceInboundEmailResourceResultSchema
>;
export type WorkspaceDiscoveredResourcesRequest = z.infer<
  typeof WorkspaceDiscoveredResourcesRequestSchema
>;

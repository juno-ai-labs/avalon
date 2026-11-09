import { IdSchema } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

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
export const WorkspaceResourceDescriptorSchema = deferredZodSchema(() => z.strictObject({
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
}));

export const WorkspaceResourceDescriptorsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceIds: z.array(IdSchema),
  /**
   * When set, only this member's own unsent upload drafts are returned. The
   * work-stream input gate uses it so somebody else's draft — or an already
   * sent one — cannot be attached by id.
   */
  draftUploadedByUserId: IdSchema.nullable(),
}));

export const WorkspaceResourceDescriptorListSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(WorkspaceResourceDescriptorSchema),
}));

export const WorkspaceResourceExistsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
}));

export const WorkspaceResourceExistsResultSchema = deferredZodSchema(() => z.strictObject({
  exists: z.boolean(),
}));

export const WorkspaceUploadDraftCreateRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  title: z.string(),
  mimeType: z.string(),
  contentRef: z.string(),
  contentSha256: z.string(),
  metadataJson: z.string(),
  uploadedByUserId: IdSchema,
  at: TimestampSchema,
}));

/**
 * `draft_exists` is a typed answer rather than a constraint error: two
 * concurrent uploads of the same draft id used to race a separate existence
 * check, and whichever lost the insert surfaced as a bare SQLite primary-key
 * failure — a 500 — instead of the 409 the check was there to produce.
 */
export const WorkspaceUploadDraftCreateResultSchema = deferredZodSchema(() => z.strictObject({
  outcome: z.enum(["created", "draft_exists"]),
}));

export const WorkspaceUploadDraftDeleteRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  userId: IdSchema,
}));

export const WorkspaceUploadDraftDeleteResultSchema = deferredZodSchema(() => z.strictObject({
  outcome: z.enum(["deleted", "not_found"]),
}));

export const WorkspaceConnectorResourceResolveRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  /** The id the row gets if no canonical row exists yet. */
  candidateResourceId: IdSchema,
  connectionId: IdSchema,
  provider: z.string(),
  providerResourceId: z.string(),
  resourceType: z.string(),
  title: z.string(),
  canonicalUrl: z.string().nullable(),
  protectedAccessJson: z.string().nullable().optional(),
  connectionAuthority: z.strictObject({
    connectorType: z.string(),
    scope: z.enum(["personal", "workspace"]),
    ownerUserId: IdSchema.nullable(),
    modelPluginId: z.string().nullable(),
    requiredCapabilities: z.array(z.string()),
  }).optional(),
  at: TimestampSchema,
}));

export const WorkspaceConnectorResourceResolveResultSchema = deferredZodSchema(() => z.union([
  z.strictObject({ resourceId: IdSchema, outcome: z.enum(["created", "existing"]) }),
  z.strictObject({ outcome: z.literal("connection_unavailable") }),
]));

/** One `resource_versions` row, in the columns the history readers consume. */
export const WorkspaceResourceVersionSchema = deferredZodSchema(() => z.strictObject({
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
  model_mime_type:z.string().nullable().default(null),
  model_content_sha256:z.string().nullable().default(null),
  content_sha256:z.string().nullable().default(null),
  model_metadata_json:z.string().nullable().default(null),
  metadata_json: z.string(),
}));

export const WorkspaceResourceVersionListRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  /** One version rather than the whole history, when set. */
  version: z.number().int().positive().nullable(),
}));

export const WorkspaceResourceVersionListSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(WorkspaceResourceVersionSchema),
}));

/**
 * Both hydration writes are compare-and-swaps against the content the caller
 * read, so a concurrent hydration or upload cannot be silently overwritten.
 * `updated: false` means the fence refused the write, and the caller releases
 * whatever object it staged for it.
 */
export const WorkspaceResourceHydrationRefreshRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  connectionId: IdSchema,
  expectedContentRef: z.string().nullable(),
  expectedContentSha256: z.string().nullable(),
  at: TimestampSchema,
}));

export const WorkspaceResourceHydrationPublishRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  connectionId: IdSchema,
  contentRef: z.string(),
  contentSha256: z.string(),
  expectedContentRef: z.string().nullable(),
  expectedContentSha256: z.string().nullable(),
  at: TimestampSchema,
}));

export const WorkspaceResourceHydrationResultSchema = deferredZodSchema(() => z.strictObject({
  updated: z.boolean(),
}));

/**
 * A person renaming a resource. The title is the caller's to validate; the
 * object records who renamed it as the version's author.
 */
export const WorkspaceResourceRenameRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  title: z.string().min(1),
  renamedByUserId: IdSchema,
  at: TimestampSchema,
}));

/**
 * `unchanged` writes nothing, since any write to `title` records a version.
 * `listed` is false for a resource enumeration leaves out, which a caller
 * must not advertise.
 */
export const WorkspaceResourceRenameResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.enum(["renamed", "unchanged"]), listed: z.boolean() }),
  z.strictObject({ outcome: z.literal("not_found") }),
]));

export const WorkspaceResourceWatchEnableRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  watchId: IdSchema,
  workstreamId: IdSchema,
  resourceId: IdSchema,
  connectionId: IdSchema,
  watchType: z.enum(["incremental", "webhook"]),
  nextPollAt: TimestampSchema.nullable(),
  at: TimestampSchema,
}));

export const WorkspaceResourceWatchDisableRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  resourceId: IdSchema,
  at: TimestampSchema,
}));

export const WorkspaceResourceObjectRefRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  objectRef: z.string(),
}));

export const WorkspaceReapableResourceObjectListRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
}));

export const WorkspaceReapableResourceObjectSchema = deferredZodSchema(() => z.strictObject({
  object_ref: z.string(),
  resource_id: z.string(),
  object_kind: z.enum(["original", "derivative", "receipt"]),
}));

export const WorkspaceReapableResourceObjectListSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(WorkspaceReapableResourceObjectSchema),
}));

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
export const WorkspaceResourceObjectRemovalResultSchema = deferredZodSchema(() => z.strictObject({
  outcome: z.enum(["retired", "awaiting_publisher", "removable", "missing"]),
}));

export const WorkspaceResourceObjectRetireResultSchema = deferredZodSchema(() => z.strictObject({
  retired: z.boolean(),
}));

export const WorkspaceResourceObjectFailureRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  objectRef: z.string(),
  errorCode: z.string(),
  at: TimestampSchema,
}));

export const WorkspaceExpiredDraftReapRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
}));

export const WorkspaceExpiredDraftReapResultSchema = deferredZodSchema(() => z.strictObject({
  removed: z.number().int().nonnegative(),
}));

export const WorkspaceResourceSlugClaimRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
  candidate: z.string(),
}));

/**
 * `candidate_taken` sends the allocator to its next attempt: the partial
 * unique index on `slug` refused the candidate because another row holds it,
 * while this row still has none.
 */
export const WorkspaceResourceSlugClaimResultSchema = deferredZodSchema(() => z.strictObject({
  outcome: z.enum(["allocated", "already_named", "candidate_taken", "missing"]),
  slug: z.string().nullable(),
}));

export const WorkspaceResourceSlugBacklogRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
}));

export const WorkspaceResourceSlugBacklogSchema = deferredZodSchema(() => z.strictObject({
  items: z.array(IdSchema),
}));

export const WorkspaceInboundEmailResourceRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  /** The id the row gets if this email has no resource yet. */
  candidateResourceId: IdSchema,
  resendEmailId: z.string(),
  title: z.string(),
  contentRef: z.string(),
  metadataJson: z.string(),
  at: TimestampSchema,
}));

export const WorkspaceInboundEmailResourceResultSchema = deferredZodSchema(() => z.strictObject({
  resourceId: IdSchema,
}));

export const WorkspaceDiscoveredResourceSchema = deferredZodSchema(() => z.strictObject({
  id: IdSchema,
  resourceType: z.string(),
  providerResourceId: z.string(),
  title: z.string(),
  canonicalUrl: z.string().nullable(),
  metadataJson: z.string(),
}));

export const WorkspaceDiscoveredResourcesRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  connectionId: IdSchema,
  provider: z.string(),
  resources: z.array(WorkspaceDiscoveredResourceSchema),
  at: TimestampSchema,
}));

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
export type WorkspaceInboundEmailResourceRequest = z.infer<
  typeof WorkspaceInboundEmailResourceRequestSchema
>;
export type WorkspaceInboundEmailResourceResult = z.infer<
  typeof WorkspaceInboundEmailResourceResultSchema
>;
export type WorkspaceDiscoveredResourcesRequest = z.infer<
  typeof WorkspaceDiscoveredResourcesRequestSchema
>;
export type WorkspaceResourceRenameRequest = z.infer<
  typeof WorkspaceResourceRenameRequestSchema
>;
export type WorkspaceResourceRenameResult = z.infer<
  typeof WorkspaceResourceRenameResultSchema
>;

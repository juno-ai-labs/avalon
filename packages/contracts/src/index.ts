import { z } from "zod";
import { ConnectorOAuthProviders } from "./connector-oauth-providers";
import { HttpUrlSchema, httpUrlSchema } from "./url-schemas";

export { ConnectorOAuthProviders } from "./connector-oauth-providers";
export {
  CONNECTOR_CARDS_BLOCK_KIND,
  CONNECTOR_CARDS_MAX,
  CONNECTOR_OFFERINGS,
  CONNECTOR_OFFERING_IDS,
  ConnectorCardSchema,
  ConnectorCardsBlockSchema,
  ConnectorOfferingIconSchema,
  ConnectorOfferingIdSchema,
  ConnectorTypeSchema,
  connectorCardsFallbackText,
  connectorOffering,
  connectorOfferingCapabilities,
  type ConnectorCard,
  type ConnectorCardsBlock,
  type ConnectorOffering,
  type ConnectorOfferingIcon,
  type ConnectorOfferingId,
  type ConnectorType,
} from "./connector-offerings";
export {
  WORKSTREAM_LINK_PATH_PREFIX,
  isWorkstreamId,
  parseWorkstreamLink,
  parseWorkstreamLinkPath,
  workstreamCanonicalUrl,
  workstreamDeepLink,
} from "./workstream-links";

export const IdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
export const RegionSchema = z.enum(["global", "eu"]);
export const ScopeSchema = z.enum(["personal", "workspace"]);
export const HarnessStatusSchema = z.enum([
  "scheduled",
  "running",
  "needs_input",
  "completed",
  "failed",
  "idle"
]);
export const HarnessFailureCodeSchema = z.enum([
  "run_wall_time_limit_exceeded",
  "run_iteration_limit_exceeded",
  "run_tool_call_limit_exceeded",
  "run_cost_limit_exceeded",
  "harness_execution_failed",
  "context_limit_exceeded",
  "tool_surface_too_large",
  "ambiguous_external_write"
]);
export type HarnessFailureCode = z.infer<typeof HarnessFailureCodeSchema>;

/**
 * The OpenRouter models a creator may pin a work stream to from the composer's
 * developer-mode model selector, in the order the selector lists them. The
 * first is the one the selector shows before anything is chosen, so it should
 * stay the model `agent-model-workstream` serves by default.
 *
 * This is a *closed* list rather than a free-text model id on purpose: an
 * override bypasses the Flagship rollout for the work stream it is attached to,
 * so the set of models that can be reached that way is a product decision
 * reviewed here rather than whatever string a client sends. Removing a model
 * from it stops new overrides naming it; work streams already pinned to it fall
 * back to the flag, because the API re-validates the stored value on read.
 *
 * See `docs/FEATURE_FLAGS.md` for how an override composes with the flags.
 */
export const AGENT_MODEL_OVERRIDES = [
  "x-ai/grok-4.3",
  "x-ai/grok-4.5",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3-flash-preview",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash-0731",
] as const;
export const AgentModelOverrideSchema = z.enum(AGENT_MODEL_OVERRIDES);
export type AgentModelOverride = z.infer<typeof AgentModelOverrideSchema>;

export const MemberRoleSchema = z.enum(["owner", "admin", "member"]);
export const IanaTimezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a supported IANA timezone");

export const UserSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  name: z.string().min(1),
  avatarUrl: HttpUrlSchema.nullable(),
  timezone: IanaTimezoneSchema,
  createdAt: TimestampSchema
});

export const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  slug: z.string().min(2).max(80),
  region: RegionSchema,
  role: MemberRoleSchema,
  timezone: IanaTimezoneSchema,
  logAgentInference: z.boolean().default(false),
  createdAt: TimestampSchema
});

export const WorkspaceMemberSchema = z.object({
  user: UserSchema,
  role: MemberRoleSchema,
  status: z.enum(["active", "invited", "suspended"]),
  joinedAt: TimestampSchema.nullable()
});

export const WorkspaceInvitationRoleSchema = z.enum(["admin", "member"]);
export const WorkspaceInvitationStatusSchema = z.enum(["pending", "accepted", "expired", "revoked"]);
export const WorkspaceInvitationSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  role: WorkspaceInvitationRoleSchema,
  status: WorkspaceInvitationStatusSchema,
  invitedByName: z.string().min(1),
  expiresAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});
export const WorkspaceInvitationPreviewSchema = z.object({
  workspaceId: IdSchema,
  workspaceName: z.string().min(1).max(120),
  region: RegionSchema,
  email: z.string().email(),
  role: WorkspaceInvitationRoleSchema,
  expiresAt: TimestampSchema
});
export const PendingWorkspaceInvitationSchema = WorkspaceInvitationPreviewSchema.extend({
  id: IdSchema,
  invitedByName: z.string().min(1)
});
export const WorkspaceOnboardingStateSchema = z.object({
  workspace: WorkspaceSchema.nullable().default(null),
  invitations: z.array(PendingWorkspaceInvitationSchema)
});
export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  region: RegionSchema
});
export const OnboardingRegionRequestSchema = z.object({ region: RegionSchema });
export const ActivateWorkspaceRequestSchema = OnboardingRegionRequestSchema.extend({
  workspaceId: IdSchema
});
export const CreateWorkspaceInvitationRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  role: WorkspaceInvitationRoleSchema.default("member")
});
export const CreateWorkspaceInvitationResponseSchema = z.object({
  invitation: WorkspaceInvitationSchema,
  inviteUrl: HttpUrlSchema,
  emailDelivery: z.enum(["sent", "skipped"])
});
export const AcceptWorkspaceInvitationRequestSchema = z.object({
  token: z.string().min(20).max(500)
});

/**
 * How often Control Tower rewrites its briefing while a meeting records, in
 * seconds. One definition for the three places that need it: the flag resolver
 * that clamps what Flagship serves, the response schema below, and the desktop
 * timer that falls back to it.
 *
 * The bounds are what makes a served cadence safe to act on. Every refresh is
 * an inference, so a mistyped flag at the low end is a bill and a rate limit;
 * at the high end it is a briefing so stale the feature stops being live. The
 * default reproduces the behavior of a client that never asked.
 */
export const CONTROL_TOWER_REFRESH_SECONDS = {
  default: 60,
  minimum: 15,
  maximum: 600
} as const;

/**
 * Every server-decided feature flag a client is allowed to see, resolved for
 * the signed-in person. Each field defaults to the answer an unreachable flag
 * provider — or a response from an older service that does not know the field —
 * has to reproduce: off for a feature, and today's behavior for a setting that
 * has no off.
 */
export const ClientFeatureFlagsSchema = z.object({
  /** Whether Application → Developer may be offered on this device. */
  developerSettings: z.boolean().default(false),
  /**
   * Control Tower's refresh cadence in seconds. `catch` rather than a bare
   * bound: a value outside the range is a provisioning mistake, and degrading
   * it to the default keeps one bad flag from failing the whole response and
   * taking every other flag down with it.
   */
  controlTowerRefreshSeconds: z.number().int()
    .min(CONTROL_TOWER_REFRESH_SECONDS.minimum)
    .max(CONTROL_TOWER_REFRESH_SECONDS.maximum)
    .catch(CONTROL_TOWER_REFRESH_SECONDS.default)
    .default(CONTROL_TOWER_REFRESH_SECONDS.default)
});

export const ParticipantSchema = z.object({
  user: UserSchema,
  participationReason: z.enum(["creator", "explicit", "message", "elicitation", "action"]),
  joinedAt: TimestampSchema
});

export const ViewerSchema = z.object({
  user: UserSchema,
  connectedAt: TimestampSchema
});

export const WorkstreamOriginSchema = z.enum(["ad_hoc", "automation"]);

export const WorkstreamSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  title: z.string().min(1).max(180),
  /**
   * Who owns the title. `naming` means Avalon is still choosing one and the
   * stored title is a placeholder, so a surface that shows it renders a
   * skeleton; `automatic` means Avalon named it and one later pass may replace
   * it; `settled` means it will not change on its own again.
   */
  titleStatus: z.enum(["naming", "automatic", "settled"]).default("settled"),
  objective: z.string().max(4000),
  /** Stable inbound address. Null is transitional for pre-migration rows only. */
  emailAddress: z.string().email().max(254).nullable().default(null),
  originType: WorkstreamOriginSchema,
  originLabel: z.string().max(120).nullable(),
  createdByUserId: IdSchema.nullable(),
  automationSubscriptionId: IdSchema.nullable(),
  automationRunId: IdSchema.nullable(),
  plannedFor: TimestampSchema.nullable(),
  harnessStatus: HarnessStatusSchema,
  latestAttentionSequenceNumber: z.number().int().nonnegative(),
  readThroughSequenceNumber: z.number().int().nonnegative(),
  manualUnreadFromSequenceNumber: z.number().int().nonnegative().nullable(),
  manualUnreadGeneration: z.number().int().nonnegative(),
  hasUnread: z.boolean(),
  firstUnreadSequenceNumber: z.number().int().nonnegative().nullable(),
  lastActivityAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  /**
   * Who may read it, in the same vocabulary `notes` uses: `personal` is only the
   * people in it, `workspace` is anyone in the workspace. Declared on the row
   * and enforced from it, so "private" is a property rather than a rule a caller
   * has to remember.
   */
  scope: ScopeSchema.default("workspace"),
  /**
   * Non-null on a work stream that exists so a subsystem can use the agent loop
   * rather than because somebody started it. A separate question from `scope`:
   * this decides whether it is *listed*, that decides who may read it. Listing
   * surfaces leave these out unless the reader has asked to see them, and render
   * them as secondary when they do.
   */
  systemKind: z.enum(["digest"]).nullable().default(null),
  /**
   * Where this work stream sits in *the reader's* pinned list, or `null` when
   * they have not pinned it. Per-viewer the way the read-state fields above are:
   * the same row is pinned for one member and not for another, so a client must
   * never treat it as a property of the work stream itself.
   *
   * A position is an index into a dense ascending run, so it is only meaningful
   * relative to the reader's other pins and changes whenever they rearrange
   * them. Sort by it; do not store it as an identity.
   */
  pinPosition: z.number().int().nonnegative().nullable().default(null)
});

export const ExternalActorSchema = z.object({
  provider: z.string().min(1).max(80),
  providerAccountId: z.string().min(1).max(200),
  providerUserId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(180),
  avatarUrl: HttpUrlSchema.nullable(),
});

export const MessageAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("human"), user: UserSchema }),
  z.object({ type: z.literal("external"), actor: ExternalActorSchema }),
  z.object({ type: z.literal("agent") }),
  z.object({ type: z.literal("system") })
]);

export const MentionSchema = z.object({
  type: z.enum(["person", "connector"]),
  userId: IdSchema.nullable(),
  connectorType: z.string().max(80).nullable(),
  displayName: z.string().min(1).max(180).nullable().optional(),
  avatarUrl: HttpUrlSchema.nullable().optional(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive()
});

export const MessageAttachmentSchema = z.object({
  id: IdSchema,
  fileName: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  contentAvailable: z.boolean(),
  createdAt: TimestampSchema,
});

export const MessageSchema = z.object({
  id: IdSchema,
  clientMessageId: z.string().max(120).nullable(),
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  author: MessageAuthorSchema,
  messageType: z.enum(["text", "system", "tool", "artifact", "elicitation", "suggestion"]),
  textContent: z.string(),
  structuredContent: z.record(z.string(), z.unknown()).nullable(),
  mentions: z.array(MentionSchema),
  attachments: z.array(MessageAttachmentSchema).default([]),
  sequenceNumber: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.nullable()
});

export const ResourceSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  connectionId: IdSchema.nullable(),
  resourceType: z.string().min(1).max(80),
  provider: z.string().min(1).max(80),
  providerResourceId: z.string().max(500).nullable(),
  title: z.string().min(1).max(300),
  mimeType: z.string().max(160).nullable(),
  canonicalUrl: HttpUrlSchema.nullable(),
  watchEnabled: z.boolean(),
  watchStatus: z.enum(["watching", "paused", "unsupported", "error"]),
  lastHydratedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  contentAvailable: z.boolean().default(false),
  sizeBytes: z.number().int().nonnegative().default(0),
});

export const NoteRecordingStatusSchema = z.enum(["idle", "recording", "complete"]);

export const NoteTranscriptSegmentSchema = z.object({
  id: IdSchema,
  noteId: IdSchema,
  sequenceNumber: z.number().int().positive(),
  startOffsetMs: z.number().int().nonnegative(),
  endOffsetMs: z.number().int().nonnegative(),
  capturedAt: TimestampSchema,
  speakerLabel: z.string().trim().min(1).max(120).nullable(),
  text: z.string().trim().min(1).max(80_000),
  createdAt: TimestampSchema,
}).refine((segment) => segment.endOffsetMs >= segment.startOffsetMs, {
  message: "Segment end time must not precede its start time",
  path: ["endOffsetMs"],
});

export const NoteSummarySchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  resourceId: IdSchema,
  ownerUserId: IdSchema,
  scope: ScopeSchema,
  title: z.string().trim().min(1).max(180),
  recordingStatus: NoteRecordingStatusSchema,
  recordedMs: z.number().int().nonnegative(),
  startedAt: TimestampSchema.nullable(),
  endedAt: TimestampSchema.nullable(),
  generatedAt: TimestampSchema.nullable(),
  lastActivityAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});

export const NoteDetailSchema = NoteSummarySchema.extend({
  manualNotes: z.string().max(200_000),
  liveNotes: z.string().max(50_000),
  notesThroughSequence: z.number().int().nonnegative(),
  segments: z.array(NoteTranscriptSegmentSchema),
});

export const CreateNoteRequestSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1).max(180),
  scope: ScopeSchema.default("personal"),
}).strict();

export const UpdateNoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  manualNotes: z.string().max(200_000).optional(),
  scope: ScopeSchema.optional(),
  recordingStatus: NoteRecordingStatusSchema.optional(),
  recordedMs: z.number().int().nonnegative().optional(),
  startedAt: TimestampSchema.nullable().optional(),
  endedAt: TimestampSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one note field is required");

export const AppendNoteTranscriptSegmentRequestSchema = z.object({
  clientSegmentId: IdSchema,
  startOffsetMs: z.number().int().nonnegative(),
  endOffsetMs: z.number().int().nonnegative(),
  capturedAt: TimestampSchema,
  speakerLabel: z.string().trim().min(1).max(120).nullable().default(null),
  text: z.string().trim().min(1).max(80_000),
}).strict().refine((segment) => segment.endOffsetMs >= segment.startOffsetMs, {
  message: "Segment end time must not precede its start time",
  path: ["endOffsetMs"],
});

export const GenerateNoteNotesRequestSchema = z.object({
  mode: z.enum(["live", "final"]).default("live"),
  transcriptStatus: z.enum(["complete", "partial"]).default("partial"),
  /**
   * The refresh cadence the client is actually keeping, in seconds, so the live
   * briefing can be written for it. The client asks for the served cadence once
   * per meeting and holds it; the server would otherwise re-resolve the flag on
   * every pass and describe a schedule nobody is on for the rest of any meeting
   * the flag moved under. Omitted by a client that does not know it, which
   * leaves the server resolving the flag as before.
   */
  refreshSeconds: z.number().int()
    .min(CONTROL_TOWER_REFRESH_SECONDS.minimum)
    .max(CONTROL_TOWER_REFRESH_SECONDS.maximum)
    .optional(),
}).strict();

// Every run is always delivered to its Avalon work stream. These are the
// additional destinations a personal automation freezes when it is saved.
export const AutomationDeliveryTargetTypeSchema = z.enum(["slack_agent_dm", "email"]);

export const ConnectionSchema = z.object({
  id: IdSchema,
  modelPluginId: z.string().regex(/^plugin_[a-z][a-z0-9_]{0,62}$/u),
  workspaceId: IdSchema,
  connectorType: z.enum(["google", "generic_webhook", "github", "granola", "linear", "notion", "slack", "x"]),
  scope: ScopeSchema,
  ownerUserId: IdSchema.nullable(),
  ownerName: z.string().nullable(),
  displayName: z.string().min(1).max(180),
  grantedCapabilities: z.array(z.string()),
  status: z.enum(["healthy", "needs_reconnect", "error", "disabled"]),
  /**
   * Set when this connection can deliver automation results to the requesting
   * user right now — the connector declares the surface and, where the
   * installation is workspace-wide, that user has linked their own identity to
   * it. Null means the connection is not a personal destination.
   */
  userDelivery: z.object({
    targetType: AutomationDeliveryTargetTypeSchema,
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(240),
  }).nullable().default(null),
  lastSyncAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});

export const ModelPluginIdSchema = z.string().regex(/^plugin_[a-z][a-z0-9_]{0,62}$/u);
export const ActivitySourceBindingKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/u);
export const ActivitySourcePluginIdsSchema = z.record(ActivitySourceBindingKeySchema, ModelPluginIdSchema);
export const AutomationPluginIconSchema = z.enum([
  "brand-github",
  "brand-google",
  "brand-google-drive",
  "brand-notion",
  "brand-slack",
  "linear",
  "plug",
  "webhook",
  "world-search",
]);
export type AutomationPluginIcon = z.infer<typeof AutomationPluginIconSchema>;

export const AutomationPluginActivitySchema = z.object({
  pluginId: ModelPluginIdSchema,
  displayName: z.string().min(1).max(200),
  icon: AutomationPluginIconSchema,
});
export type AutomationPluginActivity = z.infer<typeof AutomationPluginActivitySchema>;

export const AutomationPluginRecommendationSchema = z.object({
  pluginId: ModelPluginIdSchema,
  recommendedTools: z.array(z.string().min(1).max(160)).max(40).default([]),
  reason: z.string().min(1).max(800),
});

export const AutomationDeliveryTargetInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slack_agent_dm"), connectionId: IdSchema }).strict(),
  z.object({ type: z.literal("email") }).strict(),
]);

export const MemoryTableColumnTypeSchema = z.enum([
  "string",
  "url",
  "number",
  "integer",
  "boolean",
  "datetime",
  "date",
]);

export const AutomationMemoryTableColumnSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  type: MemoryTableColumnTypeSchema,
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
}).strict();

export const AutomationMemoryTableSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  usageInstructions: z.string().trim().min(1).max(4000),
  columns: z.array(AutomationMemoryTableColumnSchema).min(1),
  keyColumns: z.array(z.string().trim().min(1).max(120)).min(1),
}).strict().superRefine((table, context) => {
  const names = new Map<string, number>();
  table.columns.forEach((column, index) => {
    const normalized = column.name.toLocaleLowerCase();
    if (names.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns", index, "name"],
        message: "Memory-table column names must be unique",
      });
    }
    names.set(normalized, index);
  });
  const keyNames = new Set<string>();
  table.keyColumns.forEach((name, index) => {
    const normalized = name.toLocaleLowerCase();
    if (!names.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyColumns", index],
        message: "Every key column must name a declared column",
      });
    }
    if (keyNames.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyColumns", index],
        message: "Key columns must be unique",
      });
    }
    keyNames.add(normalized);
  });
});

export const AutomationDraftElicitationSchema = z.object({
  responseType: z.enum(["free_text", "single_select", "multi_select"]),
  prompt: z.string().min(1).max(4000),
  placeholder: z.string().max(500).nullable().default(null),
  options: z.array(z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(300),
    description: z.string().max(800).nullable().default(null),
  })).max(30).default([]),
  minimumSelections: z.number().int().nonnegative().default(0),
  maximumSelections: z.number().int().positive().nullable().default(null),
  allowOther: z.boolean().default(false),
});

export const ToolInvocationSchema = z.object({
  id: IdSchema,
  harnessRunId: IdSchema,
  toolCallId: z.string().min(1).max(160),
  toolName: z.string().min(1).max(160),
  /**
   * Harness-generated prose naming what this row did. Null on rows persisted
   * before rows carried prose; those fall back to the raw tool name.
   */
  activityName: z.string().min(1).max(200).nullable().default(null),
  connectionId: IdSchema.nullable(),
  /**
   * The connector plugin that owns this tool, resolved from `connectionId`, or
   * null for Avalon-owned tools. Rows render this and only this as their icon.
   */
  plugin: AutomationPluginActivitySchema.nullable().default(null),
  status: z.enum(["pending", "started", "completed", "failed", "ambiguous"]),
  inputSummary: z.string().max(1000),
  outputSummary: z.string().max(4000).nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable()
});

export const HarnessRunMetadataSchema = z.object({
  id: IdSchema,
  origin: z.string().min(1).max(80),
  status: z.enum(["scheduled", "running", "needs_input", "completed", "failed", "stopped"]),
  model: z.string().max(160).nullable(),
  error: z.object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1200)
  }).nullable().optional(),
  requestId: z.string().min(1).max(160).nullable().optional(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});

export const WorkstreamArtifactSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  harnessRunId: IdSchema.nullable(),
  artifactType: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  previewText: z.string().max(4000).nullable(),
  status: z.string().min(1).max(80),
  mimeType: z.string().min(1).max(160),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export const BackgroundTaskSchema = z.object({
  id: IdSchema,
  harnessRunId: IdSchema,
  title: z.string().min(1).max(300),
  taskType: z.enum(["agent", "tool", "connector"]),
  status: z.enum(["running", "needs_input", "completed", "failed"]),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  tokenCount: z.number().int().nonnegative().nullable(),
  toolUses: z.number().int().nonnegative().nullable(),
  transcriptMessageId: IdSchema.nullable()
});

export const ElicitationOptionSchema = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
  description: z.string().max(800).nullable()
});
export const ElicitationSchema = z.object({
  id: IdSchema,
  workstreamId: IdSchema,
  harnessRunId: IdSchema,
  prompt: z.string().min(1).max(4000),
  responseType: z.enum(["text", "radio", "single_select", "multi_select"]),
  options: z.array(ElicitationOptionSchema),
  minimumSelections: z.number().int().nonnegative(),
  maximumSelections: z.number().int().positive().nullable(),
  targetUserId: IdSchema.nullable(),
  status: z.enum(["open", "answered", "cancelled"]),
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  answeredByUserId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  answeredAt: TimestampSchema.nullable()
});

export const ActivitySuggestionSchema = z.object({
  id: IdSchema,
  activityId: IdSchema,
  workstreamId: IdSchema,
  title: z.string().min(1).max(300),
  summary: z.string().max(2000),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1200),
  status: z.enum(["pending", "accepted", "dismissed"]),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable()
});

export const HyperSightBlockRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "stopped"
]);
export const HyperSightBlockRunSchema = z.object({
  id: IdSchema,
  blockId: IdSchema,
  configurationVersionId: IdSchema,
  triggerSequence: z.number().int().nonnegative(),
  status: HyperSightBlockRunStatusSchema,
  markdown: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable()
});
export const HyperSightBlockSchema = z.object({
  id: IdSchema,
  prompt: z.string().max(12_000),
  latestRun: HyperSightBlockRunSchema.nullable()
});
export const HyperSightSchema = z.object({
  versionId: IdSchema.nullable(),
  versionNumber: z.number().int().nonnegative(),
  blocks: z.array(HyperSightBlockSchema).max(24),
  updatedAt: TimestampSchema.nullable()
});
export const HyperSightPreferenceSchema = z.object({
  visible: z.boolean(),
  updatedAt: TimestampSchema.nullable()
});
export const UpdateHyperSightPreferenceRequestSchema = z.object({
  visible: z.boolean()
}).strict();
export const UpdateHyperSightRequestSchema = z.object({
  expectedVersionNumber: z.number().int().nonnegative(),
  blocks: z.array(z.object({
    id: IdSchema,
    prompt: z.string().max(12_000)
  }).strict()).max(24)
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.blocks.forEach((block, index) => {
    if (seen.has(block.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "HyperSight block IDs must be unique",
        path: ["blocks", index, "id"]
      });
    }
    seen.add(block.id);
  });
});

export const WorkstreamDetailSchema = WorkstreamSchema.extend({
  participants: z.array(ParticipantSchema),
  viewers: z.array(ViewerSchema),
  resources: z.array(ResourceSchema),
  connections: z.array(ConnectionSchema),
  artifacts: z.array(WorkstreamArtifactSchema).default([]),
  backgroundTasks: z.array(BackgroundTaskSchema).default([]),
  openElicitations: z.array(ElicitationSchema),
  suggestions: z.array(ActivitySuggestionSchema),
  latestHarnessRunId: IdSchema.nullable(),
  latestHarnessRun: HarnessRunMetadataSchema.nullable().optional()
});

export const WorkstreamContextSchema = z.object({
  artifacts: z.array(WorkstreamArtifactSchema),
  backgroundTasks: z.array(BackgroundTaskSchema)
});

export const TriggerDefinitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("calendar"),
    rrule: z.string().min(1),
    timezone: IanaTimezoneSchema,
    summary: z.string().min(1)
  }),
  z.object({
    type: z.literal("interval"),
    intervalSeconds: z.number().int().min(60),
    summary: z.string().min(1)
  }),
  z.object({
    type: z.literal("connector_activity"),
    connectorType: z.string().min(1),
    sourceBindingKey: ActivitySourceBindingKeySchema.optional(),
    suggestedSourcePluginId: ModelPluginIdSchema.optional(),
    eventTypes: z.array(z.string().min(1)).min(1),
    deterministicFilters: z.record(z.string(), z.unknown())
  }),
  z.object({
    type: z.literal("semantic_activity"),
    connectorType: z.string().min(1).nullable(),
    sourceBindingKey: ActivitySourceBindingKeySchema.optional(),
    suggestedSourcePluginId: ModelPluginIdSchema.optional(),
    deterministicPrefilter: z.record(z.string(), z.unknown()),
    condition: z.string().min(1)
  }),
  z.object({ type: z.literal("resource_watch"), resourceId: IdSchema }),
  z.object({
    type: z.literal("webhook"),
    sourceBindingKey: ActivitySourceBindingKeySchema.optional(),
    suggestedSourcePluginId: ModelPluginIdSchema.optional(),
    eventTypes: z.array(z.string()).min(1)
  })
]);

export const AutomationDraftSchema = z.object({
  name: z.string().min(1).max(140),
  description: z.string().min(1).max(1200),
  overview: z.string().min(1).max(3000),
  instructions: z.string().min(1).max(12000),
  triggers: z.array(TriggerDefinitionSchema).min(1),
  requiredCapabilities: z.array(z.string()).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  defaultBehavior: z.record(z.string(), z.unknown()).default({}),
  recommendedPlugins: z.array(AutomationPluginRecommendationSchema).default([]),
  memoryTables: z.array(AutomationMemoryTableSchema).default([]),
  suggestedScope: ScopeSchema,
  followUpQuestion: z.string().nullable(),
  elicitation: AutomationDraftElicitationSchema.nullable().default(null),
  ready: z.boolean()
}).superRefine((draft, context) => {
  const names = new Set<string>();
  draft.memoryTables.forEach((table, index) => {
    const normalized = table.name.toLocaleLowerCase();
    if (names.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memoryTables", index, "name"],
        message: "Memory-table names must be unique within an automation",
      });
    }
    names.add(normalized);
  });
  const sourceBindings = new Map<string, { connectorType: string; pluginId: string }>();
  draft.triggers.forEach((trigger, index) => {
    if (trigger.type !== "connector_activity" && trigger.type !== "semantic_activity" && trigger.type !== "webhook") return;
    const connectorType = trigger.type === "webhook" ? "generic_webhook" : trigger.connectorType;
    if (!draft.ready) return;
    if (!trigger.sourceBindingKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "sourceBindingKey"],
        message: "Ready activity triggers require a source binding key",
      });
    }
    if (!trigger.suggestedSourcePluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "suggestedSourcePluginId"],
        message: "Ready activity triggers require an inspected source plugin",
      });
    }
    if (trigger.type === "semantic_activity" && connectorType == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "connectorType"],
        message: "Ready semantic activity triggers require a concrete connector type",
      });
    }
    if (
      trigger.type === "semantic_activity"
      && (typeof trigger.deterministicPrefilter.eventType !== "string" || trigger.deterministicPrefilter.eventType.trim().length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "deterministicPrefilter", "eventType"],
        message: "Ready semantic activity triggers require one declared event type",
      });
    }
    if (!trigger.sourceBindingKey || !trigger.suggestedSourcePluginId || !connectorType) return;
    const previous = sourceBindings.get(trigger.sourceBindingKey);
    if (previous && (previous.connectorType !== connectorType || previous.pluginId !== trigger.suggestedSourcePluginId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers", index, "sourceBindingKey"],
        message: "Reused activity source binding keys must identify the same connector and suggested plugin",
      });
      return;
    }
    sourceBindings.set(trigger.sourceBindingKey, { connectorType, pluginId: trigger.suggestedSourcePluginId });
  });
});

export const AutomationDraftStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started") }),
  z.object({
    type: z.literal("thinking"),
    inferenceRequestId: z.string().min(1).max(200),
    status: z.enum(["started", "completed"]),
    durationMs: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("delta"),
    delta: z.string(),
    reset: z.boolean().default(false)
  }),
  z.object({
    type: z.literal("tool"),
    toolCallId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    summary: z.string().min(1).max(1000),
    status: z.enum(["started", "completed", "failed"]),
    /** The single plugin that owns this tool, or null for Avalon-owned tools. */
    plugin: AutomationPluginActivitySchema.nullable().default(null),
    durationMs: z.number().int().nonnegative().optional()
  }),
  z.object({
    type: z.literal("completed"),
    /**
     * The draft subscription this turn wrote. It is the automation's real id
     * from the first turn onward — the row the sidebar lists, the next turn
     * updates, and creation promotes — so the client adopts it rather than
     * keeping the key it opened the conversation with.
     */
    draftId: IdSchema,
    draft: AutomationDraftSchema,
    assistantMessage: z.string().min(1)
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      status: z.number().int().min(0).max(599),
      code: z.string().min(1),
      message: z.string().min(1),
      requestId: z.string().min(1).nullable().default(null),
      details: z.record(z.string(), z.unknown()).optional()
    })
  })
]);

export const AutomationCompilerMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string()
});

/**
 * A draft automation as the compiler left it: the transcript so far, the
 * resources it was given, and the draft it last produced. It is what the
 * builder screen needs to pick a draft back up out of the sidebar, and exactly
 * what the next compile turn sends back.
 */
export const AutomationDraftStateSchema = z.object({
  draftId: IdSchema,
  messages: z.array(AutomationCompilerMessageSchema),
  attachmentIds: z.array(IdSchema).default([]),
  draft: AutomationDraftSchema
});

export const AutomationSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  emailAddress: z.string().email().nullable().default(null),
  scope: ScopeSchema,
  status: z.enum(["draft", "active", "paused", "error"]),
  nextRunAt: TimestampSchema.nullable(),
  lastRunAt: TimestampSchema.nullable(),
  /** Last time the subscription itself changed. It is the only activity a draft
   * has, since a draft never runs. */
  updatedAt: TimestampSchema,
  updateAvailable: z.boolean()
});

export const AutomationRunSchema = z.object({
  id: IdSchema,
  automationSubscriptionId: IdSchema,
  workstreamId: IdSchema,
  triggerType: z.string(),
  plannedFor: TimestampSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  status: HarnessStatusSchema,
  resultSummary: z.string().nullable(),
  createdAt: TimestampSchema
});

export const AutomationTemplateUpdateSchema = z.object({
  versionId: IdSchema,
  versionNumber: z.number().int().positive(),
  instructions: z.string(),
  overview: z.string(),
  triggers: z.array(TriggerDefinitionSchema),
  requiredCapabilities: z.array(z.string()),
  expectedOutputs: z.array(z.string()),
  recommendedPlugins: z.array(AutomationPluginRecommendationSchema).default([]),
  memoryTables: z.array(AutomationMemoryTableSchema).default([]),
});

export const AutomationDetailSchema = AutomationSummarySchema.extend({
  templateId: IdSchema,
  templateVersionId: IdSchema,
  versionNumber: z.number().int().positive(),
  instructions: z.string(),
  overview: z.string(),
  triggers: z.array(TriggerDefinitionSchema),
  requiredCapabilities: z.array(z.string()),
  expectedOutputs: z.array(z.string()).default([]),
  executionPrincipal: z.record(z.string(), z.unknown()),
  recommendedPlugins: z.array(AutomationPluginRecommendationSchema).default([]),
  memoryTables: z.array(AutomationMemoryTableSchema).default([]),
  defaultPluginIds: z.array(ModelPluginIdSchema).default([]),
  activitySourcePluginIds: ActivitySourcePluginIdsSchema.default({}),
  deliveryTargets: z.array(z.object({
    type: AutomationDeliveryTargetTypeSchema,
    connectionId: IdSchema.nullable().default(null),
    displayName: z.string().min(1).max(320),
    status: z.enum(["active", "needs_input", "disabled"]),
  })).default([]),
  templateUpdate: AutomationTemplateUpdateSchema.nullable().default(null),
  nextPlannedWorkstream: WorkstreamSchema.nullable(),
  recentRuns: z.array(AutomationRunSchema)
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

export const CursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const SessionSchema = z.object({
  accessToken: z.string().min(20),
  refreshToken: z.string().min(20),
  expiresAt: TimestampSchema,
  user: UserSchema,
  workspace: WorkspaceSchema.nullable(),
  apiBaseUrl: HttpUrlSchema
});

export const DesktopExchangeRequestSchema = z.object({
  ticket: z.string().min(20).max(500),
  region: RegionSchema,
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  timezone: IanaTimezoneSchema.default("America/Los_Angeles")
});
export const ConnectorOAuthProviderSchema = z.enum(ConnectorOAuthProviders);
export const ConnectorOAuthAttemptStatusSchema = z.enum(["pending", "succeeded", "denied", "failed"]);
export const ConnectorOAuthStartSchema = z.object({
  url: HttpUrlSchema,
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export const ConnectorOAuthAttemptSchema = z.object({
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  provider: ConnectorOAuthProviderSchema,
  status: ConnectorOAuthAttemptStatusSchema,
  connectionId: IdSchema.nullable(),
  errorCode: z.string().regex(/^[a-z0-9_-]{1,100}$/u).nullable(),
  expiresAt: TimestampSchema,
});
export const RefreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,500}$/u);
export const RefreshRequestSchema = z.object({ refreshToken: RefreshTokenSchema });
export const UpdateUserTimezoneRequestSchema = z.object({ timezone: IanaTimezoneSchema });
export const UpdateWorkspaceRequestSchema = z.object({
  timezone: IanaTimezoneSchema.optional(),
  logAgentInference: z.boolean().optional(),
}).refine(
  (value) => value.timezone !== undefined || value.logAgentInference !== undefined,
  "At least one workspace preference is required",
);

// --- Digest ---------------------------------------------------------------

/** Sunday through Saturday, matching `Date#getDay` so no table maps between. */
export const DigestWeekdaySchema = z.number().int().min(0).max(6);
/** Local wall-clock minute in the schedule's own timezone. */
export const DigestMinuteOfDaySchema = z.number().int().min(0).max(1439);

/**
 * A destination a digest can be sent to. `email` is always offered and needs no
 * connector; every other value is a connector's declared `userDelivery` surface,
 * which is why this is the connector target enum plus nothing — the two lists
 * are the same list, and a connector declaring a new surface must not need a
 * contract change to become a digest destination.
 */
export const DigestDeliveryTargetTypeSchema = AutomationDeliveryTargetTypeSchema;

export const DigestDeliveryTargetSchema = z.object({
  type: DigestDeliveryTargetTypeSchema,
  connectionId: IdSchema.nullable().default(null),
  /** What the destination is called in the UI, frozen when it was chosen. */
  displayName: z.string().min(1).max(320),
  status: z.enum(["active", "needs_input", "disabled"]),
  lastDeliveredAt: TimestampSchema.nullable().default(null),
});

export const DigestScheduleSchema = z.object({
  id: IdSchema,
  enabled: z.boolean(),
  /** Deduplicated and ascending, so the UI never has to sort or dedupe. */
  days: z.array(DigestWeekdaySchema).max(7),
  times: z.array(DigestMinuteOfDaySchema).max(12),
  /**
   * Read-only. A digest runs in its owner's own day, so this mirrors their
   * account timezone rather than storing a second one that could disagree.
   */
  timezone: IanaTimezoneSchema,
  deliveryTargets: z.array(DigestDeliveryTargetSchema).max(8),
  nextRunAt: TimestampSchema.nullable(),
  lastDeliveredAt: TimestampSchema.nullable(),
});

/**
 * The one write. A digest is a small, wholly-owned configuration, so it is
 * replaced rather than patched — that keeps "no days selected" and "no times
 * selected" expressible, which a partial update cannot do.
 */
export const UpdateDigestScheduleRequestSchema = z.object({
  enabled: z.boolean(),
  days: z.array(DigestWeekdaySchema).max(7),
  times: z.array(DigestMinuteOfDaySchema).max(12),
  deliveryTargets: z.array(z.object({
    type: DigestDeliveryTargetTypeSchema,
    connectionId: IdSchema.nullable().default(null),
  })).max(8),
}).refine(
  // An enabled digest that names no day, no time, or nowhere to go would sit in
  // the scheduler forever without ever producing anything a person receives.
  (value) => !value.enabled
    || (value.days.length > 0 && value.times.length > 0 && value.deliveryTargets.length > 0),
  "An enabled digest needs at least one day, one time, and one destination",
);

export const CreateWorkstreamRequestSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  objective: z.string().trim().min(1).max(4000).optional(),
  participantUserIds: z.array(IdSchema).max(25).default([]),
  openingMessage: z.string().max(50000),
  clientMessageId: z.string().min(1).max(120),
  attachmentIds: z.array(IdSchema).max(10).default([]),
  /**
   * Pins every run of this work stream to one OpenRouter model, ahead of the
   * `agent-model-workstream` flag. Sent only by the composer's developer-mode
   * selector; omitted means the flag decides, which is what every other create
   * path does.
   */
  modelOverride: AgentModelOverrideSchema.optional(),
}).refine((value) => value.openingMessage.trim().length > 0 || value.attachmentIds.length > 0, {
  message: "An opening message must include text or an attachment",
});

export const WorkOpportunitySchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  displayPrompt: z.string().min(1).max(180),
  icon: AutomationPluginIconSchema,
  sourceLabel: z.string().min(1).max(180),
});
export const WorkOpportunityPageSchema = z.object({
  items: z.array(WorkOpportunitySchema).max(4),
});
export const RecordWorkOpportunityImpressionsRequestSchema = z.object({
  opportunityIds: z.array(IdSchema).max(4),
});
export const StartWorkOpportunityRequestSchema = z.object({
  version: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(120),
});

export const UpdateWorkstreamRequestSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  objective: z.string().max(4000).optional(),
  archived: z.boolean().optional(),
  /**
   * Who may read it from now on. `personal` narrows the work stream to the
   * people already in it, `workspace` opens it to every member. Anyone who can
   * read a work stream may move it either way, because a private work stream is
   * shared work with a smaller room rather than one person's property.
   */
  scope: ScopeSchema.optional()
});

export const AcknowledgeWorkstreamReadRequestSchema = z.object({
  readThroughSequenceNumber: z.number().int().nonnegative(),
  observedManualUnreadGeneration: z.number().int().nonnegative(),
});

/**
 * The whole pinned list in its new order, not a move of one row.
 *
 * A drag produces a complete arrangement, and sending that arrangement is what
 * lets the server write a dense run without inferring one from an index whose
 * meaning depends on a list state the client may no longer share. Ids the
 * caller has since unpinned elsewhere are ignored rather than rejected, and
 * pins the caller does not name keep their relative order behind the ones it
 * did — a second window that pinned something a moment ago loses its position,
 * never its pin.
 *
 * Deliberately unbounded. Nothing limits how many work streams a person may
 * pin, so any count this array could be capped at would be a number the server
 * can legitimately exceed — and the arrangement is all-or-nothing, so a cap
 * would not truncate a drag, it would refuse one and leave the list
 * unreorderable for as long as the person stayed above it.
 */
export const ReorderWorkstreamPinsRequestSchema = z.object({
  workstreamIds: z.array(IdSchema),
});

export const CreateMessageRequestSchema = z.object({
  text: z.string().max(50000),
  clientMessageId: z.string().min(1).max(120),
  mentions: z.array(MentionSchema).default([]),
  confirmedParticipantUserIds: z.array(IdSchema).default([]),
  attachmentIds: z.array(IdSchema).max(10).default([]),
}).refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0, {
  message: "A message must include text or an attachment",
});

export const AddParticipantRequestSchema = z.object({ userId: IdSchema });
const ElicitationAnswerValueSchema = z.union([
  z.string().trim().min(1).max(4000),
  z.array(z.string().trim().min(1).max(4000)).min(1).max(30)
]);
export const AnswerElicitationRequestSchema = z.union([
  z.object({
    answer: ElicitationAnswerValueSchema,
    customResponse: z.string().trim().min(1).max(4000).optional(),
    skipped: z.literal(false).optional()
  }).strict(),
  z.object({
    skipped: z.literal(true)
  }).strict()
]);
export const CreateAutomationRequestSchema = z.object({
  /**
   * The draft this automation was built from. Creating promotes that row in
   * place — same id, same sidebar position — instead of leaving the draft
   * behind beside the automation it became. Absent only when an automation is
   * created without ever having been a draft.
   */
  draftId: IdSchema.optional(),
  draft: AutomationDraftSchema,
  scope: ScopeSchema,
  defaultPluginIds: z.array(ModelPluginIdSchema).default([]),
  activitySourcePluginIds: ActivitySourcePluginIdsSchema.default({}),
  resourceIds: z.array(IdSchema).max(20).default([]),
  deliveryTargets: z.array(AutomationDeliveryTargetInputSchema).max(2).default([]),
  /**
   * Pins the work stream each run of this automation creates to one OpenRouter
   * model. Same developer-mode selector as a new work stream, held on the
   * subscription because the runs it applies to do not exist yet.
   */
  modelOverride: AgentModelOverrideSchema.optional(),
}).superRefine((input, context) => {
  if (input.deliveryTargets.length > 0 && input.scope !== "personal") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryTargets"], message: "Result delivery outside Avalon requires a personal automation" });
  }
  const types = new Set<string>();
  for (const target of input.deliveryTargets) {
    if (types.has(target.type)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryTargets"], message: "Each delivery destination can be chosen once" });
      break;
    }
    types.add(target.type);
  }
});
export const CompileAutomationRequestSchema = z.object({
  /**
   * The draft subscription this conversation is already writing to. Absent on
   * the first turn, and ignored when it names anything but a visible draft the
   * caller owns — a compile turn may update a draft, never an automation that
   * runs.
   */
  draftId: IdSchema.optional(),
  messages: z.array(AutomationCompilerMessageSchema).min(1),
  currentDraft: AutomationDraftSchema.nullable().default(null),
  attachmentIds: z.array(IdSchema).max(10).default([]),
});
export const CreateWebhookConnectionRequestSchema = z.object({
  displayName: z.string().min(1).max(180),
  scope: ScopeSchema,
  eventTypes: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  idempotencyKey: z.string().trim().min(1).max(120).optional()
});

export const ClientSocketEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), afterSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("create_message"), payload: CreateMessageRequestSchema }),
  z.object({ type: z.literal("stop_harness") }),
  z.object({ type: z.literal("answer_elicitation"), elicitationId: IdSchema, payload: AnswerElicitationRequestSchema }),
  z.object({ type: z.literal("add_participant"), userId: IdSchema }),
  z.object({ type: z.literal("remove_participant"), userId: IdSchema }),
  z.object({ type: z.literal("attach_resource"), resourceId: IdSchema }),
  z.object({ type: z.literal("detach_resource"), resourceId: IdSchema }),
  z.object({ type: z.literal("accept_activity_suggestion"), suggestionId: IdSchema }),
  z.object({ type: z.literal("dismiss_activity_suggestion"), suggestionId: IdSchema })
]);

const ServerEventBaseSchema = z.object({
  sequence: z.number().int().nonnegative(),
  occurredAt: TimestampSchema
});
const StreamEventBaseSchema = ServerEventBaseSchema.extend({
  /** Stable identity for one model turn, across retries and route fallbacks. */
  turnId: z.string().min(1).max(180),
  /** Increments whenever a turn restarts on the same or a fallback route. */
  epoch: z.number().int().nonnegative(),
  /** Monotonic within one turn epoch; distinct from the room event sequence. */
  streamSeq: z.number().int().nonnegative()
});
/**
 * The close code the work-stream room uses when it disconnects a socket whose
 * reader may no longer see the work stream.
 *
 * It is `1008` (policy violation) rather than an application code because the
 * close frame is the whole message — there is no event body to carry a reason
 * to somebody who is no longer allowed one. The client distinguishes it from
 * every other close: an ordinary close reconnects, this one must not, because
 * the reconnect would 404 forever with a transcript still on screen.
 *
 * The room deliberately uses `1011` when it cannot *establish* who may stay, so
 * that case still reconnects and is re-authorized rather than dead-ending.
 */
export const WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE = 1008;

export const ServerSocketEventSchema = z.discriminatedUnion("type", [
  ServerEventBaseSchema.extend({ type: z.literal("snapshot"), workstream: WorkstreamDetailSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("presence_changed"), viewers: z.array(ViewerSchema) }),
  ServerEventBaseSchema.extend({ type: z.literal("message_created"), message: MessageSchema }),
  /** The title changed — a person renamed the work stream, or Avalon named it. */
  ServerEventBaseSchema.extend({
    type: z.literal("workstream_renamed"),
    title: z.string().min(1).max(180),
    titleStatus: z.enum(["automatic", "settled"])
  }),
  /**
   * Who may read this work stream changed. Everyone still in the room learns
   * the new state so the lock on their sidebar row and the header they are
   * reading agree with it; those the change just excluded are disconnected by
   * the room rather than told.
   */
  ServerEventBaseSchema.extend({
    type: z.literal("workstream_scope_changed"),
    scope: ScopeSchema
  }),
  StreamEventBaseSchema.extend({
    type: z.literal("stream_started"),
    messageId: IdSchema,
    harnessRunId: IdSchema,
    reset: z.literal(false)
  }),
  StreamEventBaseSchema.extend({
    type: z.literal("stream_delta"),
    messageId: IdSchema,
    delta: z.string(),
    /** Replaces text from the prior attempt instead of concatenating it. */
    reset: z.boolean()
  }),
  ServerEventBaseSchema.extend({ type: z.literal("stream_completed"), message: MessageSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("harness_status_changed"), status: HarnessStatusSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("tool_started"), invocation: ToolInvocationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("tool_completed"), invocation: ToolInvocationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("tool_failed"), invocation: ToolInvocationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("elicitation_created"), elicitation: ElicitationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("elicitation_answered"), elicitation: ElicitationSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("participant_added"), participant: ParticipantSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("participant_removed"), userId: IdSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("resource_attached"), resource: ResourceSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("resource_updated"), resource: ResourceSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("activity_suggestion_created"), suggestion: ActivitySuggestionSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("activity_suggestion_resolved"), suggestion: ActivitySuggestionSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("hypersight_configuration_updated"), hypersight: HyperSightSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("hypersight_block_run_updated"), run: HyperSightBlockRunSchema }),
  ServerEventBaseSchema.extend({
    type: z.literal("resync_required"),
    reason: z.enum(["history_unavailable", "sequence_ahead"]),
    latestSequence: z.number().int().nonnegative()
  }),
  ServerEventBaseSchema.extend({ type: z.literal("error"), code: z.string(), message: z.string() })
]);

/** Events delivered to one authenticated user and intentionally excluded from room replay sequencing. */
export const PersonalSocketEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hypersight_preference_updated"),
    occurredAt: TimestampSchema,
    preference: HyperSightPreferenceSchema
  })
]);

export const GenerateMeetingNotesRequestSchema = z.object({
  mode: z.enum(["live", "final"]).default("live"),
  meetingTitle: z.string().trim().min(1).max(180).default("Meeting notes"),
  transcript: z.string().trim().min(1).max(400_000),
  recentTranscript: z.string().max(100_000).default(""),
  previousNotes: z.string().max(50_000).default(""),
  userNotes: z.string().max(200_000).default(""),
  startedAt: TimestampSchema.nullable().default(null),
  endedAt: TimestampSchema.nullable().default(null),
  transcriptStatus: z.enum(["complete", "partial"]).default("partial"),
  /** The cadence the client is keeping; null means resolve the flag instead. */
  refreshSeconds: z.number().int()
    .min(CONTROL_TOWER_REFRESH_SECONDS.minimum)
    .max(CONTROL_TOWER_REFRESH_SECONDS.maximum)
    .nullable()
    .default(null),
}).strict();

export const MeetingNotesResponseSchema = z.object({
  notes: z.string().trim().min(1).max(50_000),
  generatedAt: TimestampSchema
});

/**
 * Set on a normalized activity's metadata when the polling stream that produced
 * it is not digestible, so the withholding survives the queue and the
 * `activities` row into the moment the activity log is written.
 *
 * A metadata key rather than a column because it is a stream's veto over its own
 * output, not a property of the activity that any other surface reads: nothing
 * queries on it, and the event type remains the authority on what a digest may
 * contain. The leading underscore is the same convention the activity
 * consumer's processing-claim keys already use for host-owned metadata.
 */
export const ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY = "_streamNotDigestible";

export const NormalizedActivitySchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  region: RegionSchema,
  connectionId: IdSchema,
  connectionScope: ScopeSchema,
  connectionOwnerUserId: IdSchema.nullable(),
  provider: z.string().min(1),
  providerEventId: z.string().min(1),
  eventType: z.string().min(1),
  resourceType: z.string().nullable(),
  providerResourceId: z.string().nullable(),
  actor: z.record(z.string(), z.unknown()),
  subject: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema,
  receivedAt: TimestampSchema,
  title: z.string().min(1),
  summary: z.string(),
  textSnippet: z.string().max(4000),
  payloadRef: z.string().nullable(),
  visibility: z.record(z.string(), z.unknown()),
  targetUserIds: z.array(IdSchema),
  entityKeys: z.array(z.string()),
  dedupeKey: z.string().min(1),
  rawContentHash: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  externalPeople: z.array(z.object({
    provider: z.string().min(1).max(80),
    providerTenantId: z.string().min(1).max(200).nullable(),
    providerUserId: z.string().min(1).max(200).nullable(),
    handle: z.string().min(1).max(200).nullable(),
    email: z.string().email().max(254).nullable(),
    displayName: z.string().min(1).max(180).nullable(),
    role: z.string().min(1).max(80),
    sourceText: z.string().min(1).max(1000),
  }).strict()).max(100).optional()
});

export const ActivityQueueMessageSchema = z.object({
  region: RegionSchema,
  workspaceId: IdSchema,
  activityId: IdSchema,
  attempt: z.number().int().nonnegative().default(0)
});

export const SlackIngressQueueMessageSchema = z.object({
  kind: z.literal("slack_ingress"),
  region: RegionSchema,
  workspaceId: IdSchema,
  jobId: z.string().min(1),
});

export const ExecutionPrincipalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: IdSchema }),
  z.object({ type: z.literal("workspace"), workspaceId: IdSchema })
]);

export const SlackOriginAttachmentSchema = z.object({
  id: z.string().min(1).max(255).nullable(),
  name: z.string().min(1).max(500),
  title: z.string().max(500).nullable(),
  mimeType: z.string().max(255).nullable(),
  fileType: z.string().max(120).nullable(),
  permalink: httpUrlSchema(2000).nullable()
}).strict();

export const SlackOriginNearbyMessageSchema = z.object({
  timestamp: z.string().min(1).max(80),
  userId: z.string().min(1).max(255).nullable(),
  text: z.string().max(2000),
  attachments: z.array(SlackOriginAttachmentSchema).max(10)
}).strict();

export const SlackOriginContextSchema = z.object({
  teamId: z.string().min(1).max(255),
  channelId: z.string().min(1).max(255).nullable(),
  channelName: z.string().min(1).max(255).nullable(),
  threadTs: z.string().min(1).max(80).nullable(),
  invocationType: z.enum(["app_mention", "direct_message", "slash_command", "shortcut"]),
  channelType: z.enum(["public", "private", "im", "unknown"]),
  matchedAvalonUserId: IdSchema.nullable(),
  nearbyMessagesStatus: z.enum(["available", "unavailable", "not_applicable"]),
  nearbyMessages: z.array(SlackOriginNearbyMessageSchema).max(8),
  attachments: z.array(SlackOriginAttachmentSchema).max(10),
  appContext: z.object({
    entities: z.array(z.object({
      type: z.string().min(1).max(255),
      value: z.string().min(1).max(1000),
      teamId: z.string().min(1).max(255).nullable()
    }).strict()).max(32)
  }).strict().nullable().optional()
}).strict();

/**
 * Short-lived Slack authorization attached to a user-initiated Events API
 * delivery. This is runtime-only credential material: it must never be
 * rendered into model instructions, messages, tool arguments, or logs.
 */
export const SlackSearchAuthorizationSchema = z.object({
  actionToken: z.string().min(1).max(4096)
}).strict();

export const WorkstreamWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  harnessRunId: IdSchema,
  triggerMessageId: IdSchema.nullable(),
  /**
   * The newest message this run may see, when that is not the trigger.
   *
   * The trigger doubles as the transcript's upper bound, which is right for a
   * run a message started and wrong for a `retry`: the failed run's trigger has
   * to stay the trigger — it is what admits a suggested-work brief or an
   * inbound email to the model — while the replay still needs to see anything
   * said since, including a correction that started no run of its own. Resolved
   * at launch rather than at projection time so a replayed attempt reads the
   * same window. Optional rather than nullable so every existing producer keeps
   * parsing unchanged.
   */
  transcriptFenceMessageId: IdSchema.nullable().optional(),
  automationSubscriptionId: IdSchema.nullable(),
  activityId: IdSchema.nullable(),
  /**
   * Set when the workspace scheduler started this run from a due wake-up. The
   * run reads the wake-up's prompt as its trigger. Optional rather than
   * nullable so every existing producer keeps parsing unchanged.
   */
  scheduledWakeupId: IdSchema.optional(),
  /**
   * Set when the workspace scheduler started this run to write a scheduled
   * digest. The run reads its window from the delivery row and the delivery is
   * what gets sent when the run finishes. Optional for the same reason
   * `scheduledWakeupId` is: every existing producer keeps parsing unchanged.
   */
  digestDeliveryId: IdSchema.optional(),
  executionPrincipal: ExecutionPrincipalSchema,
  slackOrigin: SlackOriginContextSchema.optional(),
  slackSearchAuthorization: SlackSearchAuthorizationSchema.optional(),
  reason: z.string().min(1).max(500)
});
export const ConnectorPollWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: IdSchema,
  connectionId: IdSchema,
  pollScheduleId: IdSchema
});

export const AddressingClassificationSchema = z.object({
  classification: z.enum(["agent_action", "human_only", "both", "uncertain"]),
  confidence: z.number().min(0).max(1),
  rationaleCode: z.enum([
    "imperative",
    "question",
    "connector_mention",
    "avalon_reference",
    "active_task",
    "elicitation_answer",
    "human_coordination",
    "social_acknowledgement",
    "insufficient_signal"
  ])
});

/**
 * How long a work stream may report that it is being named.
 *
 * Naming takes about a second, so a work stream still saying `naming` well
 * after it was created is one whose background pass never finished — the
 * isolate went away before it could settle — and its provisional title is now
 * its title. Both sides of the wire apply this: the API stops *reporting*
 * `naming` past the grace, and a client applies it to what it already holds,
 * because a rename event that was never delivered leaves a client with a row no
 * read will correct. Shared here so the two cannot drift apart and leave a
 * skeleton pulsing on a surface whose backstop expired somewhere else.
 */
export const WORKSTREAM_NAMING_GRACE_MS = 60_000;

/**
 * One generated work-stream name. Bounded well under the 180 characters a
 * title may hold: the prompt asks for under 60, and the ceiling is here to stop
 * a model that answers the request instead of naming it, not to be aimed at.
 */
export const WorkstreamNameResultSchema = z.object({
  title: z.string().trim().min(1).max(80)
});

export const ActivityRoutingResultSchema = z.object({
  candidateWorkstreamId: IdSchema.nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1000),
  matchedEntities: z.array(z.string()),
  suggest: z.boolean()
});

export const ToolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  capability: z.string().min(1),
  mode: z.enum(["read", "write"]),
  idempotency: z.enum(["safe", "provider_key", "record_before_execute"]),
  /** Optional per-tool ceiling. The host still applies its overall run limit. */
  timeoutMs: z.number().int().positive().max(300_000).optional()
});

/**
 * Connector surfaces are composable. A provider such as Linear can expose its
 * ordinary resources and tools while also hosting Avalon as a native agent.
 * Legacy manifests omit this field and normalize to the resource surface.
 */
export const ConnectorSurfaceSchema = z.enum(["resource", "native_agent", "messaging_agent"]);

export const NativeAgentInvocationModeSchema = z.enum([
  "delegation",
  "mention",
  "follow_up"
]);

export const NativeAgentActivityKindSchema = z.enum([
  "thought",
  "action",
  "elicitation",
  "response",
  "error"
]);

export const ConnectorSurfaceMaturitySchema = z.enum(["stable", "preview"]);
export const ConnectorSurfaceRuntimeStatusSchema = z.enum(["protocol_only", "operational"]);
export const NativeAgentSessionOwnershipSchema = z.enum([
  "single_connection_per_provider_account",
  "connection_scoped"
]);

export const NativeAgentSurfaceSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  invocationModes: z.array(NativeAgentInvocationModeSchema).min(1),
  activityKinds: z.array(NativeAgentActivityKindSchema).min(1),
  supportsCancellation: z.boolean(),
  supportsExternalLinks: z.boolean(),
  supportsPlans: z.boolean(),
  supportsProactiveSessions: z.boolean().default(false),
  maturity: ConnectorSurfaceMaturitySchema.default("stable"),
  /** Protocol support may ship before the coordinating runtime is safe to enable. */
  runtimeStatus: ConnectorSurfaceRuntimeStatusSchema,
  /** How provider-native sessions select one authorized Avalon connection. */
  sessionOwnership: NativeAgentSessionOwnershipSchema,
  /** Maximum time the provider allows before the signed webhook is acknowledged. */
  webhookResponseDeadlineMs: z.number().int().positive().max(60_000).optional(),
  /** Maximum time before the connector must publish activity or an external URL. */
  sessionAcknowledgementDeadlineMs: z.number().int().positive().max(60_000).optional()
});

/**
 * A provider-native conversational surface whose transport is owned by the
 * connector control plane. Unlike ordinary tools, inbound invocations and
 * streamed responses are never exposed to the model as callable operations.
 */
export const MessagingAgentSurfaceSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  invocationModes: z.array(z.enum(["direct_message", "mention", "shortcut", "command", "follow_up"])).min(1),
  supportsStreaming: z.boolean(),
  supportsThreads: z.boolean(),
  supportsAppHome: z.boolean(),
  supportsModals: z.boolean(),
  supportsUnfurling: z.boolean(),
  supportsProactiveDelivery: z.boolean(),
  maturity: ConnectorSurfaceMaturitySchema.default("stable"),
  runtimeStatus: ConnectorSurfaceRuntimeStatusSchema,
  webhookResponseDeadlineMs: z.number().int().positive().max(60_000),
});

export const ConnectorCapabilityKindSchema = z.enum(["tool", "host", "native_agent", "messaging_agent"]);

/**
 * Authorization is capability based, including capabilities that do not map
 * to an agent tool. This lets native provider identities participate in OAuth
 * grants without inventing a callable tool solely to make them selectable.
 */
export const ConnectorCapabilitySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  kind: ConnectorCapabilityKindSchema,
  description: z.string().min(1).optional()
});

export const ConnectorActivityFilterValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "string_array",
]);

export const ConnectorActivityFilterFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  valueType: ConnectorActivityFilterValueTypeSchema,
});

export const ConnectorActivityTriggerDescriptorSchema = z.object({
  eventType: z.string().min(1).max(200),
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(800),
  filterFields: z.array(ConnectorActivityFilterFieldSchema).default([]),
  /**
   * Whether a person should be told about this activity in a digest.
   *
   * There is deliberately no default. A connector declares dozens of event
   * types, and most providers emit far more machinery than news: a repository
   * that reports every check run and every workflow transition will fill a
   * digest window with its own continuous integration before a single review
   * comment reaches the reader. Which of the two an event type is can only be
   * answered by whoever designed the connector, at the moment they added it, so
   * the contract asks then and refuses a manifest that stays quiet.
   *
   * `false` is not a lesser event. It still ingests, still routes, still
   * triggers automations and watches, and still appears in the activity log.
   * It just does not interrupt a person on a schedule.
   */
  digestible: z.boolean(),
});

/**
 * A connector that can hand a finished automation result to the person who
 * owns the automation, on a surface they read as themselves — a Slack Agent DM
 * today, a Teams chat later. Declaring this is what puts the connector in the
 * "Deliver results" list; nothing about delivery is hard-coded per provider.
 *
 * `requiresPersonalIdentityLink` marks the providers whose installation is
 * workspace-wide: the installation alone addresses no one, so the connection
 * only becomes a destination once the requesting user has linked their own
 * provider identity to it.
 */
export const ConnectorUserDeliverySchema = z.object({
  targetType: AutomationDeliveryTargetTypeSchema,
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  requiresPersonalIdentityLink: z.boolean().default(false),
});

const ConnectorManifestBaseSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  surfaces: z.array(ConnectorSurfaceSchema).min(1).default(["resource"]),
  nativeAgent: NativeAgentSurfaceSchema.optional(),
  messagingAgent: MessagingAgentSurfaceSchema.optional(),
  userDelivery: ConnectorUserDeliverySchema.optional(),
  capabilities: z.array(ConnectorCapabilitySchema).default([]),
  supportedScopes: z.array(ScopeSchema),
  oauthRequired: z.boolean(),
  activityTriggers: z.array(ConnectorActivityTriggerDescriptorSchema),
  resourceTypes: z.array(z.string()),
  tools: z.array(ToolDefinitionSchema),
  supportsWatches: z.boolean(),
  supportsPolling: z.boolean(),
  supportsWebhooks: z.boolean()
});

export const ConnectorManifestSchema = ConnectorManifestBaseSchema.superRefine((manifest, context) => {
  const activityTypes = new Set<string>();
  for (const [index, trigger] of manifest.activityTriggers.entries()) {
    if (activityTypes.has(trigger.eventType)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate connector activity type: ${trigger.eventType}`,
        path: ["activityTriggers", index, "eventType"]
      });
    }
    activityTypes.add(trigger.eventType);
    const filterKeys = new Set<string>();
    for (const [filterIndex, field] of trigger.filterFields.entries()) {
      if (filterKeys.has(field.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate activity filter field: ${field.key}`,
          path: ["activityTriggers", index, "filterFields", filterIndex, "key"]
        });
      }
      filterKeys.add(field.key);
    }
  }
  const declaresNativeAgent = manifest.surfaces.includes("native_agent");
  if (declaresNativeAgent && !manifest.nativeAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A native-agent connector must declare its native agent capabilities",
      path: ["nativeAgent"]
    });
  }
  if (!declaresNativeAgent && manifest.nativeAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Native agent capabilities require the native_agent surface",
      path: ["surfaces"]
    });
  }
  const declaresMessagingAgent = manifest.surfaces.includes("messaging_agent");
  if (declaresMessagingAgent && !manifest.messagingAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A messaging-agent connector must declare its messaging agent capabilities",
      path: ["messagingAgent"]
    });
  }
  if (!declaresMessagingAgent && manifest.messagingAgent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Messaging agent capabilities require the messaging_agent surface",
      path: ["surfaces"]
    });
  }
  const capabilityIds = new Set<string>();
  for (const [index, capability] of manifest.capabilities.entries()) {
    if (capabilityIds.has(capability.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate connector capability: ${capability.id}`,
        path: ["capabilities", index, "id"]
      });
    }
    capabilityIds.add(capability.id);
  }
  const descriptorById = new Map(manifest.capabilities.map((capability) => [capability.id, capability]));
  for (const tool of manifest.tools) {
    const descriptor = descriptorById.get(tool.capability);
    if (descriptor && descriptor.kind !== "tool") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tool capability ${tool.capability} must use kind tool`,
        path: ["capabilities"]
      });
    }
  }
  const declaresNativeAgentCapability = manifest.capabilities.some(
    (capability) => capability.kind === "native_agent"
  );
  if (declaresNativeAgent && !declaresNativeAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A native-agent connector must declare an authorizable native-agent capability",
      path: ["capabilities"]
    });
  }
  if (!declaresNativeAgent && declaresNativeAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Native-agent capabilities require the native_agent surface",
      path: ["capabilities"]
    });
  }
  const declaresMessagingAgentCapability = manifest.capabilities.some(
    (capability) => capability.kind === "messaging_agent"
  );
  if (declaresMessagingAgent && !declaresMessagingAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A messaging-agent connector must declare an authorizable messaging-agent capability",
      path: ["capabilities"]
    });
  }
  if (!declaresMessagingAgent && declaresMessagingAgentCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Messaging-agent capabilities require the messaging_agent surface",
      path: ["capabilities"]
    });
  }
  if (manifest.nativeAgent) {
    const capability = manifest.capabilities.find(
      (candidate) => candidate.id === manifest.nativeAgent?.capability
    );
    if (!capability || capability.kind !== "native_agent") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Native-agent surface capability ${manifest.nativeAgent.capability} must name a native_agent capability`,
        path: ["nativeAgent", "capability"]
      });
    }
  }
  if (manifest.messagingAgent) {
    const capability = manifest.capabilities.find(
      (candidate) => candidate.id === manifest.messagingAgent?.capability
    );
    if (!capability || capability.kind !== "messaging_agent") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Messaging-agent surface capability ${manifest.messagingAgent.capability} must name a messaging_agent capability`,
        path: ["messagingAgent", "capability"]
      });
    }
  }
}).transform((manifest) => {
  const declaredIds = new Set(manifest.capabilities.map((capability) => capability.id));
  const inferredToolCapabilities = manifest.tools
    .filter((tool) => !declaredIds.has(tool.capability))
    .filter((tool, index, tools) => tools.findIndex((candidate) => candidate.capability === tool.capability) === index)
    .map((tool) => ({ id: tool.capability, kind: "tool" as const }));
  return {
    ...manifest,
    capabilities: [...manifest.capabilities, ...inferredToolCapabilities]
  };
}).transform((manifest) => ({
  ...manifest,
  activityTypes: manifest.activityTriggers.map((trigger) => trigger.eventType),
  // Derived rather than declared a second time: the descriptor is the single
  // authority on digestibility, and a consumer asking "may this event type
  // reach a digest" should not have to scan a list of descriptors to find out.
  digestibleActivityTypes: manifest.activityTriggers
    .filter((trigger) => trigger.digestible)
    .map((trigger) => trigger.eventType),
}));

export type Region = z.infer<typeof RegionSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;
export type User = z.infer<typeof UserSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
export type WorkspaceInvitation = z.infer<typeof WorkspaceInvitationSchema>;
export type WorkspaceInvitationPreview = z.infer<typeof WorkspaceInvitationPreviewSchema>;
export type PendingWorkspaceInvitation = z.infer<typeof PendingWorkspaceInvitationSchema>;
export type WorkspaceOnboardingState = z.infer<typeof WorkspaceOnboardingStateSchema>;
export type OnboardingRegionRequest = z.infer<typeof OnboardingRegionRequestSchema>;
export type ActivateWorkspaceRequest = z.infer<typeof ActivateWorkspaceRequestSchema>;
export type WorkspaceInvitationRole = z.infer<typeof WorkspaceInvitationRoleSchema>;
export type ClientFeatureFlags = z.infer<typeof ClientFeatureFlagsSchema>;
export type Workstream = z.infer<typeof WorkstreamSchema>;
export type WorkstreamDetail = z.infer<typeof WorkstreamDetailSchema>;
export type WorkstreamContext = z.infer<typeof WorkstreamContextSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ExternalActor = z.infer<typeof ExternalActorSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type NoteRecordingStatus = z.infer<typeof NoteRecordingStatusSchema>;
export type NoteTranscriptSegment = z.infer<typeof NoteTranscriptSegmentSchema>;
export type NoteSummary = z.infer<typeof NoteSummarySchema>;
export type NoteDetail = z.infer<typeof NoteDetailSchema>;
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;
export type AppendNoteTranscriptSegmentRequest = z.infer<typeof AppendNoteTranscriptSegmentRequestSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type AutomationDeliveryTargetType = z.infer<typeof AutomationDeliveryTargetTypeSchema>;
export type ConnectorUserDelivery = z.infer<typeof ConnectorUserDeliverySchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type WorkstreamArtifact = z.infer<typeof WorkstreamArtifactSchema>;
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>;
export type Elicitation = z.infer<typeof ElicitationSchema>;
export type ActivitySuggestion = z.infer<typeof ActivitySuggestionSchema>;
export type WorkOpportunity = z.infer<typeof WorkOpportunitySchema>;
export type WorkOpportunityPage = z.infer<typeof WorkOpportunityPageSchema>;
export type HyperSight = z.infer<typeof HyperSightSchema>;
export type HyperSightBlock = z.infer<typeof HyperSightBlockSchema>;
export type HyperSightBlockRun = z.infer<typeof HyperSightBlockRunSchema>;
export type HyperSightPreference = z.infer<typeof HyperSightPreferenceSchema>;
export type UpdateHyperSightPreferenceRequest = z.infer<typeof UpdateHyperSightPreferenceRequestSchema>;
export type UpdateHyperSightRequest = z.infer<typeof UpdateHyperSightRequestSchema>;
export type AutomationDraft = z.infer<typeof AutomationDraftSchema>;
export type AutomationMemoryTable = z.infer<typeof AutomationMemoryTableSchema>;
export type AutomationMemoryTableColumn = z.infer<typeof AutomationMemoryTableColumnSchema>;
export type MemoryTableColumnType = z.infer<typeof MemoryTableColumnTypeSchema>;
export type AutomationDraftStreamEvent = z.infer<typeof AutomationDraftStreamEventSchema>;
export type AutomationCompilerMessage = z.infer<typeof AutomationCompilerMessageSchema>;
export type AutomationDraftState = z.infer<typeof AutomationDraftStateSchema>;
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export type AutomationDetail = z.infer<typeof AutomationDetailSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type AutomationTemplateUpdate = z.infer<typeof AutomationTemplateUpdateSchema>;
export type ActivitySourcePluginIds = z.infer<typeof ActivitySourcePluginIdsSchema>;
export type DigestSchedule = z.infer<typeof DigestScheduleSchema>;
export type DigestDeliveryTarget = z.infer<typeof DigestDeliveryTargetSchema>;
export type DigestDeliveryTargetType = z.infer<typeof DigestDeliveryTargetTypeSchema>;
export type UpdateDigestScheduleRequest = z.infer<typeof UpdateDigestScheduleRequestSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type ConnectorOAuthProvider = z.infer<typeof ConnectorOAuthProviderSchema>;
export type ConnectorOAuthAttemptStatus = z.infer<typeof ConnectorOAuthAttemptStatusSchema>;
export type ConnectorOAuthStart = z.infer<typeof ConnectorOAuthStartSchema>;
export type ConnectorOAuthAttempt = z.infer<typeof ConnectorOAuthAttemptSchema>;
export type ClientSocketEvent = z.infer<typeof ClientSocketEventSchema>;
export type ServerSocketEvent = z.infer<typeof ServerSocketEventSchema>;
export type PersonalSocketEvent = z.infer<typeof PersonalSocketEventSchema>;
export type GenerateMeetingNotesRequest = z.infer<typeof GenerateMeetingNotesRequestSchema>;
export type MeetingNotesResponse = z.infer<typeof MeetingNotesResponseSchema>;
export type NormalizedActivity = z.infer<typeof NormalizedActivitySchema>;
export type ActivityQueueMessage = z.infer<typeof ActivityQueueMessageSchema>;
export type SlackIngressQueueMessage = z.infer<typeof SlackIngressQueueMessageSchema>;
export type ExecutionPrincipal = z.infer<typeof ExecutionPrincipalSchema>;
export type SlackOriginAttachment = z.infer<typeof SlackOriginAttachmentSchema>;
export type SlackOriginNearbyMessage = z.infer<typeof SlackOriginNearbyMessageSchema>;
export type SlackOriginContext = z.infer<typeof SlackOriginContextSchema>;
export type WorkstreamWorkflowInput = z.infer<typeof WorkstreamWorkflowInputSchema>;
export type SlackSearchAuthorization = z.infer<typeof SlackSearchAuthorizationSchema>;
export type ConnectorPollWorkflowInput = z.infer<typeof ConnectorPollWorkflowInputSchema>;
export type AddressingClassification = z.infer<typeof AddressingClassificationSchema>;
export type ActivityRoutingResult = z.infer<typeof ActivityRoutingResultSchema>;
export type WorkstreamNameResult = z.infer<typeof WorkstreamNameResultSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ConnectorSurface = z.infer<typeof ConnectorSurfaceSchema>;
export type NativeAgentInvocationMode = z.infer<typeof NativeAgentInvocationModeSchema>;
export type NativeAgentActivityKind = z.infer<typeof NativeAgentActivityKindSchema>;
export type ConnectorSurfaceMaturity = z.infer<typeof ConnectorSurfaceMaturitySchema>;
export type ConnectorSurfaceRuntimeStatus = z.infer<typeof ConnectorSurfaceRuntimeStatusSchema>;
export type NativeAgentSessionOwnership = z.infer<typeof NativeAgentSessionOwnershipSchema>;
export type NativeAgentSurface = z.infer<typeof NativeAgentSurfaceSchema>;
export type MessagingAgentSurface = z.infer<typeof MessagingAgentSurfaceSchema>;
export type ConnectorCapabilityKind = z.infer<typeof ConnectorCapabilityKindSchema>;
export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>;
export type ConnectorActivityFilterValueType = z.infer<typeof ConnectorActivityFilterValueTypeSchema>;
export type ConnectorActivityFilterField = z.infer<typeof ConnectorActivityFilterFieldSchema>;
export type ConnectorActivityTriggerDescriptor = z.infer<typeof ConnectorActivityTriggerDescriptorSchema>;
/** Input permits legacy manifests that omit `surfaces`; parsing normalizes them. */
export type ConnectorManifestInput = z.input<typeof ConnectorManifestSchema>;
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

/**
 * The machine-readable half of a thrown tool failure, reduced to what is safe
 * to show a model.
 *
 * A tool that throws otherwise reaches the model as a single string, so any
 * remediation it attached — which family of identifier was expected, that a
 * connection needs reconnecting, what values were available — is lost exactly
 * where the caller needs it to recover. Reading the shape here rather than
 * importing a connector's error class keeps the harness free of a dependency on
 * any one provider package.
 *
 * The forwarded keys are an allowlist rather than a convention each adapter is
 * trusted to follow, because several already attach whole parsed provider error
 * bodies as their details. Forwarding those would put up to a quarter-megabyte
 * of raw provider JSON into the transcript, and from there into the inference
 * payload logs, on every failed call.
 */
const FORWARDED_FAILURE_DETAIL_KEYS = [
  "reason",
  "field",
  "expected",
  "available",
  "reconnectRequired",
  "retryAfterMs",
] as const;

const MAXIMUM_FAILURE_DETAIL_BYTES = 2_000;

export interface StructuredFailureDetail {
  code: string;
  details?: Record<string, unknown>;
}

export function readStructuredFailure(error: unknown): StructuredFailureDetail | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code) return null;
  const raw = (error as { details?: unknown }).details;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { code };
  const source = raw as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const key of FORWARDED_FAILURE_DETAIL_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    details[key] = value;
  }
  if (Object.keys(details).length === 0) return { code };
  // A bound on the allowlisted values as well: `available` is a provider-shaped
  // list, so its length is not ours to assume.
  return JSON.stringify(details).length > MAXIMUM_FAILURE_DETAIL_BYTES
    ? { code }
    : { code, details };
}

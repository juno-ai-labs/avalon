import { z } from "zod";

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
  avatarUrl: z.string().url().nullable(),
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
  inviteUrl: z.string().url(),
  emailDelivery: z.enum(["sent", "skipped"])
});
export const AcceptWorkspaceInvitationRequestSchema = z.object({
  token: z.string().min(20).max(500)
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
  archivedAt: TimestampSchema.nullable()
});

export const ExternalActorSchema = z.object({
  provider: z.string().min(1).max(80),
  providerAccountId: z.string().min(1).max(200),
  providerUserId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(180),
  avatarUrl: z.string().url().nullable(),
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
  avatarUrl: z.string().url().nullable().optional(),
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
  canonicalUrl: z.string().url().nullable(),
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
}).strict();

export const ConnectionSchema = z.object({
  id: IdSchema,
  modelPluginId: z.string().regex(/^plugin_[a-z][a-z0-9_]{0,62}$/u),
  workspaceId: IdSchema,
  connectorType: z.enum(["google", "generic_webhook", "github", "linear", "notion", "slack", "x"]),
  scope: ScopeSchema,
  ownerUserId: IdSchema.nullable(),
  ownerName: z.string().nullable(),
  displayName: z.string().min(1).max(180),
  grantedCapabilities: z.array(z.string()),
  status: z.enum(["healthy", "needs_reconnect", "error", "disabled"]),
  lastSyncAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
});

export const ModelPluginIdSchema = z.string().regex(/^plugin_[a-z][a-z0-9_]{0,62}$/u);
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
  connectionId: IdSchema.nullable(),
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
    eventTypes: z.array(z.string().min(1)).min(1),
    deterministicFilters: z.record(z.string(), z.unknown())
  }),
  z.object({
    type: z.literal("semantic_activity"),
    connectorType: z.string().min(1).nullable(),
    deterministicPrefilter: z.record(z.string(), z.unknown()),
    condition: z.string().min(1)
  }),
  z.object({ type: z.literal("resource_watch"), resourceId: IdSchema }),
  z.object({ type: z.literal("webhook"), eventTypes: z.array(z.string()).min(1) })
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
    plugins: z.array(AutomationPluginActivitySchema).default([]),
    durationMs: z.number().int().nonnegative().optional()
  }),
  z.object({
    type: z.literal("completed"),
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

export const AutomationSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  emailAddress: z.string().email().nullable().default(null),
  scope: ScopeSchema,
  status: z.enum(["draft", "active", "paused", "error"]),
  nextRunAt: TimestampSchema.nullable(),
  lastRunAt: TimestampSchema.nullable(),
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
  deliveryTargets: z.array(z.object({
    type: z.literal("slack_agent_dm"),
    connectionId: IdSchema,
    displayName: z.string().min(1).max(180),
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
  apiBaseUrl: z.string().url()
});

export const DesktopExchangeRequestSchema = z.object({
  ticket: z.string().min(20).max(500),
  region: RegionSchema,
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  timezone: IanaTimezoneSchema.default("America/Los_Angeles")
});
export const ConnectorOAuthProviderSchema = z.enum(["google", "github", "linear", "notion", "slack"]);
export const ConnectorOAuthAttemptStatusSchema = z.enum(["pending", "succeeded", "denied", "failed"]);
export const ConnectorOAuthStartSchema = z.object({
  url: z.string().url(),
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

export const CreateWorkstreamRequestSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  objective: z.string().trim().min(1).max(4000).optional(),
  participantUserIds: z.array(IdSchema).max(25).default([]),
  openingMessage: z.string().max(50000),
  clientMessageId: z.string().min(1).max(120),
  attachmentIds: z.array(IdSchema).max(10).default([]),
}).refine((value) => value.openingMessage.trim().length > 0 || value.attachmentIds.length > 0, {
  message: "An opening message must include text or an attachment",
});

export const UpdateWorkstreamRequestSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  objective: z.string().max(4000).optional(),
  archived: z.boolean().optional()
});

export const AcknowledgeWorkstreamReadRequestSchema = z.object({
  readThroughSequenceNumber: z.number().int().nonnegative(),
  observedManualUnreadGeneration: z.number().int().nonnegative(),
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
  draft: AutomationDraftSchema,
  scope: ScopeSchema,
  defaultPluginIds: z.array(ModelPluginIdSchema).default([]),
  resourceIds: z.array(IdSchema).max(20).default([]),
  deliveryTargets: z.array(z.object({
    type: z.literal("slack_agent_dm"),
    connectionId: IdSchema,
  }).strict()).max(1).default([]),
}).superRefine((input, context) => {
  if (input.deliveryTargets.length > 0 && input.scope !== "personal") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryTargets"], message: "Slack Agent DM delivery requires a personal automation" });
  }
});
export const CompileAutomationRequestSchema = z.object({
  draftId: IdSchema.optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1),
  currentDraft: AutomationDraftSchema.nullable().default(null),
  attachmentIds: z.array(IdSchema).max(10).default([]),
});
export const CreateWebhookConnectionRequestSchema = z.object({
  displayName: z.string().min(1).max(180),
  scope: ScopeSchema,
  eventTypes: z.array(z.string().min(1)).default([])
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
export const ServerSocketEventSchema = z.discriminatedUnion("type", [
  ServerEventBaseSchema.extend({ type: z.literal("snapshot"), workstream: WorkstreamDetailSchema }),
  ServerEventBaseSchema.extend({ type: z.literal("presence_changed"), viewers: z.array(ViewerSchema) }),
  ServerEventBaseSchema.extend({ type: z.literal("message_created"), message: MessageSchema }),
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
}).strict();

export const MeetingNotesResponseSchema = z.object({
  notes: z.string().trim().min(1).max(50_000),
  generatedAt: TimestampSchema
});

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
  metadata: z.record(z.string(), z.unknown())
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

export const WorkstreamWorkflowInputSchema = z.object({
  region: RegionSchema,
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  harnessRunId: IdSchema,
  triggerMessageId: IdSchema.nullable(),
  automationSubscriptionId: IdSchema.nullable(),
  activityId: IdSchema.nullable(),
  executionPrincipal: ExecutionPrincipalSchema,
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

export const ActivityRoutingResultSchema = z.object({
  candidateWorkstreamId: IdSchema.nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000),
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

const ConnectorManifestBaseSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  surfaces: z.array(ConnectorSurfaceSchema).min(1).default(["resource"]),
  nativeAgent: NativeAgentSurfaceSchema.optional(),
  messagingAgent: MessagingAgentSurfaceSchema.optional(),
  capabilities: z.array(ConnectorCapabilitySchema).default([]),
  supportedScopes: z.array(ScopeSchema),
  oauthRequired: z.boolean(),
  activityTypes: z.array(z.string()),
  resourceTypes: z.array(z.string()),
  tools: z.array(ToolDefinitionSchema),
  supportsWatches: z.boolean(),
  supportsPolling: z.boolean(),
  supportsWebhooks: z.boolean()
});

export const ConnectorManifestSchema = ConnectorManifestBaseSchema.superRefine((manifest, context) => {
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
});

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
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type WorkstreamArtifact = z.infer<typeof WorkstreamArtifactSchema>;
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>;
export type Elicitation = z.infer<typeof ElicitationSchema>;
export type ActivitySuggestion = z.infer<typeof ActivitySuggestionSchema>;
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
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export type AutomationDetail = z.infer<typeof AutomationDetailSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type AutomationTemplateUpdate = z.infer<typeof AutomationTemplateUpdateSchema>;
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
export type WorkstreamWorkflowInput = z.infer<typeof WorkstreamWorkflowInputSchema>;
export type ConnectorPollWorkflowInput = z.infer<typeof ConnectorPollWorkflowInputSchema>;
export type AddressingClassification = z.infer<typeof AddressingClassificationSchema>;
export type ActivityRoutingResult = z.infer<typeof ActivityRoutingResultSchema>;
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
/** Input permits legacy manifests that omit `surfaces`; parsing normalizes them. */
export type ConnectorManifestInput = z.input<typeof ConnectorManifestSchema>;
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

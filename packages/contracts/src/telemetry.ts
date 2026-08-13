import { z } from "zod";

export const TELEMETRY_SOURCES = [
  "desktop-main",
  "desktop-renderer",
  "desktop-preload",
  "api",
] as const;
export const TELEMETRY_CATEGORIES = ["essential", "product", "diagnostic"] as const;
export const TELEMETRY_IDENTITY_SCOPES = [
  "installation",
  "anonymous-epoch",
  "platform-user",
  "workspace-user",
] as const;

export type TelemetrySource = typeof TELEMETRY_SOURCES[number];
export type TelemetryCategory = typeof TELEMETRY_CATEGORIES[number];
export type TelemetryIdentityScope = typeof TELEMETRY_IDENTITY_SCOPES[number];
export type TelemetryPropertyClassification = "operational" | "product" | "diagnostic";

interface TelemetryRegistryEntry {
  name: string;
  schemaVersion: 1;
  definition: string;
  productQuestion: string;
  owner: string;
  reviewGroup: string;
  sources: readonly TelemetrySource[];
  authoritativeSource: TelemetrySource;
  category: TelemetryCategory;
  identityScopes: readonly TelemetryIdentityScope[];
  properties: z.ZodObject<z.ZodRawShape>;
  propertyClassifications: Readonly<Record<string, TelemetryPropertyClassification>>;
  sampleRate: number;
  priority: "critical" | "high" | "normal" | "low";
  localRetention: "none" | "14-days";
  regionalRetention: "90-days" | "13-months";
  destination: "posthog-and-eu-internal" | "internal-only";
  compatibilityNote: string;
}

type RegistryInput = Omit<TelemetryRegistryEntry, "schemaVersion" | "sampleRate" | "compatibilityNote"> & {
  schemaVersion?: 1;
  sampleRate?: number;
  compatibilityNote?: string;
};

function event<T extends RegistryInput>(input: T): T & {
  schemaVersion: 1;
  sampleRate: number;
  compatibilityNote: string;
} {
  return {
    schemaVersion: 1,
    sampleRate: 1,
    compatibilityNote: "V1 fields are closed; incompatible changes require a new schema version.",
    ...input,
  };
}

const lifecycleState = z.enum(["launch_started", "ready", "foreground", "background", "graceful_exit"]);
const applicationVersionProperties = z.object({
  state: z.enum(["installed", "updated"]),
  previousVersion: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u).optional(),
  previousBuild: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u).optional(),
}).strict().superRefine((value, context) => {
  const previousCount = Number(value.previousVersion !== undefined) + Number(value.previousBuild !== undefined);
  if ((value.state === "installed" && previousCount !== 0)
    || (value.state === "updated" && previousCount !== 2)) {
    context.addIssue({ code: "custom", message: "application_version_transition_invalid" });
  }
});
const durationBucket = z.enum(["lt_100ms", "100ms_1s", "1s_5s", "5s_30s", "gte_30s"]);
const resultClass = z.enum(["success", "validation_error", "conflict", "denied", "unavailable", "failed"]);
const region = z.enum(["global", "eu"]);
const entrypoint = z.enum(["first_run", "settings", "invitation", "workspace_switcher", "composer"]);
const screen = z.enum([
  "onboarding_welcome",
  "onboarding_region",
  "onboarding_workspace",
  "workspace_home",
  "workstream",
  "application_settings",
  "developer_settings",
]);
const generatedJavascriptFrame = z.string().min(1).max(192)
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._/-]{0,159}\.(?:c?js):\d{1,7}:\d{1,5}$/u)
  .refine((value) => !value.startsWith("/") && !value.includes(".."));

const common = {
  owner: "product-analytics",
  reviewGroup: "telemetry-governance",
  sampleRate: 1,
  localRetention: "14-days" as const,
  destination: "posthog-and-eu-internal" as const,
};

export const TELEMETRY_EVENTS = {
  application_lifecycle: event({
    ...common,
    name: "application_lifecycle",
    definition: "A content-free transition in the lifecycle of one desktop application process.",
    productQuestion: "How many eligible application launches reach ready and exit cleanly by release?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation"],
    properties: z.object({ state: lifecycleState, crashReportingEligible: z.boolean() }).strict(),
    propertyClassifications: { state: "operational", crashReportingEligible: "operational" },
    priority: "critical",
    regionalRetention: "90-days",
  }),
  application_version_changed: event({
    ...common,
    name: "application_version_changed",
    definition: "A durable first-observed installation or application build transition on one desktop installation.",
    productQuestion: "Which application versions are installed or reached through a confirmed desktop update?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation"],
    properties: applicationVersionProperties,
    propertyClassifications: {
      state: "operational",
      previousVersion: "operational",
      previousBuild: "operational",
    },
    priority: "high",
    regionalRetention: "90-days",
  }),
  desktop_session: event({
    ...common,
    name: "desktop_session",
    definition: "A content-free start or end marker for one foreground desktop product session.",
    productQuestion: "What is the crash-reporting eligibility coverage of active desktop sessions?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation", "platform-user", "workspace-user"],
    properties: z.object({ state: z.enum(["started", "ended"]), continuouslyEligible: z.boolean() }).strict(),
    propertyClassifications: { state: "operational", continuouslyEligible: "operational" },
    priority: "critical",
    regionalRetention: "90-days",
  }),
  process_health: event({
    ...common,
    name: "process_health",
    definition: "A bounded content-free health transition from an Electron process observer.",
    productQuestion: "Which process roles and bounded failure classes reduce desktop reliability?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation", "platform-user", "workspace-user"],
    properties: z.object({
      process: z.enum(["main", "preload", "renderer", "utility", "gpu"]),
      state: z.enum(["gone", "unresponsive", "responsive", "exception", "rejection", "unclean_exit"]),
      reasonClass: z.enum(["crashed", "killed", "oom", "launch_failure", "unknown"]),
    }).strict(),
    propertyClassifications: { process: "operational", state: "operational", reasonClass: "operational" },
    priority: "high",
    regionalRetention: "90-days",
  }),
  update_outcome: event({
    ...common,
    name: "update_outcome",
    definition: "A content-free result emitted by the main-owned desktop update controller.",
    productQuestion: "Where do update checks, downloads, applies, or rollbacks fail by release channel?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation"],
    properties: z.object({
      phase: z.enum(["check", "download", "apply", "rollback"]),
      result: z.enum(["available", "current", "success", "failed", "cancelled"]),
      duration: durationBucket,
    }).strict(),
    propertyClassifications: { phase: "operational", result: "operational", duration: "operational" },
    priority: "high",
    regionalRetention: "90-days",
  }),
  api_operation_outcome: event({
    ...common,
    name: "api_operation_outcome",
    definition: "A content-free outcome and duration for one explicitly allowlisted API operation.",
    productQuestion: "Which approved product operations fail or slow down without recording request content?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "essential",
    identityScopes: ["platform-user", "workspace-user"],
    properties: z.object({
      operation: z.enum(["onboarding_bootstrap", "workspace_create", "workspace_activate", "workstream_create", "run_start"]),
      result: resultClass,
      duration: durationBucket,
    }).strict(),
    propertyClassifications: { operation: "operational", result: "operational", duration: "operational" },
    priority: "normal",
    regionalRetention: "90-days",
  }),
  telemetry_spool_state: event({
    ...common,
    name: "telemetry_spool_state",
    definition: "A content-free bounded transition in the desktop or regional telemetry delivery spool.",
    productQuestion: "How much telemetry is delayed or lost because a bounded delivery spool is under pressure?",
    sources: ["desktop-main", "api"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation"],
    properties: z.object({
      state: z.enum(["accepted", "rejected", "evicted", "expired", "quarantined", "pressure", "delivered"]),
      count: z.enum(["one", "two_to_ten", "eleven_to_one_hundred", "over_one_hundred"]),
    }).strict(),
    propertyClassifications: { state: "operational", count: "operational" },
    priority: "high",
    regionalRetention: "90-days",
  }),
  crash_upload_state: event({
    ...common,
    name: "crash_upload_state",
    definition: "A content-free transition for a route-final local native crash generation or upload.",
    productQuestion: "How many native crashes are awaiting restart, uploaded, invalidated, expired, or lost?",
    sources: ["desktop-main", "api"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation"],
    properties: z.object({
      state: z.enum([
        "awaiting_restart", "rotated", "queued", "uploading", "accepted", "rejected",
        "retrying", "expired", "invalidated", "evicted", "corrupt", "lost",
      ]),
    }).strict(),
    propertyClassifications: { state: "operational" },
    priority: "critical",
    regionalRetention: "90-days",
  }),
  screen_viewed: event({
    ...common,
    name: "screen_viewed",
    definition: "A deliberate router signal that a registered product screen became visible.",
    productQuestion: "Which planned screens are reached in activation and adoption journeys?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({ screen }).strict(),
    propertyClassifications: { screen: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  onboarding_region_selected: event({
    ...common,
    name: "onboarding_region_selected",
    definition: "The user's explicit selection of a registered region during the onboarding journey.",
    productQuestion: "How many onboarding journeys reach an explicit region choice and which coarse choice is made?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user"],
    properties: z.object({ selectedRegion: region, entrypoint }).strict(),
    propertyClassifications: { selectedRegion: "product", entrypoint: "product" },
    priority: "high",
    regionalRetention: "13-months",
  }),
  workspace_create_requested: event({
    ...common,
    name: "workspace_create_requested",
    definition: "A user intent to create a workspace, emitted before the authoritative API request.",
    productQuestion: "What share of workspace creation intents reach an authoritative successful outcome?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user"],
    properties: z.object({ selectedRegion: region, entrypoint }).strict(),
    propertyClassifications: { selectedRegion: "product", entrypoint: "product" },
    priority: "high",
    regionalRetention: "13-months",
  }),
  workspace_create_completed: event({
    ...common,
    name: "workspace_create_completed",
    definition: "The authoritative API outcome after a requested workspace creation operation.",
    productQuestion: "Why do workspace creation intents succeed or fail after reaching the API?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["platform-user"],
    properties: z.object({ selectedRegion: region, result: resultClass }).strict(),
    propertyClassifications: { selectedRegion: "product", result: "product" },
    priority: "high",
    regionalRetention: "13-months",
  }),
  workspace_activation_requested: event({
    ...common,
    name: "workspace_activation_requested",
    definition: "A user intent to activate an existing workspace during onboarding or switching.",
    productQuestion: "What share of workspace activation intents reach an authoritative successful outcome?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({ selectedRegion: region, entrypoint }).strict(),
    propertyClassifications: { selectedRegion: "product", entrypoint: "product" },
    priority: "high",
    regionalRetention: "13-months",
  }),
  workspace_activation_completed: event({
    ...common,
    name: "workspace_activation_completed",
    definition: "The authoritative API outcome after a requested workspace activation operation.",
    productQuestion: "Why do workspace activation intents succeed or fail after reaching the API?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["platform-user", "workspace-user"],
    properties: z.object({ selectedRegion: region, result: resultClass }).strict(),
    propertyClassifications: { selectedRegion: "product", result: "product" },
    priority: "high",
    regionalRetention: "13-months",
  }),
  workstream_create_requested: event({
    ...common,
    name: "workstream_create_requested",
    definition: "A user intent to create a work stream without copying its title, objective, or message.",
    productQuestion: "What share of work-stream creation intents reach a successful authoritative outcome?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ entrypoint }).strict(),
    propertyClassifications: { entrypoint: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_create_completed: event({
    ...common,
    name: "workstream_create_completed",
    definition: "The authoritative API outcome after a requested work-stream creation operation.",
    productQuestion: "Why do work-stream creation intents succeed or fail after reaching the API?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ result: resultClass }).strict(),
    propertyClassifications: { result: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  run_requested: event({
    ...common,
    name: "run_requested",
    definition: "A user intent to start an agent run without copying its prompt or resource context.",
    productQuestion: "What share of deliberate agent-run intents reach an authoritative terminal outcome?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ entrypoint }).strict(),
    propertyClassifications: { entrypoint: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  run_completed: event({
    ...common,
    name: "run_completed",
    definition: "The authoritative server outcome of an agent run, without prompt, output, or provider payload.",
    productQuestion: "Which bounded outcomes and duration bands explain conversion from run intent to completion?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ result: resultClass, duration: durationBucket }).strict(),
    propertyClassifications: { result: "product", duration: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  connector_setup_requested: event({
    ...common,
    name: "connector_setup_requested",
    definition: "A user intent to begin setup for one registered connector family.",
    productQuestion: "Which connector setup journeys are started and how often do they complete?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ connector: z.enum(["github", "google", "linear", "notion", "slack"]) }).strict(),
    propertyClassifications: { connector: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  connector_setup_completed: event({
    ...common,
    name: "connector_setup_completed",
    definition: "The authoritative API outcome of setup for one registered connector family.",
    productQuestion: "Where do registered connector setup journeys fail after user intent?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      connector: z.enum(["github", "google", "linear", "notion", "slack"]),
      result: resultClass,
    }).strict(),
    propertyClassifications: { connector: "product", result: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  javascript_exception: event({
    ...common,
    name: "javascript_exception",
    definition: "A sanitized JavaScript exception report with bounded application frames and breadcrumbs.",
    productQuestion: "Which sanitized application exceptions affect users by process role and release?",
    sources: ["desktop-main", "desktop-preload", "desktop-renderer"],
    authoritativeSource: "desktop-main",
    category: "diagnostic",
    identityScopes: ["platform-user", "workspace-user"],
    properties: z.object({
      process: z.enum(["main", "preload", "renderer"]),
      errorCode: z.enum(["type_error", "range_error", "unhandled_rejection", "react_boundary", "network_error", "unknown"]),
      breadcrumbStatus: z.enum(["available", "stale", "unavailable"]),
      fingerprint: z.string().regex(/^[a-f0-9]{32,64}$/u),
      generatedFrames: z.array(generatedJavascriptFrame).min(1).max(20),
    }).strict(),
    propertyClassifications: {
      process: "diagnostic",
      errorCode: "diagnostic",
      breadcrumbStatus: "diagnostic",
      fingerprint: "diagnostic",
      generatedFrames: "diagnostic",
    },
    priority: "high",
    regionalRetention: "90-days",
  }),
  native_crash_processed: event({
    ...common,
    localRetention: "none",
    name: "native_crash_processed",
    definition: "A sanitized structured native crash result produced after region-local symbolication.",
    productQuestion: "Which symbolicated native crash issues affect eligible launches by release and process?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "diagnostic",
    identityScopes: ["installation", "platform-user", "workspace-user"],
    properties: z.object({
      process: z.enum(["main", "renderer", "utility", "gpu", "unknown"]),
      parserState: z.enum(["symbolicated", "unsymbolicated", "malformed"]),
      breadcrumbStatus: z.enum(["available", "stale", "unavailable"]),
      fingerprint: z.string().regex(/^[a-f0-9]{32,64}$/u),
    }).strict(),
    propertyClassifications: {
      process: "diagnostic",
      parserState: "diagnostic",
      breadcrumbStatus: "diagnostic",
      fingerprint: "diagnostic",
    },
    priority: "critical",
    regionalRetention: "90-days",
  }),
} as const satisfies Record<string, TelemetryRegistryEntry>;

export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS;
export const telemetryEventNames = Object.keys(TELEMETRY_EVENTS) as TelemetryEventName[];

const UuidV7Schema = z.string().uuid().refine((value) => value[14] === "7", "must be UUIDv7");
const SafeReleaseSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u);

export const TelemetryBreadcrumbSchema = z.discriminatedUnion("kind", [
  z.object({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: z.literal("screen_changed"),
    screen,
  }).strict(),
  z.object({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: z.literal("lifecycle"),
    phase: lifecycleState,
  }).strict(),
  z.object({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: z.literal("operation"),
    operation: z.enum([
      "workspace_create", "workspace_activate", "workstream_create", "run_start", "connector_setup", "update",
    ]),
    state: z.enum(["requested", "succeeded", "failed"]),
  }).strict(),
]);
export type TelemetryBreadcrumb = z.infer<typeof TelemetryBreadcrumbSchema>;

export const TelemetryBreadcrumbSidecarSchema = z.object({
  version: z.literal(1),
  launchId: UuidV7Schema,
  updatedAt: z.string().datetime({ offset: true }),
  entries: z.array(TelemetryBreadcrumbSchema).max(32),
}).strict().superRefine((sidecar, context) => {
  for (let index = 1; index < sidecar.entries.length; index += 1) {
    if (sidecar.entries[index]!.sequence <= sidecar.entries[index - 1]!.sequence) {
      context.addIssue({ code: "custom", message: "breadcrumb_sequence_invalid", path: ["entries", index, "sequence"] });
    }
  }
});
export type TelemetryBreadcrumbSidecar = z.infer<typeof TelemetryBreadcrumbSidecarSchema>;
const TelemetryContextSchema = z.object({
  environment: z.enum(["development", "staging", "production"]),
  region: z.enum(["global", "eu"]).optional(),
  release: SafeReleaseSchema,
  buildId: SafeReleaseSchema,
  deviceId: UuidV7Schema.optional(),
  platform: z.enum(["darwin", "win32", "linux"]).optional(),
  arch: z.enum(["arm64", "x64"]).optional(),
  channel: z.enum(["development", "alpha", "beta", "stable"]).optional(),
  osVersion: SafeReleaseSchema.optional(),
  locale: z.string().min(2).max(35).regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u).optional(),
  timezone: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_+-]+(?:\/[a-zA-Z0-9_+-]+)*$/u).optional(),
  screenWidth: z.number().int().positive().max(100_000).optional(),
  screenHeight: z.number().int().positive().max(100_000).optional(),
  viewportWidth: z.number().int().positive().max(100_000).optional(),
  viewportHeight: z.number().int().positive().max(100_000).optional(),
  windowId: UuidV7Schema.optional(),
  launchId: UuidV7Schema.optional(),
  sessionId: UuidV7Schema.optional(),
  onboardingJourneyId: UuidV7Schema.optional(),
  operationId: UuidV7Schema.optional(),
  requestId: UuidV7Schema.optional(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  spanId: z.string().regex(/^[a-f0-9]{16}$/u).optional(),
}).strict();

const EnvelopeBaseSchema = z.object({
  schema: z.literal("com.avalon.telemetry.event"),
  schemaVersion: z.literal(1),
  eventId: UuidV7Schema,
  name: z.string(),
  source: z.enum(TELEMETRY_SOURCES),
  category: z.enum(TELEMETRY_CATEGORIES),
  identityScope: z.enum(TELEMETRY_IDENTITY_SCOPES),
  originalTimestamp: z.string().datetime({ offset: true }),
  sentAt: z.string().datetime({ offset: true }),
  context: TelemetryContextSchema,
  properties: z.record(z.string(), z.unknown()),
}).strict();

export const TelemetryEnvelopeSchema = EnvelopeBaseSchema.superRefine((value, context) => {
  const entry = TELEMETRY_EVENTS[value.name as TelemetryEventName];
  if (!entry) {
    context.addIssue({ code: "custom", message: "telemetry_event_unregistered", path: ["name"] });
    return;
  }
  if (value.schemaVersion !== entry.schemaVersion) {
    context.addIssue({ code: "custom", message: "telemetry_schema_version_unsupported", path: ["schemaVersion"] });
  }
  if (!(entry.sources as readonly TelemetrySource[]).includes(value.source)) {
    context.addIssue({ code: "custom", message: "telemetry_source_forbidden", path: ["source"] });
  }
  if (entry.category !== value.category) {
    context.addIssue({ code: "custom", message: "telemetry_category_mismatch", path: ["category"] });
  }
  if (!(entry.identityScopes as readonly TelemetryIdentityScope[]).includes(value.identityScope)) {
    context.addIssue({ code: "custom", message: "telemetry_identity_scope_forbidden", path: ["identityScope"] });
  }
  const properties = entry.properties.safeParse(value.properties);
  if (!properties.success) {
    context.addIssue({ code: "custom", message: "telemetry_properties_invalid", path: ["properties"] });
  }
});

export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelopeSchema>;

function validateBatchDeviceBinding(
  value: { installationId?: string | undefined; events: TelemetryEnvelope[] },
  context: z.RefinementCtx,
): void {
  value.events.forEach((event, index) => {
    if (event.context.deviceId !== undefined && event.context.deviceId !== value.installationId) {
      context.addIssue({
        code: "custom",
        message: "telemetry_device_binding_invalid",
        path: ["events", index, "context", "deviceId"],
      });
    }
  });
}

export const TelemetryBatchSchema = z.object({
  installationId: UuidV7Schema.optional(),
  events: z.array(TelemetryEnvelopeSchema).min(1).max(50),
}).strict().superRefine(validateBatchDeviceBinding);
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

export const TELEMETRY_BATCH_MAX_BYTES = 256 * 1024;

export const TelemetryBootstrapRequestSchema = z.object({
  anonymousEpochId: UuidV7Schema,
}).strict();
export type TelemetryBootstrapRequest = z.infer<typeof TelemetryBootstrapRequestSchema>;

export const TelemetryBootstrapResponseSchema = z.object({
  journeyId: UuidV7Schema,
  route: z.enum(["global", "eu"]),
  routingBasis: z.enum(["ip_geolocation", "geolocation_fallback"]),
  capability: z.string().min(32).max(2_048),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type TelemetryBootstrapResponse = z.infer<typeof TelemetryBootstrapResponseSchema>;

export const AnonymousTelemetryBatchSchema = z.object({
  capability: z.string().min(32).max(2_048),
  installationId: UuidV7Schema.optional(),
  events: z.array(TelemetryEnvelopeSchema).min(1).max(50),
}).strict().superRefine(validateBatchDeviceBinding);
export type AnonymousTelemetryBatch = z.infer<typeof AnonymousTelemetryBatchSchema>;

export const LinkAnonymousTelemetrySchema = z.object({
  capability: z.string().min(32).max(2_048),
}).strict();
export type LinkAnonymousTelemetry = z.infer<typeof LinkAnonymousTelemetrySchema>;

export const TelemetryAcceptanceResultSchema = z.object({
  result: z.enum(["accepted", "duplicate", "conflict", "suppressed", "route_mismatch"]),
  eventId: UuidV7Schema,
}).strict();
export type TelemetryAcceptanceResult = z.infer<typeof TelemetryAcceptanceResultSchema>;

export const TelemetryAcceptanceBatchResponseSchema = z.object({
  results: z.array(TelemetryAcceptanceResultSchema).max(50),
}).strict();
export type TelemetryAcceptanceBatchResponse = z.infer<typeof TelemetryAcceptanceBatchResponseSchema>;

export const LinkAnonymousTelemetryResponseSchema = z.object({
  result: z.enum(["linked", "duplicate", "suppressed"]),
}).strict();
export type LinkAnonymousTelemetryResponse = z.infer<typeof LinkAnonymousTelemetryResponseSchema>;

export const CrashIngestResponseSchema = z.object({
  result: z.enum(["accepted", "duplicate", "suppressed"]),
  uploadId: UuidV7Schema,
  crashId: UuidV7Schema.optional(),
}).strict();
export type CrashIngestResponse = z.infer<typeof CrashIngestResponseSchema>;

export const ProductAnalyticsPreferenceSchema = z.object({
  enabled: z.boolean(),
  version: z.number().int().positive(),
}).strict();
export type ProductAnalyticsPreference = z.infer<typeof ProductAnalyticsPreferenceSchema>;

export const UpdateProductAnalyticsPreferenceSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

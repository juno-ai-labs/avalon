import { z } from "zod";

export const TELEMETRY_SOURCES = [
  "desktop-main",
  "desktop-renderer",
  "desktop-preload",
  "api",
  "site",
] as const;
export const TELEMETRY_CATEGORIES = ["essential", "product", "diagnostic"] as const;
export const TELEMETRY_IDENTITY_SCOPES = [
  "installation",
  "anonymous-epoch",
  "platform-user",
  "workspace-user",
  "workspace",
] as const;

export type TelemetrySource = typeof TELEMETRY_SOURCES[number];
export type TelemetryCategory = typeof TELEMETRY_CATEGORIES[number];
export type TelemetryIdentityScope = typeof TELEMETRY_IDENTITY_SCOPES[number];
export type TelemetryPropertyClassification = "operational" | "product" | "diagnostic";

export const TELEMETRY_CONNECTOR_TYPES = [
  "google",
  "generic_webhook",
  "github",
  "granola",
  "linear",
  "notion",
  "slack",
  "x",
] as const;
export type TelemetryConnectorType = typeof TELEMETRY_CONNECTOR_TYPES[number];

export const TELEMETRY_WORKSTREAM_CREATION_SOURCES = [
  "composer",
  "suggested_work",
  "slack_agent",
  "automation_manual",
  "automation_scheduled",
  "automation_activity",
  "automation_inbound_email",
] as const;
export type TelemetryWorkstreamCreationSource = typeof TELEMETRY_WORKSTREAM_CREATION_SOURCES[number];

export const TELEMETRY_APPLICATION_ICON_IDS = [
  "light",
  "dark",
  "sunset-sherbet",
  "ludicrous-speed",
  "ruby",
  "holographic",
  "leather",
  "blueprint",
] as const;
export type TelemetryApplicationIconId = typeof TELEMETRY_APPLICATION_ICON_IDS[number];

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
const journeyDurationBucket = z.enum(["unknown", "lt_1s", "1s_5s", "5s_30s", "30s_2m", "2m_10m", "gte_10m"]);
const countBucket = z.enum(["zero", "one", "two_to_five", "six_to_twenty", "twenty_one_to_one_hundred", "over_one_hundred"]);
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
const applicationIcon = z.enum(TELEMETRY_APPLICATION_ICON_IDS);
const resourceId = z.string().uuid();
const uuidV7Id = z.string().uuid().refine((value) => value[14] === "7", "must be UUIDv7");
const visibility = z.enum(["private", "public"]);
const resourceCount = z.number().int().min(0).max(100);
const connectorType = z.enum(TELEMETRY_CONNECTOR_TYPES);
const safeTelemetryTaxonomyValue = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const safeModelRoute = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u);
const telemetrySurface = z.enum([
  "onboarding_welcome", "onboarding_region", "onboarding_workspace", "workspace_home",
  "workstream", "note_detail", "meeting_capture", "automation_builder", "automation_detail",
  "settings_account", "settings_digest", "settings_workspace", "settings_connections",
  "settings_application", "settings_developer", "resource_inspector", "hypersight", "terminal",
]);
const surfaceEntrypoint = z.enum([
  "direct", "sidebar_new", "sidebar_pinned", "sidebar_recent", "sidebar_note", "sidebar_automation",
  "home_waiting", "home_suggested", "menu_bar", "command_shortcut", "deep_link", "notification",
  "automation_run_list", "in_app_link", "settings", "unknown",
]);
const automationTriggerType = z.enum([
  "manual", "calendar", "interval", "connector_activity", "semantic_activity", "resource_watch", "webhook", "inbound_email",
]);
const automationDeliveryTargetType = z.enum(["email", "slack_agent_dm"]);
const connectorScope = z.enum(["personal", "workspace"]);
const connectorSetupMethod = z.enum(["oauth", "api_key", "direct", "webhook"]);
const connectorHealth = z.enum(["healthy", "needs_reconnect", "error", "disabled", "unknown"]);
export const TELEMETRY_REALTIME_SOCKETS = [
  "workspace",
  "workstream_control",
  "substream_feed",
  "block_dashboard",
] as const;
export type TelemetryRealtimeSocket = typeof TELEMETRY_REALTIME_SOCKETS[number];
export const TELEMETRY_REALTIME_SOCKET_CAUSES = [
  "opened",
  "transport_error",
  "heartbeat_timeout",
  "server_closed",
  "ticket_failed",
  "resync_required",
  "offline",
  "access_revoked",
] as const;
export type TelemetryRealtimeSocketCause = typeof TELEMETRY_REALTIME_SOCKET_CAUSES[number];

const realtimeSocketProperties = z.object({
  socket: z.enum(TELEMETRY_REALTIME_SOCKETS),
  state: z.enum(["connected", "retrying", "stopped"]),
  cause: z.enum(TELEMETRY_REALTIME_SOCKET_CAUSES),
  attempts: countBucket,
}).strict().superRefine((value, context) => {
  // The one combination that is not a measurement but a mistake: a socket that
  // opened has no failure cause, and a failure cause did not open a socket. The
  // message is a validation code for whoever reads a rejection, never a value
  // any destination sees: a refused event is not sent at all.
  if ((value.state === "connected") !== (value.cause === "opened")) {
    context.addIssue({ code: "custom", message: "realtime_socket_state_cause_invalid" });
  }
});

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

function productEvent<
  const TName extends string,
  const TSources extends readonly TelemetrySource[],
  const TScopes extends readonly TelemetryIdentityScope[],
  TProperties extends z.ZodObject<z.ZodRawShape>,
>(input: {
  name: TName;
  definition: string;
  productQuestion: string;
  sources: TSources;
  authoritativeSource: TSources[number];
  identityScopes: TScopes;
  properties: TProperties;
  priority?: "critical" | "high" | "normal" | "low";
}) {
  return event({
    ...common,
    ...input,
    category: "product" as const,
    propertyClassifications: Object.fromEntries(
      Object.keys(input.properties.shape).map((key) => [key, "product" as const]),
    ),
    priority: input.priority ?? "normal",
    regionalRetention: "13-months" as const,
  });
}

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
  realtime_socket_state: event({
    ...common,
    name: "realtime_socket_state",
    definition: "A bounded connection transition on one of the desktop client's realtime sockets.",
    productQuestion: "Which realtime sockets drop, why, and how many attempts does a client spend getting back?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: realtimeSocketProperties,
    propertyClassifications: {
      socket: "operational", state: "operational", cause: "operational", attempts: "operational",
    },
    priority: "normal",
    regionalRetention: "90-days",
  }),
  workstream_socket_started: event({
    ...common,
    name: "workstream_socket_started",
    definition: "The desktop began one WorkstreamDO control or SubstreamAgent feed connection attempt, including its ticket request.",
    productQuestion: "Why are work-stream sockets started, which kind starts, and how much connection work comes from initial admission versus reconnects?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      socketLeaseId: uuidV7Id,
      openAttemptId: uuidV7Id.optional(),
      socket: z.enum(["workstream_control", "substream_feed"]),
      reason: z.enum(["hover_warmup", "active_workstream", "background_workstream", "retained_workstream", "reconnect"]),
      attempts: countBucket,
    }).strict(),
    propertyClassifications: {
      workstreamId: "product",
      socketLeaseId: "operational",
      openAttemptId: "operational",
      socket: "operational",
      reason: "operational",
      attempts: "operational",
    },
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
  surface_viewed: productEvent({
    name: "surface_viewed",
    definition: "A registered desktop product surface became visible with its bounded navigation source.",
    productQuestion: "Which product surfaces are reached, from which entrypoints, and for which opaque resources?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      surface: telemetrySurface,
      entrypoint: surfaceEntrypoint,
      resourceType: z.enum(["workstream", "note", "automation"]).optional(),
      resourceId: z.string().uuid().optional(),
    }).strict(),
  }),
  application_settings_state: event({
    ...common,
    name: "application_settings_state",
    definition: "The actual main-owned desktop application settings observed once after launch initialization.",
    productQuestion: "Which supported startup, security, and icon settings are active across eligible desktop launches?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      launchAtLoginEnabled: z.boolean(),
      launchAtLoginAvailable: z.boolean(),
      lockdownModeEnabled: z.boolean(),
      lockdownModeAvailable: z.boolean(),
      applicationIcon,
      applicationIconAutomatic: z.boolean(),
      applicationIconAvailable: z.boolean(),
    }).strict(),
    propertyClassifications: {
      launchAtLoginEnabled: "product",
      launchAtLoginAvailable: "product",
      lockdownModeEnabled: "product",
      lockdownModeAvailable: "product",
      applicationIcon: "product",
      applicationIconAutomatic: "product",
      applicationIconAvailable: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  application_setting_change_completed: event({
    ...common,
    name: "application_setting_change_completed",
    definition: "A main-owned boolean application-setting interaction completed and its actual state was read back.",
    productQuestion: "How do people change launch-at-login and Lockdown mode, including requests the platform does not apply?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      setting: z.enum(["launch_at_login", "lockdown_mode"]),
      previousEnabled: z.boolean(),
      requestedEnabled: z.boolean(),
      appliedEnabled: z.boolean(),
    }).strict(),
    propertyClassifications: {
      setting: "product",
      previousEnabled: "product",
      requestedEnabled: "product",
      appliedEnabled: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  application_icon_changed: event({
    ...common,
    name: "application_icon_changed",
    definition: "A desktop application-icon selection completed after the native icon and preference were applied.",
    productQuestion: "Which bounded application icons do people choose, and how often do they return to automatic appearance?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      previousIcon: applicationIcon,
      previousAutomatic: z.boolean(),
      selectedIcon: applicationIcon,
      automatic: z.boolean(),
    }).strict(),
    propertyClassifications: {
      previousIcon: "product",
      previousAutomatic: "product",
      selectedIcon: "product",
      automatic: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  application_opened: event({
    ...common,
    name: "application_opened",
    definition: "A provable source started the desktop process or explicitly raised the running application.",
    productQuestion: "Which bounded entrypoints bring people into Avalon on cold starts and later activations?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      entrypoint: z.enum([
        "system_start", "user_launch", "dock", "deep_link", "menu_bar", "push_notification",
      ]),
      phase: z.enum(["cold_start", "activation"]),
    }).strict(),
    propertyClassifications: { entrypoint: "product", phase: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  menu_bar_opened: event({
    ...common,
    name: "menu_bar_opened",
    definition: "The macOS Avalon status item opened its drop-down menu for a person.",
    productQuestion: "How often is the menu-bar surface used, and how much useful content is present when it opens?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      signedIn: z.boolean(),
      suggestionCount: z.number().int().min(0).max(4),
      recentCount: z.number().int().min(0).max(5),
      pinnedCount: z.number().int().min(0).max(5),
    }).strict(),
    propertyClassifications: {
      signedIn: "product",
      suggestionCount: "product",
      recentCount: "product",
      pinnedCount: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  menu_bar_action_selected: event({
    ...common,
    name: "menu_bar_action_selected",
    definition: "A person selected one actionable row from the macOS Avalon status menu.",
    productQuestion: "Which bounded menu-bar actions do people choose after opening the surface?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "product",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      action: z.enum([
        "new_meeting_note", "new_workstream", "new_automation", "suggested_work",
        "recent_workstream", "pinned_workstream", "open_avalon", "quit_avalon",
      ]),
    }).strict(),
    propertyClassifications: { action: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  command_shortcuts_revealed: event({
    ...common,
    name: "command_shortcuts_revealed",
    definition: "A person held Command to reveal the numbered sidebar destination shortcuts.",
    productQuestion: "How often do people discover the Command-number navigation affordance?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ availableCount: z.number().int().min(0).max(9) }).strict(),
    propertyClassifications: { availableCount: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  command_shortcut_used: event({
    ...common,
    name: "command_shortcut_used",
    definition: "A valid Command-number shortcut opened one numbered sidebar destination.",
    productQuestion: "How often does shortcut discovery convert into navigation, and which destination classes are used?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      shortcutNumber: z.number().int().min(1).max(9),
      destinationType: z.enum(["pinned_workstream", "recent_workstream", "recent_note"]),
    }).strict(),
    propertyClassifications: { shortcutNumber: "product", destinationType: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  suggested_work_started: event({
    ...common,
    name: "suggested_work_started",
    definition: "A suggested work item successfully created its destination work stream.",
    productQuestion: "How often do visible work suggestions become active work streams, and from which surface?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({ surface: z.enum(["menu_bar", "workspace_home"]) }).strict(),
    propertyClassifications: { surface: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  suggested_work_impression: productEvent({
    name: "suggested_work_impression",
    definition: "The API durably recorded that a ranked suggested-work card was meaningfully visible.",
    productQuestion: "Which ranked suggestions are actually seen before they are dismissed or started?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      opportunityId: resourceId,
      version: z.number().int().positive(),
      surface: z.enum(["menu_bar", "workspace_home"]),
      position: z.number().int().min(1).max(4),
      audienceScope: z.enum(["personal", "workspace"]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      freshness: z.enum(["lt_1h", "1h_24h", "1d_7d", "gte_7d"]),
      priorImpressionCount: countBucket,
    }).strict(),
  }),
  suggested_work_dismissed: productEvent({
    name: "suggested_work_dismissed",
    definition: "A ranked suggested-work card was durably dismissed by the member who saw it.",
    productQuestion: "Which visible suggestion classes are rejected, and how long after first exposure?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      opportunityId: resourceId,
      version: z.number().int().positive(),
      surface: z.enum(["menu_bar", "workspace_home"]),
      position: z.number().int().min(1).max(4),
      audienceScope: z.enum(["personal", "workspace"]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      timeSinceFirstImpression: journeyDurationBucket,
    }).strict(),
  }),
  suggested_work_started_v2: productEvent({
    name: "suggested_work_started_v2",
    definition: "A ranked suggested-work item durably created its destination work stream with exposure context.",
    productQuestion: "Which seen suggestions become work, and how does exposure history affect conversion?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      opportunityId: resourceId,
      workstreamId: resourceId,
      version: z.number().int().positive(),
      surface: z.enum(["menu_bar", "workspace_home"]),
      position: z.number().int().min(1).max(4),
      audienceScope: z.enum(["personal", "workspace"]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      priorImpressionCount: countBucket,
    }).strict(),
  }),
  workstream_opened: event({
    ...common,
    name: "workstream_opened",
    definition: "A successfully loaded work stream became the active desktop resource.",
    productQuestion: "Which work streams are opened, reopened, or switched between, and in what state?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      visibility,
      navigation: z.enum(["opened", "switched", "reopened"]),
      origin: z.enum(["ad_hoc", "automation", "system"]),
      pinned: z.boolean(),
    }).strict(),
    propertyClassifications: {
      workstreamId: "product", visibility: "product", navigation: "product", origin: "product", pinned: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_feed_visible: event({
    ...common,
    name: "workstream_feed_visible",
    definition: "A work stream opened from the desktop sidebar painted its initial message feed.",
    productQuestion: "How long does a sidebar click take to produce a painted message feed, and is the delay before data readiness or browser paint?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      socketLeaseId: uuidV7Id.optional(),
      durationMs: z.number().int().nonnegative(),
      dataReadyDurationMs: z.number().int().nonnegative(),
      sidebarSection: z.enum(["pinned", "recent"]),
      cacheState: z.enum(["feed_cached", "detail_cached", "cold"]),
      socketPoolState: z.enum(["retained_pair", "control_warmup", "cold"]),
      feedSource: z.enum(["feed_cache", "boot_payload", "legacy_page"]),
      messageCount: countBucket,
    }).strict(),
    propertyClassifications: {
      workstreamId: "product",
      socketLeaseId: "operational",
      durationMs: "operational",
      dataReadyDurationMs: "operational",
      sidebarSection: "product",
      cacheState: "operational",
      socketPoolState: "operational",
      feedSource: "operational",
      messageCount: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_open_started: event({
    ...common,
    name: "workstream_open_started",
    definition: "The desktop accepted a primary sidebar click that began one work-stream opening attempt.",
    productQuestion: "How many sidebar opening attempts begin, including attempts later superseded or failed?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      sidebarSection: z.enum(["pinned", "recent"]),
      socketPoolState: z.enum(["retained_pair", "control_warmup", "cold"]),
      socketLeaseId: uuidV7Id.optional(),
    }).strict(),
    propertyClassifications: {
      workstreamId: "product",
      sidebarSection: "product",
      socketPoolState: "operational",
      socketLeaseId: "operational",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_open_outcome: event({
    ...common,
    name: "workstream_open_outcome",
    definition: "One sidebar work-stream opening attempt reached a visible feed, was superseded by another sidebar click, or failed to load.",
    productQuestion: "What fraction of sidebar opening attempts become visible, fail, or are abandoned by rapid switching?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      outcome: z.enum(["visible", "superseded", "load_failed"]),
      durationMs: z.number().int().nonnegative(),
      socketLeaseId: uuidV7Id.optional(),
      supersedingWorkstreamId: resourceId.optional(),
    }).strict().superRefine((properties, context) => {
      if ((properties.outcome === "superseded") !== (properties.supersedingWorkstreamId !== undefined)) {
        context.addIssue({ code: "custom", message: "superseding work stream must appear only for a superseded opening" });
      }
    }),
    propertyClassifications: {
      workstreamId: "product",
      outcome: "operational",
      durationMs: "operational",
      socketLeaseId: "operational",
      supersedingWorkstreamId: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_created: event({
    ...common,
    name: "workstream_created",
    definition: "The regional API durably created one user-visible work stream, with bounded source and connector attribution.",
    productQuestion: "Which server-side creation paths produce work streams, and which connector types caused them?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      visibility,
      creationSource: z.enum(TELEMETRY_WORKSTREAM_CREATION_SOURCES),
      origin: z.enum(["ad_hoc", "automation"]),
      connectorType: z.union([connectorType, z.enum(["none", "multiple"])]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      connectorTypeCount: z.number().int().min(0).max(TELEMETRY_CONNECTOR_TYPES.length),
      participantCount: resourceCount,
      attachmentCount: resourceCount,
      modelOverride: z.boolean(),
    }).strict(),
    propertyClassifications: {
      workstreamId: "product", visibility: "product", creationSource: "product", origin: "product",
      connectorType: "product", connectorTypes: "product", connectorTypeCount: "product",
      participantCount: "product", attachmentCount: "product", modelOverride: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_action_completed: event({
    ...common,
    name: "workstream_action_completed",
    definition: "A work-stream state action completed successfully from a desktop resource menu.",
    productQuestion: "How do people pin, unpin, change visibility, and archive work streams?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      action: z.enum(["pin", "unpin", "make_public", "make_private", "mark_unread", "rename", "archive"]),
      visibility,
      origin: z.enum(["ad_hoc", "automation", "system"]),
      pinned: z.boolean(),
    }).strict(),
    propertyClassifications: {
      workstreamId: "product", action: "product", visibility: "product", origin: "product", pinned: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  workstream_participant_changed: productEvent({
    name: "workstream_participant_changed",
    definition: "The regional API completed a participant membership change on a work stream.",
    productQuestion: "How do work streams become collaborative, and which participant changes fail?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      action: z.enum(["added", "removed"]),
      method: z.enum(["picker", "mention", "server"]),
      participantCount: countBucket,
      result: resultClass,
    }).strict(),
  }),
  workstream_resource_action_completed: productEvent({
    name: "workstream_resource_action_completed",
    definition: "A resource relationship or resource-use action completed for a work stream.",
    productQuestion: "Which kinds of context are attached, watched, inspected, and removed from work streams?",
    sources: ["api", "desktop-renderer"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      resourceId,
      resourceType: safeTelemetryTaxonomyValue,
      connectorType: z.union([connectorType, z.literal("avalon")]),
      relationshipType: safeTelemetryTaxonomyValue,
      action: z.enum(["attach", "detach", "watch", "unwatch", "preview", "open_source"]),
      result: resultClass,
      surface: z.enum(["workstream", "resource_inspector", "terminal"]),
    }).strict(),
  }),
  run_action_completed: productEvent({
    name: "run_action_completed",
    definition: "The regional API completed a person-requested stop or retry action for an agent run.",
    productQuestion: "How often do people stop or retry agent work, and do those recovery actions succeed?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      action: z.enum(["stop", "retry"]),
      result: resultClass,
    }).strict(),
  }),
  hypersight_opened: productEvent({
    name: "hypersight_opened",
    definition: "The HyperSight panel became visible for a loaded work stream.",
    productQuestion: "How often do people inspect synthesized work-stream context and at what configuration size?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({ workstreamId: resourceId, blockCount: countBucket }).strict(),
  }),
  hypersight_configuration_changed: productEvent({
    name: "hypersight_configuration_changed",
    definition: "The regional API completed a content-free change to a HyperSight block configuration.",
    productQuestion: "How do people customize HyperSight, and which configuration mutations succeed?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      action: z.enum(["add", "edit", "reorder", "delete"]),
      blockCount: countBucket,
      result: resultClass,
    }).strict(),
  }),
  hypersight_run_terminal: productEvent({
    name: "hypersight_run_terminal",
    definition: "A HyperSight refresh run reached an authoritative terminal state.",
    productQuestion: "How reliably and quickly does HyperSight refresh, including results superseded while running?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      result: z.enum(["success", "validation_error", "conflict", "denied", "unavailable", "failed", "cancelled"]),
      duration: journeyDurationBucket,
      staleAtCompletion: z.boolean(),
    }).strict(),
  }),
  terminal_workspace_terminal: productEvent({
    name: "terminal_workspace_terminal",
    definition: "A Terminal workspace lifecycle action reached its authoritative platform result.",
    productQuestion: "Where does the Terminal workspace lifecycle succeed or fail, and under which repository conditions?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      action: z.enum(["start", "restore", "expire", "fail", "start_fresh", "repository_select", "repository_replace"]),
      result: resultClass,
      duration: journeyDurationBucket,
      repositorySelected: z.boolean(),
      connectorType: z.union([connectorType, z.literal("none")]),
      localFilesRetained: z.boolean(),
    }).strict(),
  }),
  attention_consumed: productEvent({
    name: "attention_consumed",
    definition: "The regional API durably cleared a member's unread state after they consumed work-stream attention.",
    productQuestion: "Which attention signals bring people back, and how quickly are they consumed?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      unreadCount: countBucket,
      hadMention: z.boolean(),
      neededInput: z.boolean(),
      entrypoint: surfaceEntrypoint,
      timeToRead: journeyDurationBucket,
    }).strict(),
  }),
  automation_created: event({
    ...common,
    name: "automation_created",
    definition: "A desktop automation creation or template-subscription flow completed successfully.",
    productQuestion: "Which automation creation paths, scopes, and bounded capabilities reach a created automation?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      automationId: resourceId,
      visibility,
      creationMethod: z.enum(["custom", "template"]),
      pluginCount: resourceCount,
      activityTriggerEnabled: z.boolean(),
      deliveryEnabled: z.boolean(),
    }).strict(),
    propertyClassifications: {
      automationId: "product", visibility: "product", creationMethod: "product", pluginCount: "product",
      activityTriggerEnabled: "product", deliveryEnabled: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  automation_action_completed: event({
    ...common,
    name: "automation_action_completed",
    definition: "An automation resource-menu action completed successfully.",
    productQuestion: "How often do people run, archive, and delete automations from their resource menus?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      automationId: resourceId,
      action: z.enum(["run_now", "archive_draft", "delete"]),
      visibility,
      status: z.enum(["draft", "active", "paused", "error"]),
    }).strict(),
    propertyClassifications: {
      automationId: "product", action: "product", visibility: "product", status: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  automation_builder_started: productEvent({
    name: "automation_builder_started",
    definition: "The automation architect surface became actionable for a new or resumed draft.",
    productQuestion: "Which entrypoints start automation authoring, and how often are existing drafts resumed?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({ entrypoint: surfaceEntrypoint, resumedDraft: z.boolean() }).strict(),
  }),
  automation_draft_turn_completed: productEvent({
    name: "automation_draft_turn_completed",
    definition: "The regional automation architect completed one content-free compiler turn for a durable draft.",
    productQuestion: "How many authoring turns succeed, fail, or reach create-ready state by input mode?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      draftId: resourceId.optional(),
      turnNumber: countBucket,
      result: z.enum(["success", "failed", "cancelled"]),
      duration: journeyDurationBucket,
      inputMode: z.enum(["typed", "suggested_prompt", "elicitation_response", "edit"]),
      attachmentCount: resourceCount,
      connectorMentionCount: resourceCount,
      readyToCreate: z.boolean(),
    }).strict(),
  }),
  automation_draft_ready: productEvent({
    name: "automation_draft_ready",
    definition: "An automation draft first reached a create-ready revision with bounded capability dimensions.",
    productQuestion: "Which authoring journeys become create-ready, with what trigger, connector, and delivery shape?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      draftId: resourceId,
      turnsToReady: countBucket,
      visibility,
      triggerTypes: z.array(automationTriggerType).max(8),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      pluginCount: resourceCount,
      deliveryTargetTypes: z.array(automationDeliveryTargetType).max(2),
    }).strict(),
  }),
  automation_created_v2: productEvent({
    name: "automation_created_v2",
    definition: "The regional API durably created or subscribed to an automation with bounded configuration dimensions.",
    productQuestion: "Which automation creation methods and configurations survive the authoritative server write?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      automationId: resourceId,
      draftId: resourceId.optional(),
      templateId: resourceId.optional(),
      creationMethod: z.enum(["custom", "template"]),
      visibility,
      triggerTypes: z.array(automationTriggerType).max(8),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      pluginCount: resourceCount,
      deliveryTargetTypes: z.array(automationDeliveryTargetType).max(2),
      modelOverride: z.boolean(),
    }).strict(),
    priority: "high",
  }),
  automation_opened: productEvent({
    name: "automation_opened",
    definition: "A successfully loaded automation overview became the active desktop resource.",
    productQuestion: "Which automations are revisited, in what lifecycle state, and from which entrypoint?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({
      automationId: resourceId,
      visibility,
      status: z.enum(["draft", "active", "paused", "error"]),
      entrypoint: surfaceEntrypoint,
      runCount: countBucket,
    }).strict(),
  }),
  automation_action_completed_v2: productEvent({
    name: "automation_action_completed_v2",
    definition: "The regional API completed an automation lifecycle or execution action.",
    productQuestion: "Which automation actions succeed, and what state transition did each action apply?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      automationId: resourceId,
      action: z.enum(["pause", "resume", "edit", "publish_template", "adopt_template_version", "run_now", "archive_draft", "delete"]),
      visibility,
      previousStatus: z.enum(["draft", "active", "paused", "error"]),
      appliedStatus: z.enum(["draft", "active", "paused", "error", "deleted", "archived"]),
      result: resultClass,
    }).strict(),
  }),
  message_sent: event({
    ...common,
    name: "message_sent",
    definition: "A person successfully sent a work-stream message or elicitation response without retaining its content.",
    productQuestion: "How often do people send messages with attachments, mentions, or newly added participants?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      workstreamId: resourceId,
      messageId: resourceId.optional(),
      visibility,
      workstreamOrigin: z.enum(["ad_hoc", "automation"]),
      messageKind: z.enum(["message", "elicitation_response"]),
      attachmentCount: resourceCount,
      mentionCount: resourceCount,
      participantAddedCount: resourceCount,
    }).strict(),
    propertyClassifications: {
      workstreamId: "product", messageId: "product", visibility: "product", workstreamOrigin: "product",
      messageKind: "product", attachmentCount: "product", mentionCount: "product", participantAddedCount: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  human_message_created: productEvent({
    name: "human_message_created",
    definition: "The regional API durably created a human-authored work-stream message from a bounded channel.",
    productQuestion: "Where do people contribute to work streams, and how often do those messages add context or collaborators?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      messageId: resourceId,
      channel: z.enum(["desktop", "slack", "email"]),
      visibility,
      workstreamOrigin: z.enum(["ad_hoc", "automation"]),
      attachmentCount: resourceCount,
      mentionCount: resourceCount,
      participantAddedCount: resourceCount,
    }).strict(),
    priority: "high",
  }),
  elicitation_presented: productEvent({
    name: "elicitation_presented",
    definition: "A durable agent elicitation became available for a person to answer.",
    productQuestion: "Which question shapes interrupt work, and where do they enter the user experience?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      elicitationId: resourceId,
      runId: resourceId,
      workstreamId: resourceId.optional(),
      draftId: resourceId.optional(),
      responseType: z.enum(["text", "free_text", "radio", "single_select", "multi_select"]),
      optionCount: countBucket,
      surface: z.enum(["workstream", "automation_builder"]),
    }).strict(),
  }),
  elicitation_resolved: productEvent({
    name: "elicitation_resolved",
    definition: "A durable agent elicitation was answered or skipped without recording its response content.",
    productQuestion: "Which agent questions are answered or skipped, and how long do they block progress?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      elicitationId: resourceId,
      runId: resourceId,
      workstreamId: resourceId.optional(),
      draftId: resourceId.optional(),
      responseType: z.enum(["text", "free_text", "radio", "single_select", "multi_select"]),
      resolution: z.enum(["answered", "skipped"]),
      customResponseUsed: z.boolean(),
      responseLatency: journeyDurationBucket,
      surface: z.enum(["workstream", "automation_builder"]),
    }).strict(),
  }),
  content_copied: event({
    ...common,
    name: "content_copied",
    definition: "A bounded resource-related copy action completed without retaining clipboard content.",
    productQuestion: "Which resource outputs and identifiers are copied for use elsewhere?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      contentType: z.enum([
        "workstream_link", "workstream_email", "workstream_id", "message_response", "code_block",
        "note_summary", "note_transcript", "note_id", "automation_email", "automation_id",
      ]),
      resourceType: z.enum(["workstream", "message", "note", "automation"]),
      resourceId,
      workstreamId: resourceId.optional(),
    }).strict(),
    propertyClassifications: {
      contentType: "product", resourceType: "product", resourceId: "product", workstreamId: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  note_opened: event({
    ...common,
    name: "note_opened",
    definition: "A successfully loaded note became the active desktop resource.",
    productQuestion: "How often are private and public notes opened again after creation?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      visibility,
      recordingState: z.enum(["idle", "recording", "complete"]),
      navigation: z.enum(["opened", "reopened"]),
    }).strict(),
    propertyClassifications: { noteId: "product", visibility: "product", recordingState: "product", navigation: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  note_created: event({
    ...common,
    name: "note_created",
    definition: "A new meeting-or-voice-note surface successfully created its private note.",
    productQuestion: "Which entrypoints produce new meeting or voice notes?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      visibility,
      noteType: z.literal("meeting_or_voice"),
      entrypoint: z.enum(["sidebar", "menu_bar", "unknown"]),
    }).strict(),
    propertyClassifications: { noteId: "product", visibility: "product", noteType: "product", entrypoint: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  note_action_completed: event({
    ...common,
    name: "note_action_completed",
    definition: "A note visibility or archive action completed successfully.",
    productQuestion: "How do people change note visibility and archive notes?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      action: z.enum(["make_public", "make_private", "archive"]),
      visibility,
      recordingState: z.enum(["idle", "recording", "complete"]),
    }).strict(),
    propertyClassifications: { noteId: "product", action: "product", visibility: "product", recordingState: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  transcription_state_changed: event({
    ...common,
    name: "transcription_state_changed",
    definition: "The meeting-or-voice-note transcription capture successfully changed state.",
    productQuestion: "How often is transcription started, paused, resumed, and completed, and with which audio source availability?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      state: z.enum(["started", "paused", "resumed", "completed"]),
      visibility,
      audioSource: z.enum(["microphone_and_system", "microphone_only", "system_only", "unknown"]),
    }).strict(),
    propertyClassifications: { noteId: "product", state: "product", visibility: "product", audioSource: "product" },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  recording_start_completed: productEvent({
    name: "recording_start_completed",
    definition: "A meeting or voice-note recording start attempt reached its local permission and capture result.",
    productQuestion: "Why do recording starts succeed or fail, and which available audio source is used?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      result: z.enum(["success", "permission_denied", "capture_failed", "persistence_failed"]),
      permissionClass: z.enum(["both_granted", "microphone_only", "system_only", "both_blocked", "unknown"]),
      audioSource: z.enum(["microphone_and_system", "microphone_only", "system_only", "unknown"]),
      entrypoint: z.enum(["sidebar", "menu_bar", "unknown"]),
    }).strict(),
    priority: "high",
  }),
  recording_terminal: productEvent({
    name: "recording_terminal",
    definition: "A meeting or voice-note recording finalized with its true transcript, summary, and persistence result.",
    productQuestion: "How often do recordings produce complete reusable notes instead of partial or failed artifacts?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      result: z.enum(["complete", "partial_transcript", "summary_failed", "persistence_failed", "capture_failed"]),
      duration: journeyDurationBucket,
      segmentCount: countBucket,
      pauseCount: countBucket,
      finalSummaryResult: z.enum(["success", "failed", "not_attempted"]),
      audioSource: z.enum(["microphone_and_system", "microphone_only", "system_only", "unknown"]),
    }).strict(),
    priority: "high",
  }),
  note_summary_generation_completed: productEvent({
    name: "note_summary_generation_completed",
    definition: "The regional API completed a live or final note-summary generation attempt.",
    productQuestion: "How reliably and quickly are live and final note summaries generated from complete or partial transcripts?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      mode: z.enum(["live", "final"]),
      result: resultClass,
      duration: journeyDurationBucket,
      transcriptStatus: z.enum(["complete", "partial"]),
      segmentCount: countBucket,
      refreshCadence: z.enum(["disabled", "one_minute", "two_minutes", "five_minutes", "custom"]),
    }).strict(),
  }),
  note_opened_v2: productEvent({
    name: "note_opened_v2",
    definition: "A successfully loaded note became active with bounded reuse and completeness dimensions.",
    productQuestion: "Which completed notes are revisited, from where, and with which durable artifacts available?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({
      noteId: resourceId,
      visibility,
      entrypoint: surfaceEntrypoint,
      navigation: z.enum(["opened", "reopened"]),
      recordingState: z.enum(["idle", "recording", "complete"]),
      hasSummary: z.boolean(),
      hasTranscript: z.boolean(),
      duration: journeyDurationBucket,
      segmentCount: countBucket,
    }).strict(),
  }),
  agent_tool_started: event({
    ...common,
    name: "agent_tool_started",
    definition: "The regional agent runtime durably admitted one canonical tool invocation without arguments or output.",
    productQuestion: "Which tool capabilities are actually used by work streams, automations, and sub-agents?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      toolName: safeTelemetryTaxonomyValue,
      pluginId: safeTelemetryTaxonomyValue,
      capability: safeTelemetryTaxonomyValue,
      mode: z.enum(["read", "write"]),
      runKind: z.enum(["workstream", "automation", "hypersight", "subagent", "system"]),
      executionScope: z.enum(["user", "workspace"]),
    }).strict(),
    propertyClassifications: {
      workstreamId: "product", harnessRunId: "product", automationId: "product", toolName: "product",
      pluginId: "product", capability: "product", mode: "product", runKind: "product", executionScope: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  run_terminal: productEvent({
    name: "run_terminal",
    definition: "A root agent run reached its authoritative terminal state with bounded product and performance dimensions.",
    productQuestion: "Which user and unattended runs deliver value, need input, stop, or fail, and how efficiently?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      runKind: z.enum(["workstream", "automation", "hypersight", "subagent", "system"]),
      triggerType: z.enum(["composer", "retry", "manual", "scheduled", "activity", "inbound_email", "digest", "system"]),
      terminalState: z.enum(["completed", "needs_input", "stopped", "failed"]),
      duration: journeyDurationBucket,
      timeToFirstOutput: journeyDurationBucket,
      turnCount: countBucket,
      toolCallCount: countBucket,
      writeToolCallCount: countBucket,
      modelRoute: safeModelRoute.optional(),
      fallbackUsed: z.boolean(),
    }).strict(),
    priority: "high",
  }),
  agent_tool_terminal: productEvent({
    name: "agent_tool_terminal",
    definition: "A durably admitted canonical tool invocation reached a content-free terminal result.",
    productQuestion: "Which tool capabilities succeed, fail, require authority, or become ambiguous, and with what latency?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      toolName: safeTelemetryTaxonomyValue,
      pluginId: safeTelemetryTaxonomyValue,
      capability: safeTelemetryTaxonomyValue,
      mode: z.enum(["read", "write"]),
      runKind: z.enum(["workstream", "automation", "hypersight", "subagent", "system"]),
      executionScope: z.enum(["user", "workspace"]),
      result: z.enum(["success", "validation_error", "authorization_denied", "provider_error", "ambiguous", "cancelled"]),
      duration: journeyDurationBucket,
      replayed: z.boolean(),
    }).strict(),
    priority: "high",
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
  connector_setup_requested_v2: productEvent({
    name: "connector_setup_requested_v2",
    definition: "A person began setup for any registered connector through a bounded setup method and scope.",
    productQuestion: "Which connector, scope, and setup-method journeys are attempted?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: z.object({
      connector: connectorType,
      scope: connectorScope,
      method: connectorSetupMethod,
      capabilityCount: countBucket,
    }).strict(),
  }),
  connector_setup_completed_v2: productEvent({
    name: "connector_setup_completed_v2",
    definition: "The regional API completed setup or reconnection for any registered connector family.",
    productQuestion: "Where do connector setup journeys fail by connector, method, scope, and capability shape?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      connector: connectorType,
      scope: connectorScope,
      method: connectorSetupMethod,
      result: resultClass,
      duration: journeyDurationBucket,
      capabilityCount: countBucket,
      reconnect: z.boolean(),
    }).strict(),
    priority: "high",
  }),
  connector_action_completed: productEvent({
    name: "connector_action_completed",
    definition: "The regional API completed a connector test, reconnect, disconnect, or secret-rotation action.",
    productQuestion: "Which connector maintenance actions succeed and what health transition follows?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      connectorId: resourceId,
      connector: connectorType,
      scope: connectorScope,
      action: z.enum(["test", "reconnect", "disconnect", "secret_rotate"]),
      previousHealth: connectorHealth,
      appliedHealth: connectorHealth,
      result: resultClass,
    }).strict(),
  }),
  connector_health_changed: productEvent({
    name: "connector_health_changed",
    definition: "A connector's durable health state changed between two bounded classifications.",
    productQuestion: "Which connector families lose or recover health, under which coarse causes?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: z.object({
      connectorId: resourceId,
      connector: connectorType,
      scope: connectorScope,
      previousHealth: connectorHealth,
      appliedHealth: connectorHealth,
      cause: z.enum(["provider_auth", "provider_error", "user_action", "reconnect", "unknown"]),
    }).strict(),
  }),
  connector_activity_ingested: productEvent({
    name: "connector_activity_ingested",
    definition: "A regional connector-ingress batch reached a bounded admission result without provider content.",
    productQuestion: "Which connector activity classes create usable Avalon activity and where is ingestion lost?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace"],
    properties: z.object({
      connector: connectorType,
      activityType: safeTelemetryTaxonomyValue,
      result: z.enum(["accepted", "duplicate", "filtered", "failed"]),
      itemCount: countBucket,
    }).strict(),
  }),
  application_settings_state_v2: productEvent({
    name: "application_settings_state_v2",
    definition: "The actual main-owned desktop application settings observed after launch, including menu-bar state.",
    productQuestion: "Which startup, security, menu-bar, and icon settings are active across eligible desktop launches?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      launchAtLoginEnabled: z.boolean(),
      launchAtLoginAvailable: z.boolean(),
      lockdownModeEnabled: z.boolean(),
      lockdownModeAvailable: z.boolean(),
      menuBarEnabled: z.boolean(),
      menuBarAvailable: z.boolean(),
      menuBarPresent: z.boolean(),
      applicationIcon,
      applicationIconAutomatic: z.boolean(),
      applicationIconAvailable: z.boolean(),
    }).strict(),
  }),
  application_setting_change_completed_v2: productEvent({
    name: "application_setting_change_completed_v2",
    definition: "A main-owned application-setting mutation completed with its applied state and bounded result.",
    productQuestion: "How do people change startup, Lockdown, and menu-bar behavior, including requests the platform cannot apply?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: z.object({
      setting: z.enum(["launch_at_login", "lockdown_mode", "menu_bar"]),
      previousEnabled: z.boolean(),
      requestedEnabled: z.boolean(),
      appliedEnabled: z.boolean(),
      result: z.enum(["success", "not_applied", "failed"]),
    }).strict(),
  }),
  digest_schedule_updated: productEvent({
    name: "digest_schedule_updated",
    definition: "The regional API durably replaced a member's digest schedule with bounded cadence dimensions.",
    productQuestion: "How do members configure recurring digests, and which schedule shapes are retained?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      enabled: z.boolean(),
      dayCount: countBucket,
      timeCount: countBucket,
      cadence: z.enum(["disabled", "daily", "multiple_daily", "weekly", "multiple_weekly"]),
      deliveryTargetTypes: z.array(automationDeliveryTargetType).max(2),
      result: resultClass,
    }).strict(),
  }),
  digest_delivery_terminal: productEvent({
    name: "digest_delivery_terminal",
    definition: "A scheduled digest delivery reached its authoritative terminal result.",
    productQuestion: "How reliably do configured digests deliver useful activity across target types?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      deliveryId: resourceId,
      result: resultClass,
      activityCount: countBucket,
      targetTypes: z.array(automationDeliveryTargetType).max(2),
      firstDelivery: z.boolean(),
    }).strict(),
    priority: "high",
  }),
  workspace_invitation_terminal: productEvent({
    name: "workspace_invitation_terminal",
    definition: "A workspace invitation was created, revoked, accepted, or declined through the regional authority.",
    productQuestion: "How often do invitations create collaboration, and where does the invitation journey stop?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["platform-user", "workspace-user"],
    properties: z.object({
      invitationId: resourceId,
      action: z.enum(["created", "revoked", "accepted", "declined"]),
      role: z.enum(["admin", "member"]),
      deliveryResult: z.enum(["success", "failed", "not_applicable"]),
      timeToTerminal: journeyDurationBucket,
    }).strict(),
  }),
  terminal_policy_changed: productEvent({
    name: "terminal_policy_changed",
    definition: "The regional API durably changed the workspace Terminal network policy.",
    productQuestion: "Which Terminal policy modes are adopted and under what active-sandbox conditions?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: z.object({
      previousMode: z.enum(["restricted", "unrestricted", "custom"]),
      appliedMode: z.enum(["restricted", "unrestricted", "custom"]),
      customDomainCount: countBucket,
      activeSandboxCount: countBucket,
      result: resultClass,
    }).strict(),
  }),
  site_page_viewed: productEvent({
    name: "site_page_viewed",
    definition: "A classified public-site page became visible after regional telemetry bootstrap.",
    productQuestion: "Which public Avalon pages attract visits and from which bounded acquisition sources?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: z.object({
      page: z.enum(["landing", "download", "support", "legal", "auth_handoff", "invite_handoff", "workstream_handoff", "slack_handoff", "desktop_handoff", "not_found"]),
      pathname: z.string().min(1).max(160).regex(/^\/[a-z0-9_:/.-]*$/u),
      referringDomain: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/u).optional(),
      campaignSource: safeTelemetryTaxonomyValue.optional(),
      campaignMedium: safeTelemetryTaxonomyValue.optional(),
      campaignName: safeTelemetryTaxonomyValue.optional(),
    }).strict(),
  }),
  site_page_left: productEvent({
    name: "site_page_left",
    definition: "A classified public-site page was left after a bounded visible duration.",
    productQuestion: "How long do visitors engage with each public Avalon page before leaving?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: z.object({
      page: z.enum(["landing", "download", "support", "legal", "auth_handoff", "invite_handoff", "workstream_handoff", "slack_handoff", "desktop_handoff", "not_found"]),
      pathname: z.string().min(1).max(160).regex(/^\/[a-z0-9_:/.-]*$/u),
      duration: journeyDurationBucket,
    }).strict(),
  }),
  site_action_selected: productEvent({
    name: "site_action_selected",
    definition: "A visitor selected one bounded semantic action on the public Avalon site.",
    productQuestion: "Which public-site calls to action and information affordances convert attention?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: z.object({
      page: z.enum(["landing", "download", "support"]),
      action: z.enum(["download", "primary_cta", "secondary_cta", "faq_opened", "connector_setup", "support_contact"]),
      placement: z.enum(["header", "hero", "body", "footer", "faq", "connector", "unknown"]),
    }).strict(),
  }),
  desktop_handoff_attempted: productEvent({
    name: "desktop_handoff_attempted",
    definition: "A classified browser-to-desktop handoff was presented or attempted without retaining its token or resource identifier.",
    productQuestion: "Which browser handoffs reach a valid automatic or manual desktop-open attempt?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: z.object({
      handoffType: z.enum(["auth", "invite", "workstream", "slack", "settings", "automation", "unknown"]),
      method: z.enum(["presented", "automatic", "manual"]),
      validity: z.enum(["valid", "invalid"]),
    }).strict(),
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
export type TelemetryEventProperties<TName extends TelemetryEventName> = z.infer<
  (typeof TELEMETRY_EVENTS)[TName]["properties"]
>;
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
const telemetryContextCommon = {
  environment: z.enum(["development", "staging", "production"]),
  region: z.enum(["global", "eu"]).optional(),
  release: SafeReleaseSchema,
  buildId: SafeReleaseSchema,
  platform: z.enum(["darwin", "win32", "linux"]).optional(),
  arch: z.enum(["arm64", "x64"]).optional(),
  channel: z.enum(["development", "alpha", "beta", "stable"]).optional(),
  launchId: UuidV7Schema.optional(),
  sessionId: UuidV7Schema.optional(),
  onboardingJourneyId: UuidV7Schema.optional(),
  operationId: UuidV7Schema.optional(),
  requestId: UuidV7Schema.optional(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  spanId: z.string().regex(/^[a-f0-9]{16}$/u).optional(),
};

const telemetryNativeDesktopContext = {
  deviceId: UuidV7Schema.optional(),
  osVersion: z.string().trim().min(1).max(128).regex(/^\P{Cc}+$/u).optional(),
  locale: z.string().min(2).max(35).regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u).optional(),
  timezone: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_+-]+(?:\/[a-zA-Z0-9_+-]+)*$/u).optional(),
  screenWidth: z.number().int().positive().max(100_000).optional(),
  screenHeight: z.number().int().positive().max(100_000).optional(),
  viewportWidth: z.number().int().positive().max(100_000).optional(),
  viewportHeight: z.number().int().positive().max(100_000).optional(),
  windowId: UuidV7Schema.optional(),
};

const TelemetryContextV1Schema = z.object({
  ...telemetryContextCommon,
  deviceId: z.never().optional(),
  osVersion: z.never().optional(),
  locale: z.never().optional(),
  timezone: z.never().optional(),
  screenWidth: z.never().optional(),
  screenHeight: z.never().optional(),
  viewportWidth: z.never().optional(),
  viewportHeight: z.never().optional(),
  windowId: z.never().optional(),
}).strict();

const TelemetryContextV2Schema = z.object({
  ...telemetryContextCommon,
  ...telemetryNativeDesktopContext,
}).strict();

/**
 * The envelope schema identifier this build mints.
 *
 * A desktop build carries it compiled in and spools envelopes to disk before
 * sending, so the superseded spelling arrives from installed clients and from
 * a spool written before an update. The reader accepts both; only this constant
 * is written.
 */
export const TELEMETRY_ENVELOPE_SCHEMA = "ai.rallywith.telemetry.event";

/**
 * Superseded identifiers still accepted inbound, never emitted.
 *
 * Two of them, because the rename landed in two steps: `com.avalon` was the
 * original, `com.rally` the first Rally spelling, and `ai.rallywith` matches the
 * desktop bundle id. A spool on disk can hold any of the three.
 */
export const SUPERSEDED_TELEMETRY_ENVELOPE_SCHEMAS = [
  "com.rally.telemetry.event",
  "com.avalon.telemetry.event",
] as const;

const envelopeCommon = {
  schema: z.union([
    z.literal(TELEMETRY_ENVELOPE_SCHEMA),
    ...SUPERSEDED_TELEMETRY_ENVELOPE_SCHEMAS.map((value) => z.literal(value)),
  ]),
  schemaVersion: z.literal(1),
  eventId: UuidV7Schema,
  name: z.string(),
  source: z.enum(TELEMETRY_SOURCES),
  category: z.enum(TELEMETRY_CATEGORIES),
  identityScope: z.enum(TELEMETRY_IDENTITY_SCOPES),
  originalTimestamp: z.string().datetime({ offset: true }),
  sentAt: z.string().datetime({ offset: true }),
  properties: z.record(z.string(), z.unknown()),
};

const EnvelopeBaseSchema = z.union([
  z.object({ ...envelopeCommon, context: TelemetryContextV1Schema }).strict(),
  z.object({
    ...envelopeCommon,
    contextSchemaVersion: z.literal(2),
    context: TelemetryContextV2Schema,
  }).strict(),
]);

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
  routeToken: z.string().min(32).max(2_048).optional(),
}).strict();
export type TelemetryBootstrapRequest = z.infer<typeof TelemetryBootstrapRequestSchema>;

export const TelemetryRouteResponseSchema = z.object({
  route: z.enum(["global", "eu"]),
  routingBasis: z.enum(["ip_geolocation", "geolocation_fallback"]),
  routeToken: z.string().min(32).max(2_048),
}).strict();
export type TelemetryRouteResponse = z.infer<typeof TelemetryRouteResponseSchema>;

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

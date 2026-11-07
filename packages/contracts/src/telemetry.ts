import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";
import { deferredZodSchema, memoizedValue } from "./deferred-zod-schema";

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
  "custom_mcp",
  "google",
  "generic_webhook",
  "github",
  "apollo",
  "ashby",
  "canva",
  "fireflies",
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

export const CURRENT_APPLICATION_ICON_IDS = [
  "light",
  "dark",
  "calm",
  "ludicrous",
  "homage",
  "builder",
  "quiet",
] as const;
export type CurrentApplicationIconId = typeof CURRENT_APPLICATION_ICON_IDS[number];

// Ingestion and the on-disk spool must continue accepting released clients.
// Retired artwork is never reintroduced into the selectable preference allowlist.
export const TELEMETRY_APPLICATION_ICON_IDS = [
  ...CURRENT_APPLICATION_ICON_IDS,
  "sunset-sherbet",
  "ludicrous-speed",
  "ruby",
  "holographic",
  "leather",
  "blueprint",
  "grass-court",
  "clay-court",
  "hard-court",
  "ball-felt",
  "night-match",
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
  properties: z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
  propertyClassifications: Readonly<Record<string, TelemetryPropertyClassification>>;
  sampleRate: number;
  priority: "critical" | "high" | "normal" | "low";
  localRetention: "none" | "14-days";
  regionalRetention: "90-days" | "13-months";
  destination: "posthog" | "internal-only";
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
const applicationVersionProperties = deferredZodSchema(() => z.strictObject({
  state: z.enum(["installed", "updated"]),
  previousVersion: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u).optional(),
  previousBuild: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u).optional(),
}).superRefine((value, context) => {
  const previousCount = Number(value.previousVersion !== undefined) + Number(value.previousBuild !== undefined);
  if ((value.state === "installed" && previousCount !== 0)
    || (value.state === "updated" && previousCount !== 2)) {
    context.addIssue({ code: "custom", message: "application_version_transition_invalid" });
  }
}));
const durationBucket = z.enum(["lt_100ms", "100ms_1s", "1s_5s", "5s_30s", "gte_30s"]);
const journeyDurationBucket = z.enum(["unknown", "lt_1s", "1s_5s", "5s_30s", "30s_2m", "2m_10m", "gte_10m"]);
/**
 * Public-site traffic classification (docs/site-traffic-classification.md).
 * Every value is a derived yes/no code; the raw network, header, timezone and
 * input data behind it never leaves the check that read it.
 */
export const SITE_TRAFFIC_CLASSES = ["declared_bot", "automated", "datacenter", "human", "unverified"] as const;
/** Checks the page runs before its telemetry starts; sent in the bootstrap body. */
export const SITE_PAGE_START_SIGNALS = ["webdriver", "automation_globals", "engine_mismatch"] as const;
/** Facts about input the page reports when it is left. */
export const SITE_PAGE_LEAVE_SIGNALS = ["human_input", "untrusted_input", "swipe_no_scroll", "never_visible"] as const;
/** Checks the API runs on the bootstrap request itself. */
export const SITE_EDGE_SIGNALS = [
  "declared_bot",
  "signed_agent",
  "headless_ua",
  "origin_bad",
  "fetch_metadata_bad",
  "hosting_network",
  "private_relay",
  "tz_offset_mismatch",
  "transport_legacy",
  "accept_language_bad",
  "ch_contradiction",
  "x_in_app",
] as const;
export const SITE_TRAFFIC_REASONS = [
  ...SITE_EDGE_SIGNALS,
  ...SITE_PAGE_START_SIGNALS,
  ...SITE_PAGE_LEAVE_SIGNALS,
] as const;
export type SiteTrafficClass = typeof SITE_TRAFFIC_CLASSES[number];
export type SiteTrafficReason = typeof SITE_TRAFFIC_REASONS[number];
const siteTrafficClass = z.enum(SITE_TRAFFIC_CLASSES);
const siteTrafficReasons = z.array(z.enum(SITE_TRAFFIC_REASONS)).max(SITE_TRAFFIC_REASONS.length);
const countBucket = z.enum(["zero", "one", "two_to_five", "six_to_twenty", "twenty_one_to_one_hundred", "over_one_hundred"]);
const resultClass = z.enum(["success", "validation_error", "conflict", "denied", "unavailable", "failed"]);
const region = RegionSchema;
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
  "settings_application", "settings_developer", "resource_inspector", "terminal",
]);
const surfaceEntrypoint = z.enum([
  "direct", "sidebar_new", "sidebar_pinned", "sidebar_recent", "sidebar_note", "sidebar_automation",
  "home_waiting", "home_suggested", "menu_bar", "command_shortcut", "deep_link", "notification",
  "automation_run_list", "in_app_link", "settings", "unknown",
]);
/**
 * Every row the macOS status menu has ever reported selecting.
 *
 * Exported so `TelemetryReporter` takes its parameter type from here: the two
 * were hand-copied unions before, they drifted, and `open_rally`/`quit_rally`
 * were emitted for months against an enum that only admitted the `avalon`
 * spelling — every one of those events was refused at ingestion.
 *
 * Nothing is removed when a row leaves the menu. This schema is what admits an
 * event at ingestion and released clients keep sending what their build offers,
 * so a retired value stays admitted and simply stops arriving. Read a value's
 * presence here as "has been emitted by some shipped build", never as "the
 * current menu offers this".
 */
export const TELEMETRY_MENU_BAR_ACTIONS = [
  // Retired with the Suggestions section and the three New rows.
  "new_workstream", "new_automation", "suggested_work", "new_meeting_note",
  // Retired spellings, from before the product was named Rally.
  "open_avalon", "quit_avalon",
  "recent_workstream", "pinned_workstream", "open_rally", "quit_rally",
  // A row of the Needs attention section: a Channel's Main or a Breakout.
  "attention_conversation",
  // A request to join a Channel or Breakout, which opens its decision in the main window.
  "access_request",
] as const;

export type TelemetryMenuBarAction = (typeof TELEMETRY_MENU_BAR_ACTIONS)[number];

const menuBarAction = z.enum(TELEMETRY_MENU_BAR_ACTIONS);

const automationTriggerType = z.enum([
  "manual", "calendar", "interval", "connector_activity", "semantic_activity", "resource_watch", "webhook", "inbound_email",
]);
const automationDeliveryTargetType = z.enum(["email", "slack_agent_dm"]);
/** Where a digest goes: an automation destination, or the person's own Personal Channel. */
const digestDeliveryTargetType = z.enum(["email", "slack_agent_dm", "personal_channel"]);
const connectorScope = z.enum(["personal", "workspace"]);
const connectorSetupMethod = z.enum(["oauth", "api_key", "direct", "webhook"]);
const connectorHealth = z.enum(["healthy", "needs_reconnect", "error", "disabled", "unknown"]);
export const TELEMETRY_REALTIME_SOCKETS = [
  "workspace",
  "workstream_control",
  "substream_feed",
] as const;
export type TelemetryRealtimeSocket = typeof TELEMETRY_REALTIME_SOCKETS[number];
export const TELEMETRY_REALTIME_SOCKET_CAUSES = [
  "opened",
  "transport_error",
  "heartbeat_timeout",
  "server_closed",
  "ticket_failed",
  "ticket_timeout",
  "resync_required",
  "offline",
  "access_revoked",
  "open_timeout",
  "sync_timeout",
  "suspended",
] as const;
export type TelemetryRealtimeSocketCause = typeof TELEMETRY_REALTIME_SOCKET_CAUSES[number];

const realtimeSocketProperties = deferredZodSchema(() => z.strictObject({
  socket: z.enum(TELEMETRY_REALTIME_SOCKETS),
  state: z.enum(["connected", "retrying", "stopped"]),
  cause: z.enum(TELEMETRY_REALTIME_SOCKET_CAUSES),
  attempts: countBucket,
}).superRefine((value, context) => {
  // The one combination that is not a measurement but a mistake: a socket that
  // opened has no failure cause, and a failure cause did not open a socket. The
  // message is a validation code for whoever reads a rejection, never a value
  // any destination sees: a refused event is not sent at all.
  if ((value.state === "connected") !== (value.cause === "opened")) {
    context.addIssue({ code: "custom", message: "realtime_socket_state_cause_invalid" });
  }
}));

const generatedJavascriptFrame = z.string().min(1).max(192)
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._/-]{0,159}\.(?:c?js):\d{1,7}:\d{1,5}$/u)
  .refine((value) => !value.startsWith("/") && !value.includes(".."));

const common = {
  owner: "product-analytics",
  reviewGroup: "telemetry-governance",
  sampleRate: 1,
  localRetention: "14-days" as const,
  destination: "posthog" as const,
};

function productEvent<
  const TName extends string,
  const TSources extends readonly TelemetrySource[],
  const TScopes extends readonly TelemetryIdentityScope[],
  TProperties extends z.ZodLazy<z.ZodObject<z.ZodRawShape>>,
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
  const propertyClassifications = memoizedValue(() => Object.fromEntries(
    Object.keys(input.properties.unwrap().shape).map((key) => [key, "product" as const]),
  ));
  const registryEntry = event({
    ...common,
    ...input,
    category: "product" as const,
    propertyClassifications: {} as Readonly<Record<string, TelemetryPropertyClassification>>,
    priority: input.priority ?? "normal",
    regionalRetention: "13-months" as const,
  });
  Object.defineProperty(registryEntry, "propertyClassifications", {
    configurable: false,
    enumerable: true,
    get: propertyClassifications,
  });
  return registryEntry;
}

const signupEventProperties = deferredZodSchema(() => z.strictObject({
      flowId: UuidV7Schema,
      clientPlatform: z.enum(["browser", "desktop"]),
      entryPlatform: z.enum(["browser", "desktop"]),
      method: z.enum(["google", "email", "otp", "magic", "unknown"]),
      result: z.enum(["success", "failed", "denied"]),
      accountStatus: z.enum(["new", "existing"]).optional(),
      signupPath: z.enum(["new_organization", "existing_organization"]).optional(),
    }));

function signupEvent<Name extends string>(name: Name, definition: string) {
  return productEvent({
    name, definition,
    productQuestion: "Where do browser and desktop signup attempts drop off?",
    sources: ["api"], authoritativeSource: "api", identityScopes: ["anonymous-epoch"],
    properties: signupEventProperties, priority: "high",
  });
}

export const TELEMETRY_EVENTS = {
  desktop_install_opened: productEvent({
    name: "desktop_install_opened",
    definition: "The desktop process opened with newly created installation data and no saved account.",
    productQuestion: "Where do fresh desktop installations drop off before completing signup?",
    sources: ["desktop-main"], authoritativeSource: "desktop-main", identityScopes: ["anonymous-epoch"],
    properties: deferredZodSchema(() => z.strictObject({ flowId: UuidV7Schema, clientPlatform: z.literal("desktop") })),
    priority: "high",
  }),
  signup_onboarding_completed: signupEvent("signup_onboarding_completed", "A new user completed the account introduction."),
  signup_organization_ready: signupEvent("signup_organization_ready", "A new user gained access to a new or existing organization."),
  signup_organization_requested: signupEvent("signup_organization_requested", "A new user requested organization creation or invitation acceptance."),
  signup_account_created: signupEvent("signup_account_created", "A new account received an authenticated session."),
  signup_viewed: signupEvent("signup_viewed", "The browser or desktop sign-in screen became visible."),
  signup_started: signupEvent("signup_started", "A sign-in or signup request reached the API."),
  signup_email_submitted: signupEvent("signup_email_submitted", "A mailbox challenge was issued after email submission."),
  signup_verification_requested: signupEvent("signup_verification_requested", "A code, magic link, or Google callback reached verification."),
  signup_verification_completed: signupEvent("signup_verification_completed", "The API verified the mailbox or Google identity."),
  authentication_completed: signupEvent("authentication_completed", "The API issued an authenticated session for a new or returning account."),
  signup_completed: signupEvent("signup_completed", "A new user gained organization access and completed any required account introduction."),
  signup_failed: signupEvent("signup_failed", "An observed authentication stage failed or was declined."),

  application_lifecycle: event({
    ...common,
    name: "application_lifecycle",
    definition: "A content-free transition in the lifecycle of one desktop application process.",
    productQuestion: "How many eligible application launches reach ready and exit cleanly by release?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    category: "essential",
    identityScopes: ["installation"],
    properties: deferredZodSchema(() => z.strictObject({ state: lifecycleState, crashReportingEligible: z.boolean() })),
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
    properties: deferredZodSchema(() => z.strictObject({ state: z.enum(["started", "ended"]), continuouslyEligible: z.boolean() })),
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
    properties: deferredZodSchema(() => z.strictObject({
      process: z.enum(["main", "preload", "renderer", "utility", "gpu"]),
      state: z.enum(["gone", "unresponsive", "responsive", "exception", "rejection", "unclean_exit"]),
      reasonClass: z.enum(["crashed", "killed", "oom", "launch_failure", "unknown"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      phase: z.enum(["check", "download", "apply", "rollback"]),
      result: z.enum(["available", "current", "success", "failed", "cancelled"]),
      duration: durationBucket,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      operation: z.enum(["onboarding_bootstrap", "workspace_create", "workspace_activate", "workstream_create", "canvas_create", "run_start"]),
      result: resultClass,
      duration: durationBucket,
    })),
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
  desktop_action_phase: event({
    ...common,
    name: "desktop_action_phase",
    definition: "A content-free desktop phase of one durable action requested by an agent.",
    productQuestion: "Did a slow desktop action reach the renderer, wait in its queue, execute in the browser, or wait to send its answer?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "diagnostic",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      actionId: uuidV7Id,
      phase: z.enum([
        "received", "reoffered", "execution_started", "browser_state_requested", "browser_state_received",
        "browser_command_requested", "browser_command_completed", "execution_completed", "execution_failed",
        "answer_sent", "answer_deferred", "run_ended",
      ]),
      elapsedMs: z.number().int().nonnegative(),
      windowVisible: z.boolean(),
    })),
    propertyClassifications: {
      actionId: "operational", phase: "diagnostic", elapsedMs: "diagnostic", windowVisible: "operational",
    },
    priority: "normal",
    regionalRetention: "90-days",
  }),
  workspace_socket_handshake: event({
    ...common,
    name: "workspace_socket_handshake",
    definition: "A content-free phase of one desktop workspace socket's first directory handshake.",
    productQuestion: "Did an affected desktop obtain a ticket, open its socket, send subscribe, and apply the first directory?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "essential",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      attemptId: uuidV7Id,
      phase: z.enum([
        "ticket_requested", "ticket_received", "transport_open", "subscribe_sent",
        "sync_received", "sync_applied", "sync_rejected", "offline_blocked", "open_timeout", "sync_timeout",
      ]),
      // See docs/telemetry.md, the workspace socket handshake.
      sinceTicketRequested: journeyDurationBucket.optional(),
      windowVisible: z.boolean().optional(),
    })),
    propertyClassifications: {
      attemptId: "operational", phase: "operational", sinceTicketRequested: "operational", windowVisible: "operational",
    },
    priority: "high",
    regionalRetention: "90-days",
  }),
  workstream_socket_started: event({
    ...common,
    name: "workstream_socket_started",
    definition: "The desktop began one WorkstreamDO control or AgentLoopDO feed connection attempt, including its ticket request.",
    productQuestion: "Why are work-stream sockets started, which kind starts, and how much connection work comes from initial admission versus reconnects?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      socketLeaseId: uuidV7Id,
      openAttemptId: uuidV7Id.optional(),
      socket: z.enum(["workstream_control", "substream_feed"]),
      reason: z.enum(["hover_warmup", "active_workstream", "background_workstream", "retained_workstream", "reconnect"]),
      attempts: countBucket,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      state: z.enum(["accepted", "rejected", "evicted", "expired", "quarantined", "pressure", "delivered"]),
      count: z.enum(["one", "two_to_ten", "eleven_to_one_hundred", "over_one_hundred"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      state: z.enum([
        "awaiting_restart", "rotated", "queued", "uploading", "accepted", "rejected",
        "retrying", "expired", "invalidated", "evicted", "corrupt", "lost",
      ]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({ screen })),
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
    properties: deferredZodSchema(() => z.strictObject({
      surface: telemetrySurface,
      entrypoint: surfaceEntrypoint,
      resourceType: z.enum(["workstream", "note", "automation"]).optional(),
      resourceId: z.string().uuid().optional(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      launchAtLoginEnabled: z.boolean(),
      launchAtLoginAvailable: z.boolean(),
      lockdownModeEnabled: z.boolean(),
      lockdownModeAvailable: z.boolean(),
      applicationIcon,
      applicationIconAutomatic: z.boolean(),
      applicationIconAvailable: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      setting: z.enum(["launch_at_login", "lockdown_mode"]),
      previousEnabled: z.boolean(),
      requestedEnabled: z.boolean(),
      appliedEnabled: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      previousIcon: applicationIcon,
      previousAutomatic: z.boolean(),
      selectedIcon: applicationIcon,
      automatic: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      entrypoint: z.enum([
        "system_start", "user_launch", "dock", "deep_link", "menu_bar", "push_notification",
      ]),
      phase: z.enum(["cold_start", "activation"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      signedIn: z.boolean(),
      /**
       * No longer emitted: the status menu dropped its Suggestions section, so
       * there is no count to take. Kept optional rather than removed because
       * this schema is what admits an event at ingestion, and a released client
       * still sends it. Historical rows carry it; do not read its absence as
       * "nothing was suggested".
       */
      suggestionCount: z.number().int().min(0).max(4).optional(),
      /** Raised from 5 with the ten-row recent list. A released client's
       * smaller count still validates, so the two cohorts stay comparable. */
      recentCount: z.number().int().min(0).max(10),
      pinnedCount: z.number().int().min(0).max(5),
      /**
       * The number beside the status item when it opened: every conversation
       * waiting for the reader, the sidebar's count. Optional because builds
       * before the Needs attention section do not send it.
       */
      attentionCount: z.number().int().min(0).optional(),
    })),
    propertyClassifications: {
      signedIn: "product",
      suggestionCount: "product",
      recentCount: "product",
      pinnedCount: "product",
      attentionCount: "product",
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
    properties: deferredZodSchema(() => z.strictObject({
      action: menuBarAction,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({ availableCount: z.number().int().min(0).max(9) })),
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
    properties: deferredZodSchema(() => z.strictObject({
      shortcutNumber: z.number().int().min(1).max(9),
      destinationType: z.enum(["pinned_workstream", "recent_workstream", "recent_note"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({ surface: z.enum(["menu_bar", "workspace_home"]) })),
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
    properties: deferredZodSchema(() => z.strictObject({
      opportunityId: resourceId,
      version: z.number().int().positive(),
      surface: z.enum(["menu_bar", "workspace_home"]),
      position: z.number().int().min(1).max(4),
      audienceScope: z.enum(["personal", "workspace"]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      freshness: z.enum(["lt_1h", "1h_24h", "1d_7d", "gte_7d"]),
      priorImpressionCount: countBucket,
    })),
  }),
  suggested_work_dismissed: productEvent({
    name: "suggested_work_dismissed",
    definition: "A ranked suggested-work card was durably dismissed by the member who saw it.",
    productQuestion: "Which visible suggestion classes are rejected, and how long after first exposure?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      opportunityId: resourceId,
      version: z.number().int().positive(),
      surface: z.enum(["menu_bar", "workspace_home"]),
      position: z.number().int().min(1).max(4),
      audienceScope: z.enum(["personal", "workspace"]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      timeSinceFirstImpression: journeyDurationBucket,
    })),
  }),
  suggested_work_started_v2: productEvent({
    name: "suggested_work_started_v2",
    definition: "A ranked suggested-work item durably created its destination work stream with exposure context.",
    productQuestion: "Which seen suggestions become work, and how does exposure history affect conversion?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      opportunityId: resourceId,
      workstreamId: resourceId,
      version: z.number().int().positive(),
      surface: z.enum(["menu_bar", "workspace_home"]),
      position: z.number().int().min(1).max(4),
      audienceScope: z.enum(["personal", "workspace"]),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      priorImpressionCount: countBucket,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      visibility,
      navigation: z.enum(["opened", "switched", "reopened"]),
      origin: z.enum(["ad_hoc", "automation", "system"]),
      pinned: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      socketLeaseId: uuidV7Id.optional(),
      durationMs: z.number().int().nonnegative(),
      dataReadyDurationMs: z.number().int().nonnegative(),
      sidebarSection: z.enum(["pinned", "recent"]),
      cacheState: z.enum(["feed_cached", "detail_cached", "cold"]),
      socketPoolState: z.enum(["retained_pair", "control_warmup", "cold"]),
      feedSource: z.enum(["feed_cache", "socket_snapshot", "boot_payload", "local_cache"]),
      messageCount: countBucket,
    }).superRefine((properties, context) => {
      if (properties.dataReadyDurationMs > properties.durationMs) {
        context.addIssue({ code: "custom", message: "data-ready duration cannot exceed painted duration" });
      }
    })),
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
  workstream_send_ready: event({
    ...common,
    name: "workstream_send_ready",
    definition: "A work stream opened from the desktop sidebar painted a composer whose installed send handler could accept a command into the workspace socket queue.",
    productQuestion: "How long does a sidebar click take to produce a send-capable composer, and is its workspace command socket connected or queueing during connection recovery?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      durationMs: z.number().int().nonnegative(),
      workspaceSocketState: z.enum(["connecting", "connected", "reconnecting"]),
    })),
    propertyClassifications: {
      workstreamId: "product",
      durationMs: "operational",
      workspaceSocketState: "operational",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  renderer_perf_flow: event({
    ...common,
    name: "renderer_perf_flow",
    definition: "A content-free renderer timing breakdown for one latency-critical work-stream or search flow.",
    productQuestion: "Which renderer, network, and service-facing phases consume the latency budget for work-stream create, open, message-send, and workspace search flows?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "diagnostic",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      flow: z.enum(["workstream_create", "substream_prepare", "substream_create", "workstream_open", "workstream_message_send", "workspace_search"]),
      workstreamId: resourceId.optional(),
      outcome: z.enum([
        "completed", "navigation_requested", "snapshot", "replay_event", "resync_required",
        "closed", "failed", "cancelled", "offline", "superseded", "unmounted",
      ]),
      durationMs: z.number().nonnegative(),
      blockedMs: z.number().nonnegative(),
      longTaskCount: countBucket,
      searchDebounceMs: z.number().nonnegative().optional(),
      searchRequestMs: z.number().nonnegative().optional(),
      searchRenderMs: z.number().nonnegative().optional(),
      searchScopeMs: z.number().nonnegative().optional(),
      searchRetrievalMs: z.number().nonnegative().optional(),
      searchHydrationMs: z.number().nonnegative().optional(),
      searchServerMs: z.number().nonnegative().optional(),
      createRequestMs: z.number().nonnegative().optional(),
      prepareRequestMs: z.number().nonnegative().optional(),
      confirmRequestMs: z.number().nonnegative().optional(),
      systemWaitMs: z.number().nonnegative().optional(),
      cacheSeedMs: z.number().nonnegative().optional(),
      socketTicketMs: z.number().nonnegative().optional(),
      dialMs: z.number().nonnegative().optional(),
      handshakeMs: z.number().nonnegative().optional(),
      firstFrameMs: z.number().nonnegative().optional(),
      pacResolutionMs: z.number().nonnegative().optional(),
      dnsMs: z.number().nonnegative().optional(),
      tcpMs: z.number().nonnegative().optional(),
      tlsMs: z.number().nonnegative().optional(),
      edgeUpgradeMs: z.number().nonnegative().optional(),
      proxyHandshakeMs: z.number().nonnegative().optional(),
      failedRouteCount: countBucket.optional(),
      resolveMentionsMs: z.number().nonnegative().optional(),
      commandRoundTripMs: z.number().nonnegative().optional(),
      attempts: countBucket.optional(),
      sinceEffectMs: z.number().nonnegative().optional(),
      ticketId: uuidV7Id.optional(),
      clientMessageId: z.string().uuid().optional(),
      participantCount: countBucket.optional(),
      attachmentCount: countBucket.optional(),
      mentionCount: countBucket.optional(),
      messageLength: countBucket.optional(),
      messageCount: countBucket.optional(),
    })),
    propertyClassifications: {
      flow: "diagnostic",
      workstreamId: "product",
      outcome: "diagnostic",
      durationMs: "diagnostic",
      blockedMs: "diagnostic",
      longTaskCount: "diagnostic",
      searchDebounceMs: "diagnostic",
      searchRequestMs: "diagnostic",
      searchRenderMs: "diagnostic",
      searchScopeMs: "diagnostic",
      searchRetrievalMs: "diagnostic",
      searchHydrationMs: "diagnostic",
      searchServerMs: "diagnostic",
      createRequestMs: "diagnostic",
      prepareRequestMs: "diagnostic",
      confirmRequestMs: "diagnostic",
      systemWaitMs: "diagnostic",
      cacheSeedMs: "diagnostic",
      socketTicketMs: "diagnostic",
      dialMs: "diagnostic",
      handshakeMs: "diagnostic",
      firstFrameMs: "diagnostic",
      pacResolutionMs: "diagnostic",
      dnsMs: "diagnostic",
      tcpMs: "diagnostic",
      tlsMs: "diagnostic",
      edgeUpgradeMs: "diagnostic",
      proxyHandshakeMs: "diagnostic",
      failedRouteCount: "diagnostic",
      resolveMentionsMs: "diagnostic",
      commandRoundTripMs: "diagnostic",
      attempts: "diagnostic",
      sinceEffectMs: "diagnostic",
      ticketId: "operational",
      clientMessageId: "operational",
      participantCount: "diagnostic",
      attachmentCount: "diagnostic",
      mentionCount: "diagnostic",
      messageLength: "diagnostic",
      messageCount: "diagnostic",
    },
    priority: "normal",
    regionalRetention: "90-days",
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      sidebarSection: z.enum(["pinned", "recent"]),
      socketPoolState: z.enum(["retained_pair", "control_warmup", "cold"]),
      socketLeaseId: uuidV7Id.optional(),
    })),
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
    definition: "One sidebar work-stream opening attempt reached a visible feed, was superseded by another sidebar click, was abandoned by other navigation, or failed to load.",
    productQuestion: "What fraction of sidebar opening attempts become visible, fail, are superseded by another work stream, or are abandoned for another surface?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      outcome: z.enum(["visible", "superseded", "abandoned", "load_failed"]),
      durationMs: z.number().int().nonnegative(),
      socketLeaseId: uuidV7Id.optional(),
      supersedingWorkstreamId: resourceId.optional(),
    }).superRefine((properties, context) => {
      if ((properties.outcome === "superseded") !== (properties.supersedingWorkstreamId !== undefined)) {
        context.addIssue({ code: "custom", message: "superseding work stream must appear only for a superseded opening" });
      }
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
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
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      action: z.enum(["pin", "unpin", "make_public", "make_private", "mark_unread", "rename", "archive"]),
      visibility,
      origin: z.enum(["ad_hoc", "automation", "system"]),
      pinned: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      action: z.enum(["added", "removed"]),
      method: z.enum(["picker", "mention", "server"]),
      participantCount: countBucket,
      result: resultClass,
    })),
  }),
  workstream_resource_action_completed: productEvent({
    name: "workstream_resource_action_completed",
    definition: "A resource relationship or resource-use action completed for a work stream.",
    productQuestion: "Which kinds of context are attached, watched, inspected, and removed from work streams?",
    sources: ["api", "desktop-renderer"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      resourceId,
      resourceType: safeTelemetryTaxonomyValue,
      connectorType: z.union([connectorType, z.literal("avalon")]),
      relationshipType: safeTelemetryTaxonomyValue,
      action: z.enum(["attach", "detach", "watch", "unwatch", "preview", "open_source"]),
      result: resultClass,
      surface: z.enum(["workstream", "resource_inspector", "terminal"]),
    })),
  }),
  run_action_completed: productEvent({
    name: "run_action_completed",
    definition: "The regional API completed a person-requested stop or retry action for an agent run.",
    productQuestion: "How often do people stop or retry agent work, and do those recovery actions succeed?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      action: z.enum(["stop", "retry"]),
      result: resultClass,
    })),
  }),
  terminal_workspace_terminal: productEvent({
    name: "terminal_workspace_terminal",
    definition: "A Terminal workspace lifecycle action reached its authoritative platform result.",
    productQuestion: "Where does the Terminal workspace lifecycle succeed or fail, and under which repository conditions?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      action: z.enum(["start", "restore", "expire", "fail", "start_fresh", "repository_select", "repository_replace"]),
      result: resultClass,
      duration: journeyDurationBucket,
      repositorySelected: z.boolean(),
      connectorType: z.union([connectorType, z.literal("none")]),
      localFilesRetained: z.boolean(),
    })),
  }),
  attention_consumed: productEvent({
    name: "attention_consumed",
    definition: "The regional API durably cleared a member's unread state after they consumed work-stream attention.",
    productQuestion: "Which attention signals bring people back, and how quickly are they consumed?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      unreadCount: countBucket,
      hadMention: z.boolean(),
      neededInput: z.boolean(),
      entrypoint: surfaceEntrypoint,
      timeToRead: journeyDurationBucket,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      automationId: resourceId,
      visibility,
      creationMethod: z.enum(["custom", "template"]),
      pluginCount: resourceCount,
      activityTriggerEnabled: z.boolean(),
      deliveryEnabled: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      automationId: resourceId,
      action: z.enum(["run_now", "archive_draft", "delete"]),
      visibility,
      status: z.enum(["draft", "active", "paused", "error"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({ entrypoint: surfaceEntrypoint, resumedDraft: z.boolean() })),
  }),
  automation_draft_turn_completed: productEvent({
    name: "automation_draft_turn_completed",
    definition: "The regional automation architect completed one content-free compiler turn for a durable draft.",
    productQuestion: "How many authoring turns succeed, fail, or reach create-ready state by input mode?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      draftId: resourceId.optional(),
      turnNumber: countBucket,
      result: z.enum(["success", "failed", "cancelled"]),
      duration: journeyDurationBucket,
      inputMode: z.enum(["typed", "suggested_prompt", "elicitation_response", "edit"]),
      attachmentCount: resourceCount,
      connectorMentionCount: resourceCount,
      readyToCreate: z.boolean(),
    })),
  }),
  automation_draft_ready: productEvent({
    name: "automation_draft_ready",
    definition: "An automation draft first reached a create-ready revision with bounded capability dimensions.",
    productQuestion: "Which authoring journeys become create-ready, with what trigger, connector, and delivery shape?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      draftId: resourceId,
      turnsToReady: countBucket,
      visibility,
      triggerTypes: z.array(automationTriggerType).max(8),
      connectorTypes: z.array(connectorType).max(TELEMETRY_CONNECTOR_TYPES.length),
      pluginCount: resourceCount,
      deliveryTargetTypes: z.array(automationDeliveryTargetType).max(2),
    })),
  }),
  automation_created_v2: productEvent({
    name: "automation_created_v2",
    definition: "The regional API durably created or subscribed to an automation with bounded configuration dimensions.",
    productQuestion: "Which automation creation methods and configurations survive the authoritative server write?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
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
    })),
    priority: "high",
  }),
  automation_opened: productEvent({
    name: "automation_opened",
    definition: "A successfully loaded automation overview became the active desktop resource.",
    productQuestion: "Which automations are revisited, in what lifecycle state, and from which entrypoint?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      automationId: resourceId,
      visibility,
      status: z.enum(["draft", "active", "paused", "error"]),
      entrypoint: surfaceEntrypoint,
      runCount: countBucket,
    })),
  }),
  automation_action_completed_v2: productEvent({
    name: "automation_action_completed_v2",
    definition: "The regional API completed an automation lifecycle or execution action.",
    productQuestion: "Which automation actions succeed, and what state transition did each action apply?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      automationId: resourceId,
      action: z.enum(["pause", "resume", "edit", "publish_template", "adopt_template_version", "run_now", "archive_draft", "delete"]),
      visibility,
      previousStatus: z.enum(["draft", "active", "paused", "error"]),
      appliedStatus: z.enum(["draft", "active", "paused", "error", "deleted", "archived"]),
      result: resultClass,
    })),
  }),
  message_sent: event({
    ...common,
    name: "message_sent",
    definition: "The API admitted a work-stream message or elicitation response a person sent from any client, without retaining its content.",
    productQuestion: "How often do people send messages with attachments, mentions, or newly added participants?",
    sources: ["api"],
    authoritativeSource: "api",
    category: "product",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      messageId: resourceId.optional(),
      visibility,
      workstreamOrigin: z.enum(["ad_hoc", "automation"]),
      messageKind: z.enum(["message", "elicitation_response"]),
      attachmentCount: resourceCount,
      mentionCount: resourceCount,
      participantAddedCount: resourceCount,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      messageId: resourceId,
      channel: z.enum(["desktop", "slack", "email"]),
      visibility,
      workstreamOrigin: z.enum(["ad_hoc", "automation"]),
      attachmentCount: resourceCount,
      mentionCount: resourceCount,
      participantAddedCount: resourceCount,
    })),
    priority: "high",
  }),
  elicitation_presented: productEvent({
    name: "elicitation_presented",
    definition: "A durable agent elicitation became available for a person to answer.",
    productQuestion: "Which question shapes interrupt work, and where do they enter the user experience?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      elicitationId: resourceId,
      runId: resourceId,
      workstreamId: resourceId.optional(),
      draftId: resourceId.optional(),
      responseType: z.enum(["text", "free_text", "radio", "single_select", "multi_select"]),
      optionCount: countBucket,
      surface: z.enum(["workstream", "automation_builder"]),
    })),
  }),
  elicitation_resolved: productEvent({
    name: "elicitation_resolved",
    definition: "A durable agent elicitation was answered or skipped without recording its response content.",
    productQuestion: "Which agent questions are answered or skipped, and how long do they block progress?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      elicitationId: resourceId,
      runId: resourceId,
      workstreamId: resourceId.optional(),
      draftId: resourceId.optional(),
      responseType: z.enum(["text", "free_text", "radio", "single_select", "multi_select"]),
      resolution: z.enum(["answered", "skipped"]),
      customResponseUsed: z.boolean(),
      responseLatency: journeyDurationBucket,
      surface: z.enum(["workstream", "automation_builder"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      contentType: z.enum([
        "workstream_link", "workstream_email", "workstream_id", "message_response", "code_block",
        "note_summary", "note_transcript", "note_id", "automation_email", "automation_id",
      ]),
      resourceType: z.enum(["workstream", "message", "note", "automation"]),
      resourceId,
      workstreamId: resourceId.optional(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      visibility,
      recordingState: z.enum(["idle", "recording", "complete"]),
      navigation: z.enum(["opened", "reopened"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      visibility,
      noteType: z.literal("meeting_or_voice"),
      entrypoint: z.enum(["sidebar", "menu_bar", "unknown"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      action: z.enum(["make_public", "make_private", "archive"]),
      visibility,
      recordingState: z.enum(["idle", "recording", "complete"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      state: z.enum(["started", "paused", "resumed", "completed"]),
      visibility,
      audioSource: z.enum(["microphone_and_system", "microphone_only", "system_only", "unknown"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      result: z.enum(["success", "permission_denied", "capture_failed", "persistence_failed"]),
      permissionClass: z.enum(["both_granted", "microphone_only", "system_only", "both_blocked", "unknown"]),
      audioSource: z.enum(["microphone_and_system", "microphone_only", "system_only", "unknown"]),
      entrypoint: z.enum(["sidebar", "menu_bar", "unknown"]),
    })),
    priority: "high",
  }),
  recording_terminal: productEvent({
    name: "recording_terminal",
    definition: "A meeting or voice-note recording finalized with its true transcript, summary, and persistence result.",
    productQuestion: "How often do recordings produce complete reusable notes instead of partial or failed artifacts?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      result: z.enum(["complete", "partial_transcript", "summary_failed", "persistence_failed", "capture_failed"]),
      duration: journeyDurationBucket,
      segmentCount: countBucket,
      pauseCount: countBucket,
      finalSummaryResult: z.enum(["success", "failed", "not_attempted"]),
      audioSource: z.enum(["microphone_and_system", "microphone_only", "system_only", "unknown"]),
    })),
    priority: "high",
  }),
  note_summary_generation_completed: productEvent({
    name: "note_summary_generation_completed",
    definition: "The regional API completed a live or final note-summary generation attempt.",
    productQuestion: "How reliably and quickly are live and final note summaries generated from complete or partial transcripts?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      mode: z.enum(["live", "final"]),
      result: resultClass,
      duration: journeyDurationBucket,
      transcriptStatus: z.enum(["complete", "partial"]),
      segmentCount: countBucket,
      refreshCadence: z.enum(["disabled", "one_minute", "two_minutes", "five_minutes", "custom"]),
    })),
  }),
  note_opened_v2: productEvent({
    name: "note_opened_v2",
    definition: "A successfully loaded note became active with bounded reuse and completeness dimensions.",
    productQuestion: "Which completed notes are revisited, from where, and with which durable artifacts available?",
    sources: ["desktop-renderer"],
    authoritativeSource: "desktop-renderer",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      noteId: resourceId,
      visibility,
      entrypoint: surfaceEntrypoint,
      navigation: z.enum(["opened", "reopened"]),
      recordingState: z.enum(["idle", "recording", "complete"]),
      hasSummary: z.boolean(),
      hasTranscript: z.boolean(),
      duration: journeyDurationBucket,
      segmentCount: countBucket,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      toolName: safeTelemetryTaxonomyValue,
      pluginId: safeTelemetryTaxonomyValue,
      capability: safeTelemetryTaxonomyValue,
      mode: z.enum(["read", "write"]),
      runKind: z.enum(["workstream", "automation", "subagent", "system"]),
      executionScope: z.enum(["user", "workspace"]),
    })),
    propertyClassifications: {
      workstreamId: "product", harnessRunId: "product", automationId: "product", toolName: "product",
      pluginId: "product", capability: "product", mode: "product", runKind: "product", executionScope: "product",
    },
    priority: "normal",
    regionalRetention: "13-months",
  }),
  agent_completion_reprompted: productEvent({
    name: "agent_completion_reprompted",
    definition: "Completion verification committed one recovery prompt to the persistent model conversation; not merely a classifier recommendation or proof of provider delivery.",
    productQuestion: "How often and why does completion verification admit recovery, and what happens to those runs?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      reason: z.enum(["unfinished_work", "unclear", "low_confidence", "context_missing", "credential_missing", "judge_timeout", "judge_failure"]),
      choice: z.enum(["announces_unfinished_work", "answer_or_result", "blocker_or_question", "unclear"]).nullable(),
      confidence: z.number().min(0).max(1).nullable(),
      stopConfidenceThreshold: z.number().min(0).max(1),
      judgeModel: z.literal("jev-1.14.0"),
    })),
  }),
  run_terminal: productEvent({
    name: "run_terminal",
    definition: "A root agent run reached its authoritative terminal state with bounded product and performance dimensions.",
    productQuestion: "Which user and unattended runs deliver value, need input, stop, or fail, and how efficiently?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      runKind: z.enum(["workstream", "automation", "subagent", "system"]),
      triggerType: z.enum(["composer", "retry", "manual", "scheduled", "activity", "inbound_email", "digest", "system"]),
      terminalState: z.enum(["completed", "needs_input", "stopped", "failed"]),
      duration: journeyDurationBucket,
      timeToFirstOutput: journeyDurationBucket,
      turnCount: countBucket,
      toolCallCount: countBucket,
      writeToolCallCount: countBucket,
      modelRoute: safeModelRoute.optional(),
      fallbackUsed: z.boolean(),
    })),
    priority: "high",
  }),
  agent_tool_terminal: productEvent({
    name: "agent_tool_terminal",
    definition: "A durably admitted canonical tool invocation reached a content-free terminal result.",
    productQuestion: "Which tool capabilities succeed, fail, require authority, or become ambiguous, and with what latency?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      workstreamId: resourceId,
      harnessRunId: resourceId,
      automationId: resourceId.optional(),
      toolName: safeTelemetryTaxonomyValue,
      pluginId: safeTelemetryTaxonomyValue,
      capability: safeTelemetryTaxonomyValue,
      mode: z.enum(["read", "write"]),
      runKind: z.enum(["workstream", "automation", "subagent", "system"]),
      executionScope: z.enum(["user", "workspace"]),
      result: z.enum(["success", "validation_error", "authorization_denied", "provider_error", "ambiguous", "cancelled"]),
      duration: journeyDurationBucket,
      replayed: z.boolean(),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({ selectedRegion: region, entrypoint })),
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
    properties: deferredZodSchema(() => z.strictObject({ selectedRegion: region, entrypoint })),
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
    properties: deferredZodSchema(() => z.strictObject({ selectedRegion: region, result: resultClass })),
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
    properties: deferredZodSchema(() => z.strictObject({ selectedRegion: region, entrypoint })),
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
    properties: deferredZodSchema(() => z.strictObject({ selectedRegion: region, result: resultClass })),
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
    properties: deferredZodSchema(() => z.strictObject({ entrypoint })),
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
    properties: deferredZodSchema(() => z.strictObject({ result: resultClass })),
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
    properties: deferredZodSchema(() => z.strictObject({ entrypoint })),
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
    properties: deferredZodSchema(() => z.strictObject({ result: resultClass, duration: durationBucket })),
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
    properties: deferredZodSchema(() => z.strictObject({ connector: z.enum(["github", "google", "linear", "notion", "slack"]) })),
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
    properties: deferredZodSchema(() => z.strictObject({
      connector: z.enum(["github", "google", "linear", "notion", "slack"]),
      result: resultClass,
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      connector: connectorType,
      scope: connectorScope,
      method: connectorSetupMethod,
      capabilityCount: countBucket,
    })),
  }),
  connector_setup_completed_v2: productEvent({
    name: "connector_setup_completed_v2",
    definition: "The regional API completed setup or reconnection for any registered connector family.",
    productQuestion: "Where do connector setup journeys fail by connector, method, scope, and capability shape?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      connector: connectorType,
      scope: connectorScope,
      method: connectorSetupMethod,
      result: resultClass,
      duration: journeyDurationBucket,
      capabilityCount: countBucket,
      reconnect: z.boolean(),
    })),
    priority: "high",
  }),
  connector_action_completed: productEvent({
    name: "connector_action_completed",
    definition: "The regional API completed a connector test, reconnect, disconnect, or secret-rotation action.",
    productQuestion: "Which connector maintenance actions succeed and what health transition follows?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      connectorId: resourceId,
      connector: connectorType,
      scope: connectorScope,
      action: z.enum(["test", "reconnect", "disconnect", "secret_rotate"]),
      previousHealth: connectorHealth,
      appliedHealth: connectorHealth,
      result: resultClass,
    })),
  }),
  connector_health_changed: productEvent({
    name: "connector_health_changed",
    definition: "A connector's durable health state changed between two bounded classifications.",
    productQuestion: "Which connector families lose or recover health, under which coarse causes?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user", "workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      connectorId: resourceId,
      connector: connectorType,
      scope: connectorScope,
      previousHealth: connectorHealth,
      appliedHealth: connectorHealth,
      cause: z.enum(["provider_auth", "provider_error", "user_action", "reconnect", "unknown"]),
    })),
  }),
  connector_activity_ingested: productEvent({
    name: "connector_activity_ingested",
    definition: "A regional connector-ingress batch reached a bounded admission result without provider content.",
    productQuestion: "Which connector activity classes create usable Avalon activity and where is ingestion lost?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace"],
    properties: deferredZodSchema(() => z.strictObject({
      connector: connectorType,
      activityType: safeTelemetryTaxonomyValue,
      result: z.enum(["accepted", "duplicate", "filtered", "failed"]),
      itemCount: countBucket,
    })),
  }),
  application_settings_state_v2: productEvent({
    name: "application_settings_state_v2",
    definition: "The actual main-owned desktop application settings observed after launch, including menu-bar state.",
    productQuestion: "Which startup, security, menu-bar, and icon settings are active across eligible desktop launches?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
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
    })),
  }),
  application_setting_change_completed_v2: productEvent({
    name: "application_setting_change_completed_v2",
    definition: "A main-owned application-setting mutation completed with its applied state and bounded result.",
    productQuestion: "How do people change startup, Lockdown, and menu-bar behavior, including requests the platform cannot apply?",
    sources: ["desktop-main"],
    authoritativeSource: "desktop-main",
    identityScopes: ["anonymous-epoch", "platform-user", "workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      setting: z.enum(["launch_at_login", "lockdown_mode", "menu_bar"]),
      previousEnabled: z.boolean(),
      requestedEnabled: z.boolean(),
      appliedEnabled: z.boolean(),
      result: z.enum(["success", "not_applied", "failed"]),
    })),
  }),
  digest_schedule_updated: productEvent({
    name: "digest_schedule_updated",
    definition: "The regional API durably replaced a member's digest schedule with bounded cadence dimensions.",
    productQuestion: "How do members configure recurring digests, and which schedule shapes are retained?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      enabled: z.boolean(),
      dayCount: countBucket,
      timeCount: countBucket,
      cadence: z.enum(["disabled", "daily", "multiple_daily", "weekly", "multiple_weekly"]),
      deliveryTargetTypes: z.array(digestDeliveryTargetType).max(3),
      result: resultClass,
    })),
  }),
  digest_delivery_terminal: productEvent({
    name: "digest_delivery_terminal",
    definition: "A scheduled digest delivery reached its authoritative terminal result.",
    productQuestion: "How reliably do configured digests deliver useful activity across target types?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      deliveryId: resourceId,
      result: resultClass,
      activityCount: countBucket,
      targetTypes: z.array(digestDeliveryTargetType).max(3),
      firstDelivery: z.boolean(),
    })),
    priority: "high",
  }),
  workspace_invitation_terminal: productEvent({
    name: "workspace_invitation_terminal",
    definition: "A workspace invitation was created, revoked, accepted, or declined through the regional authority.",
    productQuestion: "How often do invitations create collaboration, and where does the invitation journey stop?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["platform-user", "workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      invitationId: resourceId,
      action: z.enum(["created", "revoked", "accepted", "declined"]),
      role: z.enum(["admin", "member"]),
      deliveryResult: z.enum(["success", "failed", "not_applicable"]),
      timeToTerminal: journeyDurationBucket,
    })),
  }),
  terminal_policy_changed: productEvent({
    name: "terminal_policy_changed",
    definition: "The regional API durably changed the workspace Terminal network policy.",
    productQuestion: "Which Terminal policy modes are adopted and under what active-sandbox conditions?",
    sources: ["api"],
    authoritativeSource: "api",
    identityScopes: ["workspace-user"],
    properties: deferredZodSchema(() => z.strictObject({
      previousMode: z.enum(["restricted", "unrestricted", "custom"]),
      appliedMode: z.enum(["restricted", "unrestricted", "custom"]),
      customDomainCount: countBucket,
      activeSandboxCount: countBucket,
      result: resultClass,
    })),
  }),
  site_page_viewed: productEvent({
    name: "site_page_viewed",
    definition: "A classified public-site page became visible after regional telemetry bootstrap.",
    productQuestion: "Which public Avalon pages attract visits and from which bounded acquisition sources?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: deferredZodSchema(() => z.strictObject({
      page: z.enum(["landing", "download", "support", "legal", "auth_handoff", "invite_handoff", "workstream_handoff", "slack_handoff", "desktop_handoff", "not_found"]),
      pathname: z.string().min(1).max(160).regex(/^\/[a-z0-9_:/.-]*$/u),
      referringDomain: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/u).optional(),
      campaignSource: safeTelemetryTaxonomyValue.optional(),
      campaignMedium: safeTelemetryTaxonomyValue.optional(),
      campaignName: safeTelemetryTaxonomyValue.optional(),
      // Which ad platform's click identifier the landing URL carried, never
      // the identifier itself. It tells a paid click apart from a copied link
      // that still has the campaign tags, and joins visits to the platform's
      // click counts. `x` is X's `twclid`.
      adClickIdSource: z.enum(["x"]).optional(),
      // Set by the API on acceptance, replacing whatever the page sent.
      trafficClass: siteTrafficClass.optional(),
      trafficReasons: siteTrafficReasons.optional(),
    })),
  }),
  site_page_left: productEvent({
    name: "site_page_left",
    definition: "A classified public-site page was left after a bounded visible duration.",
    productQuestion: "How long do visitors engage with each public Avalon page before leaving?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: deferredZodSchema(() => z.strictObject({
      page: z.enum(["landing", "download", "support", "legal", "auth_handoff", "invite_handoff", "workstream_handoff", "slack_handoff", "desktop_handoff", "not_found"]),
      pathname: z.string().min(1).max(160).regex(/^\/[a-z0-9_:/.-]*$/u),
      duration: journeyDurationBucket,
      pageSignals: z.array(z.enum(SITE_PAGE_LEAVE_SIGNALS)).max(SITE_PAGE_LEAVE_SIGNALS.length).optional(),
      // Set by the API on acceptance, replacing whatever the page sent.
      trafficClass: siteTrafficClass.optional(),
      trafficReasons: siteTrafficReasons.optional(),
    })),
  }),
  site_action_selected: productEvent({
    name: "site_action_selected",
    definition: "A visitor selected one bounded semantic action on the public Avalon site.",
    productQuestion: "Which public-site calls to action and information affordances convert attention?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: deferredZodSchema(() => z.strictObject({
      page: z.enum(["landing", "download", "support"]),
      action: z.enum(["download", "primary_cta", "secondary_cta", "faq_opened", "connector_setup", "support_contact", "demo_request", "founder_contact"]),
      placement: z.enum(["header", "hero", "body", "footer", "faq", "connector", "unknown", "sidekicks", "team", "pricing", "offer"]),
      // Which page the click happened on, so variants of one page (such as
      // /start-fast/ beside /) can be compared. Optional: a tab opened before
      // the site deploy still sends clicks without it.
      pathname: z.string().min(1).max(160).regex(/^\/[a-z0-9_:/.-]*$/u).optional(),
      flowId: UuidV7Schema.optional(),
      // pro/max/ultra are the per-seat plans the page showed before the
      // 2026-09-30 pricing change; a tab left open across the deploy can still send them.
      plan: z.enum(["start", "grow", "enterprise", "pro", "max", "ultra"]).optional(),
    })),
  }),
  desktop_handoff_attempted: productEvent({
    name: "desktop_handoff_attempted",
    definition: "A classified browser-to-desktop handoff was presented or attempted without retaining its token or resource identifier.",
    productQuestion: "Which browser handoffs reach a valid automatic or manual desktop-open attempt?",
    sources: ["site"],
    authoritativeSource: "site",
    identityScopes: ["anonymous-epoch"],
    properties: deferredZodSchema(() => z.strictObject({
      handoffType: z.enum(["auth", "invite", "canvas", "sidekick", "workstream", "slack", "settings", "automation", "activity", "unknown"]),
      method: z.enum(["presented", "automatic", "manual", "browser"]),
      validity: z.enum(["valid", "invalid"]),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      process: z.enum(["main", "preload", "renderer"]),
      errorCode: z.enum(["type_error", "range_error", "unhandled_rejection", "react_boundary", "network_error", "unknown"]),
      breadcrumbStatus: z.enum(["available", "stale", "unavailable"]),
      fingerprint: z.string().regex(/^[a-f0-9]{32,64}$/u),
      generatedFrames: z.array(generatedJavascriptFrame).min(1).max(20),
    })),
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
    properties: deferredZodSchema(() => z.strictObject({
      process: z.enum(["main", "renderer", "utility", "gpu", "unknown"]),
      parserState: z.enum(["symbolicated", "unsymbolicated", "malformed"]),
      breadcrumbStatus: z.enum(["available", "stale", "unavailable"]),
      fingerprint: z.string().regex(/^[a-f0-9]{32,64}$/u),
    })),
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

export const UuidV7Schema = z.string().uuid().refine((value) => value[14] === "7", "must be UUIDv7");
const SafeReleaseSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u);

export const TelemetryBreadcrumbSchema = deferredZodSchema(() => z.discriminatedUnion("kind", [
  z.strictObject({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: z.literal("screen_changed"),
    screen,
  }),
  z.strictObject({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: z.literal("lifecycle"),
    phase: lifecycleState,
  }),
  z.strictObject({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    kind: z.literal("operation"),
    operation: z.enum([
      "workspace_create", "workspace_activate", "workstream_create", "run_start", "connector_setup", "update",
    ]),
    state: z.enum(["requested", "succeeded", "failed"]),
  }),
]));
export type TelemetryBreadcrumb = z.infer<typeof TelemetryBreadcrumbSchema>;

export const TelemetryBreadcrumbSidecarSchema = deferredZodSchema(() => z.strictObject({
  version: z.literal(1),
  launchId: UuidV7Schema,
  updatedAt: z.string().datetime({ offset: true }),
  entries: z.array(TelemetryBreadcrumbSchema).max(32),
}).superRefine((sidecar, context) => {
  for (let index = 1; index < sidecar.entries.length; index += 1) {
    if (sidecar.entries[index]!.sequence <= sidecar.entries[index - 1]!.sequence) {
      context.addIssue({ code: "custom", message: "breadcrumb_sequence_invalid", path: ["entries", index, "sequence"] });
    }
  }
}));
export type TelemetryBreadcrumbSidecar = z.infer<typeof TelemetryBreadcrumbSidecarSchema>;
const telemetryContextCommon = memoizedValue(() => ({
  environment: z.enum(["development", "staging", "production"]),
  region: RegionSchema.optional(),
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
}));

const telemetryNativeDesktopContext = memoizedValue(() => ({
  deviceId: UuidV7Schema.optional(),
  osVersion: z.string().trim().min(1).max(128).regex(/^\P{Cc}+$/u).optional(),
  locale: z.string().min(2).max(35).regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u).optional(),
  timezone: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_+-]+(?:\/[a-zA-Z0-9_+-]+)*$/u).optional(),
  screenWidth: z.number().int().positive().max(100_000).optional(),
  screenHeight: z.number().int().positive().max(100_000).optional(),
  viewportWidth: z.number().int().positive().max(100_000).optional(),
  viewportHeight: z.number().int().positive().max(100_000).optional(),
  windowId: UuidV7Schema.optional(),
}));

const TelemetryContextV1Schema = deferredZodSchema(() => z.strictObject({
  ...telemetryContextCommon(),
  deviceId: z.never().optional(),
  osVersion: z.never().optional(),
  locale: z.never().optional(),
  timezone: z.never().optional(),
  screenWidth: z.never().optional(),
  screenHeight: z.never().optional(),
  viewportWidth: z.never().optional(),
  viewportHeight: z.never().optional(),
  windowId: z.never().optional(),
}));

const TelemetryContextV2Schema = deferredZodSchema(() => z.strictObject({
  ...telemetryContextCommon(),
  ...telemetryNativeDesktopContext(),
}));

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

const envelopeCommon = memoizedValue(() => ({
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
}));

const EnvelopeBaseSchema = deferredZodSchema(() => z.union([
  z.strictObject({ ...envelopeCommon(), context: TelemetryContextV1Schema }),
  z.strictObject({
    ...envelopeCommon(),
    contextSchemaVersion: z.literal(2),
    context: TelemetryContextV2Schema,
  }),
]));

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
    // One issue per nested failure, so a diagnostic names the property rather
    // than stopping at `properties`.
    for (const issue of properties.error.issues) {
      context.addIssue({ ...issue, path: ["properties", ...issue.path] });
    }
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

export const TelemetryBatchSchema = deferredZodSchema(() => z.strictObject({
  installationId: UuidV7Schema.optional(),
  events: z.array(TelemetryEnvelopeSchema).min(1).max(50),
}).superRefine(validateBatchDeviceBinding));
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

export const TELEMETRY_BATCH_MAX_BYTES = 256 * 1024;

export const TelemetryBootstrapRequestSchema = deferredZodSchema(() => z.strictObject({
  anonymousEpochId: UuidV7Schema,
  routeToken: z.string().min(32).max(2_048).optional(),
  // The page's IANA time zone, compared with the address's and then dropped.
  timeZone: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/u).optional(),
  pageSignals: z.array(z.enum(SITE_PAGE_START_SIGNALS)).max(SITE_PAGE_START_SIGNALS.length).optional(),
}));
export type TelemetryBootstrapRequest = z.infer<typeof TelemetryBootstrapRequestSchema>;

export const TelemetryRouteResponseSchema = deferredZodSchema(() => z.strictObject({
  route: RegionSchema,
  routingBasis: z.enum(["ip_geolocation", "geolocation_fallback"]),
  routeToken: z.string().min(32).max(2_048),
}));
export type TelemetryRouteResponse = z.infer<typeof TelemetryRouteResponseSchema>;

export const TelemetryBootstrapResponseSchema = deferredZodSchema(() => z.strictObject({
  journeyId: UuidV7Schema,
  route: RegionSchema,
  routingBasis: z.enum(["ip_geolocation", "geolocation_fallback"]),
  capability: z.string().min(32).max(2_048),
  expiresAt: z.string().datetime({ offset: true }),
}));
export type TelemetryBootstrapResponse = z.infer<typeof TelemetryBootstrapResponseSchema>;

export const AnonymousTelemetryBatchSchema = deferredZodSchema(() => z.strictObject({
  capability: z.string().min(32).max(2_048),
  installationId: UuidV7Schema.optional(),
  events: z.array(TelemetryEnvelopeSchema).min(1).max(50),
}).superRefine(validateBatchDeviceBinding));
export type AnonymousTelemetryBatch = z.infer<typeof AnonymousTelemetryBatchSchema>;

export const LinkAnonymousTelemetrySchema = deferredZodSchema(() => z.strictObject({
  capability: z.string().min(32).max(2_048),
}));
export type LinkAnonymousTelemetry = z.infer<typeof LinkAnonymousTelemetrySchema>;

export const TelemetryAcceptanceResultSchema = deferredZodSchema(() => z.strictObject({
  result: z.enum(["accepted", "duplicate", "conflict", "suppressed", "route_mismatch"]),
  eventId: UuidV7Schema,
}));
export type TelemetryAcceptanceResult = z.infer<typeof TelemetryAcceptanceResultSchema>;

export const TelemetryAcceptanceBatchResponseSchema = deferredZodSchema(() => z.strictObject({
  results: z.array(TelemetryAcceptanceResultSchema).max(50),
}));
export type TelemetryAcceptanceBatchResponse = z.infer<typeof TelemetryAcceptanceBatchResponseSchema>;

export const LinkAnonymousTelemetryResponseSchema = deferredZodSchema(() => z.strictObject({
  result: z.enum(["linked", "duplicate", "suppressed"]),
}));
export type LinkAnonymousTelemetryResponse = z.infer<typeof LinkAnonymousTelemetryResponseSchema>;

export const CrashIngestResponseSchema = deferredZodSchema(() => z.strictObject({
  result: z.enum(["accepted", "duplicate", "suppressed"]),
  uploadId: UuidV7Schema,
  crashId: UuidV7Schema.optional(),
}));
export type CrashIngestResponse = z.infer<typeof CrashIngestResponseSchema>;

export const ProductAnalyticsPreferenceSchema = deferredZodSchema(() => z.strictObject({
  enabled: z.boolean(),
  version: z.number().int().positive(),
}));
export type ProductAnalyticsPreference = z.infer<typeof ProductAnalyticsPreferenceSchema>;

export const UpdateProductAnalyticsPreferenceSchema = deferredZodSchema(() => z.strictObject({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}));

/** Shipped clients may replay these events after the built-in feature is retired. */
export function isRetiredMeetingTelemetry(event: { name: string; properties: unknown }): boolean {
  if (['note_opened', 'note_created', 'note_action_completed', 'note_opened_v2', 'transcription_state_changed', 'recording_start_completed', 'recording_terminal', 'note_summary_generation_completed'].includes(event.name)) return true;
  if (!event.properties || typeof event.properties !== 'object') return false;
  const properties = event.properties as Record<string, unknown>;
  return properties['resourceType'] === 'note'
    || properties['destinationType'] === 'recent_note';
}

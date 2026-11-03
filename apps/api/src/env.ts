import { configuredRegions } from "@rally/contracts/regions";
import { RegionSchema } from "@rally/contracts/regions";
import { isConfiguredRegion } from "@rally/contracts/regions";
import type { GlobalAshbyRouterRpcBinding } from "./services/ashby-routing-service";
import {
  AzureInferenceEndpointSchema,
  DesktopDeepLinkUrlSchema,
  HttpUrlSchema,
} from "@rally/contracts/url-schemas";
import type { Pipeline } from "cloudflare:pipelines";
import { z } from "zod";
import type { Region, UserId, WorkspaceId } from "@rally/contracts";
import type { WorkspaceRelationship } from "@rally/contracts/scope-grants";
import type { RegionalIdentityBridgeRpcBinding } from "./services/platform-onboarding-service";
import type { GitHubRegionalBridgeRpcBinding, GlobalGitHubRouterRpcBinding } from "./services/github-routing-service";
import type { GlobalWorkstreamEmailRouterRpcBinding } from "./services/workstream-email-routing-service";
import type { InboundEmailRegionalRpcBinding } from "./services/resend-inbound-email-service";
import type {
  GlobalLinearRouterRpcBinding,
  LinearRegionalBridgeRpcBinding,
} from "./services/linear-routing-service";
import type {
  GlobalNotionRouterRpcBinding,
  NotionRegionalBridgeRpcBinding,
} from "./services/notion-routing-service";
import type {
  GlobalSlackRouterRpcBinding,
  SlackRegionalBridgeRpcBinding,
} from "./services/slack-routing-service";
import type { RegionalTelemetryBridgeRpcBinding } from "./telemetry/regional-bridge";
import type { GlobalTelemetryControlRpcBinding } from "./telemetry/control";
import type { CrashSymbolicatorContainer } from "./crash-symbolicator-container";
import type { ArtifactHostDO } from "./durable-objects/artifact-host-do";
import type { SubstreamAgent } from "./durable-objects/substream-agent";
import type { WorkspaceDO } from "./durable-objects/workspace-do";
import type { DurableObjectMigrationReport } from "@rally/contracts/durable-object-migrations";
import type { TelemetryOperatorPrincipal } from './telemetry/operator-auth';
import type { DocumentProcessingRpcBinding } from './services/document-processing-contract';
import type { TerminalProviderRpcBinding } from './services/terminal/provider-rpc-contract';
import type { TelemetryDeliveryRpcBinding } from './telemetry/telemetry-delivery-contract';

export interface Env {
  DB: D1Database;
  TELEMETRY_DB: D1Database;
  AUDIT_DB: D1Database;
  /** The usage ledger, kept apart from `DB` so it can only fill itself. See docs/usage-metering.md. */
  USAGE_DB: D1Database;
  MESSAGE_ISSUES_DB: D1Database;
  /** Shared, content-free routing authority available to both product regions. */
  PLATFORM_DB: D1Database;
  PAYLOADS: R2Bucket;
  /** Global-only installer stream for private download grants. */
  DESKTOP_RELEASES?: R2Bucket;
  TELEMETRY_PAYLOADS: R2Bucket;
  /** One globally replicated cache shared by the configured Workers. */
  INFERENCE_PRICING_CACHE: KVNamespace;
  /** Public-site marks shared platform-wide; values expire and are replaced. */
  FAVICON_CACHE: KVNamespace;
  /** Global authorization acceleration only; regional evidence remains jurisdiction-bound. */
  AUTHORIZATION_CACHE?: KVNamespace;
  IMAGES: ImagesBinding;
  AI: Ai;
  BROWSER?: BrowserRun;
  TURBO_PUFFER_DEV_API_KEY?: string;
  TURBO_PUFFER_PROD_API_KEY?: string;
  RUN_ANALYTICS: AnalyticsEngineDataset;
  TERMINAL_ANALYTICS: AnalyticsEngineDataset;
  DOCUMENT_PROCESSOR: DocumentProcessingRpcBinding;
  TERMINAL_PROVIDER: TerminalProviderRpcBinding;
  /** Private destination adapter for the configured deployment. */
  TELEMETRY_DELIVERY?: TelemetryDeliveryRpcBinding;
  // Optional because a Worker may run without the binding. Note that
  // `wrangler dev --local` still provides the object — it is every *call* that
  // throws `Binding FLAGS needs to be run remotely`, so readers must handle
  // both. Either way they fall back to the model variables below.
  FLAGS?: Flagship;
  SUBSTREAM_AGENTS: DurableObjectNamespace<SubstreamAgent>;
  WORKSPACE_DOS: DurableObjectNamespace<WorkspaceDO>;
  CRASH_SYMBOLICATOR: DurableObjectNamespace<CrashSymbolicatorContainer>;
  /** One supervisor per live web artifact, named by the artifact's own id. */
  ARTIFACT_HOSTS: DurableObjectNamespace<ArtifactHostDO>;
  /**
   * Cloudflare's Worker Loader, which materializes model-authored code.
   *
   * Optional because it is account-level configuration this repository does not
   * create: without it a static artifact still serves and an active one degrades
   * to its assets, which is a visible partial failure rather than a dead origin.
   */
  ARTIFACT_LOADER?: WorkerLoader;
  /**
   * Cloudflare's Worker Loader again, for `code_execute` programs: a program
   * runs in a fresh isolate with no network and one capability stub. Optional
   * for the same reason as `ARTIFACT_LOADER`; absent, the code plugin is not
   * registered and runs behave as before.
   */
  CODE_LOADER?: WorkerLoader;
  ACTIVITY_QUEUE: Queue;
  /**
   * Inbound work a person is waiting on Rally to answer, kept apart from the
   * activity backlog. Send with `sendInteractive`. See docs/interactive-queue.md.
   */
  INTERACTIVE_QUEUE: Queue;
  /** Regional durable hand-off from inference capture to Pipeline ingestion. */
  INFERENCE_LAKEHOUSE_QUEUE?: Queue;
  /** Global durable hand-off from accepted typed telemetry to its lakehouse. */
  ANALYTICS_LAKEHOUSE_QUEUE?: Queue;
  /** The one path from a D1 access retraction to an open socket. */
  ACCESS_REVOCATION_QUEUE: Queue;
  PUSH_DELIVERY_QUEUE?: Queue;
  /** Usage quota metering events, sent in the background. See docs/usage-metering.md. */
  USAGE_QUEUE?: Queue;
  /** Every usage event, kept for good in the usage lakehouse in R2. */
  USAGE_LAKEHOUSE?: Pipeline;
  APNS_AUTH_KEY?: string;
  APNS_KEY_ID?: string;
  /** Web Push VAPID public key, the base64url 65-byte uncompressed P-256 point. */
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  /** Web Push VAPID private key, the base64url `d` of the same P-256 key. Secret. */
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  /** The `sub` claim push services contact about this sender, e.g. `mailto:ops@…`. */
  WEB_PUSH_SUBJECT?: string;
  CONNECTOR_POLL_WORKFLOW: Workflow;
  CONNECTOR_EVENT_WORKFLOW: Workflow;
  WORK_OPPORTUNITY_WORKFLOW: Workflow;
  /** Global-only: the demo preparation driver. Absent, the demo write routes
   * answer 503 (`demo_preparation_unavailable`) and nothing else changes — it
   * is not in the boot contract on purpose, because a demo tool's binding must
   * never take a region offline. regional binds nothing; its demo routes refuse. */
  DEMO_PREPARATION_WORKFLOW?: Workflow;
  [binding: `REGION_${string}_IDENTITY_BRIDGE`]: RegionalIdentityBridgeRpcBinding | undefined;
  [binding: `REGION_${string}_GITHUB_BRIDGE`]: GitHubRegionalBridgeRpcBinding | undefined;
  [binding: `REGION_${string}_INBOUND_EMAIL_BRIDGE`]: InboundEmailRegionalRpcBinding | undefined;
  [binding: `REGION_${string}_LINEAR_BRIDGE`]: LinearRegionalBridgeRpcBinding | undefined;
  GLOBAL_ASHBY_ROUTER?: GlobalAshbyRouterRpcBinding;
  [binding: `REGION_${string}_NOTION_BRIDGE`]: NotionRegionalBridgeRpcBinding | undefined;
  [binding: `REGION_${string}_SLACK_BRIDGE`]: SlackRegionalBridgeRpcBinding | undefined;
  [binding: `REGION_${string}_TELEMETRY_BRIDGE`]: RegionalTelemetryBridgeRpcBinding | undefined;
  GLOBAL_EMAIL_ROUTER?: GlobalWorkstreamEmailRouterRpcBinding;
  GLOBAL_GITHUB_ROUTER?: GlobalGitHubRouterRpcBinding;
  GLOBAL_LINEAR_ROUTER?: GlobalLinearRouterRpcBinding;
  GLOBAL_NOTION_ROUTER?: GlobalNotionRouterRpcBinding;
  GLOBAL_SLACK_ROUTER?: GlobalSlackRouterRpcBinding;
  GLOBAL_TELEMETRY_CONTROL?: GlobalTelemetryControlRpcBinding;
  /**
   * The regional queue that carries Durable Object migration reports to the
   * account-wide tracker. Optional deliberately: local development and every
   * partial test `Env` run without it, and an object's schema must never depend
   * on the observer that watches it. See
   * `docs/durable-object-migration-tracking.md`.
   */
  MIGRATION_REPORT_QUEUE?: Queue<DurableObjectMigrationReport>;
  /** Materialized into production Wrangler configs after the stream is ensured. */
  INFERENCE_LAKEHOUSE?: Pipeline;
  /** Materialized into Global production after the analytics stream is ensured. */
  ANALYTICS_LAKEHOUSE?: Pipeline;

  APP_ENV: "development" | "test" | "staging" | "production";
  APP_VERSION?: string;
  BUILD_SHA?: string;
  AVALON_REGION: Region;
  RALLY_DEV_AUTH?: string;
  PUBLIC_API_BASE_URL: string;

  PUBLIC_WEB_BASE_URL: string;
  /**
   * The registrable domain live artifacts are served from.
   *
   * Not `rallywith.ai` and deliberately not a subdomain of it. Model-authored
   * pages get their own registrable domain in the `*usercontent.com` idiom the
   * industry uses for exactly this, so an artifact is never same-origin with
   * the application or the API, and never cookie-adjacent to the product apex.
   *
   * It is a variable rather than a constant because the local and test
   * environments serve artifacts from somewhere else, and a hard-coded host
   * would make every artifact URL in a sandbox point at production.
   */
  ARTIFACT_SERVING_DOMAIN: string;
  ALLOWED_ORIGINS: string;
  DESKTOP_DEEP_LINK_URI: string;
  GITHUB_INGRESS_BASE_URL?: string;
  LINEAR_INGRESS_BASE_URL?: string;
  ASHBY_INGRESS_BASE_URL?: string;
  NOTION_INGRESS_BASE_URL?: string;
  SLACK_INGRESS_BASE_URL?: string;
  POSTHOG_HOST?: string;
  TERMINAL_REGION_CAPABILITY?: "supported" | "unsupported";
  TERMINAL_EMERGENCY_DISABLED?: "true" | "false";
  DAYTONA_API_KEY?: string;
  DAYTONA_ORGANIZATION_ID?: string;
  DAYTONA_WEBHOOK_SECRET?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_TARGET?: string;
  DAYTONA_TERMINAL_SNAPSHOT?: string;

  OPENROUTER_API_KEY: string;
  TYPESAFE_API_KEY?: string;
  OPENROUTER_PRIMARY_MODEL: string;
  OPENROUTER_FALLBACK_MODELS: string;
  OPENROUTER_CLASSIFIER_MODEL: string;
  OPENROUTER_STRUCTURED_MODEL: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_REALTIME_DEPLOYMENT?: string;
  /** Optional Global inference resource; kept separate from regional dictation. */
  AZURE_INFERENCE_ENDPOINT?: string;
  AZURE_INFERENCE_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  /** Acquisition-only controls; missing production bindings fail closed. */
  ACCESS_EDGE_RATE_LIMITER?: RateLimit;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /** Explicit email sign-in policy; unset keeps the new entrypoint unavailable. */
  EMAIL_LOGIN_POLICY_JSON?: string;
  BROWSER_APP_ORIGIN?: string;
  RESEND_NOTIFICATION_FROM_EMAIL?: string;
  RESEND_RECEIVING_API_KEY?: string;
  RESEND_WEBHOOK_SIGNING_SECRET?: string;
  RESEND_WEBHOOK_SECRET?: string;
  WORKSTREAM_EMAIL_ADDRESS_KEY?: string;
  WORKSTREAM_EMAIL_DOMAIN?: string;

  /** Global only. `productionOnlySecrets` enforces them there; regional never carries them. */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_CONNECTOR_OAUTH_CLIENT_ID?: string;
  GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  LINEAR_OAUTH_CLIENT_ID?: string;
  LINEAR_OAUTH_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  LINEAR_NATIVE_AGENT_ENABLED?: string;
  NOTION_OAUTH_CLIENT_ID?: string;
  NOTION_OAUTH_CLIENT_SECRET?: string;
  NOTION_INTEGRATION_ID?: string;
  SLACK_APP_ID?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  TWITTER_API_IO_API_KEY?: string;
  /**
   * The Fireflies connector's rollout gate, region by region.
   *
   * Both of its credentials are the customer's — an admin-pasted API key and a
   * member's own OAuth grant — so there is no Rally-side secret whose absence
   * could stand in for "not launched here" the way `TWITTER_API_IO_API_KEY`
   * does for X. Deliberately absent from `assertEnvContract`: unset is the off
   * state, not a misconfiguration, and a region that has never heard of
   * Fireflies must still start.
   */
  FIREFLIES_CONNECTOR_ENABLED?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  /** Global-only signer for onboarding telemetry capabilities. regional validates
   * them through the narrow Global telemetry-control RPC. */
  TELEMETRY_CAPABILITY_SIGNING_KEY?: string;
  /** Per-region operator credentials for the restricted telemetry operations
   * surface. Stored as a JSON map from opaque bearer token to fixed principal. */
  TELEMETRY_OPERATORS_JSON?: string;
  /** Per-region operator credentials for the surfaces Ace calls — workspace
   * retirement, and demo preparation — in the `demos` role. The same map
   * shape as `TELEMETRY_OPERATORS_JSON`, kept as its own secret so the two
   * are set and rotated independently (`telemetry/operator-auth.ts`). */
  DEMO_OPERATORS_JSON?: string;
  /** Optional in every region, as a pair: the bot token of the internal Slack
   * app operator notifications are posted with, and the channel they go to.
   * Either absent, `notifyOps` answers `skipped` and the log row beside each
   * notice is the only record. */
  OPS_SLACK_BOT_TOKEN?: string;
  OPS_SLACK_CHANNEL_ID?: string;
  SESSION_SIGNING_KEY: string;
  OAUTH_STATE_ENCRYPTION_KEY: string;
  CONNECTOR_CREDENTIALS_KEY: string;
  CONNECTOR_CREDENTIALS_KEY_VERSION: string;
  CONNECTOR_CREDENTIALS_KEYS_JSON?: string;

  HARNESS_MAX_PLUGIN_CATALOG_TOKENS?: string;
  HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS?: string;
  HARNESS_TTFT_TIMEOUT_MS?: string;
  HARNESS_STREAM_IDLE_TIMEOUT_MS?: string;
  HARNESS_TRANSPORT_RETRIES?: string;
  HARNESS_CHILD_MAX_MODEL_ITERATIONS?: string;
  HARNESS_CHILD_MAX_TOOL_CALLS?: string;
  HARNESS_CHILD_MAX_WALL_CLOCK_MS?: string;
  HARNESS_CHILD_MAX_COST_CENTS?: string;
  HARNESS_CHILD_MAX_CHAIN_RUNS?: string;
  HARNESS_CHILD_MAX_DEPTH?: string;
  TOOL_DEFAULT_TIMEOUT_MS: string;
  CONNECTOR_POLL_TIMEOUT_MS?: string;
  WEB_SEARCH_MAX_RESULTS: string;
  WEB_FETCH_MAX_BYTES: string;
  MAX_ATTACHMENT_BYTES: string;
  WEBHOOK_REPLAY_WINDOW_SECONDS: string;
  PROVIDER_WEBHOOK_MAX_BYTES?: string;
  INBOUND_EMAIL_MAX_BYTES?: string;
  INBOUND_EMAIL_PROCESSING_LEASE_SECONDS?: string;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
}

export interface IdentityAuthContext {
  /** Current relationship, read from D1; never trusted from token claims. */
  accessClass?: "member" | "guest";
  sessionId: string;
  userId: UserId;
  workspaceId: WorkspaceId | null;
  region: Region;
  role: "owner" | "admin" | "member" | null;
  /**
   * How this authority was established. Absent means a login session:
   * `sessionId` names a `sessions` row and the product objects re-verify it
   * there. `"connector"` means a connector ingress resolved a linked member —
   * an active `slack_user_links` row joined to an active membership, checked
   * by the Worker on the very message being delivered — and `sessionId` is a
   * correlation value only, not a row anywhere. The objects verify a connector
   * principal against current workspace membership instead of `sessions`;
   * see `SubstreamAgent.connectorPrincipalAuth`.
   *
   * `"demo_seed"` is the same kind of authority for the demo seeder: it acts
   * as a cast member who never signs in, on a workspace the seeder is
   * preparing, and the objects verify that member's current membership the
   * same way (`docs/demo-workspaces.md`).
   *
   * The Space cutover's driver is the third construction of `"connector"`, and
   * for the same reason: it runs with nobody signed in, so its `sessionId` is a
   * correlation value and the objects verify the member it acts as against
   * current membership (`docs/spaces.md`).
   *
   * A Channel access request's approver has no login session either: their
   * one-click email approval, and the check that they can still open what
   * they are asked about, act as them after the Worker re-reads their active
   * membership (`conversation-access-request-service.ts`).
   *
   * A consumed resource-authorization callback also has no login session. The
   * Worker verifies its sealed provider state, connection, and membership,
   * then the room re-checks membership under `"resource_authorization"`.
   *
   * `"engineering"` is the Access-authenticated operator product path. It
   * names an existing active member or guest without minting a session, and
   * product objects re-check that person's current regional relationship.
   *
   * Only server code constructs these values. The auth middleware builds its
   * context from verified token claims and never sets it, so a client cannot
   * claim a non-session path from outside.
   */
  principal?: "connector" | "demo_seed" | "impersonation" | "resource_authorization" | "engineering";
  /**
   * Set on a support session: the Rally staff member actually acting as
   * `userId`, read from `sessions.impersonator_user_id` with the same query that
   * authenticated the request. Authority stays `userId`'s; this names who to
   * hold accountable and is what a route consults to refuse an action a support
   * session may not take (`docs/impersonation.md`).
   */
  impersonatorUserId?: UserId;
  /**
   * The analytics surrogates this person and workspace are known by in PostHog
   * — `users.analytics_person_id` and `workspaces.analytics_workspace_id`.
   * They ride the session query that authenticates the request rather than
   * being looked up, so they cost nothing, and they are optional because they
   * are minted lazily: null means no PostHog identity exists yet, and there is
   * therefore nothing for a trace to match against.
   *
   * They are correlation values only. Nothing authorizes on them; the
   * authority for who this is remains `userId` and `workspaceId`.
   */
  analyticsPersonId?: string | null;
  analyticsWorkspaceId?: string | null;
}

/** Workspace-bound identity; a null role is a guest, never member authority.
 * Product access is decided by the addressed scope, not by this type. */
export interface AuthContext extends IdentityAuthContext {
  workspaceId: WorkspaceId;
  role: "owner" | "admin" | "member" | null;
}

/** Active membership observed by this HTTP request's authentication boundary. */
export interface RequestMembershipObservation {
  workspaceId: WorkspaceId;
  userId: UserId;
  accessClass: "member" | "guest";
  validatedAt: number;
  /** Canonical incarnation and revision from the same session query. */
  relationship?: WorkspaceRelationship;
}

export interface AppVariables {
  requestId: string;
  /** Worker-entry wall clock, captured before auth, parsing, or validation. */
  requestReceivedAt: number;
  auth: IdentityAuthContext | undefined;
  /** Set only by request middleware after current workspace membership is proven. */
  requestMembership: RequestMembershipObservation | undefined;
  operator: TelemetryOperatorPrincipal | undefined;
  /**
   * How long authentication took, in milliseconds.
   *
   * Authentication runs as middleware, before any route opens its flow span, so
   * its cost sits inside `http_request` and outside `perf_flow`. Without this a
   * reader comparing the two finds an unexplained gap. It is one uncached,
   * blocking D1 round trip on every authenticated request — see
   * `docs/performance-tracing.md`.
   */
  authDurationMs: number | undefined;
  /**
   * The connection a `/connections` write created, set by its route so the
   * write's invalidation reaches that connection's audience
   * (`noteChangedConnection`).
   */
  workspaceSyncConnectionId: string | undefined;
}

export type HonoAppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

/**
 * The runtime contract for `Env`.
 *
 * `Env` above is erased at build time, so nothing checks that a deployed Worker
 * actually received what it declares. A missing variable surfaces as a
 * `TypeError` deep in whichever request first reads it, and a malformed numeric
 * one never surfaces at all: `numericEnv` silently substitutes its fallback, so
 * a ceiling typed as `"3O000"` reads as the default forever.
 *
 * This schema asserts, at the entrypoints, exactly what the interface already
 * claims — no more. Two deliberate exceptions are gated on `APP_ENV` rather than
 * required outright, because local development runs without them today; see
 * `productionOnlySecrets`.
 */
const binding = <T>() => z.custom<T>((value) => value != null && typeof value === "object");

/**
 * A variable Wrangler carries as a string but the code reads as a number.
 *
 * Readability is the whole check: `numericEnv` already treats a non-positive
 * value as "use the default", so `"0"` is a configuration an operator may
 * legitimately set — usually to disable a ceiling during an incident. Rejecting
 * it here would make a `RUNBOOK` mitigation take the region down. `"3O000"` is
 * the case that has no reading at all, and the regex still catches it.
 */
const numericString = z.string().regex(/^\d+$/u, "must be a base-10 integer");

const EnvContractSchema = z.object({
  DB: binding<D1Database>(),
  TELEMETRY_DB: binding<D1Database>(),
  AUDIT_DB: binding<D1Database>(),
  USAGE_DB: binding<D1Database>(),
  MESSAGE_ISSUES_DB: binding<D1Database>(),
  PLATFORM_DB: binding<D1Database>(),
  PAYLOADS: binding<R2Bucket>(),
  TELEMETRY_PAYLOADS: binding<R2Bucket>(),
  INFERENCE_PRICING_CACHE: binding<KVNamespace>(),
  FAVICON_CACHE: binding<KVNamespace>(),
  AUTHORIZATION_CACHE: binding<KVNamespace>().optional(),
  IMAGES: binding<ImagesBinding>(),
  AI: binding<Ai>(),
  RUN_ANALYTICS: binding<AnalyticsEngineDataset>(),
  TERMINAL_ANALYTICS: binding<AnalyticsEngineDataset>(),
  DOCUMENT_PROCESSOR: binding<DocumentProcessingRpcBinding>().optional(),
  TERMINAL_PROVIDER: binding<TerminalProviderRpcBinding>().optional(),
  TELEMETRY_DELIVERY: binding<TelemetryDeliveryRpcBinding>().optional(),
  SUBSTREAM_AGENTS: binding<DurableObjectNamespace<SubstreamAgent>>(),
  WORKSPACE_DOS: binding<DurableObjectNamespace<WorkspaceDO>>(),
  CRASH_SYMBOLICATOR: binding<DurableObjectNamespace<CrashSymbolicatorContainer>>(),
  ARTIFACT_HOSTS: binding<DurableObjectNamespace<ArtifactHostDO>>(),
  ARTIFACT_LOADER: binding<WorkerLoader>().optional(),
  CODE_LOADER: binding<WorkerLoader>().optional(),
  ACTIVITY_QUEUE: binding<Queue>(),
  INTERACTIVE_QUEUE: binding<Queue>(),
  INFERENCE_LAKEHOUSE_QUEUE: binding<Queue>().optional(),
  ANALYTICS_LAKEHOUSE_QUEUE: binding<Queue>().optional(),
  ACCESS_REVOCATION_QUEUE: binding<Queue>(),
  USAGE_QUEUE: binding<Queue>().optional(),
  USAGE_LAKEHOUSE: binding<Pipeline>().optional(),
  INFERENCE_LAKEHOUSE: binding<Pipeline>().optional(),
  ANALYTICS_LAKEHOUSE: binding<Pipeline>().optional(),
  CONNECTOR_POLL_WORKFLOW: binding<Workflow>(),
  CONNECTOR_EVENT_WORKFLOW: binding<Workflow>(),
  WORK_OPPORTUNITY_WORKFLOW: binding<Workflow>(),
  DEMO_PREPARATION_WORKFLOW: binding<Workflow>().optional(),

  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  AVALON_REGION: RegionSchema.refine(isConfiguredRegion),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  PUBLIC_API_BASE_URL: HttpUrlSchema,
  PUBLIC_WEB_BASE_URL: HttpUrlSchema,
  // A bare registrable domain, not a URL: it is a suffix that per-artifact
  // labels are prefixed onto, and a scheme here would produce hosts nothing
  // can resolve.
  ARTIFACT_SERVING_DOMAIN: z.string().min(1).regex(/^[a-z0-9.-]+$/u),
  ALLOWED_ORIGINS: z.string().min(1),
  DESKTOP_DEEP_LINK_URI: DesktopDeepLinkUrlSchema,
  TERMINAL_REGION_CAPABILITY: z.enum(["supported", "unsupported"]).optional(),
  TERMINAL_EMERGENCY_DISABLED: z.enum(["true", "false"]).optional(),
  DAYTONA_API_URL: z.string().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_TERMINAL_SNAPSHOT: z.string().optional(),

  // `OPENROUTER_API_KEY` is deliberately not here; see `productionOnlySecrets`.
  OPENROUTER_PRIMARY_MODEL: z.string().min(1),
  OPENROUTER_FALLBACK_MODELS: z.string(),
  OPENROUTER_CLASSIFIER_MODEL: z.string().min(1),
  OPENROUTER_STRUCTURED_MODEL: z.string().min(1),
  AZURE_INFERENCE_ENDPOINT: AzureInferenceEndpointSchema.optional(),
  // Deliberately optional: Azure model routing degrades to OpenRouter when absent.
  AZURE_INFERENCE_API_KEY: z.string().min(1).optional(),

  SESSION_SIGNING_KEY: z.string().min(1),
  OAUTH_STATE_ENCRYPTION_KEY: z.string().min(1),
  CONNECTOR_CREDENTIALS_KEY: z.string().min(1),
  CONNECTOR_CREDENTIALS_KEY_VERSION: numericString,

  // Required by the interface, so required here.
  TOOL_DEFAULT_TIMEOUT_MS: numericString,
  WEB_SEARCH_MAX_RESULTS: numericString,
  WEB_FETCH_MAX_BYTES: numericString,
  MAX_ATTACHMENT_BYTES: numericString,
  WEBHOOK_REPLAY_WINDOW_SECONDS: numericString,

  // Optional, but a value that is present must be readable. This is the half
  // `numericEnv` cannot express: absent legitimately means "use the default",
  // while unparseable means someone typed it wrong and nobody found out.
  HARNESS_MAX_PLUGIN_CATALOG_TOKENS: numericString.optional(),
  HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS: numericString.optional(),
  HARNESS_TTFT_TIMEOUT_MS: numericString.optional(),
  HARNESS_STREAM_IDLE_TIMEOUT_MS: numericString.optional(),
  HARNESS_TRANSPORT_RETRIES: numericString.optional(),
  HARNESS_CHILD_MAX_MODEL_ITERATIONS: numericString.optional(),
  HARNESS_CHILD_MAX_TOOL_CALLS: numericString.optional(),
  HARNESS_CHILD_MAX_WALL_CLOCK_MS: numericString.optional(),
  HARNESS_CHILD_MAX_COST_CENTS: numericString.optional(),
  HARNESS_CHILD_MAX_CHAIN_RUNS: numericString.optional(),
  HARNESS_CHILD_MAX_DEPTH: numericString.optional(),
  CONNECTOR_POLL_TIMEOUT_MS: numericString.optional(),
  PROVIDER_WEBHOOK_MAX_BYTES: numericString.optional(),
  INBOUND_EMAIL_MAX_BYTES: numericString.optional(),
  INBOUND_EMAIL_PROCESSING_LEASE_SECONDS: numericString.optional(),


  GITHUB_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  LINEAR_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  ASHBY_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  NOTION_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  SLACK_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  POSTHOG_HOST: HttpUrlSchema.optional(),
});

/**
 * Secrets routinely absent from `.dev.vars`, so local development has always run
 * without them. Requiring them outright would break `pnpm dev:api:local` rather
 * than catch a real misconfiguration, so they are enforced only where their
 * absence is genuinely a deployment fault — which is a question of region as
 * well as of environment.
 *
 * **Google identity OAuth is a Global-only surface.** Every user signs in through
 * the Global endpoint (`regionalization.md`), `AuthService.beginIdentity` refuses
 * a non-Global region before it reads either key, and `sync-dev-env.mjs` lists
 * both under `globalOnlyKeys`. Requiring them in every region made the deployed
 * regional Worker fail its own contract on every request, every queue batch, and every
 * cron tick — while `/health`, exempt so that it can report the fault, went on
 * answering `ok`. A contract that demands what the architecture forbids does not
 * catch a misconfiguration; it manufactures one, silently.
 *
 * The TypeSafe and OpenRouter keys are required in both regions. They belong here for a second
 * reason: `scripts/seed-sandbox-env.mjs` leaves it empty whenever no real key is
 * available, which is every sandbox session, and outside production the app
 * models its absence as a supported state rather than a fault — `/health`
 * reports the provider as not configured and still answers. Requiring either
 * unconditionally at the entrypoint turned that into a 503 on every route of
 * both regions, `/health` included, so the one endpoint whose job is to report
 * which key is missing was the one endpoint that could not answer.
 *
 * Telemetry's provider token, dedicated capability signer, and operator map
 * are intentionally absent too. Collection is useful before PostHog delivery
 * is enabled, capability signing has the existing Global session key as its
 * rollout fallback, and an absent operator map makes only the restricted
 * operator surface return 503. Treating any of those staged states as a Worker-
 * wide fault takes both product regions offline while their D1/R2 bindings and
 * collector are healthy.
 *
 * In production and staging it is a fault, and since `/health` began asserting
 * this contract the probe answers 503 there rather than `openRouter: not
 * configured`. That is the intended difference between a sandbox missing a key
 * and a deployment missing one; the probe still *answers*, which is the
 * distinction that matters.
 */
const productionOnlySecrets = [
  { key: "GOOGLE_OAUTH_CLIENT_ID", regions: ["global"] },
  { key: "GOOGLE_OAUTH_CLIENT_SECRET", regions: ["global"] },
  { key: "OPENROUTER_API_KEY", regions: configuredRegions },
  { key: "TYPESAFE_API_KEY", regions: configuredRegions },
] as const satisfies readonly { key: keyof Env; regions: readonly Region[] }[];

const productionOnlyBindings = [
  { key: "DOCUMENT_PROCESSOR", regions: configuredRegions },
  { key: "TERMINAL_PROVIDER", regions: configuredRegions },
  { key: "TELEMETRY_DELIVERY", regions: configuredRegions },
  { key: "INFERENCE_LAKEHOUSE_QUEUE", regions: configuredRegions },
  { key: "INFERENCE_LAKEHOUSE", regions: configuredRegions },
  { key: "ANALYTICS_LAKEHOUSE_QUEUE", regions: configuredRegions },
  { key: "ANALYTICS_LAKEHOUSE", regions: configuredRegions },
  { key: "USAGE_QUEUE", regions: configuredRegions },
  { key: "USAGE_LAKEHOUSE", regions: configuredRegions },
  // `DEMO_PREPARATION_WORKFLOW` is deliberately absent: it drives an operator
  // tool, and a missing binding is that tool's 503, not a region-wide fault.
] as const satisfies readonly { key: keyof Env; regions: readonly Region[] }[];

/**
 * Drift guard. If a key is required by the schema but optional on `Env` — or
 * carries a different type — this assignment stops compiling. The schema cannot
 * quietly outrun the interface it mirrors.
 */
const _envMatchesItsContract: (env: Env) => z.infer<typeof EnvContractSchema> = (env) => env;
void _envMatchesItsContract;

export class EnvContractError extends Error {
  constructor(readonly keys: string[]) {
    super(`The Worker environment is misconfigured: ${keys.join(", ")}`);
    this.name = "EnvContractError";
  }
}

const validated = new WeakSet<object>();

/**
 * Assert the environment once per isolate, at the entrypoints.
 *
 * Only key names and rule names reach the error — never a value, since almost
 * every key here is a secret.
 */
export function assertEnvContract(env: Env): void {
  if (validated.has(env)) return;
  const result = EnvContractSchema.safeParse(env);
  // An unrecognized region cannot select a region-scoped rule, so it is held to
  // all of them.
  //
  // This does not prevent a fail-open: `EnvContractSchema` types `AVALON_REGION`
  // as an enum, so an unrecognized region already fails the parse and the throw
  // happens either way. What it buys is a *complete* throw — every missing
  // secret reported alongside the bad region, rather than a key list that
  // quietly shrank because the region could not be read.
  //
  // Derived from that same enum rather than restating its members, because a
  // third region added to the enum and missed here would land in "unknown, so
  // it must carry every secret" — including the Global-only login pair it must
  // not have. That is this outage, reissued for the next region, and the drift
  // guard cannot catch it: none of these keys are in the schema.
  const knownRegion = EnvContractSchema.shape.AVALON_REGION.safeParse(env.AVALON_REGION).success;
  const missingSecrets = env.APP_ENV === "production" || env.APP_ENV === "staging"
    ? productionOnlySecrets
        .filter((secret) => (!knownRegion || (secret.regions as readonly Region[]).includes(env.AVALON_REGION))
          && !env[secret.key])
        .map((secret) => secret.key)
    : [];
  const missingBindings = env.APP_ENV === "production" || env.APP_ENV === "staging"
    ? productionOnlyBindings
        .filter((bindingRule) =>
          (!knownRegion || (bindingRule.regions as readonly Region[]).includes(env.AVALON_REGION))
          && !env[bindingRule.key])
        .map((bindingRule) => bindingRule.key)
    : [];
  const terminalRequiredKeys = ["DAYTONA_API_KEY", "DAYTONA_API_URL", "DAYTONA_TARGET", "DAYTONA_TERMINAL_SNAPSHOT"] as const;
  const terminalConfigurationComplete = terminalRequiredKeys.every(
    (key) => typeof env[key] === "string" && env[key]!.trim().length > 0,
  );
  const terminalConfigurationIssues = env.TERMINAL_REGION_CAPABILITY === "supported" && terminalConfigurationComplete
    ? [
        ...(typeof env.DAYTONA_API_URL === "string"
          ? (() => {
              try {
                return new URL(env.DAYTONA_API_URL).protocol === "https:" ? [] : ["DAYTONA_API_URL is invalid"];
              } catch {
                return ["DAYTONA_API_URL is invalid"];
              }
            })()
          : []),
      ]
    : [];
  const azureInferenceConfigurationIssues = Boolean(env.AZURE_INFERENCE_ENDPOINT)
    === Boolean(env.AZURE_INFERENCE_API_KEY)
    ? []
    : ["AZURE_INFERENCE_ENDPOINT and AZURE_INFERENCE_API_KEY must be configured together"];
  if (
    result.success
    && missingSecrets.length === 0
    && missingBindings.length === 0
    && terminalConfigurationIssues.length === 0
    && azureInferenceConfigurationIssues.length === 0
  ) {
    validated.add(env);
    return;
  }
  const keys = [
    ...(result.success ? [] : result.error.issues.map((issue) => {
      const key = issue.path.map(String).join(".") || "(root)";
      // Read from the environment rather than the issue. Zod does not populate
      // `issue.input` at runtime, so testing it reported every `invalid_type`
      // as missing — including a key that is set but malformed, which sends
      // whoever is reading `env_contract_failed` after a variable that is there.
      const present = env[issue.path[0] as keyof Env] !== undefined;
      return `${key} ${present ? "is invalid" : "is missing"}`;
    })),
    ...missingSecrets.map((key) => `${key} is missing`),
    ...missingBindings.map((key) => `${key} is missing`),
    ...terminalConfigurationIssues,
    ...azureInferenceConfigurationIssues,
  ];
  throw new EnvContractError([...new Set(keys)].sort());
}

export function numericEnv(
  env: Env,
  key:
    | "HARNESS_MAX_PLUGIN_CATALOG_TOKENS"
    | "HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS"
    | "HARNESS_TTFT_TIMEOUT_MS"
    | "HARNESS_STREAM_IDLE_TIMEOUT_MS"
    | "HARNESS_CHILD_MAX_MODEL_ITERATIONS"
    | "HARNESS_CHILD_MAX_TOOL_CALLS"
    | "HARNESS_CHILD_MAX_WALL_CLOCK_MS"
    | "HARNESS_CHILD_MAX_COST_CENTS"
    | "HARNESS_CHILD_MAX_CHAIN_RUNS"
    | "HARNESS_CHILD_MAX_DEPTH"
    | "TOOL_DEFAULT_TIMEOUT_MS"
    | "CONNECTOR_POLL_TIMEOUT_MS"
    | "WEB_SEARCH_MAX_RESULTS"
    | "WEB_FETCH_MAX_BYTES"
    | "MAX_ATTACHMENT_BYTES"
    | "WEBHOOK_REPLAY_WINDOW_SECONDS"
    | "PROVIDER_WEBHOOK_MAX_BYTES"
    | "INBOUND_EMAIL_MAX_BYTES"
    | "INBOUND_EMAIL_PROCESSING_LEASE_SECONDS",
  fallback: number,
): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A count whose meaningful range **includes zero**, read separately from
 * `numericEnv` rather than by relaxing it.
 *
 * Every key `numericEnv` serves is a timeout, a byte ceiling, or a budget where
 * zero is nonsense, so its `> 0` guard doubles as validation and must keep it.
 * A retry budget is the first key here where zero is not only meaningful but the
 * single most important value: it is the operator's lever for stopping the
 * harness re-requesting into a provider that is already failing. Routing it
 * through `numericEnv` silently substituted the fallback, so `=0` read as
 * applied, changed nothing, and logged nothing — a dead switch found only by
 * reading the helper.
 */
export function countEnv(
  env: Env,
  key: "HARNESS_TRANSPORT_RETRIES",
  fallback: number,
): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function assertRegion(value: string): Region {
  if (!isConfiguredRegion(value)) {
    throw new Error(`Unsupported Avalon region: ${value}`);
  }
  return value;
}

export function linearNativeAgentEnabled(
  env: Pick<Env, "LINEAR_NATIVE_AGENT_ENABLED">,
): boolean {
  return env.LINEAR_NATIVE_AGENT_ENABLED === "true";
}

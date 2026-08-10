import type { Region } from "@avalon/contracts";
import type { RegionalIdentityBridgeRpcBinding } from "./services/platform-onboarding-service";
import type { GitHubRegionalBridgeRpcBinding, GlobalGitHubRouterRpcBinding } from "./services/github-routing-service";
import type { GlobalWorkstreamEmailRouterRpcBinding } from "./services/workstream-email-routing-service";
import type { InboundEmailRegionalRpcBinding } from "./services/resend-inbound-email-service";
import type {
  GlobalLinearRouterRpcBinding,
  LinearRegionalBridgeRpcBinding,
} from "./services/linear-routing-service";
import type {
  GlobalSlackRouterRpcBinding,
  SlackRegionalBridgeRpcBinding,
} from "./services/slack-routing-service";

export const HYPERSIGHT_MODEL = "x-ai/grok-4.3";

export interface Env {
  DB: D1Database;
  PAYLOADS: R2Bucket;
  IMAGES: ImagesBinding;
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
  // Optional because a Worker may run without the binding. Note that
  // `wrangler dev --local` still provides the object — it is every *call* that
  // throws `Binding FLAGS needs to be run remotely`, so readers must handle
  // both. Either way they fall back to the model variables below.
  FLAGS?: Flagship;
  WORKSTREAM_ROOMS: DurableObjectNamespace;
  WORKSPACE_SCHEDULERS: DurableObjectNamespace;
  ACTIVITY_QUEUE: Queue;
  WORKSTREAM_LOOP_WORKFLOW: Workflow;
  CONNECTOR_POLL_WORKFLOW: Workflow;
  EU_IDENTITY_BRIDGE?: RegionalIdentityBridgeRpcBinding;
  EU_GITHUB_BRIDGE?: GitHubRegionalBridgeRpcBinding;
  EU_INBOUND_EMAIL_BRIDGE?: InboundEmailRegionalRpcBinding;
  EU_LINEAR_BRIDGE?: LinearRegionalBridgeRpcBinding;
  EU_SLACK_BRIDGE?: SlackRegionalBridgeRpcBinding;
  GLOBAL_EMAIL_ROUTER?: GlobalWorkstreamEmailRouterRpcBinding;
  GLOBAL_GITHUB_ROUTER?: GlobalGitHubRouterRpcBinding;
  GLOBAL_LINEAR_ROUTER?: GlobalLinearRouterRpcBinding;
  GLOBAL_SLACK_ROUTER?: GlobalSlackRouterRpcBinding;

  APP_ENV: "development" | "test" | "staging" | "production";
  APP_VERSION?: string;
  BUILD_SHA?: string;
  AVALON_REGION: Region;
  AVALON_DEV_AUTH?: string;
  PUBLIC_API_BASE_URL: string;
  EU_PUBLIC_API_BASE_URL?: string;
  PUBLIC_WEB_BASE_URL: string;
  ALLOWED_ORIGINS: string;
  DESKTOP_DEEP_LINK_URI: string;
  GITHUB_INGRESS_BASE_URL?: string;
  LINEAR_INGRESS_BASE_URL?: string;
  SLACK_INGRESS_BASE_URL?: string;

  OPENROUTER_API_KEY: string;
  OPENROUTER_PRIMARY_MODEL: string;
  OPENROUTER_FALLBACK_MODELS: string;
  OPENROUTER_CLASSIFIER_MODEL: string;
  OPENROUTER_STRUCTURED_MODEL: string;
  OPENROUTER_AUTOMATION_MODEL: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_REALTIME_DEPLOYMENT?: string;
  FIRECRAWL_API_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_NOTIFICATION_FROM_EMAIL?: string;
  RESEND_RECEIVING_API_KEY?: string;
  RESEND_WEBHOOK_SIGNING_SECRET?: string;
  RESEND_WEBHOOK_SECRET?: string;
  WORKSTREAM_EMAIL_ADDRESS_KEY?: string;
  WORKSTREAM_EMAIL_DOMAIN?: string;

  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
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
  NOTION_WEBHOOK_SETUP_TOKEN?: string;
  SLACK_APP_ID?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  TWITTER_API_IO_API_KEY?: string;
  SESSION_SIGNING_KEY: string;
  OAUTH_STATE_ENCRYPTION_KEY: string;
  CONNECTOR_CREDENTIALS_KEY: string;
  CONNECTOR_CREDENTIALS_KEY_VERSION: string;
  CONNECTOR_CREDENTIALS_KEYS_JSON?: string;

  HARNESS_MAX_MODEL_ITERATIONS: string;
  HARNESS_MAX_TOOL_CALLS: string;
  HARNESS_MAX_WALL_CLOCK_MS: string;
  HARNESS_MAX_COST_CENTS?: string;
  HARNESS_MAX_PLUGIN_CATALOG_TOKENS?: string;
  HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS?: string;
  HARNESS_TTFT_TIMEOUT_MS?: string;
  HARNESS_STREAM_IDLE_TIMEOUT_MS?: string;
  HARNESS_CHILD_MAX_MODEL_ITERATIONS?: string;
  HARNESS_CHILD_MAX_TOOL_CALLS?: string;
  HARNESS_CHILD_MAX_WALL_CLOCK_MS?: string;
  HARNESS_CHILD_MAX_COST_CENTS?: string;
  HARNESS_CHILD_MAX_CHAIN_RUNS?: string;
  HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS?: string;
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
  AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR?: string;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
}

export interface IdentityAuthContext {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
  region: Region;
  role: "owner" | "admin" | "member" | null;
}

export interface AuthContext extends IdentityAuthContext {
  workspaceId: string;
  role: "owner" | "admin" | "member";
}

export interface AppVariables {
  requestId: string;
  auth: IdentityAuthContext | undefined;
}

export type HonoAppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

export function numericEnv(
  env: Env,
  key:
    | "HARNESS_MAX_MODEL_ITERATIONS"
    | "HARNESS_MAX_TOOL_CALLS"
    | "HARNESS_MAX_WALL_CLOCK_MS"
    | "HARNESS_MAX_COST_CENTS"
    | "HARNESS_MAX_PLUGIN_CATALOG_TOKENS"
    | "HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS"
    | "HARNESS_TTFT_TIMEOUT_MS"
    | "HARNESS_STREAM_IDLE_TIMEOUT_MS"
    | "HARNESS_CHILD_MAX_MODEL_ITERATIONS"
    | "HARNESS_CHILD_MAX_TOOL_CALLS"
    | "HARNESS_CHILD_MAX_WALL_CLOCK_MS"
    | "HARNESS_CHILD_MAX_COST_CENTS"
    | "HARNESS_CHILD_MAX_CHAIN_RUNS"
    | "HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS"
    | "HARNESS_CHILD_MAX_DEPTH"
    | "TOOL_DEFAULT_TIMEOUT_MS"
    | "CONNECTOR_POLL_TIMEOUT_MS"
    | "WEB_SEARCH_MAX_RESULTS"
    | "WEB_FETCH_MAX_BYTES"
    | "MAX_ATTACHMENT_BYTES"
    | "WEBHOOK_REPLAY_WINDOW_SECONDS"
    | "PROVIDER_WEBHOOK_MAX_BYTES"
    | "INBOUND_EMAIL_MAX_BYTES"
    | "INBOUND_EMAIL_PROCESSING_LEASE_SECONDS"
    | "AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR",
  fallback: number,
): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function assertRegion(value: string): Region {
  if (value !== "global" && value !== "eu") {
    throw new Error(`Unsupported Avalon region: ${value}`);
  }
  return value;
}

export function linearNativeAgentEnabled(
  env: Pick<Env, "LINEAR_NATIVE_AGENT_ENABLED">,
): boolean {
  return env.LINEAR_NATIVE_AGENT_ENABLED === "true";
}

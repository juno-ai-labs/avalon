import type { Region } from "@avalon/contracts";
import type { RegionalIdentityBridgeRpcBinding } from "./services/platform-onboarding-service";
import type { GitHubRegionalBridgeRpcBinding } from "./services/github-routing-service";

export interface Env {
  DB: D1Database;
  PAYLOADS: R2Bucket;
  WORKSTREAM_ROOMS: DurableObjectNamespace;
  WORKSPACE_SCHEDULERS: DurableObjectNamespace;
  ACTIVITY_QUEUE: Queue;
  WORKSTREAM_LOOP_WORKFLOW: Workflow;
  CONNECTOR_POLL_WORKFLOW: Workflow;
  EU_IDENTITY_BRIDGE?: RegionalIdentityBridgeRpcBinding;
  EU_GITHUB_BRIDGE?: GitHubRegionalBridgeRpcBinding;

  APP_ENV: "development" | "test" | "staging" | "production";
  AVALON_REGION: Region;
  AVALON_DEV_AUTH?: string;
  PUBLIC_API_BASE_URL: string;
  EU_PUBLIC_API_BASE_URL?: string;
  PUBLIC_WEB_BASE_URL: string;
  ALLOWED_ORIGINS: string;
  DESKTOP_DEEP_LINK_URI: string;
  GITHUB_INGRESS_BASE_URL?: string;

  OPENROUTER_API_KEY: string;
  OPENROUTER_PRIMARY_MODEL: string;
  OPENROUTER_FALLBACK_MODELS: string;
  OPENROUTER_CLASSIFIER_MODEL: string;
  OPENROUTER_STRUCTURED_MODEL: string;
  FIRECRAWL_API_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;

  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  LINEAR_OAUTH_CLIENT_ID?: string;
  LINEAR_OAUTH_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  NOTION_OAUTH_CLIENT_ID?: string;
  NOTION_OAUTH_CLIENT_SECRET?: string;
  NOTION_INTEGRATION_ID?: string;
  NOTION_WEBHOOK_SETUP_TOKEN?: string;
  SESSION_SIGNING_KEY: string;
  OAUTH_STATE_ENCRYPTION_KEY: string;
  CONNECTOR_CREDENTIALS_KEY: string;
  CONNECTOR_CREDENTIALS_KEY_VERSION: string;

  HARNESS_MAX_MODEL_ITERATIONS: string;
  HARNESS_MAX_TOOL_CALLS: string;
  HARNESS_MAX_WALL_CLOCK_MS: string;
  TOOL_DEFAULT_TIMEOUT_MS: string;
  HARNESS_MAX_CONTEXT_BYTES: string;
  WEB_SEARCH_MAX_RESULTS: string;
  WEB_FETCH_MAX_BYTES: string;
  MAX_ATTACHMENT_BYTES: string;
  WEBHOOK_REPLAY_WINDOW_SECONDS: string;
  PROVIDER_WEBHOOK_MAX_BYTES?: string;
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
    | "TOOL_DEFAULT_TIMEOUT_MS"
    | "HARNESS_MAX_CONTEXT_BYTES"
    | "WEB_SEARCH_MAX_RESULTS"
    | "WEB_FETCH_MAX_BYTES"
    | "MAX_ATTACHMENT_BYTES"
    | "WEBHOOK_REPLAY_WINDOW_SECONDS"
    | "PROVIDER_WEBHOOK_MAX_BYTES",
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

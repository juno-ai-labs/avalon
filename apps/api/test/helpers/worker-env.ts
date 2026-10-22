/**
 * A Worker environment that satisfies the whole `Env` contract.
 *
 * Shared because two very different tests need one: the contract test, which
 * asserts this shape is accepted and that removing a key is not, and any test
 * that calls a handler through `withEnvContract`, which refuses to run at all
 * until every binding is present. Override only what the test is about.
 */
import type { Env } from "../../src/env";
import { createTestEnv } from "./cloudflare-test";

function binding(): never {
  return {} as never;
}

export function contractCompleteEnv(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    DB: binding(), TELEMETRY_DB: binding(), AUDIT_DB: binding(), USAGE_DB: binding(), MESSAGE_ISSUES_DB: binding(), PLATFORM_DB: binding(), PAYLOADS: binding(), TELEMETRY_PAYLOADS: binding(),
    INFERENCE_PRICING_CACHE: binding(), FAVICON_CACHE: binding(),
    IMAGES: binding(), AI: binding(),
    RUN_ANALYTICS: binding(), TERMINAL_ANALYTICS: binding(),
    DOCUMENT_PROCESSOR: binding(), TERMINAL_PROVIDER: binding(), TELEMETRY_DELIVERY: binding(),
    CRASH_SYMBOLICATOR: binding(),
    SUBSTREAM_AGENTS: binding(),
    WORKSPACE_DOS: binding(),
    ARTIFACT_HOSTS: binding(),
    ACTIVITY_QUEUE: binding(),
    INFERENCE_LAKEHOUSE_QUEUE: binding(),
    INFERENCE_LAKEHOUSE: binding(),
    ANALYTICS_LAKEHOUSE_QUEUE: binding(),
    USAGE_QUEUE: binding(),
    USAGE_LAKEHOUSE: binding(),
    ANALYTICS_LAKEHOUSE: binding(),
    ACCESS_REVOCATION_QUEUE: binding(),
    CONNECTOR_POLL_WORKFLOW: binding(),
    CONNECTOR_EVENT_WORKFLOW: binding(), WORK_OPPORTUNITY_WORKFLOW: binding(),
    DEMO_PREPARATION_WORKFLOW: binding(),
    APP_ENV: "production",
    AVALON_REGION: "global",
    LOG_LEVEL: "info",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
    ALLOWED_ORIGINS: "app://avalon",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    OPENROUTER_API_KEY: "sk-or-secret",
    TYPESAFE_API_KEY: "typesafe-secret",
    OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
    SESSION_SIGNING_KEY: "session-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "oauth-secret",
    CONNECTOR_CREDENTIALS_KEY: "credentials-secret",
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    TELEMETRY_CAPABILITY_SIGNING_KEY: "telemetry-capability-secret",
    TELEMETRY_OPERATORS_JSON: JSON.stringify({
      "operator-token-at-least-thirty-two-characters": {
        operatorId: "0198a229-ef99-7000-8000-000000000001",
        role: "security",
      },
    }),
    POSTHOG_PROJECT_TOKEN: "phc_test",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
    TOOL_DEFAULT_TIMEOUT_MS: "30000",
    WEB_SEARCH_MAX_RESULTS: "8",
    WEB_FETCH_MAX_BYTES: "2000000",
    MAX_ATTACHMENT_BYTES: "25000000",
    WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
    CONNECTOR_POLL_TIMEOUT_MS: "20000",
    ...overrides,
  });
}

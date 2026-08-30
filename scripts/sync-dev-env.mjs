import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, ".env.local");
const legacyTargetPath = resolve(root, "apps/api/.dev.vars");
const regionalTargetPaths = {
  global: resolve(root, "apps/api/.dev.vars.global"),
  eu: resolve(root, "apps/api/.dev.vars.eu")
};

const workerKeys = [
  "APP_ENV",
  "AVALON_REGION",
  "RALLY_DEV_AUTH",
  "PUBLIC_API_BASE_URL",
  "PUBLIC_WEB_BASE_URL",
  "ALLOWED_ORIGINS",
  "DESKTOP_DEEP_LINK_URI",
  "OPENROUTER_API_KEY",
  "OPENROUTER_PRIMARY_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
  "OPENROUTER_CLASSIFIER_MODEL",
  "OPENROUTER_STRUCTURED_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_REALTIME_DEPLOYMENT",
  "AZURE_INFERENCE_ENDPOINT",
  "AZURE_INFERENCE_API_KEY",
  "FIRECRAWL_API_KEY",
  "TERMINAL_REGION_CAPABILITY",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DAYTONA_TERMINAL_SNAPSHOT",
  "TERMINAL_EMERGENCY_DISABLED",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_NOTIFICATION_FROM_EMAIL",
  "RESEND_RECEIVING_API_KEY",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  // Legacy deployment compatibility. New environments use the explicit name above.
  "RESEND_WEBHOOK_SECRET",
  "WORKSTREAM_EMAIL_DOMAIN",
  "WORKSTREAM_EMAIL_ADDRESS_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_CONNECTOR_OAUTH_CLIENT_ID",
  "GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_OAUTH_CLIENT_ID",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "LINEAR_NATIVE_AGENT_ENABLED",
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "TWITTER_API_IO_API_KEY",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_TOKEN",
  "TELEMETRY_CAPABILITY_SIGNING_KEY",
  "TELEMETRY_OPERATORS_JSON",
  "OPS_SLACK_BOT_TOKEN",
  "OPS_SLACK_CHANNEL_ID",
  "SLACK_INGRESS_BASE_URL",
  "NOTION_INGRESS_BASE_URL",
  "NOTION_OAUTH_CLIENT_ID",
  "NOTION_OAUTH_CLIENT_SECRET",
  "NOTION_INTEGRATION_ID",
  "SESSION_SIGNING_KEY",
  "OAUTH_STATE_ENCRYPTION_KEY",
  "CONNECTOR_CREDENTIALS_KEY",
  "CONNECTOR_CREDENTIALS_KEYS_JSON",
  "CONNECTOR_CREDENTIALS_KEY_VERSION",
  "TOOL_DEFAULT_TIMEOUT_MS",
  "WEB_SEARCH_MAX_RESULTS",
  "WEB_FETCH_MAX_BYTES",
  "MAX_ATTACHMENT_BYTES",
  "WEBHOOK_REPLAY_WINDOW_SECONDS",
  "PROVIDER_WEBHOOK_MAX_BYTES",
  "INBOUND_EMAIL_MAX_BYTES",
  "LOG_LEVEL"
];

// Provider values may be supplied once as KEY or overridden per region for
// providers that use regional registrations. GitHub and Linear intentionally
// use one identity in both Workers because each operates one public App behind
// a smart, account-aware ingress.
const regionalizableKeys = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_REALTIME_DEPLOYMENT",
  "AZURE_INFERENCE_ENDPOINT",
  "AZURE_INFERENCE_API_KEY",
  "FIRECRAWL_API_KEY",
  "TERMINAL_REGION_CAPABILITY",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DAYTONA_TERMINAL_SNAPSHOT",
  "TERMINAL_EMERGENCY_DISABLED",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_NOTIFICATION_FROM_EMAIL",
  "RESEND_RECEIVING_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_CONNECTOR_OAUTH_CLIENT_ID",
  "GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_OAUTH_CLIENT_ID",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "NOTION_OAUTH_CLIENT_ID",
  "NOTION_OAUTH_CLIENT_SECRET",
  "NOTION_INTEGRATION_ID",
  "TWITTER_API_IO_API_KEY",
  "SESSION_SIGNING_KEY",
  "OAUTH_STATE_ENCRYPTION_KEY",
  "CONNECTOR_CREDENTIALS_KEY",
  "CONNECTOR_CREDENTIALS_KEYS_JSON",
  "TELEMETRY_OPERATORS_JSON",
  "OPS_SLACK_BOT_TOKEN",
  "OPS_SLACK_CHANNEL_ID"
];

const globalOnlyKeys = new Set([
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  "RESEND_WEBHOOK_SECRET",
  "WORKSTREAM_EMAIL_ADDRESS_KEY",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_TOKEN",
  "TELEMETRY_CAPABILITY_SIGNING_KEY"
]);

const safeDefaults = {
  APP_ENV: "development",
  RALLY_DEV_AUTH: "true",
  PUBLIC_WEB_BASE_URL: "http://127.0.0.1:5174",
  ALLOWED_ORIGINS: "app://rallywithai,app://avalon,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174",
  DESKTOP_DEEP_LINK_URI: "rallywithai://auth/complete",
  TERMINAL_REGION_CAPABILITY: "unsupported",
  TERMINAL_EMERGENCY_DISABLED: "false",
  OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
  OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
  OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
  RESEND_FROM_EMAIL: "Rally <invites@rallywith.ai>",
  RESEND_NOTIFICATION_FROM_EMAIL: "Rally <notifications@rallywith.ai>",
  WORKSTREAM_EMAIL_DOMAIN: "automation.rallywith.ai",
  LINEAR_NATIVE_AGENT_ENABLED: "false",
  CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
  TOOL_DEFAULT_TIMEOUT_MS: "30000",
  WEB_SEARCH_MAX_RESULTS: "8",
  WEB_FETCH_MAX_BYTES: "2000000",
  MAX_ATTACHMENT_BYTES: "25000000",
  WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
  PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
  INBOUND_EMAIL_MAX_BYTES: "5000000",
  LOG_LEVEL: "info"
};

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  // A developer's `.env.local` is not in the repository, so the rename from
  // Avalon cannot reach it. Read the superseded name where the current one is
  // absent: without this the only symptom is dev sign-in answering 503, which
  // names neither the variable nor the rename.
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("AVALON_")) continue;
    const renamed = `RALLY_${key.slice("AVALON_".length)}`;
    if (values[renamed] === undefined) values[renamed] = value;
  }
  return values;
}

let local = {};
try {
  local = parseEnv(await readFile(sourcePath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function readEnvFile(path) {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {};
  }
}

const legacyExisting = await readEnvFile(legacyTargetPath);
const existingRegional = {
  global: { ...legacyExisting, ...await readEnvFile(regionalTargetPaths.global) },
  eu: { ...legacyExisting, ...await readEnvFile(regionalTargetPaths.eu) }
};

const sharedPublicAppKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_OAUTH_CLIENT_ID",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "NOTION_OAUTH_CLIENT_ID",
  "NOTION_OAUTH_CLIENT_SECRET",
  "NOTION_INTEGRATION_ID",
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET"
];
const sharedPublicAppValues = Object.fromEntries(sharedPublicAppKeys.map((key) => [
  key,
  local[key]
    || local[`${key}_GLOBAL`]
    || local[`${key}_EU`]
    || existingRegional.global[key]
    || existingRegional.eu[key]
    || ""
]));

for (const region of ["global", "eu"]) {
  const existing = existingRegional[region];
  const regional = {
    ...safeDefaults,
    ...existing,
    ...local,
    AVALON_REGION: region,
    PUBLIC_API_BASE_URL: local[`PUBLIC_API_BASE_URL_${region.toUpperCase()}`]
      || (region === "global" ? "http://127.0.0.1:8787" : "http://127.0.0.1:8788"),
    OPENROUTER_FALLBACK_MODELS: safeDefaults.OPENROUTER_FALLBACK_MODELS
  };
  for (const key of regionalizableKeys) {
    const regionalKey = `${key}_${region.toUpperCase()}`;
    if (!key.startsWith("GITHUB_") && !key.startsWith("LINEAR_") && typeof local[regionalKey] === "string") {
      regional[key] = local[regionalKey];
    }
  }
  Object.assign(regional, sharedPublicAppValues);
  // A single GitHub App may issue independent private keys to each regional
  // Worker. An unsuffixed key remains the convenient development default.
  regional.GITHUB_APP_PRIVATE_KEY = local.GITHUB_APP_PRIVATE_KEY
    || local[`GITHUB_APP_PRIVATE_KEY_${region.toUpperCase()}`]
    || existing.GITHUB_APP_PRIVATE_KEY
    || "";
  // Notion derives its one redirect URI from this, so leaving it unset would
  // point a local authorization at production. Development names the region's
  // own Worker rather than the shared host: a callback then completes in the
  // region that started it, with no cross-region service binding to run, and
  // `isSharedNotionIngress` declines the regional API so the ingress route gate
  // never applies to the whole local surface. An explicit value in .env.local
  // still wins, for exercising the shared path against a tunnel.
  regional.NOTION_INGRESS_BASE_URL = local.NOTION_INGRESS_BASE_URL
    || regional.PUBLIC_API_BASE_URL;
  // Keep generated development encryption/signing material stable per region.
  regional.SESSION_SIGNING_KEY ||= randomBytes(48).toString("base64url");
  regional.OAUTH_STATE_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
  regional.CONNECTOR_CREDENTIALS_KEY ||= randomBytes(32).toString("base64");
  // Migrate the original generated allowlist without overriding an explicit
  // developer choice in .env.local. Built Electron renderers use app://rallywithai.
  if (!("ALLOWED_ORIGINS" in local) && existing.ALLOWED_ORIGINS === "http://localhost:5173") {
    regional.ALLOWED_ORIGINS = safeDefaults.ALLOWED_ORIGINS;
  }
  const serialized = workerKeys
    .filter((key) => (region === "global" || !globalOnlyKeys.has(key))
      && typeof regional[key] === "string"
      && regional[key].length > 0)
    .map((key) => `${key}=${JSON.stringify(regional[key])}`)
    .join("\n");
  await writeFile(regionalTargetPaths[region], `${serialized}\n`, { mode: 0o600 });
}

console.log("Synced fixed Global and EU local Worker environments from .env.local.");

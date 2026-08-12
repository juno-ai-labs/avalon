import { AvalonUrlSchema, HttpUrlSchema } from "@avalon/contracts/url-schemas";
import { z } from "zod";
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
  GlobalNotionRouterRpcBinding,
  NotionRegionalBridgeRpcBinding,
} from "./services/notion-routing-service";
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
  EU_NOTION_BRIDGE?: NotionRegionalBridgeRpcBinding;
  EU_SLACK_BRIDGE?: SlackRegionalBridgeRpcBinding;
  GLOBAL_EMAIL_ROUTER?: GlobalWorkstreamEmailRouterRpcBinding;
  GLOBAL_GITHUB_ROUTER?: GlobalGitHubRouterRpcBinding;
  GLOBAL_LINEAR_ROUTER?: GlobalLinearRouterRpcBinding;
  GLOBAL_NOTION_ROUTER?: GlobalNotionRouterRpcBinding;
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
  NOTION_INGRESS_BASE_URL?: string;
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

  /** Global only. `productionOnlySecrets` enforces them there; EU never carries them. */
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
  PAYLOADS: binding<R2Bucket>(),
  IMAGES: binding<ImagesBinding>(),
  AI: binding<Ai>(),
  MEMORY_INDEX: binding<VectorizeIndex>(),
  WORKSTREAM_ROOMS: binding<DurableObjectNamespace>(),
  WORKSPACE_SCHEDULERS: binding<DurableObjectNamespace>(),
  ACTIVITY_QUEUE: binding<Queue>(),
  WORKSTREAM_LOOP_WORKFLOW: binding<Workflow>(),
  CONNECTOR_POLL_WORKFLOW: binding<Workflow>(),

  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  AVALON_REGION: z.enum(["global", "eu"]),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  PUBLIC_API_BASE_URL: HttpUrlSchema,
  PUBLIC_WEB_BASE_URL: HttpUrlSchema,
  ALLOWED_ORIGINS: z.string().min(1),
  DESKTOP_DEEP_LINK_URI: AvalonUrlSchema,

  // `OPENROUTER_API_KEY` is deliberately not here; see `productionOnlySecrets`.
  OPENROUTER_PRIMARY_MODEL: z.string().min(1),
  OPENROUTER_FALLBACK_MODELS: z.string(),
  OPENROUTER_CLASSIFIER_MODEL: z.string().min(1),
  OPENROUTER_STRUCTURED_MODEL: z.string().min(1),
  OPENROUTER_AUTOMATION_MODEL: z.string().min(1),

  SESSION_SIGNING_KEY: z.string().min(1),
  OAUTH_STATE_ENCRYPTION_KEY: z.string().min(1),
  CONNECTOR_CREDENTIALS_KEY: z.string().min(1),
  CONNECTOR_CREDENTIALS_KEY_VERSION: numericString,

  // Required by the interface, so required here.
  HARNESS_MAX_MODEL_ITERATIONS: numericString,
  HARNESS_MAX_TOOL_CALLS: numericString,
  HARNESS_MAX_WALL_CLOCK_MS: numericString,
  TOOL_DEFAULT_TIMEOUT_MS: numericString,
  WEB_SEARCH_MAX_RESULTS: numericString,
  WEB_FETCH_MAX_BYTES: numericString,
  MAX_ATTACHMENT_BYTES: numericString,
  WEBHOOK_REPLAY_WINDOW_SECONDS: numericString,

  // Optional, but a value that is present must be readable. This is the half
  // `numericEnv` cannot express: absent legitimately means "use the default",
  // while unparseable means someone typed it wrong and nobody found out.
  HARNESS_MAX_COST_CENTS: numericString.optional(),
  HARNESS_MAX_PLUGIN_CATALOG_TOKENS: numericString.optional(),
  HARNESS_REQUEST_ESTABLISHMENT_TIMEOUT_MS: numericString.optional(),
  HARNESS_TTFT_TIMEOUT_MS: numericString.optional(),
  HARNESS_STREAM_IDLE_TIMEOUT_MS: numericString.optional(),
  HARNESS_CHILD_MAX_MODEL_ITERATIONS: numericString.optional(),
  HARNESS_CHILD_MAX_TOOL_CALLS: numericString.optional(),
  HARNESS_CHILD_MAX_WALL_CLOCK_MS: numericString.optional(),
  HARNESS_CHILD_MAX_COST_CENTS: numericString.optional(),
  HARNESS_CHILD_MAX_CHAIN_RUNS: numericString.optional(),
  HARNESS_CHILD_MAX_ACTIVE_WORKSPACE_RUNS: numericString.optional(),
  HARNESS_CHILD_MAX_DEPTH: numericString.optional(),
  CONNECTOR_POLL_TIMEOUT_MS: numericString.optional(),
  PROVIDER_WEBHOOK_MAX_BYTES: numericString.optional(),
  INBOUND_EMAIL_MAX_BYTES: numericString.optional(),
  INBOUND_EMAIL_PROCESSING_LEASE_SECONDS: numericString.optional(),
  AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR: numericString.optional(),

  EU_PUBLIC_API_BASE_URL: HttpUrlSchema.optional(),
  GITHUB_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  LINEAR_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  NOTION_INGRESS_BASE_URL: HttpUrlSchema.optional(),
  SLACK_INGRESS_BASE_URL: HttpUrlSchema.optional(),
});

/**
 * Secrets routinely absent from `.dev.vars`, so local development has always run
 * without them. Requiring them outright would break `pnpm dev:api:local` rather
 * than catch a real misconfiguration, so they are enforced only where their
 * absence is genuinely a deployment fault — which is a question of region as
 * well as of environment.
 *
 * **Google identity OAuth is a Global-only surface.** Every user signs in through
 * the Global endpoint (`REGIONALIZATION.md`), `AuthService.beginIdentity` refuses
 * a non-Global region before it reads either key, and `sync-dev-env.mjs` lists
 * both under `globalOnlyKeys`. Requiring them in every region made the deployed
 * EU Worker fail its own contract on every request, every queue batch, and every
 * cron tick — while `/health`, exempt so that it can report the fault, went on
 * answering `ok`. A contract that demands what the architecture forbids does not
 * catch a misconfiguration; it manufactures one, silently.
 *
 * `OPENROUTER_API_KEY` is required in both regions, and belongs here for a second
 * reason: the app already models its absence as a supported state rather than a
 * fault — `/health` reports `openRouter: not configured` — and
 * `scripts/seed-sandbox-env.mjs` leaves it empty whenever no real key is
 * available, which is every sandbox session. Enforcing it at the entrypoint
 * turned that into a 503 on every route of both regions, `/health` included, so
 * the one endpoint whose job is to report which key is missing was the one
 * endpoint that could not answer.
 */
const productionOnlySecrets = [
  { key: "GOOGLE_OAUTH_CLIENT_ID", regions: ["global"] },
  { key: "GOOGLE_OAUTH_CLIENT_SECRET", regions: ["global"] },
  { key: "OPENROUTER_API_KEY", regions: ["global", "eu"] },
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
  if (result.success && missingSecrets.length === 0) {
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
  ];
  throw new EnvContractError([...new Set(keys)].sort());
}

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

import {
  createConnectorRegistry,
  type CustomMcpConnectorConfig,
  type FirefliesConnectorConfig,
  type CanvaConnectorConfig,
  type GranolaConnectorConfig,
  type GitHubConnectorConfig,
  type LinearConnectorConfig,
  type NotionConnectorConfig,
  type SlackConnectorConfig,
  type XConnectorConfig,
} from "@rally/connectors";
import type { Env } from "../env";
import { notionCallbackUrl } from "./notion-ingress";
import { connectorDocumentReader } from "../services/connector-document-reader";
import { logStructuredEvent } from "../observability/logger";

export function githubConnectorConfig(env: Env): GitHubConnectorConfig | null {
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_CLIENT_ID ||
    !env.GITHUB_APP_CLIENT_SECRET ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_WEBHOOK_SECRET
  ) return null;
  return {
    appId: env.GITHUB_APP_ID,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    privateKey: env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    redirectUri: new URL("/connections/github/callback", env.PUBLIC_API_BASE_URL).toString(),
    ...(env.GITHUB_APP_SLUG ? { appSlug: env.GITHUB_APP_SLUG } : {}),
  };
}

/**
 * Every region serves custom MCP servers; there is no Rally-side application to
 * register. The redirect URI is the only thing the connector needs, and a
 * server's dynamic client registration is what binds a client to it.
 */
export function customMcpConnectorConfig(env: Env): CustomMcpConnectorConfig {
  return {
    redirectUri: new URL("/connections/custom-mcp/callback", env.PUBLIC_API_BASE_URL).toString(),
  };
}

export function canvaConnectorConfig(env: Env): CanvaConnectorConfig {
  return {
    redirectUri: new URL("/connections/canva/callback", env.PUBLIC_API_BASE_URL).toString(),
    allowLoopbackRedirect: true,
  };
}

/**
 * The rollout gate, and the only thing keeping a half-launched region honest.
 *
 * Every other connector's configuration falls out of a credential it needs, so
 * an unconfigured region omits it without anyone deciding to. Fireflies needs
 * no Rally-side credential at all — the API key is the admin's and the OAuth
 * grant is the member's — so the gate is a variable whose only job is to be the
 * gate. Unset, this returns `null`, the registry never builds the adapter, the
 * type is absent from `GET /connections/catalog`, and creation is refused; the
 * rows of a region that is switched back off are retained and inert.
 */

export function firefliesConnectorConfig(env: Env): FirefliesConnectorConfig | null {
  if (env.FIREFLIES_CONNECTOR_ENABLED !== "true") return null;
  return {
    redirectUri: new URL("/connections/fireflies/callback", env.PUBLIC_API_BASE_URL).toString(),
  };
}

export function granolaConnectorConfig(env: Env): GranolaConnectorConfig {
  return {
    redirectUri: new URL("/connections/granola/callback", env.PUBLIC_API_BASE_URL).toString(),
  };
}

export function linearConnectorConfig(env: Env): LinearConnectorConfig | null {
  if (!env.LINEAR_OAUTH_CLIENT_ID || !env.LINEAR_OAUTH_CLIENT_SECRET) return null;
  return {
    clientId: env.LINEAR_OAUTH_CLIENT_ID,
    clientSecret: env.LINEAR_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/connections/linear/callback", env.PUBLIC_API_BASE_URL).toString(),
    ...(env.LINEAR_WEBHOOK_SECRET ? { webhookSecret: env.LINEAR_WEBHOOK_SECRET } : {}),
  };
}

/**
 * Both regions authorize against one public Notion connection, so both send the
 * same shared-ingress redirect URI — a Notion connection accepts exactly one,
 * and the token exchange replays it. The regional Worker therefore names a Global
 * host here on purpose; `NotionRoutingService` carries the callback back to the
 * region that started it. See `docs/notion-ingress.md`.
 */
export function notionConnectorConfig(env: Env): NotionConnectorConfig {
  return {
    redirectUri: notionCallbackUrl(env),
    ...(env.NOTION_OAUTH_CLIENT_ID && env.NOTION_OAUTH_CLIENT_SECRET
      ? {
          clientId: env.NOTION_OAUTH_CLIENT_ID,
          clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
        }
      : {}),
    ...(env.NOTION_INTEGRATION_ID ? { integrationId: env.NOTION_INTEGRATION_ID } : {}),
  };
}

export function googleConnectorConfig(env: Env) {
  if (!env.GOOGLE_CONNECTOR_OAUTH_CLIENT_ID || !env.GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CONNECTOR_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/connections/google/callback", env.PUBLIC_API_BASE_URL).toString(),
  };
}

export function slackConnectorConfig(env: Env): SlackConnectorConfig | null {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.SLACK_SIGNING_SECRET) return null;
  return {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    signingSecret: env.SLACK_SIGNING_SECRET,
    ...(env.SLACK_APP_ID ? { appId: env.SLACK_APP_ID } : {}),
    redirectUri: new URL("/connections/slack/callback", env.PUBLIC_API_BASE_URL).toString(),
  };
}

export function xConnectorConfig(env: Env): XConnectorConfig | null {
  const apiKey = env.TWITTER_API_IO_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey };
}

/**
 * One registry per `Env`, because building one is not free and the result is a
 * pure function of its input.
 *
 * Construction instantiates every configured adapter and re-validates every
 * manifest through Zod. Callers treat `connectorRegistryForEnv` as a cheap
 * lookup — the activity consumer reads one boolean from it per ingested
 * activity, and a queue batch fans out over a hundred of those at once — so
 * without this the hottest ingest path rebuilds eight adapters a hundred times
 * to answer a hundred questions.
 *
 * A `WeakMap` rather than a module-level singleton: `Env` is per-invocation in
 * a Worker, two regions can be exercised in one test file, and a cache that
 * outlives its environment would serve one region's connectors to the other.
 * The registry is immutable, so sharing one within an invocation is safe.
 */
const registriesByEnv = new WeakMap<Env, ReturnType<typeof buildConnectorRegistry>>();

export function connectorRegistryForEnv(env: Env) {
  const cached = registriesByEnv.get(env);
  if (cached) return cached;
  const registry = buildConnectorRegistry(env);
  registriesByEnv.set(env, registry);
  return registry;
}

/**
 * Whether this deployed connector can re-fetch a resource from its provider.
 *
 * The adapter method is the capability: connection/watch state can change at
 * runtime, while neither makes a connector able to hydrate a resource. Unknown
 * or unconfigured connector types fail closed so an older regional deployment
 * never advertises a control its hydrate route cannot fulfill.
 */
export function connectorSupportsResourceHydration(
  registry: ReturnType<typeof connectorRegistryForEnv>,
  connectorType: unknown,
): boolean {
  if (typeof connectorType !== "string") return false;
  try {
    return typeof registry.get(connectorType).hydrateResource === "function";
  } catch {
    return false;
  }
}

function buildConnectorRegistry(env: Env) {
  const customMcp = customMcpConnectorConfig(env);
  const canva = canvaConnectorConfig(env);
  const fireflies = firefliesConnectorConfig(env);
  const granola = granolaConnectorConfig(env);
  const github = githubConnectorConfig(env);
  const linear = linearConnectorConfig(env);
  const notion = notionConnectorConfig(env);
  const google = googleConnectorConfig(env);
  const slack = slackConnectorConfig(env);
  const x = xConnectorConfig(env);
  return createConnectorRegistry({
    observer: (level, event, fields) => logStructuredEvent(env, level, event, fields),
    documents: connectorDocumentReader(env),
    customMcp,
    apollo: { redirectUri: new URL("/connections/apollo/callback", env.PUBLIC_API_BASE_URL).toString() },
    ashby: { redirectUri: new URL("/connections/ashby/callback", env.PUBLIC_API_BASE_URL).toString() },
    canva,
    ...(fireflies ? { fireflies } : {}),
    granola,
    ...(google ? { google } : {}),
    ...(github ? { github } : {}),
    ...(linear ? { linear } : {}),
    notion,
    ...(slack ? { slack } : {}),
    ...(x ? { x } : {}),
  });
}

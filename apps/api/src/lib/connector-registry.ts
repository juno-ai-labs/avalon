import {
  createConnectorRegistry,
  type GitHubConnectorConfig,
  type LinearConnectorConfig,
  type NotionConnectorConfig,
  type SlackConnectorConfig,
  type XConnectorConfig,
} from "@avalon/connectors";
import type { Env } from "../env";

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

export function linearConnectorConfig(env: Env): LinearConnectorConfig | null {
  if (!env.LINEAR_OAUTH_CLIENT_ID || !env.LINEAR_OAUTH_CLIENT_SECRET) return null;
  return {
    clientId: env.LINEAR_OAUTH_CLIENT_ID,
    clientSecret: env.LINEAR_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/connections/linear/callback", env.PUBLIC_API_BASE_URL).toString(),
  };
}

export function notionConnectorConfig(env: Env): NotionConnectorConfig | null {
  if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) return null;
  return {
    clientId: env.NOTION_OAUTH_CLIENT_ID,
    clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/connections/notion/callback", env.PUBLIC_API_BASE_URL).toString(),
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

export function connectorRegistryForEnv(env: Env) {
  const github = githubConnectorConfig(env);
  const linear = linearConnectorConfig(env);
  const notion = notionConnectorConfig(env);
  const google = googleConnectorConfig(env);
  const slack = slackConnectorConfig(env);
  const x = xConnectorConfig(env);
  return createConnectorRegistry({
    ...(google ? { google } : {}),
    ...(github ? { github } : {}),
    ...(linear ? { linear } : {}),
    ...(notion ? { notion } : {}),
    ...(slack ? { slack } : {}),
    ...(x ? { x } : {}),
  });
}

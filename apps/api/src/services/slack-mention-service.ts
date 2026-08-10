import { ConnectorError, connectorRetryAfterMs, slackApi } from "@avalon/connectors";
import { nowIso } from "@avalon/db";
import { z } from "zod";

import type { Env } from "../env";
import { decryptString } from "../lib/crypto";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";

const SlackMentionConnectionSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  provider_account_id: z.string().min(1),
  encrypted_credentials: z.string().min(1),
  credential_iv: z.string().min(1),
  linked_slack_user_id: z.string().min(1).nullable(),
}).strict();

const SlackCredentialsSchema = z.object({ botAccessToken: z.string().min(1) }).passthrough();
type SlackMentionConnection = z.infer<typeof SlackMentionConnectionSchema>;
type SlackMentionDestination = {
  connection: SlackMentionConnection;
  token: string;
  slackUserId: string;
};

export interface WorkstreamSlackMention {
  messageId: string;
  recipientUserId: string;
  recipientEmail: string;
  authorName: string;
  workspaceId: string;
  workspaceName: string;
  workstreamId: string;
  workstreamTitle: string;
  messageText: string;
}

export type SlackMentionDelivery = "sent" | "partial" | "skipped";

/**
 * Delivers one transactional person-mention notification through the installed
 * workspace bot. Email lookup resolves a delivery address only; it never
 * creates or upgrades an Avalon-to-Slack identity link.
 */
export async function sendWorkstreamMentionSlack(
  env: Env,
  input: WorkstreamSlackMention,
  request: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = delay,
): Promise<SlackMentionDelivery> {
  let connectionId: string | null = null;
  let postedChunks = 0;
  try {
    const rawConnections = await env.DB.prepare(
      `SELECT cc.id, cc.workspace_id, cc.provider_account_id,
         cc.encrypted_credentials, cc.credential_iv,
         CASE WHEN l.status = 'active' THEN l.slack_user_id ELSE NULL END AS linked_slack_user_id
       FROM connector_connections cc
       LEFT JOIN slack_user_links l
         ON l.connection_id = cc.id AND l.workspace_id = cc.workspace_id AND l.user_id = ?
       WHERE cc.workspace_id = ? AND cc.connector_type = 'slack'
         AND cc.scope = 'workspace' AND cc.status = 'healthy'
       ORDER BY cc.id`,
    ).bind(input.recipientUserId, input.workspaceId).all<Record<string, unknown>>();
    const connections = z.array(SlackMentionConnectionSchema).parse(rawConnections.results ?? []);
    const linked = connections.filter((candidate) => candidate.linked_slack_user_id !== null);
    let destination: SlackMentionDestination | null = null;
    if (linked.length === 1) {
      const connection = linked[0]!;
      connectionId = connection.id;
      destination = {
        connection,
        token: await workspaceBotToken(env, connection),
        slackUserId: connection.linked_slack_user_id!,
      };
    } else if (linked.length === 0) {
      const matches: SlackMentionDestination[] = [];
      let incompleteLookup: unknown = null;
      for (const connection of connections) {
        connectionId = connection.id;
        const token = await workspaceBotToken(env, connection);
        let slackUserId: string | null;
        try {
          slackUserId = await lookupSlackUserId(
            token,
            connection.provider_account_id,
            input.recipientEmail,
            request,
          );
        } catch (error) {
          const reason = slackFailureReason(error);
          if (reason === "users_not_found") continue;
          if (reason === "missing_scope") {
            incompleteLookup ??= error;
            continue;
          }
          throw error;
        }
        if (slackUserId) matches.push({ connection, token, slackUserId });
      }
      if (incompleteLookup) throw incompleteLookup;
      if (matches.length === 1) destination = matches[0]!;
    }
    if (!destination) return "skipped";
    const { connection, token, slackUserId } = destination;
    connectionId = connection.id;

    const opened = await slackApi(
      token,
      "conversations.open",
      { users: slackUserId },
      AbortSignal.timeout(10_000),
      request,
    );
    const target = desktopHandoffUrl(env.PUBLIC_WEB_BASE_URL, input.workstreamId);
    const chunks = slackMentionChunks(input, target, 40_000);
    let threadTs: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await sleep(1_000);
      const response = await postSlackMentionChunk(
        token,
        {
          channel: opened.channel.id,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          client_msg_id: await stableUuid(`avalon-workstream-mention:${input.messageId}:${input.recipientUserId}:${index}`),
          text: chunk,
        },
        request,
        sleep,
      );
      postedChunks += 1;
      threadTs ??= response.ts;
    }
    return "sent";
  } catch (error) {
    const reason = slackFailureReason(error);
    if (connectionId && (reason === "missing_scope" || reason === "unauthorized")) {
      await env.DB.prepare(
        `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
         WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled'`,
      ).bind(JSON.stringify({
        code: "slack_authorization_invalid",
        message: `Slack workspace authorization needs reconnect (${reason})`,
        reconnectRequired: true,
      }), nowIso(), connectionId).run();
    }
    const outcome = postedChunks > 0 ? "partial" : "skipped";
    console.warn(`Slack mention delivery ${outcome}`, {
      message_id: input.messageId,
      recipient_user_id: input.recipientUserId,
      connection_id: connectionId,
      reason,
      posted_chunks: postedChunks,
    });
    return outcome;
  }
}

async function postSlackMentionChunk(
  token: string,
  body: {
    channel: string;
    thread_ts?: string;
    client_msg_id: string;
    text: string;
  },
  request: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ ts: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await slackApi(
        token,
        "chat.postMessage",
        body,
        AbortSignal.timeout(10_000),
        request,
      );
    } catch (error) {
      const requestedDelay = connectorRetryAfterMs(error);
      const reason = slackFailureReason(error);
      const rateLimited = requestedDelay !== null || reason === "ratelimited" || reason === "rate_limited";
      const transient = error instanceof ConnectorError && error.code === "provider_error" && (
        rateLimited
        || new Set(["fatal_error", "internal_error", "request_timeout", "service_unavailable"]).has(reason)
        || providerStatus(error) >= 500
      );
      if (!transient || attempt === 2) throw error;
      await sleep(rateLimited ? Math.max(1_000, requestedDelay ?? 1_000) : (attempt + 1) * 1_000);
    }
  }
  throw new ConnectorError("provider_error", "Slack message retry limit reached");
}

async function lookupSlackUserId(
  token: string,
  expectedTeamId: string,
  email: string,
  request: typeof fetch,
): Promise<string | null> {
  const result = await slackApi(
    token,
    "users.lookupByEmail",
    { email },
    AbortSignal.timeout(10_000),
    request,
  );
  if (
    result.user.team_id !== expectedTeamId
    || result.user.deleted === true
    || result.user.is_bot === true
  ) return null;
  return result.user.id;
}

async function workspaceBotToken(
  env: Env,
  connection: SlackMentionConnection,
): Promise<string> {
  const credentials = SlackCredentialsSchema.parse(JSON.parse(await decryptString(
    connection.encrypted_credentials,
    connection.credential_iv,
    env.CONNECTOR_CREDENTIALS_KEY,
    connection.id,
  )));
  const context = {
    id: connection.id,
    workspaceId: connection.workspace_id,
    scope: "workspace" as const,
    ownerUserId: null,
    grantedScopes: [],
    credentials,
    cursor: {},
    config: {},
  };
  await ensureFreshConnectorCredentials(
    env,
    context,
    connectorRegistryForEnv(env).get("slack"),
    AbortSignal.timeout(10_000),
  );
  return SlackCredentialsSchema.parse(context.credentials).botAccessToken;
}

function desktopHandoffUrl(webBase: string, workstreamId: string): string {
  const url = new URL("/open", webBase);
  url.hash = new URLSearchParams({ target: `avalon://workstreams/${workstreamId}` }).toString();
  return url.toString();
}

function humanReadableMessage(value: string): string {
  return value.replace(
    /\[@((?:\\.|[^\]])+)\]\(person:[0-9a-f-]{36}\)/giu,
    (_match, label: string) => `@${label.replace(/\\([\\\]])/gu, "$1")}`,
  );
}

function slackMentionChunks(input: WorkstreamSlackMention, target: string, maximum: number): string[] {
  const tokens = [
    ...escapedSlackTokens(input.authorName),
    " mentioned you in “",
    ...escapedSlackTokens(input.workstreamTitle),
    "” in ",
    ...escapedSlackTokens(input.workspaceName),
    ".\n\n",
    ...escapedSlackTokens(humanReadableMessage(input.messageText)),
    "\n\n",
    `<${target}|Open in Avalon>`,
  ];
  const chunks: string[] = [];
  let chunk = "";
  for (const token of tokens) {
    if (token.length > maximum) throw new ConnectorError("provider_error", "Slack message token exceeds its text limit");
    if (chunk.length + token.length > maximum) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += token;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function escapedSlackTokens(value: string): string[] {
  return [...value].map((character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return character;
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stableUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function slackFailureReason(error: unknown): string {
  if (error instanceof ConnectorError) {
    const details = error.details;
    if (details && typeof details === "object" && typeof (details as { error?: unknown }).error === "string") {
      return String((details as { error: string }).error);
    }
    return error.code;
  }
  if (error instanceof z.ZodError) return "invalid_slack_data";
  return error instanceof Error ? error.name : "unknown_error";
}

function providerStatus(error: ConnectorError): number {
  if (!error.details || typeof error.details !== "object") return 0;
  const status = (error.details as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : 0;
}

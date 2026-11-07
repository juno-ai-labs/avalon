import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import { ConnectorError, connectorRetryAfterMs, slackApi } from "@rally/connectors";
import { codeShaped, describeZodIssues, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { nowIso } from "@rally/db";
import { z } from "zod";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { logInfo, logWarn } from "../observability/logger";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { conversationLink } from "./conversation-link-service";

const SlackMentionConnectionSchema = z.strictObject({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  provider_account_id: z.string().min(1),
  encrypted_credentials: z.string().min(1),
  credential_iv: z.string().min(1),
  credential_key_version: z.coerce.number().int().positive(),
  linked_slack_user_id: z.string().min(1).nullable(),
});

const SlackCredentialsSchema = z.looseObject({ botAccessToken: z.string().min(1) });
type SlackMentionConnection = z.infer<typeof SlackMentionConnectionSchema>;
type SlackMentionDestination = {
  connection: SlackMentionConnection;
  token: string;
  slackUserId: string;
};

export interface WorkstreamSlackMention {
  /** The Canvas or Sidekick link, when the caller already resolved it. */
  url?: string;
  messageId: string;
  recipientUserId: string;
  recipientEmail: string;
  authorName: string;
  workspaceId: string;
  workspaceName: string;
  workstreamId: string;
  substreamId?: string;
  workstreamTitle: string;
  messageText: string;
}

export interface WorkstreamSlackParticipantAdded {
  /** The Canvas or Sidekick link, when the caller already resolved it. */
  url?: string;
  sourceId: string;
  recipientUserId: string;
  recipientEmail: string;
  actorName: string;
  workspaceId: string;
  workspaceName: string;
  workstreamId: string;
  substreamId?: string;
  workstreamTitle: string;
  workstreamObjective: string;
  /** The work stream has no settled name yet; do not quote the placeholder. */
  titleIsProvisional: boolean;
}

export type SlackMentionDelivery = "sent" | "partial" | "skipped";

/**
 * What the delivery below needs regardless of what it is telling somebody.
 *
 * The two kinds differ only in their text and in the identity their retry is
 * keyed on. Everything else — resolving the workspace bot, finding the
 * recipient's Slack account, opening the DM, chunking, retrying, and marking a
 * connection for reconnect — is one path, because a second copy of it would be
 * a second place for a Slack authorization failure to be handled differently.
 */
interface WorkstreamSlackDelivery {
  workspaceId: string;
  substreamId?: string;
  recipientUserId: string;
  recipientEmail: string;
  /** Seeds the per-chunk `client_msg_id`, so a retry posts the same message. */
  sourceId: string;
  kind: "mention" | "participant_added" | "activity";
  /** The link, when the caller has one; otherwise the conversation's canonical URL. */
  url?: string;
  chunks: (target: string, maximum: number) => string[];
}

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
  return deliverWorkstreamSlack(env, {
    workspaceId: input.workspaceId,
    ...(input.substreamId ? { substreamId: input.substreamId } : {}),
    recipientUserId: input.recipientUserId,
    recipientEmail: input.recipientEmail,
    ...(input.url ? { url: input.url } : {}),
    sourceId: input.messageId,
    kind: "mention",
    chunks: (target, maximum) => slackMentionChunks(input, target, maximum),
  }, input.workstreamId, request, sleep);
}

/**
 * Tells somebody they were added to a work stream, through the same bot.
 *
 * Reaches the same person the same way a mention does, and for the same
 * reason: being put in a room is the other thing that happens to a person in
 * Avalon which they cannot discover by looking at what they already have open.
 */
export async function sendWorkstreamParticipantAddedSlack(
  env: Env,
  input: WorkstreamSlackParticipantAdded,
  request: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = delay,
): Promise<SlackMentionDelivery> {
  return deliverWorkstreamSlack(env, {
    workspaceId: input.workspaceId,
    ...(input.substreamId ? { substreamId: input.substreamId } : {}),
    recipientUserId: input.recipientUserId,
    recipientEmail: input.recipientEmail,
    ...(input.url ? { url: input.url } : {}),
    sourceId: input.sourceId,
    kind: "participant_added",
    chunks: (target, maximum) => slackParticipantAddedChunks(input, target, maximum),
  }, input.workstreamId, request, sleep);
}

/**
 * Any other Activity row, for a person who chose Slack for its kind: a thread
 * or breakout somebody started, or a run Rally finished. Worded as the
 * sidebar and the push word it.
 */
export interface WorkstreamSlackActivity {
  /** The Activity row's own id, so a retried send is one message. */
  itemId: string;
  recipientUserId: string;
  recipientEmail: string;
  workspaceId: string;
  workspaceName: string;
  workstreamId: string;
  substreamId?: string;
  /** Where the message links: the Canvas or Sidekick the row is about. */
  url?: string;
  title: string;
  body: string;
}

export async function sendWorkstreamActivitySlack(
  env: Env,
  input: WorkstreamSlackActivity,
  request: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = delay,
): Promise<SlackMentionDelivery> {
  return deliverWorkstreamSlack(env, {
    workspaceId: input.workspaceId,
    ...(input.substreamId ? { substreamId: input.substreamId } : {}),
    ...(input.url ? { url: input.url } : {}),
    recipientUserId: input.recipientUserId,
    recipientEmail: input.recipientEmail,
    sourceId: input.itemId,
    kind: "activity",
    chunks: (target, maximum) => chunkSlackTokens([
      ...escapedSlackTokens(input.title),
      " in ",
      ...escapedSlackTokens(input.workspaceName),
      ".\n\n",
      ...(input.body ? [...escapedSlackTokens(input.body), "\n\n"] : []),
      `<${target}|Open in Rally>`,
    ], maximum),
  }, input.workstreamId, request, sleep);
}

async function deliverWorkstreamSlack(
  env: Env,
  input: WorkstreamSlackDelivery,
  workstreamId: string,
  request: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = delay,
): Promise<SlackMentionDelivery> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  let connectionId: string | null = null;
  let providerAccountId: string | null = null;
  let resolvedSlackUserId: string | null = null;
  let channelId: string | null = null;
  let threadTs: string | undefined;
  let lastMessageTs: string | null = null;
  let postedChunks = 0;
  let activeConnectionCount = 0;
  let linkedConnectionCount = 0;
  let lookupMatchCount = 0;
  let resolutionMode: "confirmed_link" | "email_lookup" | null = null;
  // A Canvas's or a Sidekick's link. A Thread, Breakout or Channel has none
  // now that no surface opens one, so nothing is sent to open nothing.
  const link = input.url ? { kind: null, url: input.url } : await conversationLink(env, {
    region: env.AVALON_REGION, workspaceId: input.workspaceId, parentId: workstreamId,
  });
  const target = link.url;
  if (!target) {
    logInfo(env, "slack_notification_terminal", {
      workspace_id: input.workspaceId, workstream_id: workstreamId, kind: input.kind, source_id: input.sourceId,
      recipient_user_id: input.recipientUserId, outcome: "skipped", reason: "conversation_not_linkable",
      parent_kind: link.kind ?? "missing",
    });
    return "skipped";
  }
  try {
    const rawConnections = await env.DB.prepare(
      `SELECT cc.id, cc.workspace_id, cc.provider_account_id,
         cc.encrypted_credentials, cc.credential_iv, cc.credential_key_version,
         CASE WHEN l.status = 'active' THEN l.slack_user_id ELSE NULL END AS linked_slack_user_id
       FROM connector_connections cc
       LEFT JOIN slack_user_links l
         ON l.connection_id = cc.id AND l.workspace_id = cc.workspace_id AND l.user_id = ?
       WHERE cc.workspace_id = ? AND cc.connector_type = 'slack'
         AND cc.scope = 'workspace' AND cc.status <> 'disabled'
       ORDER BY cc.id`,
    ).bind(input.recipientUserId, input.workspaceId).all<Record<string, unknown>>();
    const connections = z.array(SlackMentionConnectionSchema).parse(rawConnections.results ?? []);
    const linked = connections.filter((candidate) => candidate.linked_slack_user_id !== null);
    activeConnectionCount = connections.length;
    linkedConnectionCount = linked.length;
    let destination: SlackMentionDestination | null = null;
    if (linked.length === 1) {
      const connection = linked[0]!;
      connectionId = connection.id;
      providerAccountId = connection.provider_account_id;
      resolutionMode = "confirmed_link";
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
        providerAccountId = connection.provider_account_id;
        const token = await workspaceBotToken(env, connection);
        let lookup: SlackUserLookupResult;
        try {
          lookup = await lookupSlackUserId(
            token,
            connection.provider_account_id,
            input.recipientEmail,
            request,
          );
        } catch (error) {
          const reason = slackFailureReason(error);
          if (reason === "users_not_found") {
            logInfo(env, "slack_notification_lookup_candidate", {
              workspace_id: input.workspaceId,
              workstream_id: workstreamId,
              kind: input.kind,
              source_id: input.sourceId,
              recipient_user_id: input.recipientUserId,
              connection_id: connection.id,
              provider_account_id: connection.provider_account_id,
              outcome: "rejected",
              reason: "users_not_found",
            });
            continue;
          }
          if (reason === "missing_scope") {
            logWarn(env, "slack_notification_lookup_candidate", {
              workspace_id: input.workspaceId,
              workstream_id: workstreamId,
              kind: input.kind,
              source_id: input.sourceId,
              recipient_user_id: input.recipientUserId,
              connection_id: connection.id,
              provider_account_id: connection.provider_account_id,
              outcome: "incomplete",
              reason: "missing_scope",
            });
            incompleteLookup ??= error;
            continue;
          }
          throw error;
        }
        logInfo(env, "slack_notification_lookup_candidate", {
          workspace_id: input.workspaceId,
          workstream_id: workstreamId,
          kind: input.kind,
          source_id: input.sourceId,
          recipient_user_id: input.recipientUserId,
          connection_id: connection.id,
          provider_account_id: connection.provider_account_id,
          slack_user_id: lookup.observedSlackUserId,
          observed_team_id: lookup.observedTeamId,
          outcome: lookup.slackUserId ? "matched" : "rejected",
          reason: lookup.reason ?? "active_human_match",
        });
        if (lookup.slackUserId) matches.push({ connection, token, slackUserId: lookup.slackUserId });
      }
      lookupMatchCount = matches.length;
      if (incompleteLookup) throw incompleteLookup;
      if (matches.length === 1) {
        destination = matches[0]!;
        connectionId = destination.connection.id;
        providerAccountId = destination.connection.provider_account_id;
        resolutionMode = "email_lookup";
      }
    }
    if (!destination) {
      const reason = activeConnectionCount === 0
        ? "no_active_workspace_installation"
        : linkedConnectionCount > 1
          ? "multiple_confirmed_links"
          : lookupMatchCount > 1
            ? "ambiguous_email_lookup"
            : "no_email_lookup_match";
      logInfo(env, "slack_notification_terminal", {
        workspace_id: input.workspaceId,
        workstream_id: workstreamId,
        kind: input.kind,
        source_id: input.sourceId,
        recipient_user_id: input.recipientUserId,
        outcome: "skipped",
        reason,
        active_connection_count: activeConnectionCount,
        linked_connection_count: linkedConnectionCount,
        lookup_match_count: lookupMatchCount,
      });
      return "skipped";
    }
    const { connection, token, slackUserId } = destination;
    connectionId = connection.id;
    providerAccountId = connection.provider_account_id;
    resolvedSlackUserId = slackUserId;
    logInfo(env, "slack_notification_destination_resolved", {
      workspace_id: input.workspaceId,
      workstream_id: workstreamId,
      kind: input.kind,
      source_id: input.sourceId,
      recipient_user_id: input.recipientUserId,
      connection_id: connectionId,
      provider_account_id: providerAccountId,
      slack_user_id: resolvedSlackUserId,
      resolution_mode: resolutionMode,
      active_connection_count: activeConnectionCount,
      linked_connection_count: linkedConnectionCount,
      lookup_match_count: lookupMatchCount,
    });

    const opened = await slackApi(
      token,
      "conversations.open",
      { users: slackUserId },
      AbortSignal.timeout(10_000),
      request,
    );
    channelId = opened.channel.id;
    logInfo(env, "slack_notification_conversation_opened", {
      workspace_id: input.workspaceId,
      workstream_id: workstreamId,
      kind: input.kind,
      source_id: input.sourceId,
      recipient_user_id: input.recipientUserId,
      connection_id: connectionId,
      provider_account_id: providerAccountId,
      slack_user_id: resolvedSlackUserId,
      channel_id: channelId,
      outcome: "opened",
    });
    const chunks = input.chunks(target, 40_000);
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await sleep(1_000);
      const clientMessageId = await stableUuid(
        `avalon-workstream-${input.kind}:${input.sourceId}:${input.recipientUserId}:${index}`,
      );
      const response = await postSlackMentionChunk(
        token,
        {
          channel: opened.channel.id,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          client_msg_id: clientMessageId,
          text: chunk,
        },
        request,
        sleep,
      );
      postedChunks += 1;
      lastMessageTs = response.ts;
      threadTs ??= response.ts;
      logInfo(env, "slack_notification_chunk_terminal", {
        workspace_id: input.workspaceId,
        workstream_id: workstreamId,
        kind: input.kind,
        source_id: input.sourceId,
        recipient_user_id: input.recipientUserId,
        connection_id: connectionId,
        provider_account_id: providerAccountId,
        slack_user_id: resolvedSlackUserId,
        channel_id: channelId,
        client_msg_id: clientMessageId,
        slack_message_ts: response.ts,
        thread_ts: threadTs,
        chunk_index: index,
        chunk_count: chunks.length,
        outcome: "sent",
      });
    }
    logInfo(env, "slack_notification_terminal", {
      workspace_id: input.workspaceId,
      workstream_id: workstreamId,
      kind: input.kind,
      source_id: input.sourceId,
      recipient_user_id: input.recipientUserId,
      connection_id: connectionId,
      provider_account_id: providerAccountId,
      slack_user_id: resolvedSlackUserId,
      channel_id: channelId,
      slack_message_ts: lastMessageTs,
      thread_ts: threadTs ?? null,
      resolution_mode: resolutionMode,
      outcome: "sent",
      reason: "slack_api_accepted",
      posted_chunks: postedChunks,
    });
    return "sent";
  } catch (error) {
    const reason = slackFailureReason(error);
    if (connectionId && (reason === "missing_scope" || reason === "unauthorized")) {
      await env.DB.prepare(
        `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
         WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status IN ('healthy', 'error')`,
      ).bind(JSON.stringify({
        code: "slack_authorization_invalid",
        message: `Slack workspace authorization needs reconnect (${reason})`,
        reconnectRequired: true,
      }), nowIso(), connectionId).run();
    }
    const outcome = postedChunks > 0 ? "partial" : "skipped";
    // One event with the outcome as a field, not an event name interpolated
    // from it: a template literal splits the same failure across two values no
    // saved view can filter on as one. The notification kind is a field for
    // the same reason, now that two of them come through here.
    logWarn(env, "slack_notification_delivery_incomplete", {
      outcome,
      kind: input.kind,
      source_id: input.sourceId,
      recipient_user_id: input.recipientUserId,
      connection_id: connectionId,
      provider_account_id: providerAccountId,
      slack_user_id: resolvedSlackUserId,
      channel_id: channelId,
      slack_message_ts: lastMessageTs,
      thread_ts: threadTs ?? null,
      resolution_mode: resolutionMode,
      active_connection_count: activeConnectionCount,
      linked_connection_count: linkedConnectionCount,
      lookup_match_count: lookupMatchCount,
      reason,
      posted_chunks: postedChunks,
    });
    // A message somebody chose to get by Slack has no other channel standing in
    // for it, so a failure a retry can clear goes back to the queue rather than
    // being dropped. Chunks carry a stable `client_msg_id`, so a retry does not
    // post twice what already landed.
    if (slackFailureRetryable(error)) throw error;
    return outcome;
  }
}

/**
 * Whether a retry could succeed: the network failed, or Slack answered with
 * a server error or a rate limit. Anything Slack refused by name (no such
 * user, missing scope, an invalid token) will be refused again.
 */
function slackFailureRetryable(error: unknown): boolean {
  if (error instanceof ConnectorError) {
    const details = error.details;
    if (details && typeof details === "object" && typeof (details as { error?: unknown }).error === "string") return false;
    if (error.code !== "provider_error") return false;
    const status = providerStatus(error);
    return status === 0 || status === 429 || status >= 500;
  }
  return !(error instanceof z.ZodError);
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

interface SlackUserLookupResult {
  slackUserId: string | null;
  observedSlackUserId: string;
  observedTeamId: string;
  reason: "team_mismatch" | "user_deleted" | "user_is_bot" | null;
}

async function lookupSlackUserId(
  token: string,
  expectedTeamId: string,
  email: string,
  request: typeof fetch,
): Promise<SlackUserLookupResult> {
  const result = await slackApi(
    token,
    "users.lookupByEmail",
    { email },
    AbortSignal.timeout(10_000),
    request,
  );
  if (result.user.team_id !== expectedTeamId) {
    return {
      slackUserId: null,
      observedSlackUserId: result.user.id,
      observedTeamId: result.user.team_id,
      reason: "team_mismatch",
    };
  }
  if (result.user.deleted === true) {
    return {
      slackUserId: null,
      observedSlackUserId: result.user.id,
      observedTeamId: result.user.team_id,
      reason: "user_deleted",
    };
  }
  if (result.user.is_bot === true) {
    return {
      slackUserId: null,
      observedSlackUserId: result.user.id,
      observedTeamId: result.user.team_id,
      reason: "user_is_bot",
    };
  }
  return {
    slackUserId: result.user.id,
    observedSlackUserId: result.user.id,
    observedTeamId: result.user.team_id,
    reason: null,
  };
}

async function workspaceBotToken(
  env: Env,
  connection: SlackMentionConnection,
): Promise<string> {
  const credentials = SlackCredentialsSchema.parse(JSON.parse(
    await decryptVersionedConnectorCredentials(env, connection),
  ));
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


/**
 * An agent's words, made safe for a notification.
 *
 * Two internal syntaxes would otherwise reach a channel verbatim: a mention's
 * `person:` / `person://` target, which prints a raw UUID at somebody, and a
 * citation, which prints a `resource://` URL or a bare `[^1]` marker. This is a
 * third outbound surface beside the digest email and the agent's own delivery,
 * and it quotes the same message text they render — so it owes the same
 * reduction.
 *
 * In its plain shape, though: this text goes to `chat.postMessage`'s `text`
 * field, which is Slack mrkdwn and has neither `**bold**` nor `[label](url)`.
 * The Markdown shape the digest gets would arrive here as a literal `**Sources**`
 * over a literal bracketed link — a different leak from the one this call site
 * was added to close, rather than none.
 */
function humanReadableMessage(value: string): string {
  return rewriteMessageAsPlainText(value, { sources: "plain" });
}

function slackParticipantAddedChunks(
  input: WorkstreamSlackParticipantAdded,
  target: string,
  maximum: number,
): string[] {
  // Read through the same renderer the mention path uses. The objective is a
  // work stream's description, which the description agent rewrites from
  // transcript messages — and those carry `[@Name](person://<uuid>)` (or the
  // legacy bare `person:` form), which would otherwise print a raw UUID.
  const objective = humanReadableMessage(input.workstreamObjective).trim();
  // A work stream created from the composer has no name yet: quoting its
  // placeholder title names the room by a fragment of the opening message, and
  // then prints the same words again below. See `participant-email-service.ts`.
  const opening = input.titleIsProvisional
    ? [
      ...escapedSlackTokens(input.actorName),
      " started a thread with you in ",
      ...escapedSlackTokens(input.workspaceName),
      ".\n\n",
    ]
    : [
      ...escapedSlackTokens(input.actorName),
      " added you to “",
      ...escapedSlackTokens(input.workstreamTitle),
      "” in ",
      ...escapedSlackTokens(input.workspaceName),
      ".\n\n",
    ];
  return chunkSlackTokens([
    ...opening,
    ...(objective ? [...escapedSlackTokens(objective), "\n\n"] : []),
    `<${target}|Open in Rally>`,
  ], maximum);
}

function slackMentionChunks(input: WorkstreamSlackMention, target: string, maximum: number): string[] {
  return chunkSlackTokens([
    ...escapedSlackTokens(input.authorName),
    " mentioned you in “",
    ...escapedSlackTokens(input.workstreamTitle),
    "” in ",
    ...escapedSlackTokens(input.workspaceName),
    ".\n\n",
    ...escapedSlackTokens(humanReadableMessage(input.messageText)),
    "\n\n",
    `<${target}|Open in Rally>`,
  ], maximum);
}

/**
 * Packs already-escaped tokens into messages no larger than Slack's limit.
 *
 * Tokens are single characters apart from the trailing link, which must not be
 * split: half a `<url|label>` is not a link, it is visible markup.
 */
function chunkSlackTokens(tokens: readonly string[], maximum: number): string[] {
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
    // A malformed Slack body arrives as `provider_error` with the failing
    // paths the adapter attached, not as a raw `ZodError`: the adapter parses
    // the response and wraps the rejection. The word `provider_error` alone
    // is what a network fault also says.
    const responseIssues = details && typeof details === "object" ? (details as { responseIssues?: unknown }).responseIssues : undefined;
    if (typeof responseIssues === "string" && isCodeShaped(responseIssues)) return codeShaped(`invalid_slack_data:${responseIssues}`);
    return error.code;
  }
  // Slack answered with a body this binary does not model. The failing path
  // is the diagnosis and is schema shape; the body's values stay behind.
  if (error instanceof z.ZodError) return codeShaped(`invalid_slack_data:${describeZodIssues(error)}`);
  return error instanceof Error ? error.name : "unknown_error";
}

function providerStatus(error: ConnectorError): number {
  if (!error.details || typeof error.details !== "object") return 0;
  const status = (error.details as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : 0;
}

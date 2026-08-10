import { ConnectorError, slackApi } from "@avalon/connectors";
import { workstreamCanonicalUrl } from "@avalon/contracts";
import { nowIso } from "@avalon/db";
import { z } from "zod";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import {
  WORKSTREAM_UNFURL_COLUMNS,
  WORKSTREAM_UNFURL_JOINS,
  slackChannelIsExternallyShared,
  workstreamUnfurlBlocks,
  workstreamUnfurlSummary,
} from "./slack-workstream-card";

/**
 * Rewrite Slack unfurl cards whose work stream has changed status since the
 * card was posted.
 *
 * This runs from the five-minute maintenance sweep rather than from the status
 * writes themselves. `harness_status` is written from seven places across the
 * runtime, the scheduler, and the tool layer; hooking each one would be seven
 * chances to miss a transition and no cheaper. A sweep is one place, it
 * coalesces a burst of transitions into a single rewrite, it re-checks the
 * channel audience on every pass, and a refresh that fails is simply retried
 * next pass instead of being lost.
 *
 * The cost of that choice is up to five minutes of staleness, which is well
 * inside what a status badge needs.
 */

/** Cards older than this are left frozen; nobody is rereading that message. */
const REFRESH_WINDOW_DAYS = 30;
/** Ceiling per sweep across all connections, so one busy region cannot run long. */
const MAX_REFRESHES_PER_SWEEP = 100;
/**
 * Ceiling per Slack workspace per sweep. `chat.unfurl` is Tier 3 — 50+ per
 * minute per method per workspace — and live `link_shared` unfurls, which
 * someone is waiting on, spend from the same budget. The remainder of a
 * workspace's backlog is picked up by the next sweep.
 */
const MAX_REFRESHES_PER_CONNECTION = 20;

/** Slack errors that mean this row can never be unfurled again. */
const TERMINAL_UNFURL_REASONS = new Set([
  "cannot_unfurl_url",
  "cannot_find_message",
  "message_not_found",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "cannot_parse_attachment",
]);

const StaleUnfurlRowSchema = z.object({
  connection_id: z.string(),
  slack_channel_id: z.string(),
  slack_message_ts: z.string(),
  url: z.string(),
  workstream_id: z.string(),
  harness_status: z.string(),
});

interface SlackUnfurlConnection {
  id: string;
  workspace_id: string;
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version?: number;
}

const SlackCredentialsSchema = z.object({ botAccessToken: z.string().min(1) }).loose();

export async function refreshSlackWorkstreamUnfurls(env: Env): Promise<void> {
  const since = new Date(Date.now() - REFRESH_WINDOW_DAYS * 86_400_000).toISOString();
  // A card is rewritten only when the status it shows no longer matches the
  // work stream. Comparing last activity instead would mark almost every row
  // stale on every sweep, since any message bumps it.
  const stale = await env.DB.prepare(
    `SELECT l.connection_id, l.slack_channel_id, l.slack_message_ts, l.url, l.workstream_id,
            w.id, ${WORKSTREAM_UNFURL_COLUMNS}
       FROM slack_unfurled_links l
       JOIN workstreams w ON w.id = l.workstream_id AND w.workspace_id = l.workspace_id
       ${WORKSTREAM_UNFURL_JOINS}
      WHERE l.shared_at >= ?1 AND w.harness_status <> l.rendered_status
      ORDER BY w.last_activity_at DESC
      LIMIT ?2`,
  ).bind(since, MAX_REFRESHES_PER_SWEEP + 1).all<Record<string, unknown>>();

  const rows = stale.results ?? [];
  if (rows.length > MAX_REFRESHES_PER_SWEEP) {
    // Never let a bounded sweep read as "everything is current".
    console.info("Slack unfurl refresh hit its per-sweep ceiling", {
      ceiling: MAX_REFRESHES_PER_SWEEP,
      deferred: rows.length - MAX_REFRESHES_PER_SWEEP,
    });
  }

  const byConnection = new Map<string, Record<string, unknown>[]>();
  for (const row of rows.slice(0, MAX_REFRESHES_PER_SWEEP)) {
    const connectionId = String(row.connection_id);
    const bucket = byConnection.get(connectionId) ?? [];
    if (bucket.length >= MAX_REFRESHES_PER_CONNECTION) continue;
    bucket.push(row);
    byConnection.set(connectionId, bucket);
  }

  for (const [connectionId, connectionRows] of byConnection) {
    try {
      await refreshConnectionUnfurls(env, connectionId, connectionRows);
    } catch (error) {
      // One unhealthy installation must not stop the others.
      console.warn("Slack unfurl refresh failed for a connection", {
        connection_id: connectionId,
        reason: slackUnfurlErrorReason(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function refreshConnectionUnfurls(
  env: Env,
  connectionId: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const connection = await env.DB.prepare(
    `SELECT id, workspace_id, encrypted_credentials, credential_iv, credential_key_version
       FROM connector_connections
      WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status = 'healthy'`,
  ).bind(connectionId).first<SlackUnfurlConnection>();
  if (!connection) return;
  const token = await workspaceBotToken(env, connection);

  // One audience check per channel per sweep, not per card. Re-checking is also
  // the redaction path: a channel that became externally shared after the card
  // was posted is rewritten back to the anonymous form.
  const externalByChannel = new Map<string, boolean>();
  const at = nowIso();

  for (const raw of rows) {
    const parsed = StaleUnfurlRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;

    let external = externalByChannel.get(row.slack_channel_id);
    if (external === undefined) {
      external = await slackChannelIsExternallyShared(token, row.slack_channel_id);
      externalByChannel.set(row.slack_channel_id, external);
    }

    const blocks = workstreamUnfurlBlocks(
      external ? null : workstreamUnfurlSummary(raw),
      workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, row.workstream_id),
    );

    try {
      await slackApi(token, "chat.unfurl", {
        channel: row.slack_channel_id,
        ts: row.slack_message_ts,
        unfurls: { [row.url]: { blocks } },
      }, AbortSignal.timeout(5_000));
    } catch (error) {
      const reason = slackUnfurlErrorReason(error);
      if (!TERMINAL_UNFURL_REASONS.has(reason)) {
        // Transient. Leave rendered_status alone so the next sweep retries.
        console.warn("Slack unfurl refresh deferred", {
          connection_id: connectionId,
          workstream_id: row.workstream_id,
          reason,
        });
        continue;
      }
      // The message or channel is gone. Keeping the row would retry forever.
      await env.DB.prepare(
        `DELETE FROM slack_unfurled_links
          WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
      ).bind(connectionId, row.slack_channel_id, row.slack_message_ts, row.url).run();
      continue;
    }

    await env.DB.prepare(
      `UPDATE slack_unfurled_links SET rendered_status = ?, refreshed_at = ?
        WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
    ).bind(
      row.harness_status,
      at,
      connectionId,
      row.slack_channel_id,
      row.slack_message_ts,
      row.url,
    ).run();
  }
}

function slackUnfurlErrorReason(error: unknown): string {
  if (error instanceof ConnectorError) {
    const details = error.details;
    if (details && typeof details === "object" && typeof (details as { error?: unknown }).error === "string") {
      return String((details as { error: string }).error);
    }
    return error.code;
  }
  return "unknown";
}

async function workspaceBotToken(env: Env, connection: SlackUnfurlConnection): Promise<string> {
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

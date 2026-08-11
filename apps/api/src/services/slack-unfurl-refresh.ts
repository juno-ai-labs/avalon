import { slackApi } from "@avalon/connectors";
import { workstreamCanonicalUrl } from "@avalon/contracts";
import { nowIso } from "@avalon/db";
import { z } from "zod";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import {
  TERMINAL_UNFURL_REASONS,
  WORKSTREAM_UNFURL_COLUMNS,
  WORKSTREAM_UNFURL_JOINS,
  slackChannelIsExternallyShared,
  slackUnfurlErrorReason,
  unfurlStatusLabel,
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
/**
 * How long a recorded card may go without its channel audience being
 * revalidated. Status drift alone is not enough: a channel that becomes
 * externally shared has to be redacted whether or not the work stream moved.
 */
const AUDIENCE_REVALIDATION_HOURS = 24;

const StaleUnfurlRowSchema = z.object({
  connection_id: z.string(),
  slack_channel_id: z.string(),
  slack_message_ts: z.string(),
  url: z.string(),
  workstream_id: z.string(),
  harness_status: z.string(),
  rendered_status: z.string(),
  // SQLite has no boolean type; the column is a 0/1 integer.
  rendered_anonymous: z.number().int(),
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
  const audienceCutoff = new Date(Date.now() - AUDIENCE_REVALIDATION_HOURS * 3_600_000).toISOString();
  // Two independent reasons to look at a card. Status drift is the common one;
  // comparing last activity instead would mark almost every row stale on every
  // sweep, since any message bumps it. The audience clock is the other: a
  // channel can become externally shared while the work stream sits perfectly
  // still, and that card has to be redacted even though nothing drifted.
  //
  // The per-connection cap is applied by ROW_NUMBER *before* the global limit.
  // Taking the global 100 first and trimming per connection afterwards lets one
  // busy workspace fill every slot and starve the rest indefinitely.
  const stale = await env.DB.prepare(
    `SELECT * FROM (
       SELECT l.connection_id, l.slack_channel_id, l.slack_message_ts, l.url, l.workstream_id,
              l.rendered_status AS rendered_status, l.rendered_anonymous,
              w.id, ${WORKSTREAM_UNFURL_COLUMNS},
              w.last_activity_at AS ordered_activity_at,
              ROW_NUMBER() OVER (
                PARTITION BY l.connection_id ORDER BY w.last_activity_at DESC
              ) AS connection_rank
         FROM slack_unfurled_links l
         JOIN workstreams w ON w.id = l.workstream_id AND w.workspace_id = l.workspace_id
         JOIN connector_connections c ON c.id = l.connection_id AND c.status = 'healthy'
         ${WORKSTREAM_UNFURL_JOINS}
        WHERE l.shared_at >= ?1
          AND w.archived_at IS NULL
          AND (w.harness_status <> l.rendered_status OR l.audience_checked_at < ?2)
     )
     WHERE connection_rank <= ?3
     ORDER BY ordered_activity_at DESC
     LIMIT ?4`,
  ).bind(
    since,
    audienceCutoff,
    MAX_REFRESHES_PER_CONNECTION,
    MAX_REFRESHES_PER_SWEEP + 1,
  ).all<Record<string, unknown>>();

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
    byConnection.set(connectionId, [...(byConnection.get(connectionId) ?? []), row]);
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
  const externalByChannel = new Map<string, boolean | null>();
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
    // Unlike posting a new card, an unconfirmed audience must not redact an
    // existing one. Fail-closed here would let a five-second timeout rewrite a
    // correct card to the anonymous form and then persist that as the truth.
    // Leave the row entirely untouched so the next sweep retries.
    if (external === null) {
      console.warn("Slack unfurl refresh deferred; audience could not be confirmed", {
        connection_id: connectionId,
        channel_id: row.slack_channel_id,
      });
      continue;
    }

    // Rewriting an identical card would burn the workspace's `chat.unfurl`
    // budget for no visible change, so compare what the card actually renders
    // rather than the raw status. Most states share the same empty badge, so a
    // move between two of them — `completed` to `idle`, say — drifts the row
    // without changing a pixel. Record the new status and post nothing.
    const wasAnonymous = row.rendered_anonymous === 1;
    const badgeUnchanged = unfurlStatusLabel(row.harness_status) === unfurlStatusLabel(row.rendered_status);
    if (badgeUnchanged && external === wasAnonymous) {
      await markCardCurrent(env, connectionId, row, at);
      continue;
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
      `UPDATE slack_unfurled_links
          SET rendered_status = ?, rendered_anonymous = ?, audience_checked_at = ?, refreshed_at = ?
        WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
    ).bind(
      row.harness_status,
      external ? 1 : 0,
      at,
      at,
      connectionId,
      row.slack_channel_id,
      row.slack_message_ts,
      row.url,
    ).run();
  }
}

/**
 * Record that the posted card is current without touching Slack. Advancing
 * `rendered_status` matters even though nothing was posted: leaving it behind
 * would re-select the row on every sweep for as long as the raw status differs.
 */
async function markCardCurrent(
  env: Env,
  connectionId: string,
  row: { slack_channel_id: string; slack_message_ts: string; url: string; harness_status: string },
  at: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE slack_unfurled_links SET rendered_status = ?, audience_checked_at = ?
      WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
  ).bind(row.harness_status, at, connectionId, row.slack_channel_id, row.slack_message_ts, row.url).run();
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

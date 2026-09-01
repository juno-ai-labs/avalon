import { slackApi } from "@rally/connectors";
import { asWorkspaceId, workstreamCanonicalUrl } from "@rally/contracts";
import { nowIso } from "@rally/db";
import { z } from "zod";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import {
  TERMINAL_UNFURL_REASONS,
  slackChannelIsExternallyShared,
  slackUnfurlErrorReason,
  workstreamUnfurlBlocks,
  workstreamUnfurlCardHash,
  workstreamUnfurlSummary,
} from "./slack-workstream-card";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

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
  rendered_hash: z.string().nullable(),
});

interface SlackUnfurlConnection {
  id: string;
  workspace_id: string;
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version?: number;
}

const SlackCredentialsSchema = z.object({ botAccessToken: z.string().min(1) }).loose();

export async function refreshSlackWorkstreamUnfurls(env: Env, workspaceId?: string): Promise<void> {
  if (!workspaceId && env.WORKSPACE_DOS) throw new Error("slack_unfurl_workspace_required");
  if (workspaceId) env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const since = new Date(Date.now() - REFRESH_WINDOW_DAYS * 86_400_000).toISOString();
  const audienceCutoff = new Date(Date.now() - AUDIENCE_REVALIDATION_HOURS * 3_600_000).toISOString();
  // Three independent reasons to look at a card, none of which subsumes the
  // others. Status drift is the common one; comparing last activity instead
  // would mark almost every row stale on every sweep, since any message bumps
  // it. An edit to the work stream itself is the second — a rename changes the
  // card without touching its status, and `updated_at` moves only on a real
  // edit. The audience clock is the third: a channel can become externally
  // shared while the work stream sits perfectly still, and that card has to be
  // redacted even though nothing drifted.
  //
  // Selecting a row is not the same as rewriting it — the hash decides that —
  // so an edit that does not change the card costs a comparison, not a post.
  //
  // The per-connection cap is applied by ROW_NUMBER *before* the global limit.
  // Taking the global 100 first and trimming per connection afterwards lets one
  // busy workspace fill every slot and starve the rest indefinitely.
  const rows = await loadDurableObjectStaleUnfurls(env, since, audienceCutoff);
  if (rows.length > MAX_REFRESHES_PER_SWEEP) {
    // Never let a bounded sweep read as "everything is current".
    logInfo(env, "slack_unfurl_refresh_ceiling_reached", {
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
      // `detail`, not `message`: the logger reserves `message` for the row
      // summary Workers Logs lists, and an opaque provider string is not one.
      logWarn(env, "slack_unfurl_refresh_connection_failed", {
        connection_id: connectionId,
        reason: slackUnfurlErrorReason(error),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function loadDurableObjectStaleUnfurls(
  env: Env,
  since: string,
  audienceCutoff: string,
): Promise<Record<string, unknown>[]> {
  const links = await env.DB.prepare(
    `SELECT link.connection_id, link.slack_channel_id, link.slack_message_ts,
            link.url, link.workspace_id, link.workstream_id, link.rendered_status,
            link.rendered_anonymous, link.rendered_hash, link.refreshed_at,
            link.audience_checked_at
       FROM slack_unfurled_links link
       JOIN connector_connections connection
         ON connection.id = link.connection_id AND connection.status <> 'disabled'
      WHERE link.shared_at >= ?
      ORDER BY link.refreshed_at ASC LIMIT ?`,
  ).bind(since, MAX_REFRESHES_PER_SWEEP * 2 + 1).all<Record<string, unknown>>();
  const byWorkspace = new Map<string, Set<string>>();
  for (const link of links.results ?? []) {
    const workspaceId = String(link.workspace_id);
    const workstreamId = String(link.workstream_id);
    const ids = byWorkspace.get(workspaceId) ?? new Set<string>();
    ids.add(workstreamId);
    byWorkspace.set(workspaceId, ids);
  }
  const directory = new Map<string, Record<string, unknown>>();
  for (const [workspaceId, idSet] of byWorkspace) {
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
    const ids = [...idSet];
    for (let offset = 0; offset < ids.length; offset += 250) {
      const page = await workspace.lookupWorkstreamDirectory({
        workspaceId,
        workstreamIds: ids.slice(offset, offset + 250),
      });
      for (const item of page.items) {
        directory.set(`${workspaceId}:${item.workstreamId}`, {
          id: item.workstreamId,
          title: item.title,
          harness_status: durableDirectoryHarnessStatus(item.state),
          last_activity_at: item.lastActivityAt,
          origin_type: item.originType,
          automation_name: item.originLabel,
          archived_at: item.archivedAt,
          updated_at: item.updatedAt,
        });
      }
    }
  }
  const checkedAt = nowIso();
  const stale: Record<string, unknown>[] = [];
  const unchangedUpdates: D1PreparedStatement[] = [];
  const advanceRefreshedAt = (link: Record<string, unknown>) => env.DB.prepare(
    `UPDATE slack_unfurled_links SET refreshed_at = ?
      WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
  ).bind(
    checkedAt,
    link.connection_id,
    link.slack_channel_id,
    link.slack_message_ts,
    link.url,
  );
  for (const link of links.results ?? []) {
    const item = directory.get(`${String(link.workspace_id)}:${String(link.workstream_id)}`);
    if (!item || item.archived_at !== null) {
      // Not a card to refresh, but still a row the sweep's due time is derived
      // from: advance it as an unchanged card is advanced, or the sweep comes
      // straight back for it — and, since the stall gate, is held and reported
      // for a link nobody will ever refresh. Left alone, one archived work
      // stream pinned every other card in the workspace behind the backoff.
      unchangedUpdates.push(advanceRefreshedAt(link));
      continue;
    }
    const changed = item.harness_status !== link.rendered_status
      || String(item.updated_at) > String(link.refreshed_at)
      || String(link.audience_checked_at) < audienceCutoff
      || link.rendered_hash === null;
    if (changed) {
      stale.push({ ...link, ...item, ordered_activity_at: item.last_activity_at });
      continue;
    }
    unchangedUpdates.push(advanceRefreshedAt(link));
  }
  if (unchangedUpdates.length > 0) await env.DB.batch(unchangedUpdates);
  const perConnection = new Map<string, number>();
  return stale.sort((left, right) => (
    String(right.ordered_activity_at).localeCompare(String(left.ordered_activity_at))
  )).filter((row) => {
    const connectionId = String(row.connection_id);
    const count = perConnection.get(connectionId) ?? 0;
    if (count >= MAX_REFRESHES_PER_CONNECTION) return false;
    perConnection.set(connectionId, count + 1);
    return true;
  }).slice(0, MAX_REFRESHES_PER_SWEEP + 1);
}

function durableDirectoryHarnessStatus(state: unknown): string {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(String(state))) return "running";
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(String(state))) return "failed";
  if (state === "cancelled") return "stopped";
  return "idle";
}

async function refreshConnectionUnfurls(
  env: Env,
  connectionId: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const connection = await env.DB.prepare(
    `SELECT id, workspace_id, encrypted_credentials, credential_iv, credential_key_version
       FROM connector_connections
      WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled'`,
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
      external = await slackChannelIsExternallyShared(env, token, row.slack_channel_id);
      externalByChannel.set(row.slack_channel_id, external);
    }
    // Unlike posting a new card, an unconfirmed audience must not redact an
    // existing one. Fail-closed here would let a five-second timeout rewrite a
    // correct card to the anonymous form and then persist that as the truth.
    // Leave the row entirely untouched so the next sweep retries.
    if (external === null) {
      logWarn(env, "slack_unfurl_refresh_audience_unconfirmed", {
        connection_id: connectionId,
        channel_id: row.slack_channel_id,
      });
      continue;
    }

    const blocks = workstreamUnfurlBlocks(
      external ? null : workstreamUnfurlSummary(raw),
      workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, {
        region: env.AVALON_REGION,
        workspaceId: connection.workspace_id,
        workstreamId: row.workstream_id,
      }),
    );
    const hash = await workstreamUnfurlCardHash(blocks);

    // Ask the only question that matters — would this card render differently?
    // — by comparing what it would emit against what is posted. No stored field
    // answers that on its own: the drawing code can change, the title and
    // activity stamp both render, and an anonymous card is identical whatever
    // the status does. Rewriting an identical card would spend a `chat.unfurl`
    // from the workspace's Tier 3 budget to change nothing.
    //
    // A row recorded before hashing shipped has no hash, which never matches,
    // so it is rewritten exactly once and then settles.
    if (row.rendered_hash === hash) {
      await markCardCurrent(env, connectionId, row, at, hash);
      continue;
    }

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
        logWarn(env, "slack_unfurl_refresh_deferred", {
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
          SET rendered_status = ?, rendered_anonymous = ?, rendered_hash = ?,
              audience_checked_at = ?, refreshed_at = ?
        WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
    ).bind(
      row.harness_status,
      external ? 1 : 0,
      hash,
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
 * Record that the posted card is already correct, without touching Slack.
 *
 * Every field the selection query reads has to advance here, or a row that
 * needs no rewrite is re-selected on every sweep forever. `rendered_status`
 * covers status drift and `refreshed_at` covers an edit to the work stream
 * that does not reach the card — changing the objective, say, which `updated_at`
 * bumps but the card never shows. Both are cheap; neither posts to Slack.
 */
async function markCardCurrent(
  env: Env,
  connectionId: string,
  row: { slack_channel_id: string; slack_message_ts: string; url: string; harness_status: string },
  at: string,
  hash: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE slack_unfurled_links
        SET rendered_status = ?, rendered_hash = ?, audience_checked_at = ?, refreshed_at = ?
      WHERE connection_id = ? AND slack_channel_id = ? AND slack_message_ts = ? AND url = ?`,
  ).bind(row.harness_status, hash, at, at, connectionId, row.slack_channel_id, row.slack_message_ts, row.url).run();
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

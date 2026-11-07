import { parseLinkTarget, type LinkTarget } from "@rally/contracts/links";
import { codeShaped, describeZodIssues, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { ConnectorError, slackApi } from "@rally/connectors";
import { z } from "zod";

import { sha256 } from "../lib/crypto";
import { logWarn, type LogEnv } from "../observability/logger";

/**
 * The Slack unfurl card for a Rally link. A Canvas or Sidekick link, posted
 * live from `link_shared`, carries the resource's name. A card posted for a
 * Thread link before Canvases replaced Threads also carried a status badge and
 * last activity, and the maintenance sweep still rewrites those until their
 * rows go with Threads. Neither carries any contents. See `docs/links.md` for
 * the audience rule that decides between this and the anonymous card.
 */
export interface WorkstreamUnfurlSummary {
  title: string;
  harnessStatus: string;
  lastActivityAt: string | null;
}

/** Slack sends at most a handful of links per message; bound the batch anyway. */
export const SLACK_UNFURL_MAX_LINKS = 10;

/**
 * A fingerprint of the attachment posted on a message.
 *
 * The sweep needs to answer "would this card render differently now?", and no
 * single stored field does: the drawing code can change, the title and activity
 * stamp both render, and an anonymous card is identical whatever the status is.
 * Hashing the emitted blocks answers it directly, and needs no constant that a
 * future change has to remember to bump.
 *
 * `JSON.stringify` is stable here because these blocks are built by
 * `workstreamUnfurlBlocks` with a fixed key order rather than assembled from
 * user data.
 */
export async function workstreamUnfurlCardHash(
  blocks: Record<string, unknown>[],
): Promise<string> {
  return sha256(JSON.stringify(blocks));
}

/**
 * Slack errors that mean this message can never carry an unfurl. Retrying is
 * pointless on both paths: the sweep deletes the row, and the live handler acks
 * the ingress job rather than burning its retry budget on an unfixable state.
 */
export const TERMINAL_UNFURL_REASONS = new Set([
  "cannot_unfurl_url",
  "cannot_find_message",
  "message_not_found",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "cannot_parse_attachment",
]);

export function slackUnfurlErrorReason(error: unknown): string {
  return slackErrorReason(error);
}

/**
 * The Canvas and Sidekick links in one `link_shared` event that this Slack
 * team's own Organization holds, keyed by the URL Slack reported, at most
 * SLACK_UNFURL_MAX_LINKS of them. A link to another Organization or region,
 * a retired Thread link and anything that is not a Rally link are left out:
 * Slack shows its own preview for those.
 */
export function slackUnfurlLinkTargets(
  links: readonly Record<string, unknown>[],
  scope: { webBaseUrls: readonly string[]; region: string; workspaceId: string },
): Map<string, LinkTarget> {
  const linked = new Map<string, LinkTarget>();
  for (const link of links) {
    if (typeof link.url !== "string" || linked.size >= SLACK_UNFURL_MAX_LINKS) continue;
    const target = parseLinkTarget(link.url, { webBaseUrl: scope.webBaseUrls });
    if (target && target.region === scope.region && target.workspaceId === scope.workspaceId) linked.set(link.url, target);
  }
  return linked;
}

/** A Canvas's or a Sidekick's card: its name when it may be shown, else the anonymous card. */
export function linkUnfurlBlocks(title: string | null, url: string): Record<string, unknown>[] {
  return workstreamUnfurlBlocks(title ? { title, harnessStatus: "", lastActivityAt: null } : null, url);
}

export function workstreamUnfurlSummary(row: Record<string, unknown>): WorkstreamUnfurlSummary {
  return {
    title: typeof row.title === "string" ? row.title : "",
    harnessStatus: typeof row.harness_status === "string" ? row.harness_status : "",
    lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : null,
  };
}

/**
 * Only a work stream someone can act on wears a badge: one that is working, one
 * that is waiting on a person, and one that stopped because it broke.
 * `completed`, `scheduled`, and `idle` render none — "Completed" tells a reader
 * nothing to do, and a settled work stream stops producing the changes that
 * rewrite its card, so that label would sit there for the message's whole life.
 *
 * The emoji leads the title so the state is legible before the text is read,
 * and the word follows in the detail line so the emoji is never the only
 * carrier of meaning. Both come from this one table so they cannot drift apart,
 * and the running and needs-input marks match App Home's task rows.
 */
const SLACK_UNFURL_STATUS_BADGES: Record<string, { emoji: string; label: string }> = {
  needs_input: { emoji: ":warning:", label: "Needs input" },
  running: { emoji: ":large_green_circle:", label: "Running" },
  failed: { emoji: ":red_circle:", label: "Failed" },
  stopped: { emoji: ":white_circle:", label: "Stopped" },
};

function unfurlStatusBadge(harnessStatus: string): { emoji: string; label: string } | null {
  return SLACK_UNFURL_STATUS_BADGES[harnessStatus] ?? null;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackErrorReason(error: unknown): string {
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
  return "unknown";
}

/**
 * Whether Slack has put another company in this conversation — an externally
 * shared channel or a Slack Connect DM.
 *
 * Returns `null` when the lookup itself failed, which callers must distinguish
 * from a confirmed `true`. Posting a new card should fail closed and withhold
 * detail; *rewriting* an existing one must not, because a five-second timeout
 * would otherwise redact a correct card and persist that as the truth.
 *
 * A 1:1 DM is a real case here, not an edge one: Slack omits `is_private` from
 * an `im` response, so this call only survives because the schema treats that
 * field as optional. Do not short-circuit on a `D` channel id — a Slack Connect
 * DM has one too, and it is exactly the case worth catching.
 */
export async function slackChannelIsExternallyShared(
  env: LogEnv,
  token: string,
  channelId: string,
): Promise<boolean | null> {
  try {
    const result = await slackApi(token, "conversations.info", {
      channel: channelId,
    }, AbortSignal.timeout(5_000));
    return result.channel.is_ext_shared === true || result.channel.is_pending_ext_shared === true;
  } catch (error) {
    logWarn(env, "slack_unfurl_audience_lookup_failed", {
      channel_id: channelId,
      reason: slackErrorReason(error),
    });
    return null;
  }
}

function slackUnfurlUpdatedAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  // Slack renders this token in each reader's own timezone. An absolute stamp
  // also cannot rot between refreshes: a relative "24m ago" baked into a card
  // would still claim 24m however long the card sits unchanged.
  return `Updated <!date^${Math.floor(parsed / 1000)}^{date_short_pretty} at {time}|${new Date(parsed).toISOString()}>`;
}

export function workstreamUnfurlBlocks(
  summary: WorkstreamUnfurlSummary | null,
  url: string,
): Record<string, unknown>[] {
  const openButton = {
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Open in Rally" },
      url,
      action_id: "rally_open_unfurl",
    }],
  };
  if (!summary) {
    return [
      { type: "section", text: { type: "mrkdwn", text: "*Rally*\nOpen this item in Rally to view it with your existing workspace permissions." } },
      openButton,
    ];
  }
  // Truncate before escaping, or a cut can land inside an `&amp;` entity.
  const title = escapeMrkdwn(summary.title.trim().slice(0, 200) || "Untitled work stream");
  const badge = unfurlStatusBadge(summary.harnessStatus);
  const detail = [
    badge?.label ?? null,
    slackUnfurlUpdatedAt(summary.lastActivityAt),
  ].filter((part): part is string => part !== null).join(" · ");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${badge ? `${badge.emoji} ` : ""}*<${url}|${title}>*${detail ? `\n${detail}` : ""}`,
      },
    },
    openButton,
  ];
}

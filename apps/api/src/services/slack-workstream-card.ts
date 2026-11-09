import { parseLinkTarget, type LinkTarget } from "@rally/contracts/links";
import { codeShaped, describeZodIssues, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { ConnectorError, slackApi } from "@rally/connectors";
import { z } from "zod";

import { logWarn, type LogEnv } from "../observability/logger";

/**
 * A Rally link's Slack card, and the reads that decide whether one is shown.
 * See `docs/links.md` for the audience rule that decides between this and the
 * anonymous card.
 */

/** Slack sends at most a handful of links per message; bound the batch anyway. */
export const SLACK_UNFURL_MAX_LINKS = 10;

/**
 * Slack errors that mean this message can never carry an unfurl. Retrying is
 * pointless: the live handler acks the ingress job rather than burning its
 * retry budget on an unfixable state.
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
/**
 * A Rally link's card: its title, linked, and an Open in Rally button. A
 * Thread's card also carried its run state and was refreshed as that moved;
 * Threads are retired (plan step C-2), and a Canvas's or a Sidekick's card is
 * its title as it was unfurled.
 */
export function linkUnfurlBlocks(title: string | null, url: string): Record<string, unknown>[] {
  const openButton = {
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Open in Rally" },
      url,
      action_id: "rally_open_unfurl",
    }],
  };
  if (!title) {
    return [
      { type: "section", text: { type: "mrkdwn", text: "*Rally*\nOpen this item in Rally to view it with your existing workspace permissions." } },
      openButton,
    ];
  }
  // Truncate before escaping, or a cut can land inside an `&amp;` entity.
  const text = escapeMrkdwn(title.trim().slice(0, 200) || "Untitled");
  return [{ type: "section", text: { type: "mrkdwn", text: `*<${url}|${text}>*` } }, openButton];
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

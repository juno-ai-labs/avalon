import { ConnectorError, slackApi } from "@avalon/connectors";
import { z } from "zod";

/**
 * The Slack unfurl card for a work-stream link, shared by the live
 * `link_shared` path and the maintenance sweep that refreshes posted cards.
 *
 * The card carries the work stream's title, status, last activity, and
 * automation origin — enough to know whether the link is worth opening and
 * whether the agent is blocked — and no work-stream contents. See
 * `docs/WORKSTREAM_LINKS.md` for the audience rule that decides between this
 * and the anonymous card.
 */
export interface WorkstreamUnfurlSummary {
  title: string;
  harnessStatus: string;
  lastActivityAt: string | null;
  automationName: string | null;
}

/** Slack sends at most a handful of links per message; bound the batch anyway. */
export const SLACK_UNFURL_MAX_LINKS = 10;

/** Columns every summary query must project, so both callers stay in step. */
export const WORKSTREAM_UNFURL_COLUMNS =
  `w.title, w.harness_status, w.last_activity_at, w.origin_type, t.name AS automation_name`;

/** The joins `WORKSTREAM_UNFURL_COLUMNS` depends on. */
export const WORKSTREAM_UNFURL_JOINS =
  `LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
   LEFT JOIN automation_templates t ON t.id = s.template_id`;

export function workstreamUnfurlSummary(row: Record<string, unknown>): WorkstreamUnfurlSummary {
  return {
    title: typeof row.title === "string" ? row.title : "",
    harnessStatus: typeof row.harness_status === "string" ? row.harness_status : "",
    lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : null,
    automationName: row.origin_type === "automation" && typeof row.automation_name === "string"
      ? row.automation_name
      : null,
  };
}

const SLACK_UNFURL_STATUS_LABELS: Record<string, string> = {
  needs_input: ":warning: Needs input",
  running: ":large_green_circle: Running",
  scheduled: "Scheduled",
  completed: "Completed",
  failed: ":red_circle: Failed",
  idle: "Idle",
};

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackErrorReason(error: unknown): string {
  if (error instanceof ConnectorError) {
    const details = error.details;
    if (details && typeof details === "object" && typeof (details as { error?: unknown }).error === "string") {
      return String((details as { error: string }).error);
    }
    return error.code;
  }
  if (error instanceof z.ZodError) return "invalid_slack_data";
  return "unknown";
}

/**
 * True when Slack has put another company in this conversation — an externally
 * shared channel or a Slack Connect DM. A lookup that fails is treated as
 * external: the unfurl still posts, without the work stream's details.
 */
export async function slackChannelIsExternallyShared(
  token: string,
  channelId: string,
): Promise<boolean> {
  try {
    const result = await slackApi(token, "conversations.info", {
      channel: channelId,
    }, AbortSignal.timeout(5_000));
    return result.channel.is_ext_shared === true || result.channel.is_pending_ext_shared === true;
  } catch (error) {
    console.warn("Slack unfurl audience lookup failed; withholding work-stream detail", {
      channel_id: channelId,
      reason: slackErrorReason(error),
    });
    return true;
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
      text: { type: "plain_text", text: "Open in Avalon" },
      url,
      action_id: "avalon_open_unfurl",
    }],
  };
  if (!summary) {
    return [
      { type: "section", text: { type: "mrkdwn", text: "*Avalon*\nOpen this item in Avalon to view it with your existing workspace permissions." } },
      openButton,
    ];
  }
  // Truncate before escaping, or a cut can land inside an `&amp;` entity.
  const title = escapeMrkdwn(summary.title.trim().slice(0, 200) || "Untitled work stream");
  const detail = [
    SLACK_UNFURL_STATUS_LABELS[summary.harnessStatus] ?? null,
    slackUnfurlUpdatedAt(summary.lastActivityAt),
    summary.automationName ? `via ${escapeMrkdwn(summary.automationName.trim().slice(0, 100))}` : null,
  ].filter((part): part is string => part !== null).join(" · ");
  return [
    { type: "section", text: { type: "mrkdwn", text: `*<${url}|${title}>*${detail ? `\n${detail}` : ""}` } },
    openButton,
  ];
}

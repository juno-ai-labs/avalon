import { codeShaped, describeZodIssues, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { ConnectorError, slackApi } from "@rally/connectors";
import { z } from "zod";

import { markImagePath, type Mark } from "@rally/contracts/marks";
import {
  parseSidekickLinkPathTarget,
  parseSpaceLinkPathTarget,
  parseWorkstreamLinkTarget,
} from "@rally/contracts/workstream-links";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { WorkspaceLinkPreview, WorkspaceLinkTarget } from "../durable-objects/workspace-directory-protocol";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn, type LogEnv } from "../observability/logger";

/**
 * The Slack unfurl card for a work-stream link, shared by the live
 * `link_shared` path and the maintenance sweep that refreshes posted cards.
 *
 * The card carries the work stream's title, last activity, and automation
 * origin, plus a status badge while it is running, needs input, or failed —
 * enough to know whether the link is worth opening and whether the agent is
 * blocked — and no work-stream contents. See
 * `docs/workstream-links.md` for the audience rule that decides between this
 * and the anonymous card.
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
 * `linkUnfurlBlocks` with a fixed key order rather than assembled from
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

/** What a link resolved to, and which Organization's object answers for it. */
export interface SlackLinkTarget {
  workspaceId: string;
  target: WorkspaceLinkTarget;
  /** The thread a Channel or Breakout link names, for its status; null for a Space or Sidekick. */
  workstreamId: string | null;
}

/**
 * The Rally object a link in a Slack message names, or null for anything this
 * region cannot answer.
 *
 * Every link shape a member can paste: a thread or Breakout in its current,
 * addressed-legacy or ID-only form, a Channel (a stored Space), and a
 * Sidekick. An ID-only link names no Organization and so is read as the
 * connection's own. A link minted in another region is that region's to
 * preview, and gets no card here.
 */
export function slackLinkTarget(
  raw: string,
  options: { origins: readonly string[]; region: string; connectionWorkspaceId: string },
): SlackLinkTarget | null {
  const thread = parseWorkstreamLinkTarget(raw, { webBaseUrl: options.origins });
  if (thread) {
    if (thread.region !== null && thread.region !== options.region) return null;
    const space = "spaceId" in thread && thread.spaceId ? { spaceId: thread.spaceId } : {};
    return {
      workspaceId: thread.workspaceId ?? options.connectionWorkspaceId,
      workstreamId: thread.workstreamId,
      target: thread.substreamId
        ? { kind: "breakout", workstreamId: thread.workstreamId, substreamId: thread.substreamId, ...space }
        : { kind: "channel", workstreamId: thread.workstreamId, ...space },
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.search || url.hash || !options.origins.some((origin) => URL.canParse(origin) && new URL(origin).origin === url.origin)) return null;
  const space = parseSpaceLinkPathTarget(url.pathname);
  if (space) {
    return space.region === options.region
      ? { workspaceId: space.workspaceId, workstreamId: null, target: { kind: "space", spaceId: space.spaceId } }
      : null;
  }
  const sidekick = parseSidekickLinkPathTarget(url.pathname);
  return sidekick?.region === options.region
    ? { workspaceId: sidekick.workspaceId, workstreamId: null, target: { kind: "sidekick", sidekickId: sidekick.sidekickId } }
    : null;
}

/**
 * One preview per link, in order, asking each Organization's object once.
 *
 * A failed or refused lookup degrades those links to the plain card rather
 * than dropping the unfurl: an Organization this region has never placed is
 * refused before any object opens, exactly as the handoff page's title is.
 */
export async function slackLinkPreviews(
  env: Env,
  links: readonly SlackLinkTarget[],
): Promise<(WorkspaceLinkPreview | null)[]> {
  const byWorkspace = new Map<string, number[]>();
  links.forEach((link, index) => byWorkspace.set(link.workspaceId, [...(byWorkspace.get(link.workspaceId) ?? []), index]));
  const previews: (WorkspaceLinkPreview | null)[] = links.map(() => null);
  await Promise.all([...byWorkspace].map(async ([workspaceId, indexes]) => {
    try {
      const workspace = await durableObjectStubForWorkspace(
        env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
      );
      const result = await workspace.linkPreviews({ workspaceId, targets: indexes.map((index) => links[index]!.target) });
      indexes.forEach((index, position) => { previews[index] = result.previews[position] ?? null; });
    } catch (error) {
      logWarn(env, "slack_unfurl_preview_failed", { workspace_id: workspaceId, reason: linkPreviewErrorReason(error) });
    }
  }));
  return previews;
}

function linkPreviewErrorReason(error: unknown): string {
  if (error instanceof z.ZodError) return codeShaped(`invalid_link_preview:${describeZodIssues(error)}`);
  // The object's own refusal (`workspace_placement_affinity_unavailable`) or
  // the runtime's; neither carries the caller's data.
  return error instanceof Error ? codeShaped(error.message || error.name) : "non_error_thrown";
}

/** The word each kind of link reads as in the product since the navigation redesign. */
const LINK_KIND_LABELS: Record<WorkspaceLinkTarget["kind"], string> = {
  channel: "Thread",
  breakout: "Breakout",
  space: "Channel",
  sidekick: "Sidekick",
};

export interface LinkUnfurlInput {
  url: string;
  kind: WorkspaceLinkTarget["kind"];
  /** Name, colour and icon — public to whoever holds the link. Null when nothing answered. */
  preview: WorkspaceLinkPreview | null;
  /** Status and recency — only where the audience rule allows it. */
  summary: WorkstreamUnfurlSummary | null;
  /** The site origin `/marks/...` images are served from. */
  markOrigin: string;
}

function markImage(origin: string, mark: Mark, altText: string): Record<string, unknown> {
  return { type: "image", image_url: new URL(markImagePath(mark), origin).href, alt_text: altText };
}

/**
 * The card for one Rally link: the Channel it sits in above, then its own name
 * beside its mark, a status line where the audience rule allows one, and the
 * button. Name, colour and icon are shown to anyone the link reaches; status,
 * recency and contents are not (`docs/workstream-links.md`).
 */
export function linkUnfurlBlocks(input: LinkUnfurlInput): Record<string, unknown>[] {
  const { preview, summary, url, kind } = input;
  const openButton = {
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Open in Rally" },
      url,
      action_id: "rally_open_unfurl",
    }],
  };
  if (!preview && !summary) {
    return [
      { type: "section", text: { type: "mrkdwn", text: "*Rally*\nOpen this item in Rally to view it with your existing workspace permissions." } },
      openButton,
    ];
  }
  // Truncate before escaping, or a cut can land inside an `&amp;` entity.
  const title = escapeMrkdwn((preview?.title ?? summary?.title ?? "").trim().slice(0, 200) || "Untitled");
  const badge = summary ? unfurlStatusBadge(summary.harnessStatus) : null;
  const detail = [
    LINK_KIND_LABELS[kind],
    badge?.label ?? null,
    summary ? slackUnfurlUpdatedAt(summary.lastActivityAt) : null,
  ].filter((part): part is string => part !== null).join(" · ");
  const blocks: Record<string, unknown>[] = [];
  if (preview?.channel) {
    const channelTitle = escapeMrkdwn(preview.channel.title.trim().slice(0, 200));
    blocks.push({
      type: "context",
      elements: [
        markImage(input.markOrigin, preview.channel.mark, preview.channel.title),
        { type: "mrkdwn", text: `*${channelTitle}*` },
      ],
    });
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `${badge ? `${badge.emoji} ` : ""}*<${url}|${title}>*\n${detail}` },
    ...(preview?.mark ? { accessory: markImage(input.markOrigin, preview.mark, preview.title) } : {}),
  });
  blocks.push(openButton);
  return blocks;
}

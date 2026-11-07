import {
  ExecutionPrincipalSchema,
  asUserId,
  asWorkspaceId,
  type ActivityItem,
  type ActivityItemKind,
} from "@rally/contracts";
import { nowIso } from "@rally/db";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceDigestClaimResultSchema,
  WorkspaceDigestDeliveryContextSchema,
  WorkspaceDigestFireScheduleSchema,
  WorkspaceDigestSettleResultSchema,
  WorkspaceDigestTerminalContextSchema,
} from "../durable-objects/workspace-digests-protocol";
import { WorkspaceActivityResultSchema } from "../durable-objects/workspace-space-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { stableUuid } from "../lib/stable-uuid";
import { emitProductUsageTelemetry, resourceTelemetryEventId, telemetryCountBucket } from "../telemetry/product-usage";
import { deliverDigest } from "./digest-delivery-service";
import { singleLine } from "./resend";
import { withWorkspaceRuntimeDatabase, workspaceRegionalDatabase } from "./workspace-runtime-database";
import { conversationCanonicalUrl } from "./conversation-link-service";

/**
 * A digest is what is still unread in a person's Activity, sent at the start
 * and end of their day. `docs/digests.md#the-digest` owns the design.
 */

export interface DigestScheduleFireInput {
  scheduleId: string;
  workspaceId: string;
  /** The occurrence instant, which is what makes a re-fired alarm idempotent. */
  plannedFor: string;
}

export type DigestFireOutcome =
  | { sent: true; deliveryId: string; itemCount: number }
  | { sent: false; reason: "already_settled" | "disabled" | "unauthorized" | "empty" };

/** The WorkspaceDO that owns this workspace's digest tables and its Activity feed. */
function workspaceDigests(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/**
 * Sends one due digest occurrence.
 *
 * The occurrence's id is derived from its schedule and instant, so a retried
 * alarm finds the delivery its first attempt claimed and finishes it, sending
 * the text that attempt kept rather than reading Activity again. Each
 * destination records the delivery it last received, so a retry re-sends only
 * what has not landed.
 */
export async function fireDigestSchedule(
  env: Env,
  input: DigestScheduleFireInput,
): Promise<DigestFireOutcome> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const workspace = await workspaceDigests(env, input.workspaceId);
  const digest = WorkspaceDigestFireScheduleSchema.parse(await workspace.digestScheduleForFire({
    workspaceId: input.workspaceId,
    scheduleId: input.scheduleId,
    plannedFor: input.plannedFor,
  })).schedule;
  const identity = digest ? await workspaceRegionalDatabase(env).prepare(
    `SELECT u.timezone, u.name AS user_name, w.name AS workspace_name
       FROM users u JOIN workspaces w ON w.id = ?
       JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id AND m.status = 'active'
      WHERE u.id = ?`,
  ).bind(input.workspaceId, digest.userId).first<{
    timezone: string;
    user_name: string;
    workspace_name: string;
  }>() : null;
  // A revoked membership or a deleted schedule is a decision, not a failure:
  // retrying would only reach the same answer.
  if (!digest || !identity) return { sent: false, reason: "unauthorized" };
  if (!digest.enabled) return { sent: false, reason: "disabled" };
  // A schedule saved months ago must not still act as somebody who is no
  // longer that person.
  const principal = ExecutionPrincipalSchema.parse(JSON.parse(digest.executionPrincipalJson));
  if (principal.type !== "user" || principal.userId !== digest.userId) return { sent: false, reason: "unauthorized" };

  const deliveryId = await stableUuid(["digest_delivery", digest.id, input.plannedFor]);
  const existing = WorkspaceDigestDeliveryContextSchema.parse(await workspace.digestDeliveryContext({
    workspaceId: input.workspaceId,
    deliveryId,
  })).delivery;
  if (existing && existing.status !== "planned") return { sent: false, reason: "already_settled" };

  let delivery = existing;
  if (!delivery) {
    const { items, olderCount } = splitByAge(
      await unreadActivity(env, input.workspaceId, digest.userId),
      input.plannedFor,
      digest.lastDeliveredFor,
    );
    // Only rows older than the window left: earlier digests listed them, so
    // this occurrence has nothing new and sends nothing.
    const markdown = items.length ? await renderUnreadDigest(env, input.workspaceId, items, olderCount) : null;
    const claimed = WorkspaceDigestClaimResultSchema.parse(await workspace.claimDigestDelivery({
      workspaceId: input.workspaceId,
      deliveryId,
      digestScheduleId: digest.id,
      userId: digest.userId,
      plannedFor: input.plannedFor,
      cursorFrom: null,
      cursorThrough: 0,
      eventCount: items.length,
      highlightCount: items.filter((item) => item.kind === "mentioned").length,
      // Nothing unread, nothing sent.
      status: markdown ? "planned" : "empty",
      summaryMarkdown: markdown,
      at: nowIso(),
    }));
    if (claimed.outcome === "already_planned") return { sent: false, reason: "already_settled" };
    if (!markdown) return { sent: false, reason: "empty" };
    delivery = {
      id: deliveryId,
      userId: digest.userId,
      plannedFor: input.plannedFor,
      eventCount: items.length,
      highlightCount: items.filter((item) => item.kind === "mentioned").length,
      status: "planned",
      workstreamId: null,
      summaryMarkdown: markdown,
    };
  }
  if (!delivery.summaryMarkdown) throw new Error("digest_summary_missing");

  // A destination's failure is recorded, not thrown; an attempt that dies
  // before settling is retried by the alarm and lands here again.
  const outcome = await deliverDigest(env, {
    workspaceId: input.workspaceId,
    deliveryId,
    userId: digest.userId,
    recipientName: identity.user_name,
    workspaceName: identity.workspace_name,
    timezone: identity.timezone,
    plannedFor: input.plannedFor,
    bodyMarkdown: delivery.summaryMarkdown,
    itemCount: delivery.eventCount,
    highlightCount: delivery.highlightCount,
  });
  const status = outcome.failed > 0 && outcome.delivered === 0 ? "failed" : "delivered";
  const settled = WorkspaceDigestSettleResultSchema.parse(await workspace.settleDigestDelivery({
    workspaceId: input.workspaceId,
    deliveryId,
    status,
    errorJson: status === "failed" ? JSON.stringify({ code: "digest_every_destination_failed" }) : null,
    at: nowIso(),
  }));
  if (settled.outcome === "settled") await emitDigestTerminal(env, input.workspaceId, digest.userId, delivery, status);
  return { sent: true, deliveryId, itemCount: delivery.eventCount };
}

/** The person's unread Activity, as their Activity tab lists it: its first page, newest first. */
async function unreadActivity(env: Env, workspaceId: string, userId: string): Promise<ActivityItem[]> {
  const workspace = await workspaceDigests(env, workspaceId);
  const result = WorkspaceActivityResultSchema.parse(await workspace.listActivity({
    workspaceId: asWorkspaceId(workspaceId),
    userId: asUserId(userId),
    cursor: null,
    only: null,
  }));
  // Thrown, not read as "nothing unread": an empty settle would hide why.
  if (!result.ok) throw new Error(`digest_activity_unreadable:${result.code}`);
  const mentions = new Set(result.page.items.filter((item) => item.kind === "mentioned").map((item) => `message:${item.id}`));
  return result.page.items.filter((item) => item.unread && !(item.kind === "new_message" && mentions.has(item.id)));
}

/**
 * How long an unread row keeps being listed. A row stays unread until it is
 * read, so without this every digest repeats everything the person has not
 * opened; past the window it is only counted. The number is the team's choice.
 * The window always reaches back to the last delivered digest too, so a gap
 * longer than this (a weekend, a weekly schedule) never hides a row that no
 * digest has listed yet.
 */
const LISTED_FOR_DAYS = 2;
const LISTED_FOR_MS = LISTED_FOR_DAYS * 24 * 60 * 60 * 1000;

/** Unread rows within the window of the occurrence, and how many fell outside it. */
export function splitByAge(
  items: readonly ActivityItem[],
  plannedFor: string,
  lastDeliveredFor: string | null,
): { items: ActivityItem[]; olderCount: number } {
  // Measured from the occurrence, not the clock, so a retry reaches the same split.
  const window = Date.parse(plannedFor) - LISTED_FOR_MS;
  const cutoff = lastDeliveredFor === null ? window : Math.min(window, Date.parse(lastDeliveredFor));
  const recent = items.filter((item) => Date.parse(item.occurredAt) >= cutoff);
  return { items: recent, olderCount: items.length - recent.length };
}

/**
 * The heading of each kind's section, in the order Settings lists the kinds.
 * Every kind must have one: a kind without a section would be counted in the
 * digest's opening line and then never listed.
 */
const SECTION_HEADINGS = {
  mentioned: "Mentions",
  new_message: "New messages",
  added: "Added to a thread",
  thread_started: "New threads",
  breakout_started: "New breakouts",
  run_finished: "Rally finished",
  merged: "Merges",
  artifact_updated: "Pinned artifacts",
} as const satisfies Record<ActivityItemKind, string>;
const UNNAMED_THREAD = "Untitled thread";
const UNNAMED_BREAKOUT = "Untitled breakout";

/**
 * The digest's text: one `##` section per kind, one bullet per row, worded as
 * the sidebar words it and linked to what it names. Markdown, because every
 * destination already renders it: the email, a Slack message, a thread.
 */
export async function renderUnreadDigest(
  env: Env,
  workspaceId: string,
  items: readonly ActivityItem[],
  olderCount = 0,
): Promise<string> {
  const actorIds = [...new Set(items.flatMap((item) => item.actorUserId ? [item.actorUserId] : []))];
  const names = new Map<string, string>();
  if (actorIds.length) {
    const rows = await workspaceRegionalDatabase(env).prepare(
      `SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(actorIds)).all<{ id: string; name: string | null }>();
    for (const row of rows.results) if (row.name?.trim()) names.set(row.id, row.name.trim());
  }
  const sections: string[] = [];
  for (const [kind, heading] of Object.entries(SECTION_HEADINGS) as Array<[ActivityItemKind, string]>) {
    const rows = items.filter((item) => item.kind === kind);
    if (!rows.length) continue;
    const lines = await Promise.all(rows.map(async (item) => {
      // A row about a Canvas's Chat or a Sidekick links to it. A Thread,
      // Breakout or Channel has no link now that no surface opens one, so its
      // row names it unlinked.
      const url = await conversationCanonicalUrl(env, { region: env.AVALON_REGION, workspaceId, parentId: item.threadId });
      const linked = (label: string): string => url ? `[${label}](${url})` : label;
      const actor = escapeMarkdown(item.actorUserId === null ? item.actorLabel : names.get(item.actorUserId) ?? "Someone");
      // A merge from a thread this reader cannot open names no thread.
      const thread = item.mergedInto?.threadPrivate ? linked("a private thread")
        : linked(escapeMarkdown(item.threadTitle.trim() || UNNAMED_THREAD));
      const breakout = item.breakout ? linked(escapeMarkdown(item.breakout.title.trim() || UNNAMED_BREAKOUT)) : null;
      switch (item.kind) {
        case "new_message": return `- ${actor} replied in ${breakout ?? thread}`;
        case "mentioned": return `- ${actor} mentioned you in ${breakout ?? thread}`;
        case "added": return `- ${actor} added you to ${breakout ?? thread}`;
        case "thread_started": return `- ${actor} started ${thread}`;
        case "breakout_started": return `- ${actor} started ${breakout ?? thread} on ${escapeMarkdown(item.threadTitle.trim() || UNNAMED_THREAD)}`;
        case "run_finished": return `- ${actor} finished ${breakout ?? thread}`;
        case "merged": return item.breakout
          ? `- ${actor} merged ${escapeMarkdown(item.breakout.title.trim() || UNNAMED_BREAKOUT)} into ${thread}`
          : `- ${actor} merged ${thread} into ${escapeMarkdown(item.mergedInto?.name.trim() || "a channel")}`;
        case "artifact_updated": return `- ${actor} updated ${escapeMarkdown(item.artifact?.title.trim() || "an artifact")} in ${thread}`;
      }
    }));
    sections.push([`## ${heading}`, ...lines].join("\n"));
  }
  const count = items.length;
  const older = olderCount ? [`${olderCount} more older than ${LISTED_FOR_DAYS} days.`] : [];
  return [`${count} unread item${count === 1 ? "" : "s"} in your Activity.`, ...sections, ...older].join("\n\n");
}

/**
 * A title or name as one line of text: its line breaks folded, so it cannot
 * start a heading or a bullet of its own, and its brackets and emphasis marks
 * escaped, so it stays text inside a link.
 */
function escapeMarkdown(value: string): string {
  return singleLine(value).replace(/[\\[\]*_`#>]/gu, (character) => `\\${character}`);
}

async function emitDigestTerminal(
  env: Env,
  workspaceId: string,
  userId: string,
  delivery: { id: string; eventCount: number },
  result: "delivered" | "failed",
): Promise<void> {
  const context = WorkspaceDigestTerminalContextSchema.parse(
    await (await workspaceDigests(env, workspaceId)).digestTerminalTelemetryContext({ workspaceId, deliveryId: delivery.id }),
  );
  emitProductUsageTelemetry(env, {
    workspaceId: asWorkspaceId(workspaceId),
    userId: asUserId(userId),
    name: "digest_delivery_terminal",
    properties: {
      deliveryId: delivery.id,
      result: result === "delivered" ? "success" : "failed",
      activityCount: telemetryCountBucket(delivery.eventCount),
      targetTypes: digestTelemetryTargetTypes(context.targetTypes),
      firstDelivery: context.priorDeliveredCount === 0,
    },
    operationId: delivery.id,
    eventId: resourceTelemetryEventId(delivery.id, 10),
  });
}

/** The destination types telemetry names; anything it does not know is left out rather than refused. */
export function digestTelemetryTargetTypes(types: readonly string[]): Array<"email" | "slack_agent_dm" | "personal_channel"> {
  return types.flatMap((type) => type === "email" || type === "slack_agent_dm" || type === "personal_channel" ? [type] : []);
}

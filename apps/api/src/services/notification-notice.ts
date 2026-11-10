import { asWorkspaceId, IdSchema } from "@rally/contracts";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import { SidekickRunNotificationSchema, type PushNotificationData, type SidekickRunNotification } from "@rally/contracts/push-notifications";

import type { Env } from "../env";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { WorkspaceDirectoryNotificationStateSchema } from "../durable-objects/workspace-directory-protocol";
import {
  ParentNoticeSchema,
  WorkspaceNotificationIntentDeliverySchema,
  type ParentNotice,
  type WorkspaceNotificationIntentDelivery,
} from "../durable-objects/workspace-notification-intent-protocol";
import { sourceNoticeText } from "../durable-objects/sidekick-source-notices";
import { asApiError } from "../lib/api-error";
import { logWarn } from "../observability/logger";
import { notificationDeliveryContext } from "./conversation-effect-service";
import { conversationLink } from "./conversation-link-service";
import { sourceDecisionActions } from "./sidekick-source-decision-link";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

/**
 * One notification, rendered once and channel-neutral: what it says, who
 * did it, where it opens and in which Organization. Every sink (push, email)
 * takes this and adds only its own transport's form. `docs/push-notifications.md`
 * ("Sinks") owns the design.
 */
export interface Notice {
  /** The intent it renders: what a receipt, a collapse id and an email's idempotency key are keyed on. */
  intentId: string;
  kind: PushNotificationData["kind"];
  title: string;
  /** Plain text: the message, the run's reply, the request's message, or empty. */
  body: string;
  /** Who acted, by name as the notice captured it. */
  actorName: string;
  /** The canonical link it opens. */
  url: string;
  workspaceId: string;
  recipientUserId: string;
  /** The Canvas or Sidekick it is about. */
  parentId: string;
  /** The conversation under it: `"0"` for the Chat, a run's id, or null. */
  substreamId: string | null;
  /** The message the link opens at: a mention's or a reply's in a Canvas's Chat. */
  message?: { turnId: string; sequence: number };
  /**
   * What the recipient can decide from the notice itself, each a link that
   * records the decision when it is opened: a Sidekick source request's
   * Approve and Decline. A sink that can draw buttons draws these in place of
   * its one link to `url`; push opens `url` as for every kind.
   */
  actions?: { label: string; url: string }[];
}

export type NoticeRendering =
  | { outcome: "pending" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "ready"; notice: Notice };

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

/** What a notice says, before it is linked. */
type NoticeWords = Omit<Notice, "url" | "workspaceId" | "recipientUserId" | "message"> & {
  artifactId?: string;
  /** The message to open at, where the event names one; kept only if the link takes it. */
  message?: { turnId: string; sequence: number };
};

/**
 * Render one intent as its notice, checked as delivery checks it: the
 * recipient is still a member and may still open what it is about (a
 * declined request excepted), and what it is about still has a link. One
 * rendering per kind, for every sink.
 */
export async function renderNotice(env: Env, workspace: WorkspaceStub, address: { workspaceId: string; recipientUserId: string; intentId: string }): Promise<NoticeRendering> {
  const raw = await workspace.readNotificationIntentForDelivery({ workspaceId: asWorkspaceId(address.workspaceId), intentId: address.intentId });
  if (!raw) return { outcome: "skipped", reason: "notification_intent_missing" };
  const row = WorkspaceNotificationIntentDeliverySchema.parse(raw);
  if (row.recipientUserId !== address.recipientUserId) throw new Error("notice_recipient_mismatch");
  const words = row.notificationKind === "needs_input" || row.notificationKind === "run_finished"
    ? await runNoticeWords(env, workspace, row)
    : row.notificationKind === "mention" || row.notificationKind === "participant_added"
    ? await personNoticeWords(env, row)
    : await parentNoticeWords(env, workspace, row);
  if ("outcome" in words) return words;
  const linked = await conversationLink(env, { region: env.AVALON_REGION, workspaceId: row.workspaceId, parentId: words.parentId,
    ...(words.artifactId ? { artifactId: words.artifactId } : {}), ...(words.message ? { message: words.message } : {}) });
  // A Thread, Breakout or Channel, which no surface opens any more, or a
  // parent that is gone: nothing to open, so nothing is sent.
  if (!linked.url) return { outcome: "skipped", reason: `conversation_not_linkable:${linked.kind ?? "missing"}` };
  const notice: Notice = {
    intentId: words.intentId, kind: words.kind, title: words.title, body: words.body, actorName: words.actorName,
    url: linked.url, workspaceId: row.workspaceId, recipientUserId: row.recipientUserId, parentId: words.parentId,
    substreamId: words.substreamId, ...(linked.message ? { message: linked.message } : {}),
    ...(words.actions ? { actions: words.actions } : {}),
  };
  return { outcome: "ready", notice };
}

/**
 * The message a link opens at, when the event names its turn and sequence;
 * a turn id that is not a UUID (no link form takes it) opens the parent.
 */
function messagePosition(turnId: string, sequence: number | undefined): { message?: { turnId: string; sequence: number } } {
  return sequence !== undefined && IdSchema.safeParse(turnId).success ? { message: { turnId, sequence } } : {};
}

/** A mention or an add: the conversation's own effect, checked as the processor checks it. */
async function personNoticeWords(env: Env, row: WorkspaceNotificationIntentDelivery): Promise<NoticeWords | Exclude<NoticeRendering, { outcome: "ready" }>> {
  const context = await notificationDeliveryContext(env, row);
  if (context.outcome !== "ready") return context.outcome === "pending" ? { outcome: "pending" } : { outcome: "skipped", reason: context.reason };
  const { effect, childId } = context;
  const words = effect.kind === "mention_notification"
    ? { title: `${effect.authorNameSnapshot} mentioned you in ${effect.workstreamTitleSnapshot}`, body: effect.messageText, actorName: effect.authorNameSnapshot }
    : { title: `${effect.actorNameSnapshot} added you to ${effect.workstreamTitleSnapshot}`, body: effect.workstreamObjectiveSnapshot ?? "", actorName: effect.actorNameSnapshot };
  return {
    intentId: row.intentId,
    kind: row.notificationKind as PushNotificationData["kind"],
    title: words.title,
    body: rewriteMessageAsPlainText(words.body, { sources: "none" }),
    actorName: words.actorName,
    parentId: row.workstreamId,
    substreamId: childId,
    // A mention in the Chat opens at its message; one recorded before the
    // effect carried its sequence, or in a run's conversation, opens the parent.
    ...(effect.kind === "mention_notification" && !childId ? messagePosition(effect.messageId, effect.transcriptSequence) : {}),
  };
}

/** What a run's notice says about the state it reached. */
const RUN_STATE_WORDS: Record<SidekickRunNotification["state"], string> = {
  needs_input: "needs your input", completed: "finished", failed: "failed", stopped: "stopped",
};

/** A Sidekick run's notice; its title is the Sidekick's name as the run saw it. */
async function runNoticeWords(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery): Promise<NoticeWords | Exclude<NoticeRendering, { outcome: "ready" }>> {
  const notice = SidekickRunNotificationSchema.parse(JSON.parse(row.payloadJson));
  const refused = await recipientRefused(env, workspace, row);
  if (refused) return refused;
  return {
    intentId: row.intentId,
    kind: row.notificationKind as PushNotificationData["kind"],
    title: `${notice.sidekickName} ${RUN_STATE_WORDS[notice.state]}`,
    body: rewriteMessageAsPlainText(notice.reply ?? "", { sources: "none" }),
    actorName: notice.sidekickName,
    parentId: row.workstreamId,
    substreamId: notice.runId,
  };
}

/**
 * Why a notice about a Canvas or Sidekick is not sent to this person now:
 * they are no longer an active member, its parent is gone, or it no longer
 * admits them (`unlisted` waives the last, for a notice about a Canvas they
 * were refused, or a Sidekick source request and its answer, which name the
 * Sidekick to someone who need not be able to open it). Null when it may be
 * sent.
 */
async function recipientRefused(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery,
  options: { unlisted?: boolean } = {}): Promise<Exclude<NoticeRendering, { outcome: "ready" }> | null> {
  const member = await workspaceRegionalDatabase(env).prepare(
    `SELECT 1 AS active FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  ).bind(row.workspaceId, row.recipientUserId).first<{ active: number }>();
  if (!member) return { outcome: "skipped", reason: "recipient_inactive_or_identity_missing" };
  const raw = await workspace.notificationDirectoryState({ workspaceId: row.workspaceId, workstreamId: row.workstreamId, userId: row.recipientUserId });
  const viewer = raw ? WorkspaceDirectoryNotificationStateSchema.parse(raw) : null;
  if (!viewer) return { outcome: "skipped", reason: "notification_parent_missing" };
  // A declined request is about a Canvas its requester may not open, by definition.
  if (!viewer.listable && !options.unlisted) return { outcome: "skipped", reason: "recipient_not_listable" };
  return null;
}

/** What a hosted parent's own notice says, from what was captured when it was recorded. */
function parentWords(notice: ParentNotice): { title: string; body: string; actorName: string } {
  switch (notice.kind) {
    case "new_message": return { title: `${notice.authorName} in ${notice.parentTitle}`, body: notice.text, actorName: notice.authorName };
    case "artifact_updated": return { title: `${notice.authorName} updated ${notice.artifactTitle} in ${notice.parentTitle}`, body: "", actorName: notice.authorName };
    case "access_request": return { title: `${notice.requesterName} asked to open ${notice.parentTitle}`, body: notice.message ?? "", actorName: notice.requesterName };
    case "access_granted": return { title: `${notice.deciderName} let you into ${notice.parentTitle}`, body: "", actorName: notice.deciderName };
    case "access_denied": return { title: `${notice.deciderName} declined your request to open a Canvas`, body: "", actorName: notice.deciderName };
    case "source_request": return { title: `${notice.requesterName} asked to use your ${notice.connectorName} for ${notice.parentTitle}`,
      body: sourceNoticeText(notice), actorName: notice.requesterName };
    case "source_approved": return { title: `${notice.personName} approved ${notice.parentTitle}'s use of their ${notice.connectorName}`,
      body: sourceNoticeText(notice), actorName: notice.personName };
    case "source_declined": return { title: `${notice.personName} declined ${notice.parentTitle}'s use of their ${notice.connectorName}`,
      body: sourceNoticeText(notice), actorName: notice.personName };
  }
}

/** A Sidekick source request and its two answers: the notices that name a Sidekick to someone who need not be able to open it. */
function aboutSource(notice: ParentNotice): boolean {
  return notice.kind === "source_request" || notice.kind === "source_approved" || notice.kind === "source_declined";
}

/**
 * The Approve and Decline links a source request's email carries. Without a
 * browser origin configured there is nowhere for them to open, so the notice
 * goes with its one link and the reason is logged by name.
 */
async function sourceRequestActions(env: Env, row: WorkspaceNotificationIntentDelivery, requestId: string): Promise<Pick<Notice, "actions">> {
  try {
    return { actions: await sourceDecisionActions(env, { workspaceId: row.workspaceId, sidekickId: row.workstreamId, requestId,
      userId: row.recipientUserId }) };
  } catch (error) {
    const refused = asApiError(error);
    if (!refused) throw error;
    logWarn(env, "source_decision_link_unavailable", { intent_id: row.intentId, code: refused.code });
    return {};
  }
}

/**
 * A reply, a pinned Canvas's new version, an access request, its grant or its
 * denial, a Sidekick source request or its answer, rendered from the notice
 * its parent captured. A new version opens its Canvas onto that artifact; a
 * source request carries the links that answer it.
 */
async function parentNoticeWords(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery): Promise<NoticeWords | Exclude<NoticeRendering, { outcome: "ready" }>> {
  const notice = ParentNoticeSchema.parse(JSON.parse(row.payloadJson));
  const refused = await recipientRefused(env, workspace, row, { unlisted: notice.kind === "access_denied" || aboutSource(notice) });
  if (refused) return refused;
  const words = parentWords(notice);
  return {
    intentId: row.intentId,
    kind: notice.kind,
    title: words.title,
    body: rewriteMessageAsPlainText(words.body, { sources: "none" }),
    actorName: words.actorName,
    // A source request opens the Canvas it was asked in, where its card is:
    // the Sidekick is closed to the person asked until they approve.
    parentId: notice.kind === "source_request" && notice.placeCanvasId ? notice.placeCanvasId : row.workstreamId,
    substreamId: notice.kind === "new_message" ? "0" : null,
    ...(notice.kind === "artifact_updated" ? { artifactId: notice.resourceId } : {}),
    ...(notice.kind === "new_message" ? messagePosition(notice.messageId, notice.messageSequence) : {}),
    ...(notice.kind === "source_request" ? await sourceRequestActions(env, row, notice.requestId) : {}),
  };
}

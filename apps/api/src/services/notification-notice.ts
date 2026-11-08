import { asWorkspaceId } from "@rally/contracts";
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
import { notificationDeliveryContext } from "./conversation-effect-service";
import { conversationLink } from "./conversation-link-service";
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
  /** The conversation's own email address, where a reply to the email continues it (a mention or an add). */
  replyTo: string | null;
}

export type NoticeRendering =
  | { outcome: "pending" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "ready"; notice: Notice };

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

/** What a notice says, before it is linked. */
type NoticeWords = Omit<Notice, "url" | "workspaceId" | "recipientUserId"> & { artifactId?: string };

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
  if (row.recipientUserId !== address.recipientUserId) throw new Error("Notice recipient mismatch");
  const words = row.notificationKind === "needs_input" || row.notificationKind === "run_finished"
    ? await runNoticeWords(env, workspace, row)
    : row.notificationKind === "mention" || row.notificationKind === "participant_added"
    ? await personNoticeWords(env, row)
    : await parentNoticeWords(env, workspace, row);
  if ("outcome" in words) return words;
  const linked = await conversationLink(env, { region: env.AVALON_REGION, workspaceId: row.workspaceId, parentId: words.parentId,
    ...(words.artifactId ? { artifactId: words.artifactId } : {}) });
  // A Thread, Breakout or Channel, which no surface opens any more, or a
  // parent that is gone: nothing to open, so nothing is sent.
  if (!linked.url) return { outcome: "skipped", reason: `conversation_not_linkable:${linked.kind ?? "missing"}` };
  const notice: Notice = {
    intentId: words.intentId, kind: words.kind, title: words.title, body: words.body, actorName: words.actorName,
    url: linked.url, workspaceId: row.workspaceId, recipientUserId: row.recipientUserId, parentId: words.parentId,
    substreamId: words.substreamId, replyTo: words.replyTo,
  };
  return { outcome: "ready", notice };
}

/** A mention or an add: the conversation's own effect, checked as the processor checks it. */
async function personNoticeWords(env: Env, row: WorkspaceNotificationIntentDelivery): Promise<NoticeWords | Exclude<NoticeRendering, { outcome: "ready" }>> {
  const context = await notificationDeliveryContext(env, row);
  if (context.outcome !== "ready") return context.outcome === "pending" ? { outcome: "pending" } : { outcome: "skipped", reason: context.reason };
  const { effect, childId, viewer } = context;
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
    replyTo: viewer.emailAddress?.trim() || null,
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
    replyTo: null,
  };
}

/**
 * Why a notice about a Canvas or Sidekick is not sent to this person now:
 * they are no longer an active member, its parent is gone, or it no longer
 * admits them (`unlisted` waives the last, for a notice about a Canvas they
 * were refused). Null when it may be sent.
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
  }
}

/**
 * A reply, a pinned Canvas's new version, an access request, its grant or its
 * denial, rendered from the notice its parent captured. A new version opens
 * its Canvas onto that artifact.
 */
async function parentNoticeWords(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery): Promise<NoticeWords | Exclude<NoticeRendering, { outcome: "ready" }>> {
  const notice = ParentNoticeSchema.parse(JSON.parse(row.payloadJson));
  const refused = await recipientRefused(env, workspace, row, { unlisted: notice.kind === "access_denied" });
  if (refused) return refused;
  const words = parentWords(notice);
  return {
    intentId: row.intentId,
    kind: notice.kind,
    title: words.title,
    body: rewriteMessageAsPlainText(words.body, { sources: "none" }),
    actorName: words.actorName,
    parentId: row.workstreamId,
    substreamId: notice.kind === "new_message" ? "0" : null,
    replyTo: null,
    ...(notice.kind === "artifact_updated" ? { artifactId: notice.resourceId } : {}),
  };
}

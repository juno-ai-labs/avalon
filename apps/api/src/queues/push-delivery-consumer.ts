import { notifyOps } from "../observability/ops-slack-notifier";
import { asWorkspaceId, WorkspaceAttentionSchema } from "@rally/contracts";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import { PushDeliveryMessageSchema, SidekickRunNotificationSchema, type PushDeliveryMessage, type PushNotificationData, type SidekickRunNotification } from "@rally/contracts/push-notifications";
import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { ParentNoticeSchema, WorkspaceNotificationIntentDeliverySchema, type ParentNotice, type WorkspaceNotificationIntentDelivery } from "../durable-objects/workspace-notification-intent-protocol";
import { WorkspaceDirectoryNotificationStateSchema } from "../durable-objects/workspace-directory-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ApiError } from "../lib/api-error";
import { logInfo, logWarn } from "../observability/logger";
import { notificationDeliveryContext } from "../services/conversation-effect-service";
import { pushEnabled } from "../services/push-delivery-service";
import { livePushDevices } from "../services/push-device-service";
import { sendApns, type ApnsOutcome } from "../services/push/apns-transport";
import type { PushDevice } from "../services/push-device-service";
import { renderPushPayload, renderWebPushPayload, pushCollapseId, type PushPayloads } from "../services/push/push-payload";
import { sendWebPush, WEB_PUSH_PAYLOAD_BYTES, type WebPushOutcome } from "../services/push/web-push-transport";
import { workspaceRegionalDatabase } from "../services/workspace-runtime-database";
import { conversationLink, type ConversationLink } from "../services/conversation-link-service";

/** One send per device, to the transport the device registered with. */
export type PushSend = (env: Env, device: PushDevice, payload: PushPayloads, collapseId: string) => Promise<ApnsOutcome | WebPushOutcome>;
const sendByTransport: PushSend = async (env, device, payload, collapseId) => {
  if (device.transport === "apns") return sendApns(env, device, payload.apns, collapseId);
  if (device.transport === "webpush") return sendWebPush(env, device, payload.web, collapseId);
  return { outcome: "rejected", reason: "unknown_transport" };
};

/**
 * A transport whose deployment credential the provider refused, with the
 * reason. Its devices wait for a retry; the other transport keeps sending.
 */
export type ProviderFaults = Map<PushDevice["transport"], string>;

/** What one push says and where it opens, or why it waits or sends nothing. */
type PushContent =
  | { outcome: "pending" }
  | { outcome: "skipped"; reason: string }
  | {
    outcome: "ready";
    /** What a receipt and the collapse id are keyed on, per workspace. */
    deliveryKey: string;
    kind: PushNotificationData["kind"];
    title: string;
    body: string;
    workstreamId: string;
    substreamId: string | null;
    /** The artifact the notification opens its Canvas onto, expanded. */
    artifactId?: string;
  };

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

/** A mention or an add: its notification intent, checked as the processor checks it. */
async function intentContent(env: Env, workspace: WorkspaceStub, message: PushDeliveryMessage & { intentId: string }): Promise<PushContent> {
  const raw = await workspace.readNotificationIntentForDelivery({ workspaceId: asWorkspaceId(message.workspaceId), intentId: message.intentId });
  if (!raw) return { outcome: "skipped", reason: "notification_intent_missing" };
  const row = WorkspaceNotificationIntentDeliverySchema.parse(raw);
  if (row.recipientUserId !== message.recipientUserId) throw new Error("Push recipient mismatch");
  if (row.notificationKind === "needs_input" || row.notificationKind === "run_finished") {
    return await runNoticeContent(env, workspace, row);
  }
  if (row.notificationKind !== "mention" && row.notificationKind !== "participant_added") {
    return await parentNoticeContent(env, workspace, row);
  }
  const context = await notificationDeliveryContext(env, row);
  if (context.outcome !== "ready") return context.outcome === "pending" ? { outcome: "pending" } : { outcome: "skipped", reason: context.reason };
  const { effect, childId } = context;
  return {
    outcome: "ready",
    deliveryKey: row.intentId,
    kind: row.notificationKind,
    title: effect.kind === "mention_notification"
      ? `${effect.authorNameSnapshot} mentioned you in ${effect.workstreamTitleSnapshot}`
      : `${effect.actorNameSnapshot} added you to ${effect.workstreamTitleSnapshot}`,
    body: rewriteMessageAsPlainText(
      effect.kind === "mention_notification" ? effect.messageText : effect.workstreamObjectiveSnapshot ?? "",
      { sources: "none" },
    ),
    workstreamId: row.workstreamId,
    substreamId: childId,
  };
}

/** What a run's push says about the state it reached. */
const RUN_STATE_WORDS: Record<SidekickRunNotification["state"], string> = {
  needs_input: "needs your input", completed: "finished", failed: "failed", stopped: "stopped",
};

/**
 * A Sidekick run's notice: whether the person may still open the Sidekick,
 * read now as a mention's recipient is, and what the run said when it got
 * there. The title is the Sidekick's name as the run saw it.
 */
async function runNoticeContent(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery): Promise<PushContent> {
  const notice = SidekickRunNotificationSchema.parse(JSON.parse(row.payloadJson));
  const refused = await recipientRefused(env, workspace, row);
  if (refused) return refused;
  return {
    outcome: "ready",
    deliveryKey: row.intentId,
    kind: row.notificationKind as PushNotificationData["kind"],
    title: `${notice.sidekickName} ${RUN_STATE_WORDS[notice.state]}`,
    body: rewriteMessageAsPlainText(notice.reply ?? "", { sources: "none" }),
    workstreamId: row.workstreamId,
    substreamId: notice.runId,
  };
}

/**
 * Why a notice about a Canvas or Sidekick is not sent to this person now:
 * they are no longer an active member, its parent is gone, or it no longer
 * admits them. Null when it may be sent.
 */
async function recipientRefused(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery): Promise<PushContent | null> {
  const member = await workspaceRegionalDatabase(env).prepare(
    `SELECT 1 AS active FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  ).bind(row.workspaceId, row.recipientUserId).first<{ active: number }>();
  if (!member) return { outcome: "skipped", reason: "recipient_inactive_or_identity_missing" };
  const raw = await workspace.notificationDirectoryState({ workspaceId: row.workspaceId, workstreamId: row.workstreamId, userId: row.recipientUserId });
  const viewer = raw ? WorkspaceDirectoryNotificationStateSchema.parse(raw) : null;
  if (!viewer) return { outcome: "skipped", reason: "notification_parent_missing" };
  if (!viewer.listable) return { outcome: "skipped", reason: "recipient_not_listable" };
  return null;
}

/** What a hosted parent's own notice says: its title and body, from what was captured when it was recorded. */
function parentNoticeWords(notice: ParentNotice): { title: string; body: string } {
  switch (notice.kind) {
    case "new_message": return { title: `${notice.authorName} in ${notice.parentTitle}`, body: notice.text };
    case "artifact_updated": return { title: `${notice.authorName} updated ${notice.artifactTitle} in ${notice.parentTitle}`, body: "" };
    case "access_request": return { title: `${notice.requesterName} asked to open ${notice.parentTitle}`, body: notice.message ?? "" };
    case "access_granted": return { title: `${notice.deciderName} let you into ${notice.parentTitle}`, body: "" };
  }
}

/**
 * A reply, a pinned Canvas's new version, an access request or its grant:
 * checked as a run notice is, and rendered from the notice its parent
 * captured. A new version opens its Canvas onto that artifact.
 */
async function parentNoticeContent(env: Env, workspace: WorkspaceStub, row: WorkspaceNotificationIntentDelivery): Promise<PushContent> {
  const notice = ParentNoticeSchema.parse(JSON.parse(row.payloadJson));
  const refused = await recipientRefused(env, workspace, row);
  if (refused) return refused;
  const words = parentNoticeWords(notice);
  return {
    outcome: "ready",
    deliveryKey: row.intentId,
    kind: notice.kind,
    title: words.title,
    body: rewriteMessageAsPlainText(words.body, { sources: "none" }),
    workstreamId: row.workstreamId,
    substreamId: notice.kind === "new_message" ? "0" : null,
    ...(notice.kind === "artifact_updated" ? { artifactId: notice.resourceId } : {}),
  };
}

/**
 * Where a delivery links: the Canvas whose Chat it is about, or the Sidekick
 * whose conversation or run it is about. Null for a Thread, Breakout or
 * Channel, which no surface opens any more: such a delivery is skipped, named
 * `conversation_not_linkable`, rather than sent to open nothing.
 */
async function contentUrl(env: Env, workspaceId: string, content: Extract<PushContent, { outcome: "ready" }>): Promise<ConversationLink> {
  return await conversationLink(env, { region: env.AVALON_REGION, workspaceId, parentId: content.workstreamId,
    ...(content.artifactId ? { artifactId: content.artifactId } : {}) });
}

export async function deliverPush(
  env: Env,
  message: PushDeliveryMessage,
  send: PushSend = sendByTransport,
  faults: ProviderFaults = new Map(),
): Promise<boolean> {
  if (message.region !== env.AVALON_REGION) throw new Error("Push queue region mismatch");
  // An Activity row's push, email or connector delivery, queued before the
  // Activity feed was retired (plan step C-2): nothing reads it back now.
  if (!("intentId" in message)) {
    logInfo(env, "push_delivery_skipped", { activity_item_id: message.activityItemId, channel: message.channel ?? "push",
      reason: "activity_item_retired" });
    return true;
  }
  if (!await pushEnabled(env, { userId: message.recipientUserId, workspaceId: message.workspaceId })) return true;
  const id = asWorkspaceId(message.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
  const content = await intentContent(env, workspace, message);
  const pointer = message.intentId;
  if (content.outcome === "pending") return false;
  if (content.outcome === "skipped") {
    logInfo(env, "push_delivery_skipped", { intent_id: pointer, reason: content.reason });
    return true;
  }
  // Every kind, mentions and adds included: a choice changed since this was
  // queued holds too.
  if (!await workspace.notificationAllows({ workspaceId: id, userId: message.recipientUserId, kind: content.kind,
    channel: "push" })) {
    logInfo(env, "push_delivery_skipped", { intent_id: pointer, reason: "push_preference_off" });
    return true;
  }
  const linked = await contentUrl(env, message.workspaceId, content);
  if (!linked.url) {
    logInfo(env, "push_delivery_skipped", { intent_id: pointer, reason: "conversation_not_linkable", parent_kind: linked.kind ?? "missing" });
    return true;
  }
  const url = linked.url;
  // The badge counts what this person's sidebar lists, and a guest's lists less.
  const member = await workspaceRegionalDatabase(env).prepare(`SELECT access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .bind(message.workspaceId, message.recipientUserId).first<{ access_class: "member" | "guest" }>();
  const attention = WorkspaceAttentionSchema.parse(await workspace.attention({
    workspaceId: id, userId: message.recipientUserId, accessClass: member?.access_class ?? "member",
  }));
  const data = { v: 1 as const, kind: content.kind, region: env.AVALON_REGION, workspaceId: message.workspaceId, url };
  // A reply replaces the alert before it about the same conversation, and a
  // pinned Canvas's new version the one before it about that Canvas; every
  // other kind keeps its own.
  const collapseId = await pushCollapseId(message.workspaceId, content.kind === "new_message" ? `conversation:${content.workstreamId}:${content.substreamId ?? "0"}`
    : content.kind === "artifact_updated" ? `artifacts:${content.workstreamId}` : content.deliveryKey);
  const { title, body } = content;
  const payload: PushPayloads = {
    apns: renderPushPayload({ title, body, threadKey: content.workstreamId, badge: attention.readerAttentionCount, data }),
    web: renderWebPushPayload({ title, body, collapseId, data, badge: attention.readerAttentionCount, maxBytes: WEB_PUSH_PAYLOAD_BYTES }),
  };
  const row = { workspaceId: message.workspaceId, recipientUserId: message.recipientUserId, intentId: content.deliveryKey };
  const db = workspaceRegionalDatabase(env);
  const devices = await livePushDevices(env, row.recipientUserId);
  if (!devices.length) logInfo(env, "push_delivery_skipped", { intent_id: row.intentId, reason: "no_live_devices" });
  let complete = true;
  for (const device of devices) {
    const receipt = await db.prepare(`SELECT 1 FROM push_delivery_receipts WHERE workspace_id = ? AND intent_id = ? AND device_id = ?`)
      .bind(row.workspaceId, row.intentId, device.id).first();
    if (receipt) continue;
    // A refused credential fails every device on that transport alike.
    if (faults.has(device.transport)) { complete = false; continue; }
    const result = await send(env, device, payload, collapseId);
    const at = new Date().toISOString();
    if (result.outcome === "sent") {
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO push_delivery_receipts VALUES (?, ?, ?, ?)`).bind(row.workspaceId, row.intentId, device.id, at),
        db.prepare(`UPDATE user_push_devices SET last_delivery_at = ?, last_failure_code = NULL WHERE id = ?`).bind(at, device.id),
      ]);
    } else if (result.outcome === "bad_token" || (result.outcome === "unregistered" && (device.transport === "webpush"
      // A browser subscription the push service has dropped never comes back; APNs dates its answer.
      || ("timestamp" in result && result.timestamp !== undefined && result.timestamp >= Date.parse(device.last_seen_at))))) {
      await db.prepare(`UPDATE user_push_devices SET disabled_at = ?, disabled_reason = ? WHERE id = ? AND token = ? AND last_seen_at = ?`)
        .bind(at, result.outcome, device.id, device.token, device.last_seen_at).run();
    } else if (["transient", "provider_auth_failed", "provider_token_throttled"].includes(result.outcome)) complete = false;
    if (result.outcome === "provider_auth_failed" || result.outcome === "provider_token_throttled") {
      faults.set(device.transport, result.reason ?? result.outcome);
    }
    if (result.outcome !== "sent" && result.outcome !== "skipped") {
      await db.prepare(`UPDATE user_push_devices SET last_failure_code = ? WHERE id = ? AND token = ?`)
        .bind(result.reason ?? result.outcome, device.id, device.token).run();
    }
    logInfo(env, "push_delivery_terminal", { intent_id: row.intentId, device_id: device.id, ...result });
  }
  return complete;
}
/**
 * Once a transport's credential is refused, the rest of the batch skips that
 * transport's devices and retries those messages; the other transport's
 * devices are still sent. One ops notice per refused transport.
 */
export async function consumePushDeliveryQueue(batch: MessageBatch<unknown>, env: Env, send: PushSend = sendByTransport): Promise<void> {
  const faults: ProviderFaults = new Map();
  for (const message of batch.messages) {
    try {
      if (await deliverPush(env, PushDeliveryMessageSchema.parse(message.body), send, faults)) message.ack();
      else message.retry();
    } catch (error) {
      // The queue carries email and Slack too, so the failure names its channel and its code.
      const permanent = error instanceof ApiError && error.details?.retryable === false;
      logWarn(env, "push_delivery_failed", {
        message_id: message.id,
        channel: (message.body as { channel?: unknown } | null)?.channel ?? "push",
        code: error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown_error",
        permanent,
      });
      // A provider that refused the message outright will refuse it again.
      if (permanent) message.ack();
      else message.retry();
    }
  }
  for (const [transport, reason] of faults) await notifyOps(env, {
    event: "push_provider_auth_failed",
    summary: transport === "apns" ? "APNs provider authentication needs attention (the APNs key)." : "Web Push authentication needs attention (the VAPID key).",
    fields: { transport, reason },
  });
}

import { notifyOps } from "../observability/ops-slack-notifier";
import { asUserId, asWorkspaceId, WorkspaceAttentionSchema } from "@rally/contracts";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import { PushDeliveryMessageSchema, type PushDeliveryMessage, type PushNotificationData } from "@rally/contracts/push-notifications";
import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { WorkspaceNotificationIntentDeliverySchema } from "../durable-objects/workspace-notification-intent-protocol";
import { WorkspaceActivityPushReadResultSchema } from "../durable-objects/workspace-space-protocol";
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
import { sendActivityEmail } from "../services/activity-email-service";
import { sendWorkstreamActivitySlack } from "../services/slack-notification-service";

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

/**
 * Any other Activity row, read back through the feed now, so a row the person
 * has read or lost since it was queued sends nothing. Worded as the sidebar
 * words it.
 */
async function activityContent(env: Env, workspace: WorkspaceStub, message: Extract<PushDeliveryMessage, { activityItemId: string }>): Promise<PushContent> {
  const item = WorkspaceActivityPushReadResultSchema.parse(await workspace.readActivityItemForPush({
    workspaceId: asWorkspaceId(message.workspaceId), userId: asUserId(message.recipientUserId), itemId: message.activityItemId, channel: message.channel ?? "push",
  }));
  if (!item) return { outcome: "skipped", reason: "activity_item_not_pending" };
  const actor = item.actorUserId === null ? item.actorLabel
    : (await workspaceRegionalDatabase(env).prepare(`SELECT name FROM users WHERE id = ?`)
      .bind(item.actorUserId).first<{ name: string | null }>())?.name?.trim() || "Someone";
  // A merge from a thread this person cannot open names no thread.
  const thread = item.mergedInto?.threadPrivate ? PRIVATE_THREAD : item.threadTitle.trim() || UNNAMED_THREAD;
  const breakout = item.breakout ? item.breakout.title.trim() || UNNAMED_BREAKOUT : null;
  const words = item.kind === "thread_started" ? { title: `${actor} started ${thread}`, body: "" }
    : item.kind === "breakout_started" ? { title: `${actor} started a breakout on ${thread}`, body: breakout ?? "" }
    : item.kind === "new_message" ? { title: `${actor} replied in ${breakout ?? thread}`, body: item.preview ?? "" }
    : item.kind === "merged" ? mergedWords(actor, thread, breakout, item.mergedInto?.name)
    : item.kind === "artifact_updated" ? { title: `${actor || "Someone"} updated ${item.artifact?.title.trim() || "an artifact"}`, body: `in ${thread}` }
    : { title: `${actor} finished ${breakout ?? thread}`, body: breakout ? `in ${thread}` : "" };
  return {
    outcome: "ready",
    deliveryKey: `activity:${item.kind === "new_message" ? message.activityItemId : item.id}`,
    kind: item.kind as PushNotificationData["kind"],
    ...words,
    workstreamId: item.threadId,
    // A merge opens where it landed: a breakout's merge is in its thread.
    substreamId: item.kind === "merged" ? null : item.breakout?.substreamId ?? null,
    // A pinned artifact's update opens the artifact, not just its Canvas.
    ...(item.kind === "artifact_updated" && item.artifact ? { artifactId: item.artifact.resourceId } : {}),
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

/** "Maya merged Sequence B into Q3 plan", or "Maya merged Q3 plan into GTM". */
function mergedWords(actor: string, thread: string, breakout: string | null, channel: string | undefined): { title: string; body: string } {
  if (breakout !== null) return { title: `${actor} merged ${breakout} into ${thread}`, body: "" };
  return { title: `${actor} merged ${thread} into ${channel?.trim() || "a channel"}`, body: "" };
}
const UNNAMED_THREAD = "Untitled thread";
const PRIVATE_THREAD = "a private thread";
const UNNAMED_BREAKOUT = "Untitled breakout";

/**
 * An Activity row by email or a connector's surface, for a person who chose
 * that for its kind. Read back and checked as a push is, so a row read or a
 * choice changed since it was queued sends nothing. The provider's own
 * idempotency key is the receipt: a retry sends the same message once.
 */
async function deliverActivityElsewhere(
  env: Env,
  workspace: WorkspaceStub,
  message: PushDeliveryMessage & { activityItemId: string; channel: NonNullable<ActivityChannel> },
  senders: ActivitySenders,
): Promise<boolean> {
  const content = await activityContent(env, workspace, message);
  if (content.outcome === "pending") return false;
  if (content.outcome === "skipped") {
    logInfo(env, "activity_delivery_skipped", { activity_item_id: message.activityItemId, channel: message.channel, reason: content.reason });
    return true;
  }
  const ready = content;
  if (!await workspace.notificationAllows({ workspaceId: asWorkspaceId(message.workspaceId), userId: message.recipientUserId,
    kind: ready.kind, channel: message.channel })) {
    logInfo(env, "activity_delivery_skipped", { activity_item_id: message.activityItemId, channel: message.channel, reason: "channel_not_chosen" });
    return true;
  }
  const linked = await contentUrl(env, message.workspaceId, ready);
  if (!linked.url) {
    logInfo(env, "activity_delivery_skipped", { activity_item_id: message.activityItemId, channel: message.channel,
      reason: "conversation_not_linkable", parent_kind: linked.kind ?? "missing" });
    return true;
  }
  const url: string = linked.url;
  const identity = await workspaceRegionalDatabase(env).prepare(
    `SELECT u.email AS email, w.name AS workspace_name
       FROM workspace_members m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'active'`,
  ).bind(message.workspaceId, message.recipientUserId).first<{ email: string; workspace_name: string }>();
  if (!identity) {
    logInfo(env, "activity_delivery_skipped", { activity_item_id: message.activityItemId, channel: message.channel, reason: "recipient_inactive" });
    return true;
  }
  const claim = content.kind === "new_message" || content.kind === "run_finished" ? {
    workspaceId: asWorkspaceId(message.workspaceId), userId: asUserId(message.recipientUserId),
    threadId: content.workstreamId, substreamId: content.substreamId, itemId: message.activityItemId,
    channel: message.channel, claimId: crypto.randomUUID(),
  } : null;
  if (claim) {
    const decision = await workspace.claimActivityAlert(claim);
    if (decision !== "claimed") return decision !== "busy";
  }
  try {
    const outcome = await sendElsewhere(message.channel);
    if (outcome === "sent" && (content.kind === "new_message" || content.kind === "run_finished")) {
      await workspace.recordActivityAlert({ workspaceId: asWorkspaceId(message.workspaceId), userId: asUserId(message.recipientUserId),
        threadId: content.workstreamId, substreamId: content.substreamId, itemId: message.activityItemId, channel: message.channel });
    }
    logInfo(env, "activity_delivery_terminal", { activity_item_id: message.activityItemId, channel: message.channel, outcome });
    return true;
  } finally {
    if (claim) await workspace.releaseActivityAlert(claim);
  }

  // Exhaustive over the channel: a connector surface added to the contract
  // without a sender here fails to compile rather than going out as another.
  async function sendElsewhere(channel: NonNullable<ActivityChannel>) {
    switch (channel) {
      case "email": return senders.email(env, {
        itemId: message.activityItemId,
        recipientUserId: message.recipientUserId,
        recipientEmail: identity!.email,
        workspaceName: identity!.workspace_name,
        title: ready.title,
        body: ready.body,
        url,
        region: env.AVALON_REGION,
      });
      case "slack_agent_dm": return senders.slack(env, {
        itemId: message.activityItemId,
        recipientUserId: message.recipientUserId,
        recipientEmail: identity!.email,
        workspaceId: message.workspaceId,
        workspaceName: identity!.workspace_name,
        workstreamId: ready.workstreamId,
        ...(ready.substreamId ? { substreamId: ready.substreamId } : {}),
        url,
        title: ready.title,
        body: ready.body,
      });
      default: {
        const unknown: never = channel;
        throw new Error(`activity_channel_unsupported:${String(unknown)}`);
      }
    }
  }
}
type ActivityChannel = Extract<PushDeliveryMessage, { activityItemId: string }>["channel"];
/** The providers an Activity row is sent through when it is not a push. */
export interface ActivitySenders {
  email: typeof sendActivityEmail;
  slack: typeof sendWorkstreamActivitySlack;
}
const activitySenders: ActivitySenders = { email: sendActivityEmail, slack: sendWorkstreamActivitySlack };

export async function deliverPush(
  env: Env,
  message: PushDeliveryMessage,
  send: PushSend = sendByTransport,
  faults: ProviderFaults = new Map(),
  senders: ActivitySenders = activitySenders,
): Promise<boolean> {
  if (message.region !== env.AVALON_REGION) throw new Error("Push queue region mismatch");
  if ("activityItemId" in message && message.channel) {
    const id = asWorkspaceId(message.workspaceId);
    const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
    return deliverActivityElsewhere(env, workspace, { ...message, channel: message.channel }, senders);
  }
  if (!await pushEnabled(env, { userId: message.recipientUserId, workspaceId: message.workspaceId })) return true;
  const id = asWorkspaceId(message.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
  const content = "intentId" in message
    ? await intentContent(env, workspace, message)
    : await activityContent(env, workspace, message);
  const pointer = "intentId" in message ? message.intentId : message.activityItemId;
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
  const collapseId = await pushCollapseId(message.workspaceId, content.kind === "new_message" ? `conversation:${content.workstreamId}:${content.substreamId ?? "0"}` : content.deliveryKey);
  const { title, body } = content;
  const payload: PushPayloads = {
    apns: renderPushPayload({ title, body, threadKey: content.workstreamId, badge: attention.readerAttentionCount, data }),
    web: renderWebPushPayload({ title, body, collapseId, data, badge: attention.readerAttentionCount, maxBytes: WEB_PUSH_PAYLOAD_BYTES }),
  };
  const row = { workspaceId: message.workspaceId, recipientUserId: message.recipientUserId, intentId: content.deliveryKey };
  const db = workspaceRegionalDatabase(env);
  const devices = await livePushDevices(env, row.recipientUserId);
  if (!devices.length) logInfo(env, "push_delivery_skipped", { intent_id: row.intentId, reason: "no_live_devices" });
  const claim = devices.length > 0 && "activityItemId" in message && (content.kind === "new_message" || content.kind === "run_finished") ? {
    workspaceId: id, userId: asUserId(message.recipientUserId), threadId: content.workstreamId,
    substreamId: content.substreamId, itemId: message.activityItemId, channel: "push" as const, claimId: crypto.randomUUID(),
  } : null;
  if (claim) {
    const decision = await workspace.claimActivityAlert(claim);
    if (decision !== "claimed") return decision !== "busy";
  }
  try {
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
        if ("activityItemId" in message && (content.kind === "new_message" || content.kind === "run_finished")) {
          await workspace.recordActivityAlert({ workspaceId: id, userId: asUserId(message.recipientUserId),
            threadId: content.workstreamId, substreamId: content.substreamId, itemId: message.activityItemId, channel: "push" });
        }
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
  } finally {
    if (claim) await workspace.releaseActivityAlert(claim);
  }
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

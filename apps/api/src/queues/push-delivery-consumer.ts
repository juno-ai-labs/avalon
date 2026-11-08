import { notifyOps } from "../observability/ops-slack-notifier";
import { asWorkspaceId, WorkspaceAttentionSchema } from "@rally/contracts";
import { PushDeliveryMessageSchema, type PushDeliveryMessage } from "@rally/contracts/push-notifications";
import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ApiError } from "../lib/api-error";
import { logInfo, logWarn } from "../observability/logger";
import { renderNotice, type Notice } from "../services/notification-notice";
import { sendNoticeEmail } from "../services/notice-email";
import { pushEnabled } from "../services/push-delivery-service";
import { livePushDevices } from "../services/push-device-service";
import { sendApns, type ApnsOutcome } from "../services/push/apns-transport";
import type { PushDevice } from "../services/push-device-service";
import { renderPushPayload, renderWebPushPayload, pushCollapseId, type PushPayloads } from "../services/push/push-payload";
import { sendWebPush, WEB_PUSH_PAYLOAD_BYTES, type WebPushOutcome } from "../services/push/web-push-transport";
import { workspaceRegionalDatabase } from "../services/workspace-runtime-database";

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

/**
 * One queue message: render its intent once as a channel-neutral notice
 * (`renderNotice`), then hand it to the sink the message names, after the
 * person's choice for that kind and channel. Answers whether the message is
 * done (false: retry it).
 */
export async function deliverPush(
  env: Env,
  message: PushDeliveryMessage,
  send: PushSend = sendByTransport,
  faults: ProviderFaults = new Map(),
  sendEmail: typeof sendNoticeEmail = sendNoticeEmail,
): Promise<boolean> {
  if (message.region !== env.AVALON_REGION) throw new Error("Push queue region mismatch");
  // An Activity row's push, email or connector delivery, queued before the
  // Activity feed was retired (plan step C-2): nothing reads it back now.
  if (!("intentId" in message)) {
    logInfo(env, "push_delivery_skipped", { activity_item_id: message.activityItemId, channel: message.channel ?? "push",
      reason: "activity_item_retired" });
    return true;
  }
  const channel = message.channel ?? "push";
  if (channel === "push" && !await pushEnabled(env, { userId: message.recipientUserId, workspaceId: message.workspaceId })) return true;
  const id = asWorkspaceId(message.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
  const rendered = await renderNotice(env, workspace, message);
  const pointer = message.intentId;
  if (rendered.outcome === "pending") return false;
  if (rendered.outcome === "skipped") {
    logInfo(env, channel === "push" ? "push_delivery_skipped" : "notification_email_skipped", { intent_id: pointer, reason: rendered.reason });
    return true;
  }
  const notice = rendered.notice;
  // Every kind: a choice changed since this was queued holds too.
  if (!await workspace.notificationAllows({ workspaceId: id, userId: message.recipientUserId, kind: notice.kind, channel })) {
    logInfo(env, channel === "push" ? "push_delivery_skipped" : "notification_email_skipped",
      { intent_id: pointer, reason: `${channel}_preference_off` });
    return true;
  }
  if (channel === "email") {
    const sent = await sendEmail(env, notice);
    logInfo(env, sent.outcome === "sent" ? "notification_email_sent" : "notification_email_skipped", {
      intent_id: pointer, kind: notice.kind,
      reason: sent.outcome === "sent" ? "provider_accepted" : "reason" in sent ? sent.reason : "transport_disabled_for_environment",
    });
    return true;
  }
  return await sendPushNotice(env, workspace, notice, send, faults);
}

/** The push sink: the notice as each device's transport renders it, once per device. */
async function sendPushNotice(env: Env, workspace: DurableObjectStub<WorkspaceDO>, notice: Notice, send: PushSend,
  faults: ProviderFaults): Promise<boolean> {
  const id = asWorkspaceId(notice.workspaceId);
  // The badge counts what this person's sidebar lists, and a guest's lists less.
  const member = await workspaceRegionalDatabase(env).prepare(`SELECT access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .bind(notice.workspaceId, notice.recipientUserId).first<{ access_class: "member" | "guest" }>();
  const attention = WorkspaceAttentionSchema.parse(await workspace.attention({
    workspaceId: id, userId: notice.recipientUserId, accessClass: member?.access_class ?? "member",
  }));
  const data = { v: 1 as const, kind: notice.kind, region: env.AVALON_REGION, workspaceId: notice.workspaceId, url: notice.url };
  // A reply replaces the alert before it about the same conversation, and a
  // pinned Canvas's new version the one before it about that Canvas; every
  // other kind keeps its own.
  const collapseId = await pushCollapseId(notice.workspaceId, notice.kind === "new_message" ? `conversation:${notice.parentId}:${notice.substreamId ?? "0"}`
    : notice.kind === "artifact_updated" ? `artifacts:${notice.parentId}` : notice.intentId);
  const { title, body } = notice;
  const payload: PushPayloads = {
    apns: renderPushPayload({ title, body, threadKey: notice.parentId, badge: attention.readerAttentionCount, data }),
    web: renderWebPushPayload({ title, body, collapseId, data, badge: attention.readerAttentionCount, maxBytes: WEB_PUSH_PAYLOAD_BYTES }),
  };
  const row = { workspaceId: notice.workspaceId, recipientUserId: notice.recipientUserId, intentId: notice.intentId };
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
      // The queue carries email too, so the failure names its channel and its code.
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

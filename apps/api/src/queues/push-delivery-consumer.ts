import { asWorkspaceId } from "@rally/contracts";
import { PushDeliveryMessageSchema, type PushDeliveryMessage } from "@rally/contracts/push-notifications";
import { workstreamCanonicalUrl } from "@rally/contracts/workstream-links";
import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceNotificationIntentDeliverySchema } from "../durable-objects/workspace-notification-intent-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import { notificationDeliveryContext } from "../services/conversation-effect-service";
import { pushEnabled } from "../services/push-delivery-service";
import { livePushDevices } from "../services/push-device-service";
import { sendApns } from "../services/push/apns-transport";
import { renderPushPayload, pushCollapseId } from "../services/push/push-payload";
import { workspaceRegionalDatabase } from "../services/workspace-runtime-database";

export async function deliverPush(env: Env, message: PushDeliveryMessage, send: typeof sendApns = sendApns): Promise<boolean> {
  if (message.region !== env.AVALON_REGION) throw new Error("Push queue region mismatch");
  if (!await pushEnabled(env, { userId: message.recipientUserId, workspaceId: message.workspaceId })) return true;
  const id = asWorkspaceId(message.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
  const raw = await workspace.readNotificationIntentForDelivery({ workspaceId: id, intentId: message.intentId });
  if (!raw) return true;
  const row = WorkspaceNotificationIntentDeliverySchema.parse(raw);
  if (row.recipientUserId !== message.recipientUserId) throw new Error("Push recipient mismatch");
  const context = await notificationDeliveryContext(env, row);
  if (context.outcome === "pending") return false;
  if (context.outcome === "skipped") {
    logInfo(env, "push_delivery_skipped", { intent_id: row.intentId, reason: context.reason });
    return true;
  }
  const { effect, childId } = context;
  const title = effect.kind === "mention_notification"
    ? `${effect.authorNameSnapshot} mentioned you in ${effect.workstreamTitleSnapshot}`
    : `${effect.actorNameSnapshot} added you to ${effect.workstreamTitleSnapshot}`;
  const body = effect.kind === "mention_notification" ? effect.messageText : effect.workstreamObjectiveSnapshot ?? "";
  const payload = renderPushPayload({ title, body, threadKey: childId ?? row.workstreamId, data: {
    v: 1, kind: row.notificationKind, region: env.AVALON_REGION, workspaceId: row.workspaceId,
    url: workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, { region: env.AVALON_REGION, workspaceId: row.workspaceId,
      workstreamId: row.workstreamId, ...(childId ? { substreamId: childId } : {}) }),
  } });
  const db = workspaceRegionalDatabase(env);
  const collapseId = await pushCollapseId(row.workspaceId, row.intentId);
  const devices = await livePushDevices(env, row.recipientUserId);
  if (!devices.length) logInfo(env, "push_delivery_skipped", { intent_id: row.intentId, reason: "no_live_devices" });
  let complete = true;
  for (const device of devices) {
    const receipt = await db.prepare(`SELECT 1 FROM push_delivery_receipts WHERE workspace_id = ? AND intent_id = ? AND device_id = ?`)
      .bind(row.workspaceId, row.intentId, device.id).first();
    if (receipt) continue;
    const result = await send(env, device, payload, collapseId);
    const at = new Date().toISOString();
    if (result.outcome === "sent") {
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO push_delivery_receipts VALUES (?, ?, ?, ?)`).bind(row.workspaceId, row.intentId, device.id, at),
        db.prepare(`UPDATE user_push_devices SET last_delivery_at = ?, last_failure_code = NULL WHERE id = ?`).bind(at, device.id),
      ]);
    } else if (result.outcome === "bad_token" || (result.outcome === "unregistered" && result.timestamp !== undefined && result.timestamp >= Date.parse(device.last_seen_at))) {
      await db.prepare(`UPDATE user_push_devices SET disabled_at = ?, disabled_reason = ? WHERE id = ? AND token = ? AND last_seen_at = ?`)
        .bind(at, result.outcome, device.id, device.token, device.last_seen_at).run();
    } else if (["transient", "provider_auth_failed", "provider_token_throttled"].includes(result.outcome)) complete = false;
    if (result.outcome !== "sent" && result.outcome !== "skipped") {
      await db.prepare(`UPDATE user_push_devices SET last_failure_code = ? WHERE id = ? AND token = ?`)
        .bind(result.reason ?? result.outcome, device.id, device.token).run();
    }
    logInfo(env, "push_delivery_terminal", { intent_id: row.intentId, device_id: device.id, ...result });
  }
  return complete;
}
export async function consumePushDeliveryQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (await deliverPush(env, PushDeliveryMessageSchema.parse(message.body))) message.ack();
      else message.retry();
    } catch {
      logWarn(env, "push_delivery_failed", { message_id: message.id });
      message.retry();
    }
  }
}

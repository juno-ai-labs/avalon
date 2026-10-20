import type { PushDeliveryMessage } from "@rally/contracts/push-notifications";
import type { Env } from "../env";
import { resolvePushNotificationsEnabled } from "./client-feature-flags";
import { livePushDevices } from "./push-device-service";
import { pushAvailable } from "./push/apns-transport";
import { webPushAvailable } from "./push/web-push-transport";

export async function pushEnabled(env: Env, subject: { userId: string; workspaceId: string }): Promise<boolean> {
  return resolvePushNotificationsEnabled(env, subject);
}
/** Enqueued only when a live device's own transport can send from this deployment. */
export async function enqueuePushDelivery(env: Env, message: PushDeliveryMessage, delaySeconds = 0): Promise<boolean> {
  if (!env.PUSH_DELIVERY_QUEUE || (!pushAvailable(env) && !webPushAvailable(env))
    || !await pushEnabled(env, { userId: message.recipientUserId, workspaceId: message.workspaceId })) return false;
  const devices = await livePushDevices(env, message.recipientUserId);
  if (!devices.some((device) => device.transport === "webpush" ? webPushAvailable(env) : pushAvailable(env))) return false;
  await env.PUSH_DELIVERY_QUEUE.send(message, { delaySeconds });
  return true;
}

/**
 * An Activity row for a channel other than push: queued on the same queue,
 * whose consumer reads it back and sends it. Push availability does not
 * gate it; only the queue's own binding does.
 */
export async function enqueueActivityDelivery(
  env: Env,
  message: PushDeliveryMessage & { activityItemId: string; channel: NonNullable<Extract<PushDeliveryMessage, { activityItemId: string }>["channel"]> },
  delaySeconds = 0,
): Promise<boolean> {
  if (!env.PUSH_DELIVERY_QUEUE) return false;
  await env.PUSH_DELIVERY_QUEUE.send(message, { delaySeconds });
  return true;
}

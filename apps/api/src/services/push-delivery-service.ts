import type { NotificationChannel } from "@rally/contracts";
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
 * Queue one recorded notice for each sink its recipient chose: a push when
 * one of their devices can take it (`enqueuePushDelivery`), and an email.
 * The consumer reads the choice again before sending, so a change made since
 * this ran still holds; this read only saves queueing what nobody chose.
 * Answers whether anything was queued.
 */
export async function enqueueNotice(
  env: Env,
  address: { workspaceId: string; recipientUserId: string; intentId: string },
  channels: readonly NotificationChannel[],
): Promise<boolean> {
  const message = { region: env.AVALON_REGION, ...address };
  const push = channels.includes("push") && await enqueuePushDelivery(env, message);
  const email = channels.includes("email") && env.PUSH_DELIVERY_QUEUE !== undefined;
  if (email) await env.PUSH_DELIVERY_QUEUE!.send({ ...message, channel: "email" } satisfies PushDeliveryMessage);
  return push || email;
}

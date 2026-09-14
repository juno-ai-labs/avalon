import type { PushDeliveryMessage } from "@rally/contracts/push-notifications";
import type { Env } from "../env";
import { resolvePushNotificationsEnabled } from "./client-feature-flags";
import { livePushDevices } from "./push-device-service";
import { pushConfigured } from "./push/apns-transport";

export async function pushEnabled(env: Env, subject: { userId: string; workspaceId: string }): Promise<boolean> {
  return resolvePushNotificationsEnabled(env, subject);
}
export async function enqueuePushDelivery(env: Env, message: PushDeliveryMessage): Promise<boolean> {
  if (!env.PUSH_DELIVERY_QUEUE || !pushConfigured(env)
    || !await pushEnabled(env, { userId: message.recipientUserId, workspaceId: message.workspaceId })
    || !(await livePushDevices(env, message.recipientUserId)).length) return false;
  await env.PUSH_DELIVERY_QUEUE.send(message);
  return true;
}

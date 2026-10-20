import { PUSH_BODY_PREVIEW_CHARACTERS, type PushNotificationData } from "@rally/contracts/push-notifications";

// APNs regular alert payload ceiling, Apple Sending notification requests.
export const APNS_PAYLOAD_BYTES = 4096;
/** The rendered alert for each transport; a device is sent the one it registered for. */
export interface PushPayloads { apns: string; web: string }
export function renderPushPayload(input: {
  title: string; body: string; threadKey: string; data: PushNotificationData; badge: number;
}): string {
  const characters = Array.from(input.body);
  const title = Array.from(input.title);
  let titleLength = title.length;
  const encode = (length: number) => JSON.stringify({
    aps: { alert: { title: title.slice(0, titleLength).join("") + (titleLength < title.length ? "…" : ""), body: characters.slice(0, length).join("") + (length < characters.length ? "…" : "") },
      badge: input.badge, "thread-id": input.threadKey, sound: "default" },
    rally: input.data,
  });
  let length = Math.min(characters.length, PUSH_BODY_PREVIEW_CHARACTERS);
  while (length > 0 && new TextEncoder().encode(encode(length)).byteLength > APNS_PAYLOAD_BYTES) length--;
  while (titleLength > 0 && new TextEncoder().encode(encode(length)).byteLength > APNS_PAYLOAD_BYTES) titleLength--;
  return encode(length);
}
export async function pushCollapseId(workspaceId: string, intentId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([workspaceId, intentId])));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The Web Push payload the browser's service worker shows: the same title,
 * body and target as the APNs alert, as plain JSON. A Web Notification `tag`
 * does not group like APNs `thread-id`: a later notification with the same tag
 * replaces the earlier one. So `tag` is the reply conversation's collapse id, or another kind's intent
 * collapse id, the same one
 * APNs gets as `apns-collapse-id`: later notifications in that conversation
 * replace the preceding reply alert while mentions stay distinct. Delivery
 * receipts remain per intent.
 */
export function renderWebPushPayload(input: {
  title: string; body: string; collapseId: string; data: PushNotificationData; maxBytes: number;
}): string {
  const characters = Array.from(input.body);
  const title = Array.from(input.title);
  let titleLength = title.length;
  const encode = (length: number) => JSON.stringify({
    title: title.slice(0, titleLength).join("") + (titleLength < title.length ? "…" : ""),
    body: characters.slice(0, length).join("") + (length < characters.length ? "…" : ""),
    tag: input.collapseId,
    rally: input.data,
  });
  // The body gives way first, then the title, as in the APNs alert.
  let length = Math.min(characters.length, PUSH_BODY_PREVIEW_CHARACTERS);
  while (length > 0 && new TextEncoder().encode(encode(length)).byteLength > input.maxBytes) length--;
  while (titleLength > 0 && new TextEncoder().encode(encode(length)).byteLength > input.maxBytes) titleLength--;
  return encode(length);
}

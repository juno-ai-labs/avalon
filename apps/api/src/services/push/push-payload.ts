import { PUSH_BODY_PREVIEW_CHARACTERS, type PushNotificationData } from "@rally/contracts/push-notifications";

// APNs regular alert payload ceiling, Apple Sending notification requests.
export const APNS_PAYLOAD_BYTES = 4096;
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

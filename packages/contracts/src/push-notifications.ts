import { RegionSchema } from "./regions";
import { z } from "zod";
import { HttpsUrlSchema } from "./url-schemas";

// Product decision in the Apple push PRD; byte fitting is separate.
export const PUSH_BODY_PREVIEW_CHARACTERS = 1000;
export const APNS_TOPICS = {
  macos: "ai.rallywith.desktop",
  ios: "ai.rallywith.ios",
} as const;
const token = z.string().regex(/^[0-9a-f]+$/i);

/**
 * The push services browsers subscribe through. A subscription endpoint is a
 * URL the Worker later POSTs to, so only these hosts are accepted: at
 * registration, and again before each send. Chrome and Edge on FCM, Firefox on
 * Mozilla autopush, Safari on Apple, and Edge on Windows on WNS.
 */
export const WEB_PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"] as const;
/** WNS hands out per-region hosts under this suffix. */
export const WEB_PUSH_SERVICE_HOST_SUFFIXES = [".notify.windows.com"] as const;

/** An HTTPS URL on a known push service, with no userinfo and the default port. */
export function isWebPushServiceUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return (WEB_PUSH_SERVICE_HOSTS as readonly string[]).includes(url.hostname)
    || WEB_PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
}

const appVersion = z.string();
export const RegisterPushDeviceRequestSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("macos"),
    transport: z.literal("apns"),
    topic: z.literal(APNS_TOPICS.macos),
    apnsEnvironment: z.literal("production"),
    token,
    appVersion,
  }),
  z.object({
    platform: z.literal("ios"),
    transport: z.literal("apns"),
    topic: z.literal(APNS_TOPICS.ios),
    apnsEnvironment: z.enum(["production", "sandbox"]),
    token,
    appVersion,
  }),
  // A browser's Web Push subscription, as `PushSubscription.toJSON()` gives it.
  z.object({
    platform: z.literal("web"),
    transport: z.literal("webpush"),
    endpoint: HttpsUrlSchema.refine(isWebPushServiceUrl, "Expected a known Web Push service URL"),
    // RFC 8291: an uncompressed P-256 point (65 bytes, leading 0x04, so "B")
    // and a 16-byte auth secret, each unpadded base64url.
    keys: z.object({ p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}$/u), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/u) }),
    appVersion,
  }),
]);
/** What a browser needs to subscribe: the server's VAPID public key. */
export const WebPushConfigurationSchema = z.object({ publicKey: z.string().min(80).max(100) });
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequestSchema>;
export const PushDeliveryMessageSchema = z.object({
  region: RegionSchema,
  workspaceId: z.string(),
  recipientUserId: z.string(),
  intentId: z.string(),
});
export type PushDeliveryMessage = z.infer<typeof PushDeliveryMessageSchema>;
export const PushNotificationDataSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["mention", "participant_added"]),
  url: HttpsUrlSchema,
  workspaceId: z.string(),
  region: RegionSchema,
});
export type PushNotificationData = z.infer<typeof PushNotificationDataSchema>;

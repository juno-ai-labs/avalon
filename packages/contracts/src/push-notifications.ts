import { AutomationDeliveryTargetTypeSchema } from "./index";
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
 * URL the Worker later POSTs to, so only these are accepted: at
 * registration, and again before each send. Chrome and Edge on FCM, Firefox on
 * Mozilla autopush, Safari on Apple, and Edge on Windows on WNS. Each is held
 * to the path its subscription URLs take: the same hosts also serve
 * credential-gated APIs (FCM's HTTP v1, WNS app channels), whose `401` must not
 * read as this deployment's VAPID key being refused.
 */
const WEB_PUSH_SERVICES: ReadonlyArray<{ host: string | RegExp; path: RegExp }> = [
  { host: "fcm.googleapis.com", path: /^\/(?:fcm\/send|wp)\/[^/]+$/u },
  { host: "updates.push.services.mozilla.com", path: /^\/wpush\/v[12]\/[^/]+$/u },
  { host: "web.push.apple.com", path: /^\/[^/]+$/u },
  // WNS hands out per-region hosts.
  { host: /^[a-z0-9-]+\.notify\.windows\.com$/u, path: /^\/w\/$/u },
];

/** A subscription URL on a known push service: HTTPS, no userinfo, the default port, its own path shape. */
export function isWebPushServiceUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return WEB_PUSH_SERVICES.some(({ host, path }) =>
    (typeof host === "string" ? url.hostname === host : host.test(url.hostname)) && path.test(url.pathname));
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
const PushDeliveryAddressSchema = z.object({
  region: RegionSchema,
  workspaceId: z.string(),
  recipientUserId: z.string(),
});
/**
 * What the push queue carries: who, and a pointer to what. A mention or an
 * add names its notification intent; every other Activity row names the row
 * itself, which the consumer reads back through the Activity feed. Neither
 * carries the notification's text.
 *
 * An Activity row carries `channel` when it goes somewhere other than the
 * person's devices: an email, or a connector's delivery surface. Without it,
 * the message is a push.
 */
export const PushDeliveryMessageSchema = z.union([
  PushDeliveryAddressSchema.extend({ intentId: z.string() }).strict(),
  PushDeliveryAddressSchema.extend({
    activityItemId: z.string().min(1).max(400),
    channel: AutomationDeliveryTargetTypeSchema.optional(),
  }).strict(),
]);
export type PushDeliveryMessage = z.infer<typeof PushDeliveryMessageSchema>;
export const PushNotificationDataSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["mention", "new_message", "participant_added", "thread_started", "breakout_started", "run_finished", "merged", "artifact_updated", "needs_input"]),
  url: HttpsUrlSchema,
  workspaceId: z.string(),
  region: RegionSchema,
});
export type PushNotificationData = z.infer<typeof PushNotificationDataSchema>;

/**
 * What a Sidekick run's notification intent stores: the run, the Sidekick's
 * name and the run's reply when the run reached the state the notice is
 * about. `needs_input` is a run waiting on a person; `run_finished` is a run
 * that completed, failed or stopped. The push renders from these alone, so a
 * later rename or a newer reply does not rewrite a notice already queued.
 */
export const SidekickRunNotificationSchema = z.strictObject({
  kind: z.enum(["needs_input", "run_finished"]),
  sidekickId: z.string().min(1),
  runId: z.string().min(1),
  sidekickName: z.string().max(300),
  state: z.enum(["needs_input", "completed", "failed", "stopped"]),
  reply: z.string().nullable(),
  occurredAt: z.number().int().nonnegative(),
});
export type SidekickRunNotification = z.infer<typeof SidekickRunNotificationSchema>;

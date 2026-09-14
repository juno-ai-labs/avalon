import { RegionSchema } from "./regions";
import { z } from "zod";
import { HttpsUrlSchema } from "./url-schemas";

// Product decision in the Apple push PRD; byte fitting is separate.
export const PUSH_BODY_PREVIEW_CHARACTERS = 1000;
export const APNS_TOPICS = { macos: "ai.rallywith.desktop" } as const;
export const RegisterPushDeviceRequestSchema = z.object({
  platform: z.literal("macos"),
  transport: z.literal("apns"),
  topic: z.literal(APNS_TOPICS.macos),
  apnsEnvironment: z.literal("production"),
  token: z.string().regex(/^[0-9a-f]+$/i),
  appVersion: z.string(),
});
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

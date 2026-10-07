import { IdSchema, UserIdSchema } from "@rally/contracts";
import { z } from "zod";

export const ContentAudienceSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("workspace") }),
  z.strictObject({
    scope: z.literal("users"),
    userIds: z.array(IdSchema).min(1),
  }),
]);

export type ContentAudience = z.infer<typeof ContentAudienceSchema>;

export const WorkstreamReaderAudienceSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("workspace") }),
  z.strictObject({
    scope: z.literal("personal"),
    userIds: z.array(IdSchema),
  }),
]);

export type WorkstreamReaderAudience = z.infer<typeof WorkstreamReaderAudienceSchema>;

/**
 * A Channel as observed: who may read it, and its roster. Both, because
 * `readers` says only `workspace` once the Channel is Organization-wide, and
 * the roster exists in both scopes.
 */
export const ObservedChannelSchema = z.strictObject({
  readers: WorkstreamReaderAudienceSchema,
  participantUserIds: z.array(UserIdSchema),
});
export type ObservedChannel = z.infer<typeof ObservedChannelSchema>;

/** Whether one member is inside a content audience. */
export function contentAudienceAllowsUser(source: ContentAudience, userId: string): boolean {
  return source.scope === "workspace" || source.userIds.includes(userId);
}

/** Content may move only to a work-stream audience no broader than its source. */
export function contentAudienceContainsWorkstream(
  source: ContentAudience,
  target: WorkstreamReaderAudience | null,
): boolean {
  // `null` is the authoritative answer for an unknown or archived target. It
  // fails closed instead of inventing an audience for retained content.
  if (!target) return false;
  if (source.scope === "workspace") return true;
  if (target.scope === "workspace" || target.userIds.length === 0) return false;
  const permitted = new Set(source.userIds);
  return target.userIds.every((userId) => permitted.has(userId));
}

import { IdSchema } from "@rally/contracts";
import { z } from "zod";

export const ContentAudienceSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }).strict(),
  z.object({
    scope: z.literal("users"),
    userIds: z.array(IdSchema).min(1),
  }).strict(),
]);

export type ContentAudience = z.infer<typeof ContentAudienceSchema>;

export const WorkstreamReaderAudienceSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }).strict(),
  z.object({
    scope: z.literal("personal"),
    userIds: z.array(IdSchema),
  }).strict(),
]);

export type WorkstreamReaderAudience = z.infer<typeof WorkstreamReaderAudienceSchema>;

/** Whether one member is inside a content audience. */
export function contentAudienceAllowsUser(source: ContentAudience, userId: string): boolean {
  return source.scope === "workspace" || source.userIds.includes(userId);
}

/** Whether one member may read a work stream with this exact audience. */
export function workstreamAudienceAllowsUser(
  audience: WorkstreamReaderAudience | null,
  userId: string,
): boolean {
  return Boolean(audience && (
    audience.scope === "workspace" || audience.userIds.includes(userId)
  ));
}

/** Content may move only to a work-stream audience no broader than its source. */
export function contentAudienceContainsWorkstream(
  source: ContentAudience,
  target: WorkstreamReaderAudience | null,
): boolean {
  // `null` is the authoritative answer for an unknown or archived target. It
  // must fail closed because the direct-watch caller deliberately passes that
  // result through without inventing an audience.
  if (!target) return false;
  if (source.scope === "workspace") return true;
  if (target.scope === "workspace" || target.userIds.length === 0) return false;
  const permitted = new Set(source.userIds);
  return target.userIds.every((userId) => permitted.has(userId));
}

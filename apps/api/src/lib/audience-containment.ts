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

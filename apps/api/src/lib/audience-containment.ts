import { IdSchema } from "@avalon/contracts";
import { z } from "zod";

export const ContentAudienceSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }).strict(),
  z.object({
    scope: z.literal("users"),
    userIds: z.array(IdSchema).min(1).max(1_000),
  }).strict(),
]);

export type ContentAudience = z.infer<typeof ContentAudienceSchema>;

export type WorkstreamReaderAudience =
  | { scope: "workspace" }
  | { scope: "personal"; userIds: string[] };

/** Content may move only to a work-stream audience no broader than its source. */
export function contentAudienceContainsWorkstream(
  source: ContentAudience,
  target: WorkstreamReaderAudience | null,
): boolean {
  if (!target) return false;
  if (source.scope === "workspace") return true;
  if (target.scope === "workspace" || target.userIds.length === 0) return false;
  const permitted = new Set(source.userIds);
  return target.userIds.every((userId) => permitted.has(userId));
}

import { z } from "zod";

import { IdSchema, WorkstreamIdSchema } from "./identifiers";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";

/**
 * A pinned artifact: a resource Rally generated in a thread's Main, with what
 * the Artifacts list draws for it, read when the list is.
 *
 * The Thread, Channel and Breakout pin kinds, and the Activity feed this file
 * also held, retired with those surfaces in the Canvases and Sidekicks pivot.
 */
export const ArtifactPinSchema = z.strictObject({
  /** The resource. */
  id: IdSchema,
  /** The thread whose Main the artifact was generated in, which opens it. */
  threadId: WorkstreamIdSchema,
  title: z.string().min(1).max(300),
  resourceType: z.string().min(1).max(80),
  mimeType: z.string().max(160).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  currentVersion: z.number().int().positive(),
  /**
   * Somebody else made a version since this person pinned it that they have
   * not seen: the same fact that keeps its `artifact_updated` Activity row
   * unread, cleared by the same read event.
   */
  unread: z.boolean(),
  /** The thread as its row draws it: a badge on the artifact's tile, and its name. */
  thread: z.strictObject({
    title: z.string().min(1).max(180),
    appearance: WorkstreamAppearanceSchema.nullable(),
    spaceIds: z.array(IdSchema),
  }),
});
export type ArtifactPin = z.infer<typeof ArtifactPinSchema>;

/** Every artifact a person pinned that they can still see, in their order. */
export const ArtifactPinListSchema = z.array(ArtifactPinSchema);
export type ArtifactPinList = z.infer<typeof ArtifactPinListSchema>;

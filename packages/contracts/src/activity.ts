import { z } from "zod";

import { IdSchema, SubstreamIdSchema } from "./identifiers";

/**
 * Activity: one person's feed of what happened to them in Canvases and
 * Sidekicks. Each item is one of the four events that also produce a push
 * intent, written in that intent's own transaction, so the feed and the push
 * cannot disagree. `docs/activity.md` owns the model.
 */

/** What happened: a mention of me, me being added, a run that needs my input, a run I asked for finished. */
export const ActivityKindSchema = z.enum(["mention", "participant_added", "needs_input", "run_finished"]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** Where it happened: a Canvas, or a Sidekick (`automation`, its storage name). */
export const ActivityParentKindSchema = z.enum(["canvas", "automation"]);
export type ActivityParentKind = z.infer<typeof ActivityParentKindSchema>;

/** Who did it: a person (their id), Rally, or a Sidekick (its id). */
export const ActivityActorSchema = z.strictObject({
  kind: z.enum(["person", "rally", "sidekick"]),
  id: IdSchema.nullable(),
});
export type ActivityActor = z.infer<typeof ActivityActorSchema>;

const TimestampSchema = z.string().datetime({ offset: true });

/** One Activity item as its recipient sees it. */
export const ActivityItemSchema = z.object({
  id: z.string().min(1).max(300),
  kind: ActivityKindSchema,
  parentKind: ActivityParentKindSchema,
  parentId: IdSchema,
  /**
   * The Canvas's or Sidekick's title now, read at list time; null when the
   * recipient may no longer open it or it is gone, so a title they can no
   * longer read is never named to them.
   */
  parentTitle: z.string().max(300).nullable(),
  /** The conversation it happened in: `"0"` for the Chat or shared conversation, a run's id for a run. */
  substreamId: SubstreamIdSchema.nullable(),
  /** The mentioning message, for a mention. */
  messageId: IdSchema.nullable(),
  /**
   * The mentioning message's transcript sequence, which opening the Chat at
   * it needs beside its id; null for every other kind, and for a mention
   * recorded before the effect carried it.
   */
  messageSequence: z.number().int().positive().nullable(),
  /** The run, for `needs_input` and `run_finished`. */
  runId: IdSchema.nullable(),
  actor: ActivityActorSchema,
  /** The push body's own text: the message, or what the run said. */
  preview: z.string().nullable(),
  createdAt: TimestampSchema,
  /**
   * Derived, never written per item: the recipient has read the conversation
   * past what the item is about, or marked everything seen since it arrived.
   */
  seen: z.boolean(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

/**
 * One person's Activity, newest first, at the list's waterline. `items` is
 * the newest page (the sidebar lists' bound); `unseenCount` counts every
 * unseen item, not only the page's.
 */
export const ActivityPageSchema = z.strictObject({
  waterline: z.number().int().nonnegative(),
  unseenCount: z.number().int().nonnegative(),
  items: z.array(ActivityItemSchema).max(250),
});
export type ActivityPage = z.infer<typeof ActivityPageSchema>;

/**
 * The workspace socket's push of one person's Activity after it moved: an
 * item recorded, a read that cleared some, or Mark all seen. Sent to that
 * person's sockets only. Its own event type, so a desktop that predates it
 * ignores it (`isUnknownSocketEvent`).
 */
export const WorkspaceActivityListEventSchema = z.strictObject({
  type: z.literal("workspace_activity_list"),
  occurredAt: TimestampSchema,
  waterline: z.number().int().positive(),
  unseenCount: z.number().int().nonnegative(),
  items: z.array(ActivityItemSchema).max(250),
});
export type WorkspaceActivityListEvent = z.infer<typeof WorkspaceActivityListEventSchema>;

/** The workspace socket command behind Mark all seen: everything recorded until now is seen. */
export const ActivityMarkAllSeenCommandSchema = z.strictObject({ type: z.literal("activity_mark_all_seen") });

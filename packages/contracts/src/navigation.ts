import { z } from "zod";

import { IdSchema, WorkstreamIdSchema } from "./identifiers";

/**
 * What a person can pin: a thread (storage `workstream`), a Channel (storage
 * `space`) or a breakout (storage `substream`). One list per kind, each in the
 * person's own order. See `docs/workstream-pinning.md`.
 */
export const PinKindSchema = z.enum(["thread", "channel", "breakout"]);
export type PinKind = z.infer<typeof PinKindSchema>;

/**
 * One pin. `parentId` is the breakout's thread, which a client needs to open
 * it, and `null` for the other two kinds.
 */
export const PinSchema = z.strictObject({
  kind: PinKindSchema,
  id: IdSchema,
  parentId: WorkstreamIdSchema.nullable(),
}).superRefine((pin, context) => {
  if ((pin.kind === "breakout") !== (pin.parentId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["parentId"],
      message: "A breakout pin carries its thread and no other pin does",
    });
  }
});
export type Pin = z.infer<typeof PinSchema>;

/** Every pin a person has, each kind in their order. */
export const PinListSchema = z.array(PinSchema);
export type PinList = z.infer<typeof PinListSchema>;

/** Pin one item. A breakout names its thread. */
export const PinRequestSchema = z.strictObject({
  parentId: WorkstreamIdSchema.optional(),
});
export type PinRequest = z.infer<typeof PinRequestSchema>;

/** Save one kind's order: ids, first to last. Unknown ids are dropped. */
export const PinOrderRequestSchema = z.strictObject({
  kind: PinKindSchema,
  ids: z.array(IdSchema),
});
export type PinOrderRequest = z.infer<typeof PinOrderRequestSchema>;

/**
 * What the Channels tab prints under each Channel's name, for the Channels this
 * viewer may list: how many threads they may list in it, and when the newest of
 * those last moved. Counts only listable threads, so a number never tells a
 * person about threads they cannot see.
 */
export const ChannelStatsSchema = z.strictObject({
  channelId: IdSchema,
  threadCount: z.number().int().nonnegative(),
  /**
   * How many rows the Channel's feed holds above this viewer's read position:
   * threads placed since they last read it, still in it, and theirs to open.
   * Zero for a guest.
   */
  newThreadCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime({ offset: true }).nullable(),
  /**
   * The Channel's unread state, in the same fields and with the same meaning
   * a thread or a breakout carries: each thread placed in the Channel takes
   * the next attention sequence number, and the viewer's read position is
   * acknowledged the way a conversation's is. Only a placement advances it.
   * A guest is never unread, and a member is unread only while
   * `newThreadCount` is above zero: a private thread they are not in moves
   * the latest number without being news to them.
   */
  latestAttentionSequenceNumber: z.number().int().nonnegative(),
  readThroughSequenceNumber: z.number().int().nonnegative(),
  firstUnreadSequenceNumber: z.number().int().positive().nullable(),
  hasUnread: z.boolean(),
});
export type ChannelStats = z.infer<typeof ChannelStatsSchema>;

/**
 * Acknowledge a Channel read through a placement. A Channel has no "mark
 * unread", so unlike a thread's acknowledgement there is no generation to
 * compare against.
 */
export const AcknowledgeChannelReadRequestSchema = z.strictObject({
  readThroughSequenceNumber: z.number().int().nonnegative(),
});
export type AcknowledgeChannelReadRequest = z.infer<typeof AcknowledgeChannelReadRequestSchema>;

export const ChannelStatsListSchema = z.array(ChannelStatsSchema);
export type ChannelStatsList = z.infer<typeof ChannelStatsListSchema>;

/**
 * One row of the Activity tab.
 *
 * - `added`: somebody added the viewer to a thread or a breakout.
 * - `mentioned`: somebody mentioned the viewer.
 * - `thread_started`: somebody started a thread the viewer may list.
 * - `breakout_started`: somebody started a breakout the viewer may list.
 * - `run_finished`: Rally finished its latest run in a thread or breakout the
 *   viewer takes part in.
 *
 * `breakout` is set when the row is about a breakout rather than its thread.
 * Titles are the conversation's current ones, read when the page is.
 */
export const ActivityItemKindSchema = z.enum([
  "added",
  "mentioned",
  "thread_started",
  "breakout_started",
  "run_finished",
]);
export type ActivityItemKind = z.infer<typeof ActivityItemKindSchema>;

/** A narrower Activity feed: `mentions` keeps only the rows where somebody mentioned this person. */
export const ActivityFilterSchema = z.enum(["mentions"]);
export type ActivityFilter = z.infer<typeof ActivityFilterSchema>;

export const ActivityItemSchema = z.strictObject({
  id: z.string().min(1).max(400),
  kind: ActivityItemKindSchema,
  occurredAt: z.string().datetime({ offset: true }),
  actorUserId: IdSchema.nullable(),
  actorLabel: z.string().max(300),
  threadId: WorkstreamIdSchema,
  threadTitle: z.string(),
  breakout: z.strictObject({ substreamId: IdSchema, title: z.string() }).nullable(),
  /** The Channels the thread sits in that the viewer may list. */
  channelIds: z.array(IdSchema),
  /** Until Mark all read covers it, or an event settles it; see `ActivityEventSchema`. */
  unread: z.boolean(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

/** One page of the Activity tab, newest first. */
export const ActivityPageSchema = z.strictObject({
  items: z.array(ActivityItemSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type ActivityPage = z.infer<typeof ActivityPageSchema>;

/** Mark everything up to and including this time as read. */
export const ActivitySeenRequestSchema = z.strictObject({
  seenThrough: z.string().datetime({ offset: true }),
});
export type ActivitySeenRequest = z.infer<typeof ActivitySeenRequestSchema>;

/** What an Activity event is about: a thread, one of its breakouts, or a Channel. */
export const ActivitySubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), threadId: WorkstreamIdSchema }),
  z.strictObject({ kind: z.literal("breakout"), threadId: WorkstreamIdSchema, substreamId: IdSchema }),
  z.strictObject({ kind: z.literal("channel"), channelId: IdSchema }),
]);
export type ActivitySubject = z.infer<typeof ActivitySubjectSchema>;

/**
 * Something the person did that can settle Activity rows, reported by the app.
 *
 * `read`: they saw `subject` through `through`, its attention ordinal (a
 * thread's or breakout's message, a Channel's placement), and 0 when they
 * only opened it. Every row the subject settles at or below that is done:
 * reading message 29 of a thread settles a mention at 29 or earlier, and
 * leaves one at 30 standing.
 */
export const ActivityEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("read"),
    subject: ActivitySubjectSchema,
    through: z.number().int().nonnegative(),
  }),
]);
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityEventsRequestSchema = z.strictObject({
  events: z.array(ActivityEventSchema).min(1),
});
export type ActivityEventsRequest = z.infer<typeof ActivityEventsRequestSchema>;

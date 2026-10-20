import { z } from "zod";

import { IdSchema, WorkstreamIdSchema } from "./identifiers";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";

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

/**
 * A pinned artifact: a resource Rally generated in a thread's Main, with what
 * the Artifacts list draws for it, read when the list is.
 *
 * Not a fourth `PinKind`. A shipped desktop parses `Pin` strictly, so one
 * unknown kind in `pins` would fail the whole list; artifact pins travel as a
 * list of their own instead, beside `pins` on the same socket messages, where
 * an older build drops the key it does not know. They share the stored table,
 * order rules and limit with the other kinds (`docs/workstream-pinning.md`).
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

/** Pin one artifact, named with the thread it was generated in. */
export const ArtifactPinRequestSchema = z.strictObject({
  threadId: WorkstreamIdSchema,
});
export type ArtifactPinRequest = z.infer<typeof ArtifactPinRequestSchema>;

/** Save the artifact pins' order: ids, first to last. Unknown ids are dropped. */
export const ArtifactPinOrderRequestSchema = z.strictObject({
  ids: z.array(IdSchema),
});
export type ArtifactPinOrderRequest = z.infer<typeof ArtifactPinOrderRequestSchema>;

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
 * - `merged`: somebody merged a result up a level: a breakout into its thread
 *   (`breakout` is the source, frozen at merge time), or a thread into one of
 *   its Channels (`mergedInto` is the Channel). Served only to builds at
 *   `CHANNEL_MERGES_CLIENT_CONTRACT` or later; see docs/conversation-merge.md.
 *
 * - `artifact_updated`: an artifact the viewer pinned has a new version that
 *   somebody else made (`artifact` names it; `threadId` is the thread it was
 *   generated in). Served only to builds at `ARTIFACT_UPDATES_CLIENT_CONTRACT`
 *   or later; see docs/workstream-pinning.md#artifact-pins.
 *
 * `breakout` is set when the row is about a breakout rather than its thread.
 * Titles are the conversation's current ones, read when the page is.
 */
export const ActivityItemKindSchema = z.enum([
  "added",
  "mentioned",
  "new_message",
  "thread_started",
  "breakout_started",
  "run_finished",
  "merged",
  "artifact_updated",
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
  /** Plain message text, present only for human reply activity. */
  preview: z.string().optional(),
  unreadMessageCount: z.number().int().nonnegative().optional(),
  threadId: WorkstreamIdSchema,
  threadTitle: z.string(),
  breakout: z.strictObject({ substreamId: IdSchema, title: z.string() }).nullable(),
  /**
   * On a thread's `merged` row: the Channel it merged into. `threadPrivate`
   * when the viewer may not open the thread: `threadTitle` is then empty and
   * the row is the Channel's. Served only to builds at
   * `CHANNEL_PRIVATE_MERGES_CLIENT_CONTRACT` or later.
   */
  mergedInto: z.strictObject({ channelId: IdSchema, name: z.string(), threadPrivate: z.literal(true).optional() }).optional(),
  /** On an `artifact_updated` row: the artifact, its current title, and the version the row is about. */
  artifact: z.strictObject({
    resourceId: IdSchema,
    title: z.string(),
    version: z.number().int().positive(),
  }).optional(),
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

/** What an Activity event is about: a thread, one of its breakouts, a Channel, or an artifact. */
export const ActivitySubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), threadId: WorkstreamIdSchema }),
  z.strictObject({ kind: z.literal("breakout"), threadId: WorkstreamIdSchema, substreamId: IdSchema }),
  z.strictObject({ kind: z.literal("channel"), channelId: IdSchema }),
  /** A pinned artifact; `through` is the version the person has seen. */
  z.strictObject({ kind: z.literal("artifact"), resourceId: IdSchema }),
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

/** One conversation in Activity, regardless of how many events it produced. */
export interface ActivityGroup extends ActivityItem {
  groupKey: string;
  unreadMessages: number;
  unreadMention: boolean;
  rallyFinished: boolean;
}

/**
 * Flatten across pages, before filtering unread. Keep destinations separate:
 * a private breakout, a pinned artifact, and a merge into a Channel each opens
 * somewhere different. Human replies lead over routine AI completion activity.
 */
export function groupActivityItems(items: readonly ActivityItem[]): ActivityGroup[] {
  const buckets = new Map<string, ActivityItem[]>();
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.artifact ? `artifact:${item.artifact.resourceId}`
      : item.mergedInto ? `channel:${item.mergedInto.channelId}`
        : `conversation:${item.threadId}:${item.kind === "merged" ? "0" : item.breakout?.substreamId ?? "0"}`;
    const bucket = buckets.get(key) ?? [];
    // Refetched infinite pages can overlap. A mention and reply may also
    // refer to the same event: keep both kinds, but count the reply once.
    const eventKey = `${key}\0${item.kind}\0${item.id}`;
    if (!seen.has(eventKey)) { bucket.push(item); seen.add(eventKey); }
    buckets.set(key, bucket);
  }
  return [...buckets].map(([groupKey, bucket]): ActivityGroup => {
    bucket.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const latest = bucket[0]!;
    const human = bucket.find((item) => item.kind === "new_message");
    const representative = human ?? bucket.find((item) => item.unread && item.kind === "mentioned") ?? latest;
    return {
      ...representative,
      groupKey,
      occurredAt: latest.occurredAt,
      unread: bucket.some((item) => item.unread),
      unreadMessages: human?.unread ? human.unreadMessageCount ?? bucket.filter((item) => item.kind === "new_message" && item.unread).length : 0,
      unreadMention: bucket.some((item) => item.kind === "mentioned" && item.unread),
      rallyFinished: bucket.some((item) => item.kind === "run_finished" && item.unread),
    };
  }).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

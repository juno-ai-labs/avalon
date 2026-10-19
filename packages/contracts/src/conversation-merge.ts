import { z } from "zod";

import { citedResourceIds } from "./citations";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkstreamIdSchema } from "./identifiers";
import { MentionSchema } from "./mention-schema";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";

/**
 * Merge-back: the result of a Breakout posted into its Thread, or the result of
 * a Thread posted into one of its Channels. One representation, "X merged into
 * Y", with a short markdown body that may embed artifacts as `resource://`
 * links. See docs/PRDs/2026-10-16_merge-back/prd.md and
 * docs/conversation-merge.md.
 */

/**
 * `POST /conversations/:parentId/merge`. With `breakoutId` it merges that
 * Breakout of this Thread into the Thread's Main conversation; without it, it
 * merges this Thread into a Channel: `channelId` when given, otherwise the
 * thread's earliest current placement. The server writes every tag; the
 * client supplies only the words and a retry key.
 */
export const ConversationMergeRequestSchema = z.strictObject({
  body: z.string().trim().min(1).max(MESSAGE_MAX_CHARACTERS),
  /** The operation id: a retry with the same value is answered with the first result. */
  clientMessageId: z.string().min(1).max(120),
  breakoutId: IdSchema.optional(),
  channelId: z.string().uuid().optional(),
  /**
   * A Breakout merge's mentions and the nonparticipants the person confirmed,
   * as the composer hands them to any message; the Thread's Main admits them
   * as it admits its own messages. A Channel merge has no mentions to keep.
   */
  mentions: z.array(MentionSchema).optional(),
  confirmedParticipantUserIds: z.array(z.string().uuid()).optional(),
}).refine((value) => value.breakoutId === undefined || value.channelId === undefined, {
  message: "A merge goes into a Thread (breakoutId) or into a Channel (channelId), not both",
  path: ["channelId"],
});
export type ConversationMergeRequest = z.infer<typeof ConversationMergeRequestSchema>;

/**
 * Why a merge was refused. The route answers each with its HTTP status; the
 * `conversation_merge` tool answers each with the sentence in
 * docs/PRDs/2026-10-16_merge-back/agent-behavior.md.
 */
export const ConversationMergeErrorCodeSchema = z.enum([
  /** The named Channel does not hold this thread now. */
  "merge_channel_not_placed",
  /** The person cannot post in the target. */
  "merge_target_not_writable",
  /** An embedded resource fails the attach path's source check. */
  "merge_resource_not_shareable",
  /** The source or the target is archived. */
  "conversation_archived",
  /** The person cannot read the source, or the Breakout is not this Thread's. */
  "conversation_access_denied",
]);
export type ConversationMergeErrorCode = z.infer<typeof ConversationMergeErrorCodeSchema>;

/** A Channel a thread can merge into: one of its current placements the person may post in. */
export const ConversationMergeChannelSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
});
export type ConversationMergeChannel = z.infer<typeof ConversationMergeChannelSchema>;

/**
 * `GET /conversations/:parentId/merge-channels`: the Channels this thread can
 * merge into for this person, earliest placement first, so the first is the
 * default the server would choose.
 */
export const ConversationMergeChannelsSchema = z.strictObject({
  channels: z.array(ConversationMergeChannelSchema),
});
export type ConversationMergeChannels = z.infer<typeof ConversationMergeChannelsSchema>;

/** Where a merge landed. */
export const ConversationMergeTargetSchema = z.strictObject({
  kind: z.enum(["thread", "channel"]),
  /** The Thread's id, or the Channel's (the storage Space's) id. */
  id: z.string().min(1),
  title: z.string(),
});
export type ConversationMergeTarget = z.infer<typeof ConversationMergeTargetSchema>;

export const ConversationMergeResultSchema = z.strictObject({
  mergedInto: ConversationMergeTargetSchema,
  messageId: z.string().min(1),
  /** True when this operation id already merged and nothing was written again. */
  replayed: z.boolean(),
  /** Embedded resources this call newly made readable in the target. */
  sharedResourceIds: z.array(z.string().min(1)),
});
export type ConversationMergeResult = z.infer<typeof ConversationMergeResultSchema>;

/**
 * The `structuredContent` of a Breakout merge in its Thread. Written by the
 * server only: the send path carries no structured content, and the merge
 * route sets this after checking the Breakout belongs to the Thread and the
 * person can read it.
 */
export const ConversationMergeV1Schema = z.strictObject({
  type: z.literal("conversation_merge"),
  schemaVersion: z.literal(1),
  mergedFrom: z.strictObject({
    breakoutId: SubstreamIdSchema,
    /** Frozen at merge time, so a later rename does not rewrite history. */
    title: z.string().max(300),
  }),
  mergedByUserId: UserIdSchema,
  /** Rally merged on the person's request, through `conversation_merge`. */
  actingAgent: z.boolean(),
});
export type ConversationMergeV1 = z.infer<typeof ConversationMergeV1Schema>;

/**
 * The `structuredContent` of the system row a merge leaves in its source: the
 * Breakout, or the Thread's Main. It says where the result went, so the source
 * can show it was merged and open the merge where it landed. Written by the
 * server only, after the merge itself; system rows never reach the model's
 * history.
 */
export const ConversationMergedIntoV1Schema = z.strictObject({
  type: z.literal("conversation_merged_into"),
  schemaVersion: z.literal(1),
  mergedInto: ConversationMergeTargetSchema,
  /** The merge in the target: a Thread's transcript turn, or a Channel message. */
  messageId: z.string().min(1),
  mergedByUserId: UserIdSchema,
  /** Rally merged on the person's request, through `conversation_merge`. */
  actingAgent: z.boolean(),
});
export type ConversationMergedIntoV1 = z.infer<typeof ConversationMergedIntoV1Schema>;

/** An artifact a merge embeds, as it was when merged: enough to draw its card. */
/**
 * How a citation names a resource: its UUID or its alias. A merge attaches
 * what its body cites, as written.
 */
export const MergeResourceTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const MergeEmbedSchema = z.strictObject({
  id: z.string().min(1),
  /** The resource's alias, so a body citing it by alias still resolves. */
  slug: z.string().min(1).optional(),
  title: z.string().max(500),
  kind: z.string().max(100),
});
export type MergeEmbed = z.infer<typeof MergeEmbedSchema>;

/** The thread a Channel merge came from, as the feed resolves it for the reader. */
export const ChannelMergeSourceSchema = z.strictObject({
  threadId: WorkstreamIdSchema,
  /** The thread's current title; empty when the directory no longer has one. */
  title: z.string(),
  /** The thread's description, for the quote line; null when it has none. */
  summary: z.string().nullable(),
  embeds: z.array(MergeEmbedSchema),
  /**
   * The reader cannot open the thread, so its title, summary and embeds are
   * withheld (empty) and the merge reads as from a private thread. Served
   * only to a build at `CHANNEL_PRIVATE_MERGES_CLIENT_CONTRACT` or later.
   */
  private: z.literal(true).optional(),
});
export type ChannelMergeSource = z.infer<typeof ChannelMergeSourceSchema>;

/** The `resource://` ids a merge body embeds or cites, in order, without repeats. */
export const mergeResourceIds = citedResourceIds;

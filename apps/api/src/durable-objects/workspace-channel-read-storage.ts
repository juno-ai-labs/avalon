import { unreadState } from "./unread-state";

/**
 * Migration 98: a Channel's (storage `space`) unread waterline and each
 * person's read position in it.
 *
 * The columns are the ones a thread (`channels` / `channel_viewers`) and a
 * breakout (`breakouts` / `breakout_viewers`) already carry, with the same
 * names and the same meaning, so a Channel can later move onto its own
 * AgentLoopDO and write them through directory effects without a second
 * vocabulary. What advances the waterline is a thread being placed in the
 * Channel, and nothing else: each activation of a membership takes the next
 * ordinal and stamps it on the membership, which is what a feed row reports as
 * its `attentionSequenceNumber`.
 *
 * **Why `space_reads` rather than columns on `space_viewers`.** Every Space is
 * Organization-wide (migration 94), so a member reaches most Channels with no
 * `space_viewers` row at all, and that table is a projection from the Space's
 * own authority: a viewer row is deleted when the projection says inactive,
 * and replaced at each newer source version. A read position kept there would
 * have nowhere to live for most readers and would be erased by an unrelated
 * audience change. A row here is written by the reader alone, the way
 * `workspace_activity_seen` and `workspace_pins` are.
 *
 * No foreign key to `spaces`, for the reason `space_invitees` gives: a key
 * would make a future rebuild of `spaces` cascade here.
 *
 * **Backfill.** Every active placement is numbered per Channel in placement
 * order, and the Channel's waterline and tracking start are both set to the
 * count, so nothing is unread on deploy. Rows that are not active keep `NULL`;
 * the feed reads active rows only and treats `NULL` as zero.
 */
export const WORKSPACE_CHANNEL_READS_MIGRATION: readonly string[] = [
  `ALTER TABLE spaces ADD COLUMN latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
     CHECK (latest_attention_ordinal >= 0)`,
  `ALTER TABLE spaces ADD COLUMN unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
     CHECK (unread_tracking_start_ordinal >= 0)`,
  `ALTER TABLE space_channel_memberships ADD COLUMN attention_ordinal INTEGER
     CHECK (attention_ordinal IS NULL OR attention_ordinal > 0)`,
  `CREATE TABLE space_reads (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seen_attention_ordinal INTEGER CHECK (seen_attention_ordinal IS NULL OR seen_attention_ordinal >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
  ) STRICT`,
  `UPDATE space_channel_memberships
      SET attention_ordinal = ranked.ordinal
     FROM (
       SELECT space_id, workstream_id,
              ROW_NUMBER() OVER (PARTITION BY space_id ORDER BY joined_at, workstream_id) AS ordinal
         FROM space_channel_memberships
        WHERE state = 'active'
     ) ranked
    WHERE space_channel_memberships.space_id = ranked.space_id
      AND space_channel_memberships.workstream_id = ranked.workstream_id`,
  `UPDATE spaces
      SET latest_attention_ordinal = placed.count,
          unread_tracking_start_ordinal = placed.count
     FROM (
       SELECT space_id, COUNT(*) AS count
         FROM space_channel_memberships
        WHERE state = 'active'
        GROUP BY space_id
     ) placed
    WHERE spaces.space_id = placed.space_id`,
];

/** One Channel's unread state for one viewer, in `ChannelStats`'s field names. */
export interface ChannelReadState {
  latestAttentionSequenceNumber: number;
  readThroughSequenceNumber: number;
  firstUnreadSequenceNumber: number | null;
  hasUnread: boolean;
}

/** The stored columns {@link channelReadState} derives from. */
export interface ChannelReadRow {
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  seen_attention_ordinal: number | null;
}

/**
 * The derivation a thread and a breakout use, applied to a Channel. A guest
 * is never unread: they see a Channel only through the threads they may list,
 * so a placement they cannot see is not news to them. A member's hidden
 * placements are taken out by `channelStats`, which knows what they may open.
 */
export function channelReadState(row: ChannelReadRow, guest: boolean): ChannelReadState {
  const latest = Number(row.latest_attention_ordinal);
  if (guest) {
    return {
      latestAttentionSequenceNumber: latest,
      readThroughSequenceNumber: latest,
      firstUnreadSequenceNumber: null,
      hasUnread: false,
    };
  }
  const state = unreadState({
    latest,
    seen: row.seen_attention_ordinal === null ? null : Number(row.seen_attention_ordinal),
    trackingStart: Number(row.unread_tracking_start_ordinal),
    // A Channel has no "mark unread": a person's read position only moves
    // forward, and only a new placement makes it unread again.
    manual: null,
  });
  return {
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: state.readThrough,
    firstUnreadSequenceNumber: state.firstUnread,
    hasUnread: state.hasUnread,
  };
}

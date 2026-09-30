/**
 * Start a newly seated participant's read cursor at the latest message.
 *
 * Somebody added to a Channel that already has history did not miss that
 * history; it was written before they were here. Without a cursor of their
 * own they fall back to `unread_tracking_start_ordinal`, which is 0 on any
 * Channel created after unread tracking shipped, so the whole transcript read
 * as unread and the feed opened at the first message instead of the newest.
 *
 * Call it in the same transaction as the write that makes the person active,
 * and only when they were not already active: re-running it on a no-op add
 * would mark read whatever arrived since they joined. Messages appended after
 * this call, including the one that seats them, still count as unread. The
 * "you were added" signal is `participants.first_opened_at`, which this leaves
 * alone.
 *
 * On a re-add the cursor only moves forward, and a manual unread mark from the
 * earlier membership is dropped with a new generation so a client holding the
 * old mark does not restore it.
 */
export function startReadCursorAtLatest(sql: SqlStorage, userId: string, now: number): void {
  // `WHERE id = 1` also settles SQLite's parse of an upsert on INSERT … SELECT.
  sql.exec(
    `INSERT INTO member_attention
       (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
        manual_unread_from_ordinal, latest_mention_attention_ordinal,
        last_seen_at, version, updated_at)
     SELECT ?, unread_tracking_start_ordinal, MAX(0, next_attention_ordinal - 1),
            NULL, 0, ?, 0, ?
       FROM workstream WHERE id = 1
     ON CONFLICT(user_id) DO UPDATE SET
       seen_attention_ordinal = MAX(member_attention.seen_attention_ordinal,
                                    excluded.seen_attention_ordinal),
       manual_unread_from_ordinal = NULL,
       version = member_attention.version + 1,
       updated_at = excluded.updated_at`,
    userId,
    now,
    now,
  );
}

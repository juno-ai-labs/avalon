/**
 * Start a newly seated participant's read cursor at, or just below, the latest
 * message.
 *
 * Somebody added to a Channel that already has history did not miss that
 * history; it was written before they were here. Without a cursor of their
 * own they fall back to `unread_tracking_start_ordinal`, which is 0 on any
 * Channel created after unread tracking shipped, so the whole transcript read
 * as unread and the feed opened at the first message instead of the newest.
 *
 * `leaveLatestUnread` keeps the newest message unread, so somebody added by
 * another person still gets an unread badge and lands on where the room is.
 * Pass false when the person seated themselves, since they are already
 * looking at it, and on the message paths, where the seating message takes
 * its ordinal after this call and is already the unread one.
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
export function startReadCursorAtLatest(
  sql: SqlStorage,
  userId: string,
  now: number,
  leaveLatestUnread: boolean,
): void {
  // `WHERE id = 1` also settles SQLite's parse of an upsert on INSERT … SELECT.
  sql.exec(
    `INSERT INTO member_attention
       (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
        manual_unread_from_ordinal, latest_mention_attention_ordinal,
        last_seen_at, version, updated_at)
     SELECT ?, unread_tracking_start_ordinal, MAX(0, next_attention_ordinal - ?),
            NULL, 0, ?, 0, ?
       FROM workstream WHERE id = 1
     ON CONFLICT(user_id) DO UPDATE SET
       seen_attention_ordinal = MAX(member_attention.seen_attention_ordinal,
                                    excluded.seen_attention_ordinal),
       manual_unread_from_ordinal = NULL,
       version = member_attention.version + 1,
       updated_at = excluded.updated_at`,
    userId,
    leaveLatestUnread ? 2 : 1,
    now,
    now,
  );
}

/**
 * Mark one turn read for a person who had read everything before it: their
 * cursor moves from `ordinal - 1` to `ordinal`, and from nowhere else, so a
 * message somebody else wrote before or after it stays unread to them. A
 * person with no cursor here is seated at the turn, as
 * `startReadCursorAtLatest` seats a participant. A manual unread mark is
 * never touched. For a write the person caused and is looking at, such as
 * the row of a Sidekick run they started; call it in that write.
 */
export function seatReadAtOwnTurn(sql: SqlStorage, userId: string, ordinal: number, now: number): void {
  // `WHERE id = 1` also settles SQLite's parse of an upsert on INSERT … SELECT.
  sql.exec(
    `INSERT INTO member_attention
       (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
        manual_unread_from_ordinal, latest_mention_attention_ordinal,
        last_seen_at, version, updated_at)
     SELECT ?1, unread_tracking_start_ordinal, ?2, NULL, 0, ?3, 0, ?3
       FROM workstream WHERE id = 1
     ON CONFLICT(user_id) DO UPDATE SET
       seen_attention_ordinal = excluded.seen_attention_ordinal,
       version = member_attention.version + 1,
       updated_at = excluded.updated_at
     WHERE member_attention.seen_attention_ordinal = ?2 - 1`,
    userId,
    ordinal,
    now,
  );
}

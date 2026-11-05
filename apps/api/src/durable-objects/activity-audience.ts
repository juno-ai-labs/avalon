/**
 * Who is told about news in an Organization-wide Channel.
 *
 * Listing decides who may *see* a thread or a Channel post; this decides who is
 * *told* about one. Every member may list an Organization-wide thread placed in
 * an Organization-wide Channel, but only the people taking part are told it
 * started: participants of the Channel, and participants of the thread itself.
 * Somebody who never joined the Channel can still open the thread; it is not
 * pushed, emailed, sent to Slack or put in their Activity and digest.
 *
 * A Channel counts only for what happened once the person had joined it
 * (`space_viewers.joined_at`, migration 134), so joining a Channel does not
 * bring its history into Activity. A NULL join time is a participant from
 * before that column, who keeps hearing about everything as before.
 *
 * A private thread or a private Channel already lists to the people in it, so
 * neither fragment narrows them. A thread placed in no Organization-wide
 * Channel is outside this rule and keeps its listing audience.
 *
 * A change inside a thread (a breakout started or merged in it) is told to the
 * thread's participants alone, Channel or no Channel.
 *
 * Every fragment here is code-owned SQL over caller-chosen aliases and read the
 * viewer's id from `?1`. See `docs/digests.md#the-activity-tab`.
 */

/**
 * Whether `?1` took part in the Channel whose id is `spaceId` when the event
 * at `occurredAt` (Unix milliseconds) happened.
 */
function channelParticipantSql(spaceId: string, occurredAt: string): string {
  return `EXISTS (SELECT 1 FROM space_viewers audience_space_viewer
                   WHERE audience_space_viewer.space_id = ${spaceId}
                     AND audience_space_viewer.user_id = ?1
                     AND audience_space_viewer.is_participant = 1
                     AND (audience_space_viewer.joined_at IS NULL
                          OR audience_space_viewer.joined_at <= ${occurredAt}))`;
}

/**
 * Whether `?1` is told a thread started. `directory` is the thread's `channels`
 * row and `viewer` its `channel_viewers` row for `?1`, left-joined;
 * `occurredAt` is the start's time.
 *
 * `participant` is any further participation that counts, such as a
 * breakout's own viewer row; pass `"0"` for none.
 */
export function threadStartAudienceSql(directory: string, viewer: string, occurredAt: string, participant = "0"): string {
  return `(${directory}.scope <> 'workspace'
            OR ${viewer}.is_participant = 1
            OR ${participant}
            OR NOT EXISTS (SELECT 1 FROM space_channel_memberships audience_placement
                             JOIN spaces audience_space ON audience_space.space_id = audience_placement.space_id
                            WHERE audience_placement.workstream_id = ${directory}.workstream_id
                              AND audience_placement.state = 'active'
                              AND audience_space.scope = 'workspace'
                              AND audience_space.archived_at IS NULL)
            OR EXISTS (SELECT 1 FROM space_channel_memberships audience_placement
                        WHERE audience_placement.workstream_id = ${directory}.workstream_id
                          AND audience_placement.state = 'active'
                          AND ${channelParticipantSql("audience_placement.space_id", occurredAt)}))`;
}

/**
 * Whether `?1` is told of a change inside a thread, such as a breakout
 * started or merged in it: the thread's participants alone, whoever else may
 * list it. `viewer` is the thread's `channel_viewers` row for `?1`,
 * left-joined, and `participant` any further participation that counts, such
 * as the breakout's own viewer row; pass `"0"` for none.
 */
export function threadChangeAudienceSql(viewer: string, participant = "0"): string {
  return `(${viewer}.is_participant = 1 OR ${participant})`;
}

/**
 * Whether `?1` is told about a post in the Channel `space` that is about the
 * thread whose `channel_viewers` row is `viewer`, posted at `occurredAt`:
 * always in a private Channel, else only as a participant of that thread or
 * of the Channel by then.
 */
export function channelPostAudienceSql(space: string, viewer: string, occurredAt: string): string {
  return `(${space}.scope <> 'workspace'
            OR ${viewer}.is_participant = 1
            OR ${channelParticipantSql(`${space}.space_id`, occurredAt)})`;
}

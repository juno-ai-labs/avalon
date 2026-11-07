/**
 * Who is told about news in an Organization-wide Channel; the rule was
 * recorded in the retired `docs/digests.md`. Every fragment is
 * code-owned SQL over caller-chosen aliases and reads the viewer's id from `?1`.
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
                     AND audience_space_viewer.joined_at <= ${occurredAt})`;
}

/**
 * Whether `?1` is told a thread started. `directory` is the thread's `channels`
 * row and `viewer` its `channel_viewers` row for `?1`, left-joined;
 * `occurredAt` is the start's time.
 */
export function threadStartAudienceSql(directory: string, viewer: string, occurredAt: string): string {
  return `(${directory}.scope <> 'workspace'
            OR ${viewer}.is_participant = 1
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

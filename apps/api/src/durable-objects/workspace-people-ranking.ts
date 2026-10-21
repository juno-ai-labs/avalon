import type { PeopleRanking } from "@rally/contracts";
import { breakoutListedSql, channelListedSql, mainOpenableSql, type Viewer } from "./listing-rules";

/** Seek the reader's own messages without visiting other authors' history. */
export const WORKSPACE_PEOPLE_RANKING_MIGRATION: readonly string[] = [
  `CREATE INDEX workspace_activity_people_actor_idx ON workspace_activity_events(actor_user_id, event_id)
    WHERE event_type = 'workstream_message_created' AND subject_type = 'workstream'
      AND actor_type = 'user' AND actor_user_id IS NOT NULL
      AND json_extract(metadata_json, '$.mergedFrom') IS NULL`,
];

/**
 * Read existing human message/mention facts, never a second interaction ledger.
 * Candidate seeks precede access joins; materialize that result once for all
 * three interaction directions. Unary + preserves the expression index's
 * affinity on the Breakout id, as in the Activity feed. See docs/shared-ui.md.
 */
export function rankPeople(storage: DurableObjectStorage, viewer: Viewer, spaceId: string | null): PeopleRanking {
  const rows = storage.sql.exec<{
    user_id: string; interactions: number; latest: number; channel_interactions: number; channel_latest: number;
  }>(`WITH candidate_events AS (
    SELECT event_id FROM workspace_activity_events INDEXED BY workspace_activity_people_actor_idx
     WHERE actor_user_id = ?1 AND event_type = 'workstream_message_created' AND subject_type = 'workstream'
       AND actor_type = 'user' AND actor_user_id IS NOT NULL
       AND json_extract(metadata_json, '$.mergedFrom') IS NULL
    UNION
    SELECT event_id FROM workspace_activity_event_targets INDEXED BY workspace_activity_event_targets_user_idx
     WHERE user_id = ?1 AND relation IN ('mentioned', 'participant')
    UNION
    SELECT event.event_id
      FROM breakout_viewers participant INDEXED BY breakout_viewers_user_participant_idx
      JOIN breakouts breakout ON breakout.workstream_id = participant.workstream_id
        AND breakout.substream_id = participant.substream_id
        AND breakout.authority_generation = participant.authority_generation AND breakout.archived_at IS NULL
      CROSS JOIN workspace_activity_events event INDEXED BY workspace_activity_replies_conversation_idx
     WHERE participant.user_id = ?1 AND participant.is_participant = 1
       AND event.subject_id = participant.workstream_id
       AND COALESCE(json_extract(event.metadata_json, '$.substreamId'), '0') = +participant.substream_id
       AND event.event_type = 'workstream_message_created' AND event.subject_type = 'workstream'
       AND event.actor_type = 'user' AND json_extract(event.metadata_json, '$.mergedFrom.breakoutId') IS NULL
       AND json_extract(event.metadata_json, '$.mergedFrom') IS NULL
  ), messages AS MATERIALIZED (
    SELECT event.event_id, event.actor_user_id, event.occurred_at, directory.workstream_id,
           breakout.substream_id, breakout.authority_generation AS breakout_generation,
           breakout_viewer.is_participant AS breakout_participant,
           EXISTS (SELECT 1 FROM space_channel_memberships placement
             WHERE placement.workstream_id = directory.workstream_id
               AND placement.space_id = ?2 AND placement.state = 'active') AS in_channel
      FROM candidate_events candidate
      CROSS JOIN workspace_activity_events event ON event.event_id = candidate.event_id
      JOIN channels directory ON directory.workstream_id = event.subject_id
      LEFT JOIN channel_viewers viewer ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?1 AND viewer.authority_generation = directory.authority_generation
      LEFT JOIN breakouts breakout ON breakout.workstream_id = directory.workstream_id
        AND breakout.substream_id = COALESCE(json_extract(event.metadata_json, '$.substreamId'), '0')
      LEFT JOIN breakout_viewers breakout_viewer ON breakout_viewer.workstream_id = breakout.workstream_id
        AND breakout_viewer.substream_id = breakout.substream_id AND breakout_viewer.user_id = ?1
        AND breakout_viewer.authority_generation = breakout.authority_generation
     WHERE event.event_type = 'workstream_message_created' AND event.subject_type = 'workstream'
       AND event.actor_type = 'user' AND event.actor_user_id IS NOT NULL
       AND json_extract(event.metadata_json, '$.mergedFrom') IS NULL
       AND directory.archived_at IS NULL
       AND ((COALESCE(json_extract(event.metadata_json, '$.substreamId'), '0') = '0'
             AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)})
         OR (breakout.archived_at IS NULL AND breakout.substream_id IS NOT NULL
             AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
             AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: true, userId: "?1" })}))
  ), interactions AS (
    SELECT message.event_id, target.user_id, message.occurred_at, message.in_channel
      FROM messages message JOIN workspace_activity_event_targets target ON target.event_id = message.event_id
     WHERE message.actor_user_id = ?1 AND target.user_id <> ?1
       AND target.relation IN ('mentioned', 'participant')
    UNION
    SELECT message.event_id, message.actor_user_id, message.occurred_at, message.in_channel
      FROM messages message
     WHERE message.actor_user_id <> ?1
       AND (message.breakout_participant = 1 OR EXISTS (
         SELECT 1 FROM workspace_activity_event_targets target
          WHERE target.event_id = message.event_id AND target.user_id = ?1
            AND target.relation IN ('mentioned', 'participant')))
    UNION
    SELECT message.event_id, participant.user_id, message.occurred_at, message.in_channel
      FROM messages message JOIN breakout_viewers participant
        ON participant.workstream_id = message.workstream_id AND participant.substream_id = message.substream_id
       AND participant.authority_generation = message.breakout_generation AND participant.is_participant = 1
     WHERE message.actor_user_id = ?1 AND participant.user_id <> ?1
  )
  SELECT user_id, COUNT(*) AS interactions, MAX(occurred_at) AS latest,
         SUM(in_channel) AS channel_interactions,
         MAX(CASE WHEN in_channel THEN occurred_at ELSE 0 END) AS channel_latest
    FROM interactions GROUP BY user_id
   ORDER BY interactions DESC, latest DESC, user_id`, viewer.userId, spaceId).toArray();
  return {
    channel: rows.filter((row) => row.channel_interactions > 0)
      .sort((a, b) => b.channel_interactions - a.channel_interactions || b.channel_latest - a.channel_latest || a.user_id.localeCompare(b.user_id))
      .map((row) => row.user_id),
    organization: rows.map((row) => row.user_id),
  };
}

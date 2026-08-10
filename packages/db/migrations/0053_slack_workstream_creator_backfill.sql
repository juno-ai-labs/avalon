-- Work streams started from Slack by a member Avalon could not yet map to an
-- account were stored without a creator, so every surface reads them as
-- automation output even after the Slack session resolved to that member. The
-- session assignment — a verified email match or an explicit account link — is
-- that mapping, so credit its member as the creator. Ambiguous work streams
-- (sessions assigned to different members) and work streams that already have
-- a creator are left untouched.
UPDATE workstreams
SET created_by_user_id = creator.user_id
FROM (
  SELECT s.workspace_id AS workspace_id,
         s.workstream_id AS workstream_id,
         MIN(s.assigned_user_id) AS user_id
  FROM slack_agent_sessions s
  JOIN workspace_members wm
    ON wm.workspace_id = s.workspace_id
   AND wm.user_id = s.assigned_user_id
   AND wm.status = 'active'
  WHERE s.assigned_user_id IS NOT NULL
  GROUP BY s.workspace_id, s.workstream_id
  HAVING COUNT(DISTINCT s.assigned_user_id) = 1
) AS creator
WHERE workstreams.id = creator.workstream_id
  AND workstreams.workspace_id = creator.workspace_id
  AND workstreams.created_by_user_id IS NULL;

-- The creator is a participant of their own work stream. Sessions assigned
-- before this migration already inserted the row; this covers the rest.
INSERT INTO workstream_participants
  (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
SELECT w.id, w.created_by_user_id, w.created_by_user_id, 'creator', w.created_at, NULL
FROM workstreams w
JOIN slack_agent_sessions s
  ON s.workstream_id = w.id AND s.workspace_id = w.workspace_id
 AND s.assigned_user_id = w.created_by_user_id
WHERE w.created_by_user_id IS NOT NULL
-- A member who was removed from the work stream stays removed; restoring them
-- is a membership decision, not an attribution one.
ON CONFLICT(workstream_id, user_id) DO NOTHING;

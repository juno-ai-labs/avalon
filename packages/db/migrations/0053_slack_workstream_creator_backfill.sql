-- Work streams started from Slack by a member Avalon could not yet map to an
-- account were stored without a creator, so every surface reads them as
-- automation output even after the Slack session resolved to that member. The
-- session assignment — a verified email match or an explicit account link — is
-- that mapping, so credit its member as the creator. Work streams that already
-- have a creator are left untouched, as are ambiguous ones — where the sessions
-- name different members. Ambiguity is judged among active members only: a
-- session assigned to somebody who has since been suspended does not block the
-- one remaining active member from being credited.
--
-- A claim also writes `assigned_user_id`, and any linked member may claim a
-- task that needs personal authority. A session claimed by someone other than
-- the Slack member who started it therefore says who took the task over, not
-- who created it, and is excluded — the same rule the runtime claim path
-- applies. Verified-email and account-link assignments leave
-- `claimed_by_slack_user_id` null or equal to the original author.
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
    AND (s.claimed_by_slack_user_id IS NULL
         OR s.claimed_by_slack_user_id = s.slack_user_id)
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

-- A creator already added by an earlier session assignment carries the reason
-- that assignment used. The People rail subtitles a participant with it, so a
-- credited creator would otherwise read "explicit".
UPDATE workstream_participants
SET participation_reason = 'creator'
WHERE participation_reason <> 'creator'
  AND EXISTS (
    SELECT 1 FROM workstreams w
    JOIN slack_agent_sessions s
      ON s.workstream_id = w.id AND s.workspace_id = w.workspace_id
    WHERE w.id = workstream_participants.workstream_id
      AND w.created_by_user_id = workstream_participants.user_id
      AND s.assigned_user_id = w.created_by_user_id
  );

-- A personal automation can now deliver each result to the owner's email
-- address as well as to a Slack Agent DM. Email targets carry no connector
-- connection and no Slack identity, so those columns become nullable and a
-- per-type shape check replaces the NOT NULL constraints they had.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE automation_delivery_targets_with_email (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('slack_agent_dm', 'email')),
  connection_id TEXT REFERENCES connector_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_team_id TEXT,
  slack_user_id TEXT,
  email_address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_input', 'disabled')),
  last_delivered_at TEXT,
  last_delivered_workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_subscription_id, target_type),
  CHECK (
    (target_type = 'slack_agent_dm'
      AND connection_id IS NOT NULL AND slack_team_id IS NOT NULL
      AND slack_user_id IS NOT NULL AND email_address IS NULL)
    OR (target_type = 'email'
      AND connection_id IS NULL AND slack_team_id IS NULL
      AND slack_user_id IS NULL AND email_address IS NOT NULL)
  )
);

INSERT INTO automation_delivery_targets_with_email
SELECT id, workspace_id, automation_subscription_id, target_type, connection_id,
       user_id, slack_team_id, slack_user_id, NULL, status, last_delivered_at,
       last_delivered_workstream_id, last_error_json, created_at, updated_at
FROM automation_delivery_targets;

DROP TABLE automation_delivery_targets;

ALTER TABLE automation_delivery_targets_with_email RENAME TO automation_delivery_targets;

CREATE INDEX automation_delivery_targets_connection_idx
  ON automation_delivery_targets(connection_id, status);

PRAGMA defer_foreign_keys = OFF;

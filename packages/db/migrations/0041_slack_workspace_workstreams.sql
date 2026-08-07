-- Workspace-owned Slack work streams retain the initiating Slack member as
-- external attribution without manufacturing an Avalon user identity.
ALTER TABLE messages ADD COLUMN external_actor_json TEXT
  CHECK (external_actor_json IS NULL OR json_valid(external_actor_json));

ALTER TABLE elicitations ADD COLUMN answered_by_external_actor_json TEXT
  CHECK (
    answered_by_external_actor_json IS NULL
    OR json_valid(answered_by_external_actor_json)
  );

DROP INDEX IF EXISTS slack_agent_sessions_workstream_idx;
ALTER TABLE slack_agent_sessions RENAME TO slack_agent_sessions_before_workspace_principal;

CREATE TABLE slack_agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  execution_scope TEXT NOT NULL CHECK (execution_scope IN ('user', 'workspace')),
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  slack_stream_ts TEXT,
  last_delivery_key TEXT,
  opening_client_message_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  invocation_kind TEXT NOT NULL CHECK (
    invocation_kind IN ('app_mention', 'direct_message', 'slash_command', 'shortcut')
  ),
  channel_type TEXT NOT NULL CHECK (channel_type IN ('public', 'private', 'im', 'unknown')),
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT,
  assignment_method TEXT CHECK (
    assignment_method IS NULL OR assignment_method IN ('verified_email', 'explicit_link')
  ),
  claimed_by_slack_user_id TEXT,
  claimed_at TEXT,
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, slack_channel_id, slack_thread_ts),
  UNIQUE (workstream_id),
  CHECK (
    (execution_scope = 'user' AND linked_user_id IS NOT NULL)
    OR execution_scope = 'workspace'
  )
);

INSERT INTO slack_agent_sessions (
  id, workspace_id, connection_id, linked_user_id, execution_scope,
  slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
  slack_stream_ts, last_delivery_key, opening_client_message_id, workstream_id, invocation_kind,
  channel_type, assigned_user_id, assigned_at, assignment_method,
  claimed_by_slack_user_id, claimed_at, context_json,
  created_at, updated_at
)
SELECT
  id, workspace_id, connection_id, user_id, 'user',
  slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
  slack_stream_ts, last_delivery_key, 'legacy:' || id, workstream_id, 'direct_message',
  'unknown', user_id, created_at, 'explicit_link',
  slack_user_id, created_at, context_json, created_at, updated_at
FROM slack_agent_sessions_before_workspace_principal;

DROP TABLE slack_agent_sessions_before_workspace_principal;

CREATE INDEX slack_agent_sessions_workstream_idx
  ON slack_agent_sessions(workspace_id, workstream_id);

-- Defaults allow explicit mentions in public channels where the bot receives
-- the event, direct messages, commands, and shortcuts. Private channels stay
-- disabled unless an administrator explicitly allowlists them.
CREATE TABLE slack_agent_policies (
  connection_id TEXT PRIMARY KEY REFERENCES connector_connections(id) ON DELETE CASCADE,
  allow_unlinked_workspace_tasks INTEGER NOT NULL DEFAULT 1
    CHECK (allow_unlinked_workspace_tasks IN (0, 1)),
  public_channel_mode TEXT NOT NULL DEFAULT 'all_invited'
    CHECK (public_channel_mode IN ('all_invited', 'allowlist', 'disabled')),
  private_channel_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (private_channel_mode IN ('allowlist', 'disabled')),
  allow_direct_messages INTEGER NOT NULL DEFAULT 1
    CHECK (allow_direct_messages IN (0, 1)),
  allow_commands INTEGER NOT NULL DEFAULT 1
    CHECK (allow_commands IN (0, 1)),
  allow_shortcuts INTEGER NOT NULL DEFAULT 1
    CHECK (allow_shortcuts IN (0, 1)),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO slack_agent_policies (connection_id, created_at, updated_at)
SELECT id, created_at, updated_at
FROM connector_connections
WHERE connector_type = 'slack' AND scope = 'workspace';

CREATE TABLE slack_agent_channel_allowlist (
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  slack_channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('public', 'private')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, slack_channel_id)
);

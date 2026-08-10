-- Keep denied Slack prompts briefly so a user can retry after an administrator
-- fixes the connection or agent policy without retyping the original request.
CREATE TABLE slack_agent_pending_prompts (
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 40000),
  denial_reason TEXT NOT NULL CHECK (
    denial_reason IN ('connection', 'channel_resolution', 'policy')
  ),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, slack_channel_id, slack_thread_ts, slack_user_id)
);

CREATE INDEX slack_agent_pending_prompts_expiry_idx
  ON slack_agent_pending_prompts(expires_at);

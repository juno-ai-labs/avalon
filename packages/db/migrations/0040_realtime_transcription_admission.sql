CREATE TABLE realtime_transcription_ticket_receipts (
  ticket_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
    CHECK (expires_at > consumed_at)
);

CREATE INDEX realtime_transcription_ticket_receipts_expiry_idx
ON realtime_transcription_ticket_receipts(expires_at);

CREATE TABLE realtime_transcription_sessions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
    CHECK (expires_at > started_at)
);

CREATE INDEX realtime_transcription_sessions_user_idx
ON realtime_transcription_sessions(workspace_id, user_id, expires_at);

CREATE INDEX realtime_transcription_sessions_workspace_idx
ON realtime_transcription_sessions(workspace_id, expires_at);

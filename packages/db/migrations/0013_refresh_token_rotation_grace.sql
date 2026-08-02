PRAGMA foreign_keys = ON;

-- Keep only the immediately previous refresh-token hash for a short replay
-- window. If a rotation response is lost, the client can safely retry the old
-- token and receive a fresh successor instead of being permanently stranded.
ALTER TABLE sessions ADD COLUMN previous_refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN refresh_rotated_at TEXT;

CREATE INDEX sessions_previous_refresh_token_idx
  ON sessions(previous_refresh_token_hash, refresh_rotated_at);

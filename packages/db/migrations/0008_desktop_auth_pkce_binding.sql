ALTER TABLE oauth_states ADD COLUMN desktop_attempt_id TEXT;
ALTER TABLE oauth_states ADD COLUMN desktop_code_challenge TEXT;

ALTER TABLE desktop_login_tickets ADD COLUMN desktop_attempt_id TEXT;
ALTER TABLE desktop_login_tickets ADD COLUMN desktop_code_challenge TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_desktop_attempt_idx
  ON oauth_states(desktop_attempt_id)
  WHERE desktop_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS desktop_login_tickets_attempt_idx
  ON desktop_login_tickets(desktop_attempt_id)
  WHERE desktop_attempt_id IS NOT NULL;

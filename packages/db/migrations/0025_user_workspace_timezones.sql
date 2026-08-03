ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';

ALTER TABLE workspaces ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';

UPDATE users SET timezone = 'America/Los_Angeles';

UPDATE workspaces
SET timezone = CASE
  WHEN region = 'eu' THEN 'Europe/London'
  ELSE 'America/Los_Angeles'
END;

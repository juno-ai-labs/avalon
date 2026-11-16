-- Migration-first: the Worker before it reads neither column. A connector
-- callback holds its result here until the starting session claims it
-- (docs/connectors.md, "Claiming a connector authorization").
ALTER TABLE oauth_states ADD COLUMN held_callback_encrypted TEXT;
ALTER TABLE oauth_states ADD COLUMN claim_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_claim_idx
  ON oauth_states(claim_hash)
  WHERE claim_hash IS NOT NULL;

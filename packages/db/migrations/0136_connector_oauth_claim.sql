-- Migration-first: the Worker before it reads neither column, and a state
-- with neither is one no callback has reached yet.
--
-- A connector authorization now completes in two requests, as a desktop
-- sign-in does. The provider's callback holds its result here, sealed, and
-- hands the browser that consented a one-time ticket; the signed-in client
-- that started the authorization claims the ticket, and only then is the code
-- exchanged. Completing on the state alone let an authorization link one
-- person started attach another person's provider account to it.
-- States live ten minutes; no backfill is needed.
ALTER TABLE oauth_states ADD COLUMN held_callback_encrypted TEXT;
ALTER TABLE oauth_states ADD COLUMN claim_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_claim_idx
  ON oauth_states(claim_hash)
  WHERE claim_hash IS NOT NULL;

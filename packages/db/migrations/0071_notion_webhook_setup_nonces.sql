-- Notion's subscription verification request is unsigned. Authorize it with a
-- short-lived, single-use nonce rather than a reusable Worker secret embedded
-- in the permanent webhook URL. Only the Global ingress reads these rows; the
-- table also exists in EU because migrations remain identical by region.
CREATE TABLE notion_webhook_setup_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (length(nonce_hash) = 43),
  verification_token_hash TEXT CHECK (
    verification_token_hash IS NULL OR length(verification_token_hash) = 43
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (
    (consumed_at IS NULL AND verification_token_hash IS NULL)
    OR (consumed_at IS NOT NULL AND verification_token_hash IS NOT NULL)
  )
);

CREATE INDEX notion_webhook_setup_nonces_expiry_idx
  ON notion_webhook_setup_nonces(expires_at)
  WHERE consumed_at IS NULL;

-- Links the active encrypted verification token to the nonce that installed
-- it. A retry of that nonce is idempotent; a nonce superseded by a later setup
-- can no longer restore the old signing secret.
ALTER TABLE provider_webhook_challenges
  ADD COLUMN setup_nonce_hash TEXT CHECK (
    setup_nonce_hash IS NULL OR length(setup_nonce_hash) = 43
  );

-- Claiming a new nonce makes it the only nonce allowed to retry the current
-- setup. Keep that link in the same SQLite statement as the claim: a Worker
-- failure after the claim can then retry safely, while a superseded nonce can
-- never race in and restore an earlier verification token.
CREATE TRIGGER notion_webhook_setup_nonce_consumed
AFTER UPDATE OF consumed_at ON notion_webhook_setup_nonces
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
BEGIN
  UPDATE provider_webhook_challenges
  SET setup_nonce_hash = NEW.nonce_hash
  WHERE provider = 'notion';
END;

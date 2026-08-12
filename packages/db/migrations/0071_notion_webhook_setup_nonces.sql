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
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  CHECK (
    (consumed_at IS NULL AND verification_token_hash IS NULL)
    OR (consumed_at IS NOT NULL AND verification_token_hash IS NOT NULL)
  )
);

CREATE INDEX notion_webhook_setup_nonces_expiry_idx
  ON notion_webhook_setup_nonces(expires_at)
  WHERE consumed_at IS NULL;

-- This is the database serialization point for concurrent operator commands.
-- A D1 batch changes the previous row and inserts its replacement atomically;
-- the unique index also makes it impossible for any other writer to leave two
-- current setup generations behind.
CREATE UNIQUE INDEX notion_webhook_setup_nonces_current_idx
  ON notion_webhook_setup_nonces(is_current)
  WHERE is_current = 1;

-- Links the active encrypted verification token to the nonce that installed
-- it. A retry of that nonce is idempotent; a nonce superseded by a later setup
-- can no longer restore the old signing secret.
ALTER TABLE provider_webhook_challenges
  ADD COLUMN setup_nonce_hash TEXT CHECK (
    setup_nonce_hash IS NULL OR length(setup_nonce_hash) = 43
  );

-- The nonce rowid is a monotonic setup generation. Replicating it lets the EU
-- database reject an older Global request that arrives after a newer one.
ALTER TABLE provider_webhook_challenges
  ADD COLUMN setup_generation INTEGER CHECK (
    setup_generation IS NULL OR setup_generation > 0
  );

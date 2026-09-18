CREATE TABLE email_login_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  magic_hash TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_failed_attempts INTEGER CHECK (max_failed_attempts > 0),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_payload_encrypted TEXT NOT NULL,
  delivery_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redemption_id TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE,
  session_secret_encrypted TEXT,
  CHECK ((redeemed_at IS NULL AND redemption_id IS NULL AND user_id IS NULL AND session_id IS NULL AND session_secret_encrypted IS NULL)
    OR (redeemed_at IS NOT NULL AND redemption_id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND session_secret_encrypted IS NOT NULL))
) STRICT;
CREATE INDEX email_login_delivery_pending_idx ON email_login_challenges(created_at,id)
  WHERE delivery_sent_at IS NULL AND redeemed_at IS NULL;

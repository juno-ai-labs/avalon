-- Opaque delivery references only; encrypted bodies remain with their callers.
-- Transactional mail parks uncertain attempts; notification mail records
-- completed sends while retaining at-least-once retries of transient failures.
CREATE TABLE email_delivery_receipts (
  delivery_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'review_required', 'failed')),
  attempt_token TEXT,
  diagnostic_code TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

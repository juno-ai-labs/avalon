/** Real D1 starts empty in workerd; the opaque delivery control plane only. */
export const EMAIL_DELIVERY_TABLE = `CREATE TABLE email_delivery_receipts (
  delivery_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'review_required', 'failed')),
  attempt_token TEXT,
  diagnostic_code TEXT,
  updated_at INTEGER NOT NULL
) STRICT`;

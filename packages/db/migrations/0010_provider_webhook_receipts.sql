CREATE TABLE provider_webhook_receipts (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear', 'notion')),
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_json TEXT,
  PRIMARY KEY (provider, delivery_id)
);

CREATE INDEX provider_webhook_receipts_received_idx
  ON provider_webhook_receipts(provider, received_at DESC);

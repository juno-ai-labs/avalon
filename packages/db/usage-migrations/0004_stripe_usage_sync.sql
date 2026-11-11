-- Absolute UTC-hour totals survive raw-event retention. Their revision is the
-- outbox: a receipt for an older revision cannot acknowledge a later event.
CREATE TABLE billing_usage_hours (
  workspace_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  organization_pays INTEGER NOT NULL CHECK (organization_pays IN (0, 1)),
  amount_microusd INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  meter_id TEXT,
  sent_revision INTEGER NOT NULL DEFAULT 0,
  confirmed_revision INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER,
  confirmed_at INTEGER,
  error_code TEXT,
  PRIMARY KEY (workspace_id, hour_start, organization_pays)
);

-- Backfill the retained ledger without inventing timestamps for older usage.
-- Stripe's 35-day ingestion boundary is handled explicitly by the dispatcher.
INSERT INTO billing_usage_hours (workspace_id, hour_start, organization_pays, amount_microusd)
SELECT workspace_id, (unixepoch(occurred_at) / 3600) * 3600, organization_pays, SUM(cost_microusd)
FROM usage_events GROUP BY workspace_id, (unixepoch(occurred_at) / 3600) * 3600, organization_pays;

CREATE TRIGGER usage_billing_hour_insert AFTER INSERT ON usage_events BEGIN
  INSERT INTO billing_usage_hours (workspace_id, hour_start, organization_pays, amount_microusd)
  VALUES (NEW.workspace_id, (unixepoch(NEW.occurred_at) / 3600) * 3600, NEW.organization_pays, NEW.cost_microusd)
  ON CONFLICT (workspace_id, hour_start, organization_pays) DO UPDATE SET
    amount_microusd = amount_microusd + excluded.amount_microusd,
    revision = revision + 1,
    error_code = NULL;
END;

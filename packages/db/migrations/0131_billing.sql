-- Billing belongs to the organization, including single-person organizations.
CREATE TABLE billing_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  checkout_id TEXT,
  status TEXT NOT NULL DEFAULT 'none',
  offer_id TEXT,
  currency TEXT,
  trial_started_at INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL,
  trial_extended INTEGER NOT NULL DEFAULT 0,
  overage_started_at INTEGER,
  overage_enabled INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT,
  sync_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE billing_overages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_microusd INTEGER NOT NULL,
  price_id TEXT NOT NULL,
  invoice_item_id TEXT,
  PRIMARY KEY (workspace_id, period_start)
);

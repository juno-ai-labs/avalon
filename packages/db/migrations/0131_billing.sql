ALTER TABLE workspaces ADD COLUMN billing_plan_override INTEGER NOT NULL DEFAULT 0;

-- Billing belongs to the organization, including single-person organizations.
CREATE TABLE billing_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  free_subscription_id TEXT UNIQUE,
  free_subscription_closed INTEGER NOT NULL DEFAULT 0,
  trial_award_synced_end INTEGER,
  checkout_generation TEXT NOT NULL,
  checkout_request_json TEXT,
  status TEXT NOT NULL DEFAULT 'none',
  offer_id TEXT,
  currency TEXT,
  trial_started_at INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL,
  trial_base_ends_at INTEGER NOT NULL,
  team_trial_ends_at INTEGER NOT NULL,
  team_trial_members INTEGER NOT NULL,
  trial_extended INTEGER NOT NULL DEFAULT 0,
  overage_started_at INTEGER,
  overage_enabled INTEGER NOT NULL DEFAULT 0
);
-- Preserve paid terms after cancellation/re-subscription, independently of the current account.
CREATE TABLE billing_terms (
  subscription_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  cutoff_quota_microusd INTEGER,
  final_invoice_id TEXT,
  final_invoice_finalized INTEGER NOT NULL DEFAULT 0
);
-- Each resumption starts a new billable interval; suspended gaps never become debt.
CREATE TABLE billing_intervals (
  subscription_id TEXT NOT NULL REFERENCES billing_terms(subscription_id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  price_id TEXT NOT NULL,
  cutoff_quota_microusd INTEGER,
  PRIMARY KEY(subscription_id, starts_at)
);
CREATE UNIQUE INDEX billing_interval_open ON billing_intervals(subscription_id) WHERE ends_at IS NULL;
CREATE TRIGGER billing_initial_interval AFTER INSERT ON billing_terms BEGIN
  INSERT INTO billing_intervals(subscription_id, starts_at, ends_at, price_id, cutoff_quota_microusd)
  VALUES (NEW.subscription_id, NEW.starts_at, NEW.ends_at, NEW.price_id, NEW.cutoff_quota_microusd);
END;
CREATE TABLE billing_overages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES billing_terms(subscription_id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_microusd INTEGER NOT NULL,
  price_id TEXT NOT NULL,
  invoice_item_id TEXT,
  meter_id TEXT,
  meter_event_at INTEGER,
  PRIMARY KEY (subscription_id, period_start)
);

-- Request receipts only. Stripe owns grants, balances, expiry and redemption.
CREATE TABLE billing_credit_operations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  stripe_grant_id TEXT,
  PRIMARY KEY (workspace_id, operation_id)
);
CREATE TABLE billing_trial_operations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  delivery_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  PRIMARY KEY (workspace_id, operation_id)
);
-- A separate metered subscription keeps cancellation-tail usage billable and
-- keeps subscription-fee coupons off overages. Stripe closes it at period end.
CREATE TABLE billing_overage_subscriptions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  price_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  subscription_id TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, price_id)
);

-- Record qualification at the actual transition, independent of lazy account creation.
-- Counts retain earned eligibility after departure, without retaining user identities.
-- Explicit UPSERT survives an outer membership UPSERT's conflict policy; OR IGNORE
-- can be overridden and reject two identical qualifications within one second.
CREATE TABLE billing_team_qualifications (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  qualified_at INTEGER NOT NULL,
  members INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, qualified_at, members)
);
INSERT INTO billing_team_qualifications(workspace_id, qualified_at, members)
  SELECT workspace_id, unixepoch(), COUNT(*) FROM workspace_members
  WHERE status = 'active' AND access_class = 'member' GROUP BY workspace_id;
CREATE TRIGGER billing_member_insert AFTER INSERT ON workspace_members
WHEN NEW.status = 'active' AND NEW.access_class = 'member' BEGIN
  INSERT INTO billing_team_qualifications(workspace_id, qualified_at, members)
    SELECT NEW.workspace_id, unixepoch(), COUNT(*) FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND status = 'active' AND access_class = 'member'
    ON CONFLICT (workspace_id, qualified_at, members) DO NOTHING;
END;
CREATE TRIGGER billing_member_update AFTER UPDATE OF status, access_class ON workspace_members
WHEN NEW.status = 'active' AND NEW.access_class = 'member'
  AND (OLD.status <> 'active' OR OLD.access_class <> 'member') BEGIN
  INSERT INTO billing_team_qualifications(workspace_id, qualified_at, members)
    SELECT NEW.workspace_id, unixepoch(), COUNT(*) FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND status = 'active' AND access_class = 'member'
    ON CONFLICT (workspace_id, qualified_at, members) DO NOTHING;
END;
CREATE TRIGGER billing_team_trial_award AFTER INSERT ON billing_team_qualifications BEGIN
  UPDATE billing_accounts SET trial_extended = 1, trial_ends_at = MAX(trial_ends_at, team_trial_ends_at)
    WHERE workspace_id = NEW.workspace_id AND trial_extended = 0 AND subscription_id IS NULL
      AND NEW.qualified_at < trial_base_ends_at AND NEW.members >= team_trial_members;
END;

-- Deployment configuration enables billing and owns infrastructure. Operators
-- version the commercial catalog without losing retired subscription mappings.
CREATE TABLE billing_catalog (
  region TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  catalog_json TEXT NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE TABLE billing_admin_operations (
  scope TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  delivery_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  result_json TEXT,
  error_code TEXT,
  PRIMARY KEY (scope, operation_id)
);

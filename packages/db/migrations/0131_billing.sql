-- Billing belongs to the organization, including single-person organizations.
CREATE TABLE billing_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  free_subscription_id TEXT UNIQUE,
  trial_award_synced_end INTEGER,
  checkout_generation TEXT NOT NULL,
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
  overage_enabled INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT
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
  final_invoice_id TEXT
);
CREATE TABLE billing_overages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES billing_terms(subscription_id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_microusd INTEGER NOT NULL,
  price_id TEXT NOT NULL,
  invoice_item_id TEXT,
  PRIMARY KEY (subscription_id, period_start)
);

-- Award at the membership transition, so a later departure/read cannot erase an earned offer.
CREATE TRIGGER billing_team_trial_insert AFTER INSERT ON workspace_members BEGIN
  UPDATE billing_accounts SET trial_extended = 1, trial_ends_at = MAX(trial_ends_at, team_trial_ends_at)
  WHERE workspace_id = NEW.workspace_id AND trial_extended = 0 AND subscription_id IS NULL
    AND (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = NEW.workspace_id
      AND m.status = 'active' AND m.access_class = 'member'
      AND unixepoch(m.joined_at) < trial_base_ends_at) >= team_trial_members;
END;
CREATE TRIGGER billing_team_trial_update AFTER UPDATE OF status, access_class, joined_at ON workspace_members BEGIN
  UPDATE billing_accounts SET trial_extended = 1, trial_ends_at = MAX(trial_ends_at, team_trial_ends_at)
  WHERE workspace_id = NEW.workspace_id AND trial_extended = 0 AND subscription_id IS NULL
    AND (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = NEW.workspace_id
      AND m.status = 'active' AND m.access_class = 'member'
      AND unixepoch(m.joined_at) < trial_base_ends_at) >= team_trial_members;
END;

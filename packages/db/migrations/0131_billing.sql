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
  final_invoice_id TEXT,
  final_invoice_finalized INTEGER NOT NULL DEFAULT 0
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

-- Record qualification at the actual transition, independent of lazy account creation.
-- Counts retain earned eligibility after departure, without retaining user identities.
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
  INSERT OR IGNORE INTO billing_team_qualifications(workspace_id, qualified_at, members)
    SELECT NEW.workspace_id, unixepoch(), COUNT(*) FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND status = 'active' AND access_class = 'member';
END;
CREATE TRIGGER billing_member_update AFTER UPDATE OF status, access_class ON workspace_members
WHEN NEW.status = 'active' AND NEW.access_class = 'member'
  AND (OLD.status <> 'active' OR OLD.access_class <> 'member') BEGIN
  INSERT OR IGNORE INTO billing_team_qualifications(workspace_id, qualified_at, members)
    SELECT NEW.workspace_id, unixepoch(), COUNT(*) FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND status = 'active' AND access_class = 'member';
END;
CREATE TRIGGER billing_team_trial_award AFTER INSERT ON billing_team_qualifications BEGIN
  UPDATE billing_accounts SET trial_extended = 1, trial_ends_at = MAX(trial_ends_at, team_trial_ends_at)
    WHERE workspace_id = NEW.workspace_id AND trial_extended = 0 AND subscription_id IS NULL
      AND NEW.qualified_at < trial_base_ends_at AND NEW.members >= team_trial_members;
END;

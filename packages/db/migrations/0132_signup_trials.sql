-- Stripe owns trial deadlines and cancellation. These rows retain the original
-- creation request so a delayed retry cannot award a second trial.
CREATE TABLE billing_signup_trials (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,
  subscription_id TEXT
);
ALTER TABLE billing_accounts ADD COLUMN payment_method_ready INTEGER NOT NULL DEFAULT 0;

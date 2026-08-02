ALTER TABLE automation_runs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_activity_unique_idx
  ON automation_runs(automation_subscription_id, trigger_activity_id)
  WHERE trigger_activity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_manual_idempotency_unique_idx
  ON automation_runs(workspace_id, automation_subscription_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

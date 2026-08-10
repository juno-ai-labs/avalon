ALTER TABLE automation_subscriptions
ADD COLUMN activity_trigger_bindings_json TEXT NOT NULL DEFAULT '{}';

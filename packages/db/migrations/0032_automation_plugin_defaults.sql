ALTER TABLE automation_template_versions ADD COLUMN overview TEXT NOT NULL DEFAULT '';
ALTER TABLE automation_template_versions ADD COLUMN recommended_plugins_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE automation_subscriptions ADD COLUMN default_plugins_json TEXT NOT NULL DEFAULT '[]';

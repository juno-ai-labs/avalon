CREATE TABLE user_push_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  transport TEXT NOT NULL,
  topic TEXT NOT NULL,
  apns_environment TEXT NOT NULL,
  token TEXT NOT NULL,
  app_version TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disabled_at TEXT,
  disabled_reason TEXT,
  last_delivery_at TEXT,
  last_failure_code TEXT,
  UNIQUE (user_id, installation_id, transport)
);
CREATE INDEX user_push_devices_by_user ON user_push_devices(user_id);
CREATE INDEX user_push_devices_by_token ON user_push_devices(token);
CREATE TABLE user_push_device_sessions (
  device_id TEXT NOT NULL REFERENCES user_push_devices(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, session_id)
);
CREATE TABLE push_delivery_receipts (
  workspace_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES user_push_devices(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, intent_id, device_id)
);

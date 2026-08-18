-- Durable inbox for external/regional effects emitted by authoritative
-- Workstream Durable Objects. Workspace directory effects travel directly to
-- WorkspaceDO and never land in D1.
CREATE TABLE workstream_regional_effect_receipts (
  message_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  partition_key TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  effect_kind TEXT NOT NULL CHECK (effect_kind IN ('activity_event', 'mention_notification')),
  payload_hash TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  acknowledged_at TEXT,
  UNIQUE (workstream_id, generation, partition_key, source_version)
);

CREATE INDEX workstream_regional_effect_receipts_source_idx
  ON workstream_regional_effect_receipts(
    workspace_id, workstream_id, generation, partition_key, source_version DESC
  );

CREATE INDEX workstream_regional_effect_receipts_ack_idx
  ON workstream_regional_effect_receipts(acknowledged_at, applied_at)
  WHERE acknowledged_at IS NOT NULL;

-- External delivery is deliberately a regional concern. The WorkstreamDO
-- provides the immutable intent, while this short-lived row resolves current
-- membership, profile, preferences, connector credentials, and email address.
-- payload_json is erased after a terminal outcome so message text is not kept
-- as a second transcript.
CREATE TABLE workstream_notification_intents (
  intent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
  notification_kind TEXT NOT NULL CHECK (notification_kind = 'mention'),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'delivered', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (source_message_id, recipient_user_id, notification_kind)
);

CREATE INDEX workstream_notification_intents_delivery_idx
  ON workstream_notification_intents(state, lease_expires_at, created_at);

CREATE INDEX workstream_notification_intents_terminal_idx
  ON workstream_notification_intents(state, updated_at)
  WHERE state IN ('delivered', 'skipped');

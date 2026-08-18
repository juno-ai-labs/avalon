ALTER TABLE users ADD COLUMN analytics_person_id TEXT;
ALTER TABLE users ADD COLUMN product_analytics_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (product_analytics_enabled IN (0, 1));
ALTER TABLE users ADD COLUMN product_analytics_preference_version INTEGER NOT NULL DEFAULT 1
  CHECK (product_analytics_preference_version > 0);
ALTER TABLE users ADD COLUMN preference_subject_handle TEXT;

CREATE UNIQUE INDEX users_analytics_person_id_idx
  ON users(analytics_person_id) WHERE analytics_person_id IS NOT NULL;
CREATE UNIQUE INDEX users_preference_subject_handle_idx
  ON users(preference_subject_handle) WHERE preference_subject_handle IS NOT NULL;

ALTER TABLE workspaces ADD COLUMN analytics_workspace_id TEXT;
CREATE UNIQUE INDEX workspaces_analytics_workspace_id_idx
  ON workspaces(analytics_workspace_id) WHERE analytics_workspace_id IS NOT NULL;

CREATE TABLE telemetry_accepted_events (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('global', 'eu')),
  routing_basis TEXT NOT NULL CHECK (
    routing_basis IN ('explicit_binding', 'explicit_selection', 'ip_geolocation', 'geolocation_fallback')
  ),
  analytics_subject_id TEXT NOT NULL,
  workspace_analytics_id TEXT,
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TEXT NOT NULL,
  normalized_timestamp TEXT NOT NULL,
  delete_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (
    delivery_state IN ('pending', 'delivering', 'delivered', 'retrying', 'suppressed', 'terminal', 'expired')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  delivered_at TEXT,
  terminal_code TEXT,
  CHECK ((route = 'global') OR (delivery_state NOT IN ('delivering', 'delivered', 'retrying')))
);

CREATE INDEX telemetry_accepted_events_delivery_idx
  ON telemetry_accepted_events(delivery_state, next_attempt_at, accepted_at);
CREATE INDEX telemetry_accepted_events_expiry_idx ON telemetry_accepted_events(delete_at);
CREATE INDEX telemetry_accepted_events_subject_idx
  ON telemetry_accepted_events(subject_user_id, delete_at) WHERE subject_user_id IS NOT NULL;

CREATE TRIGGER telemetry_accepted_event_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_accepted_events
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_eu_events (
  -- This is an independently expiring semantic contribution, not delivery
  -- metadata. A foreign-key cascade would incorrectly truncate its 13-month
  -- analysis window when the 90-day acceptance row is reaped.
  event_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  identity_scope TEXT NOT NULL,
  analytics_subject_id TEXT NOT NULL,
  workspace_analytics_id TEXT,
  normalized_timestamp TEXT NOT NULL,
  environment TEXT,
  release TEXT,
  build_id TEXT,
  platform TEXT,
  architecture TEXT,
  channel TEXT,
  launch_id TEXT,
  session_id TEXT,
  operation_id TEXT,
  properties_json TEXT NOT NULL,
  delete_at TEXT NOT NULL
);

CREATE INDEX telemetry_eu_events_query_idx
  ON telemetry_eu_events(event_name, normalized_timestamp);
CREATE INDEX telemetry_eu_events_subject_idx
  ON telemetry_eu_events(analytics_subject_id, delete_at);
CREATE INDEX telemetry_eu_events_expiry_idx ON telemetry_eu_events(delete_at);
CREATE INDEX telemetry_eu_events_release_health_idx
  ON telemetry_eu_events(event_name, release, platform, architecture, channel, normalized_timestamp);
CREATE INDEX telemetry_eu_events_launch_idx
  ON telemetry_eu_events(launch_id, normalized_timestamp) WHERE launch_id IS NOT NULL;

CREATE TRIGGER telemetry_eu_event_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_eu_events
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_onboarding_journeys (
  journey_id TEXT PRIMARY KEY,
  anonymous_epoch_id TEXT NOT NULL UNIQUE,
  route TEXT NOT NULL CHECK (route IN ('global', 'eu')),
  routing_basis TEXT NOT NULL CHECK (routing_basis IN ('ip_geolocation', 'geolocation_fallback')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_onboarding_journeys_expiry_idx
  ON telemetry_onboarding_journeys(delete_at);

CREATE TRIGGER telemetry_onboarding_journey_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_onboarding_journeys
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_crash_reports (
  crash_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  installation_analytics_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('global', 'eu')),
  object_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  content_sha256 TEXT NOT NULL,
  release TEXT NOT NULL,
  build_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  architecture TEXT NOT NULL CHECK (architecture IN ('arm64', 'x64')),
  process_role TEXT NOT NULL CHECK (process_role IN ('main', 'renderer', 'utility', 'gpu', 'unknown')),
  launch_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('development', 'alpha', 'beta', 'stable')),
  breadcrumbs_json TEXT,
  breadcrumb_status TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (breadcrumb_status IN ('available', 'stale', 'unavailable')),
  parser_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (parser_state IN ('pending', 'processing', 'symbolicated', 'unsymbolicated', 'malformed', 'failed')),
  structured_report_json TEXT,
  issue_fingerprint TEXT,
  processing_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempt_count >= 0),
  processing_next_attempt_at TEXT,
  processing_started_at TEXT,
  destination_state TEXT NOT NULL DEFAULT 'waiting_for_processing'
    CHECK (destination_state IN ('waiting_for_processing', 'pending', 'delivered', 'retrying', 'terminal', 'internal_only', 'suppressed')),
  destination_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (destination_attempt_count >= 0),
  destination_next_attempt_at TEXT,
  destination_delivered_at TEXT,
  received_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_crash_reports_processing_idx
  ON telemetry_crash_reports(parser_state, received_at);
CREATE INDEX telemetry_crash_reports_processing_retry_idx
  ON telemetry_crash_reports(parser_state, processing_next_attempt_at, processing_started_at, received_at);
CREATE INDEX telemetry_crash_reports_delivery_idx
  ON telemetry_crash_reports(destination_state, destination_next_attempt_at, received_at);
CREATE INDEX telemetry_crash_reports_subject_idx
  ON telemetry_crash_reports(subject_user_id, delete_at) WHERE subject_user_id IS NOT NULL;
CREATE INDEX telemetry_crash_reports_expiry_idx ON telemetry_crash_reports(delete_at);
CREATE INDEX telemetry_crash_reports_launch_idx
  ON telemetry_crash_reports(launch_id, received_at);

CREATE TRIGGER telemetry_crash_report_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_crash_reports
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_eu_crash_contributions (
  occurrence_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  occurred_at TEXT NOT NULL,
  release TEXT NOT NULL,
  build_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  architecture TEXT NOT NULL CHECK (architecture IN ('arm64', 'x64')),
  process_role TEXT NOT NULL CHECK (process_role IN ('main', 'renderer', 'utility', 'gpu', 'unknown')),
  channel TEXT NOT NULL CHECK (channel IN ('development', 'alpha', 'beta', 'stable')),
  launch_id TEXT NOT NULL,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_eu_crash_contributions_issue_idx
  ON telemetry_eu_crash_contributions(fingerprint, occurred_at);
CREATE INDEX telemetry_eu_crash_contributions_expiry_idx
  ON telemetry_eu_crash_contributions(delete_at);
CREATE INDEX telemetry_eu_crash_contributions_launch_idx
  ON telemetry_eu_crash_contributions(launch_id, occurred_at);

CREATE TRIGGER telemetry_eu_crash_contribution_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_eu_crash_contributions
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_crash_access_audit (
  id TEXT PRIMARY KEY,
  crash_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('customer_support', 'incident_response')),
  result_code TEXT NOT NULL CHECK (result_code IN ('found', 'not_found', 'expired', 'storage_error')),
  accessed_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_crash_access_audit_expiry_idx
  ON telemetry_crash_access_audit(delete_at);

CREATE TRIGGER telemetry_crash_access_audit_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_crash_access_audit
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_operation_id TEXT;
CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
  ON connector_oauth_attempts(telemetry_operation_id)
  WHERE telemetry_operation_id IS NOT NULL;

CREATE TABLE telemetry_destination_state (
  destination TEXT PRIMARY KEY CHECK (destination IN (
    'posthog_capture', 'posthog_javascript_exception', 'posthog_profile', 'posthog_crash'
  )),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_open_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE telemetry_ingest_rate_buckets (
  surface TEXT NOT NULL CHECK (surface IN ('crash_upload', 'telemetry_bootstrap')),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 43),
  bucket_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  delete_at TEXT NOT NULL,
  PRIMARY KEY (surface, subject_hash, bucket_start)
);
CREATE INDEX telemetry_ingest_rate_buckets_expiry_idx
  ON telemetry_ingest_rate_buckets(delete_at);

CREATE TRIGGER telemetry_ingest_rate_bucket_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_ingest_rate_buckets
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_maintenance_state (
  task TEXT PRIMARY KEY CHECK (task IN ('crash_object_retention')),
  cursor TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE telemetry_delivery_receipts (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('global', 'eu')),
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_delivery_receipts_expiry_idx ON telemetry_delivery_receipts(delete_at);

CREATE TRIGGER telemetry_delivery_receipt_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_delivery_receipts
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_identity_links (
  anonymous_epoch_id TEXT PRIMARY KEY,
  analytics_person_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('global', 'eu')),
  linked_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_identity_links_expiry_idx ON telemetry_identity_links(delete_at);

CREATE TRIGGER telemetry_identity_link_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_identity_links
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_profile_jobs (
  id TEXT PRIMARY KEY,
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('epoch_transition', 'person_profile', 'group_profile')),
  destination_analytics_id TEXT NOT NULL,
  anonymous_epoch_id TEXT,
  properties_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'acknowledged', 'terminal', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  delete_at TEXT NOT NULL,
  CHECK ((job_kind = 'epoch_transition') = (anonymous_epoch_id IS NOT NULL)),
  CHECK ((job_kind = 'group_profile') = (workspace_id IS NOT NULL))
);
CREATE INDEX telemetry_profile_jobs_delivery_idx
  ON telemetry_profile_jobs(state, created_at);
CREATE INDEX telemetry_profile_jobs_expiry_idx ON telemetry_profile_jobs(delete_at);

CREATE TRIGGER telemetry_profile_job_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_profile_jobs
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_rejection_buckets (
  bucket_start TEXT NOT NULL,
  violation_code TEXT NOT NULL,
  event_name TEXT NOT NULL DEFAULT 'unregistered',
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  delete_at TEXT NOT NULL,
  PRIMARY KEY (bucket_start, violation_code, event_name)
);
CREATE INDEX telemetry_rejection_buckets_expiry_idx ON telemetry_rejection_buckets(delete_at);

CREATE TRIGGER telemetry_rejection_bucket_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_rejection_buckets
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TABLE telemetry_replay_audit (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('destination_recovery', 'incident_response')),
  result_code TEXT NOT NULL CHECK (
    result_code IN ('requeued', 'denied', 'not_found', 'wrong_region', 'expired', 'suppressed', 'invalid_state')
  ),
  original_delete_at TEXT,
  created_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);
CREATE INDEX telemetry_replay_audit_expiry_idx ON telemetry_replay_audit(delete_at);

CREATE TRIGGER telemetry_replay_audit_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_replay_audit
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

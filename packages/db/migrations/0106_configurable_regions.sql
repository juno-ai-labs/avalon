-- Deployment identifiers are configuration, not a fixed geographical enum.
-- Hold dependent rows before rebuilding so cascading foreign keys preserve data.
-- Large telemetry tables have no inbound foreign keys: copy directly into the
-- replacement, then rename it, avoiding a second full payload rewrite.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE "_region_copy_workspaces" AS SELECT * FROM "workspaces";

CREATE TABLE "_region_copy_workspace_members" AS SELECT * FROM "workspace_members";

CREATE TABLE "_region_copy_oauth_states" AS SELECT * FROM "oauth_states";

CREATE TABLE "_region_copy_workspace_invitations" AS SELECT * FROM "workspace_invitations";

CREATE TABLE "_region_copy_workstreams" AS SELECT * FROM "workstreams";

CREATE TABLE "_region_copy_audit_events" AS SELECT * FROM "audit_events";

CREATE TABLE "_region_copy_provider_webhook_challenges" AS SELECT * FROM "provider_webhook_challenges";

CREATE TABLE "_region_copy_sessions" AS SELECT * FROM "sessions";

CREATE TABLE "_region_copy_desktop_login_tickets" AS SELECT * FROM "desktop_login_tickets";

CREATE TABLE "_region_copy_github_installation_routes" AS SELECT * FROM "github_installation_routes";

CREATE TABLE "_region_copy_linear_organization_routes" AS SELECT * FROM "linear_organization_routes";

CREATE TABLE "_region_copy_slack_installation_routes" AS SELECT * FROM "slack_installation_routes";

CREATE TABLE "_region_copy_notion_workspace_routes" AS SELECT * FROM "notion_workspace_routes";

CREATE TABLE "_region_copy_telemetry_accepted_events" (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  route TEXT NOT NULL,
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
  terminal_code TEXT, analytics_lakehouse_state TEXT
  CHECK (analytics_lakehouse_state IN ('pending', 'queued', 'delivered', 'suppressed', 'rejected')), analytics_lakehouse_delivered_at TEXT
);

INSERT INTO "_region_copy_telemetry_accepted_events" SELECT * FROM "telemetry_accepted_events";

CREATE TABLE "_region_copy_telemetry_onboarding_journeys" AS SELECT * FROM "telemetry_onboarding_journeys";

CREATE TABLE "_region_copy_telemetry_crash_reports" AS SELECT * FROM "telemetry_crash_reports";

CREATE TABLE "_region_copy_telemetry_delivery_receipts" (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  route TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);

INSERT INTO "_region_copy_telemetry_delivery_receipts" SELECT * FROM "telemetry_delivery_receipts";

CREATE TABLE "_region_copy_telemetry_identity_links" AS SELECT * FROM "telemetry_identity_links";

CREATE TABLE "_region_copy_telemetry_profile_jobs" AS SELECT * FROM "telemetry_profile_jobs";

CREATE TABLE "_region_copy_workstream_authority_routes" AS SELECT * FROM "workstream_authority_routes";

CREATE TABLE "_region_copy_workstream_create_receipts" AS SELECT * FROM "workstream_create_receipts";

CREATE TABLE "_region_copy_workspace_product_authority_routes" AS SELECT * FROM "workspace_product_authority_routes";

CREATE TABLE "_region_copy_connector_ingress_routes" AS SELECT * FROM "connector_ingress_routes";

CREATE TABLE "_region_copy_workstream_email_routes" AS SELECT * FROM "workstream_email_routes";

CREATE TABLE "_region_copy_platform_workspace_bindings" AS SELECT * FROM "platform_workspace_bindings";

CREATE TABLE "_region_copy_platform_workspace_operations" AS SELECT * FROM "platform_workspace_operations";

CREATE TABLE "_region_copy_demo_seed_receipts" AS SELECT * FROM "demo_seed_receipts";

CREATE TABLE "_region_copy_ashby_connection_routes" AS SELECT * FROM "ashby_connection_routes";

DROP TRIGGER "workspaces_region_immutable";

DROP TRIGGER "telemetry_accepted_event_deadline_immutable";

DROP TRIGGER "telemetry_onboarding_journey_deadline_immutable";

DROP TRIGGER "telemetry_crash_report_deadline_immutable";

DROP TRIGGER "telemetry_delivery_receipt_deadline_immutable";

DROP TRIGGER "telemetry_identity_link_deadline_immutable";

DROP TRIGGER "telemetry_profile_job_deadline_immutable";

DROP TRIGGER "workstreams_reject_post_cutover_insert";

DROP TRIGGER "workspace_placement_default";

DROP TRIGGER "workspace_placement_immutable";

DROP TRIGGER "workstreams_reject_post_cutover_delete";

DROP TRIGGER "workstreams_reject_post_cutover_update";

DROP TRIGGER "telemetry_accepted_events_analytics_lakehouse_seed";

DROP TRIGGER "workstream_email_routes_identity_immutable";

DROP TRIGGER "workstream_email_routes_no_delete";

DROP TRIGGER "platform_workspace_binding_placement_default";

DROP TRIGGER "platform_workspace_binding_placement_immutable";

DELETE FROM "ashby_connection_routes";

DELETE FROM "demo_seed_receipts";

DELETE FROM "platform_workspace_operations";

DELETE FROM "platform_workspace_bindings";

DELETE FROM "workstream_email_routes";

DELETE FROM "connector_ingress_routes";

DELETE FROM "workspace_product_authority_routes";

DELETE FROM "workstream_create_receipts";

DELETE FROM "workstream_authority_routes";

DELETE FROM "telemetry_profile_jobs";

DELETE FROM "telemetry_identity_links";

DELETE FROM "telemetry_crash_reports";

DELETE FROM "telemetry_onboarding_journeys";

DELETE FROM "notion_workspace_routes";

DELETE FROM "slack_installation_routes";

DELETE FROM "linear_organization_routes";

DELETE FROM "github_installation_routes";

DELETE FROM "desktop_login_tickets";

DELETE FROM "sessions";

DELETE FROM "provider_webhook_challenges";

DELETE FROM "audit_events";

DELETE FROM "workstreams";

DELETE FROM "workspace_invitations";

DELETE FROM "oauth_states";

DELETE FROM "workspace_members";

DELETE FROM "workspaces";

DROP TABLE "workspaces";

DROP TABLE "oauth_states";

DROP TABLE "provider_webhook_challenges";

DROP TABLE "sessions";

DROP TABLE "desktop_login_tickets";

DROP TABLE "github_installation_routes";

DROP TABLE "linear_organization_routes";

DROP TABLE "slack_installation_routes";

DROP TABLE "notion_workspace_routes";

DROP TABLE "telemetry_accepted_events";

DROP TABLE "telemetry_onboarding_journeys";

DROP TABLE "telemetry_crash_reports";

DROP TABLE "telemetry_delivery_receipts";

DROP TABLE "telemetry_identity_links";

DROP TABLE "connector_ingress_routes";

DROP TABLE "workstream_email_routes";

DROP TABLE "platform_workspace_bindings";

DROP TABLE "platform_workspace_operations";

DROP TABLE "ashby_connection_routes";

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  region TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles', analytics_workspace_id TEXT, placement_affinity TEXT NOT NULL DEFAULT 'wnam'
  CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')), abandoned_at TEXT);

CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_verifier_encrypted TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  return_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
, workspace_name TEXT, invitation_id TEXT REFERENCES workspace_invitations(id) ON DELETE SET NULL, desktop_attempt_id TEXT, desktop_code_challenge TEXT);

CREATE TABLE provider_webhook_challenges (
  provider TEXT NOT NULL CHECK (provider IN ('notion')),
  region TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  credential_key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT, setup_nonce_hash TEXT CHECK (
    setup_nonce_hash IS NULL OR length(setup_nonce_hash) = 43
  ), setup_generation INTEGER CHECK (
    setup_generation IS NULL OR setup_generation > 0
  ),
  PRIMARY KEY (provider, region)
);

CREATE TABLE "sessions" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
, previous_refresh_token_hash TEXT, refresh_rotated_at TEXT);

CREATE TABLE "desktop_login_tickets" (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  desktop_attempt_id TEXT,
  desktop_code_challenge TEXT
);

CREATE TABLE github_installation_routes (
  installation_id TEXT NOT NULL CHECK (
    length(installation_id) BETWEEN 1 AND 32
    AND installation_id NOT GLOB '*[^0-9]*'
  ),
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (installation_id, region, workspace_id)
);

CREATE TABLE linear_organization_routes (
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 200),
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (organization_id, region, workspace_id, connection_id)
);

CREATE TABLE slack_installation_routes (
  team_id TEXT PRIMARY KEY CHECK (length(team_id) BETWEEN 2 AND 100),
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE notion_workspace_routes (
  notion_workspace_id TEXT NOT NULL CHECK (length(notion_workspace_id) BETWEEN 1 AND 200),
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (notion_workspace_id, region, workspace_id, connection_id)
);

CREATE TABLE telemetry_onboarding_journeys (
  journey_id TEXT PRIMARY KEY,
  anonymous_epoch_id TEXT NOT NULL UNIQUE,
  route TEXT NOT NULL,
  routing_basis TEXT NOT NULL CHECK (routing_basis IN ('ip_geolocation', 'geolocation_fallback')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  delete_at TEXT NOT NULL
);

CREATE TABLE telemetry_crash_reports (
  crash_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  installation_analytics_id TEXT NOT NULL,
  route TEXT NOT NULL,
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

CREATE TABLE telemetry_identity_links (
  anonymous_epoch_id TEXT PRIMARY KEY,
  analytics_person_id TEXT NOT NULL,
  route TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);

CREATE TABLE connector_ingress_routes (
  connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  provider_account_id TEXT,
  provider_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  updated_at TEXT NOT NULL
);

CREATE TABLE workstream_email_routes (
  email_address TEXT PRIMARY KEY COLLATE NOCASE,
  address_source TEXT NOT NULL CHECK (address_source IN ('migration', 'allocator', 'owner')),
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workstream_id TEXT,
  automation_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (email_address = lower(email_address)),
  CHECK (length(email_address) <= 254 AND instr(email_address, '@') > 1),
  CHECK (
    (workstream_id IS NOT NULL AND automation_subscription_id IS NULL)
    OR (workstream_id IS NULL AND automation_subscription_id IS NOT NULL)
  ),
  UNIQUE (region, workspace_id, workstream_id),
  UNIQUE (region, workspace_id, automation_subscription_id)
);

CREATE TABLE platform_workspace_bindings (
  platform_user_id TEXT NOT NULL,
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'inactive')),
  operation_id TEXT NOT NULL UNIQUE,
  pending_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  placement_affinity TEXT NOT NULL DEFAULT 'wnam'
    CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
  PRIMARY KEY (platform_user_id, region, workspace_id)
);

CREATE TABLE platform_workspace_operations (
  operation_id TEXT PRIMARY KEY,
  platform_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'accept')),
  request_fingerprint TEXT NOT NULL,
  region TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  placement_affinity TEXT NOT NULL
    CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
  invitation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (action = 'create' AND invitation_id IS NULL)
    OR (action = 'accept' AND invitation_id IS NOT NULL)
  )
);

CREATE TABLE ashby_connection_routes (
  connection_id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  updated_at TEXT NOT NULL
);

INSERT INTO "workspaces" SELECT * FROM "_region_copy_workspaces";

INSERT INTO "workspace_members" SELECT * FROM "_region_copy_workspace_members";

INSERT INTO "oauth_states" SELECT * FROM "_region_copy_oauth_states";

INSERT INTO "workspace_invitations" SELECT * FROM "_region_copy_workspace_invitations";

INSERT INTO "workstreams" SELECT * FROM "_region_copy_workstreams";

INSERT INTO "audit_events" SELECT * FROM "_region_copy_audit_events";

INSERT INTO "provider_webhook_challenges" SELECT * FROM "_region_copy_provider_webhook_challenges";

INSERT INTO "sessions" SELECT * FROM "_region_copy_sessions";

INSERT INTO "desktop_login_tickets" SELECT * FROM "_region_copy_desktop_login_tickets";

INSERT INTO "github_installation_routes" SELECT * FROM "_region_copy_github_installation_routes";

INSERT INTO "linear_organization_routes" SELECT * FROM "_region_copy_linear_organization_routes";

INSERT INTO "slack_installation_routes" SELECT * FROM "_region_copy_slack_installation_routes";

INSERT INTO "notion_workspace_routes" SELECT * FROM "_region_copy_notion_workspace_routes";

ALTER TABLE "_region_copy_telemetry_accepted_events" RENAME TO "telemetry_accepted_events";

INSERT INTO "telemetry_onboarding_journeys" SELECT * FROM "_region_copy_telemetry_onboarding_journeys";

INSERT INTO "telemetry_crash_reports" SELECT * FROM "_region_copy_telemetry_crash_reports";

ALTER TABLE "_region_copy_telemetry_delivery_receipts" RENAME TO "telemetry_delivery_receipts";

INSERT INTO "telemetry_identity_links" SELECT * FROM "_region_copy_telemetry_identity_links";

INSERT INTO "telemetry_profile_jobs" SELECT * FROM "_region_copy_telemetry_profile_jobs";

INSERT INTO "workstream_authority_routes" SELECT * FROM "_region_copy_workstream_authority_routes";

INSERT INTO "workstream_create_receipts" SELECT * FROM "_region_copy_workstream_create_receipts";

INSERT INTO "workspace_product_authority_routes" SELECT * FROM "_region_copy_workspace_product_authority_routes";

INSERT INTO "connector_ingress_routes" SELECT * FROM "_region_copy_connector_ingress_routes";

INSERT INTO "workstream_email_routes" SELECT * FROM "_region_copy_workstream_email_routes";

INSERT INTO "platform_workspace_bindings" SELECT * FROM "_region_copy_platform_workspace_bindings";

INSERT INTO "platform_workspace_operations" SELECT * FROM "_region_copy_platform_workspace_operations";

INSERT INTO "demo_seed_receipts" SELECT * FROM "_region_copy_demo_seed_receipts";

INSERT INTO "ashby_connection_routes" SELECT * FROM "_region_copy_ashby_connection_routes";

DROP TABLE "_region_copy_workspaces";

DROP TABLE "_region_copy_workspace_members";

DROP TABLE "_region_copy_oauth_states";

DROP TABLE "_region_copy_workspace_invitations";

DROP TABLE "_region_copy_workstreams";

DROP TABLE "_region_copy_audit_events";

DROP TABLE "_region_copy_provider_webhook_challenges";

DROP TABLE "_region_copy_sessions";

DROP TABLE "_region_copy_desktop_login_tickets";

DROP TABLE "_region_copy_github_installation_routes";

DROP TABLE "_region_copy_linear_organization_routes";

DROP TABLE "_region_copy_slack_installation_routes";

DROP TABLE "_region_copy_notion_workspace_routes";

DROP TABLE "_region_copy_telemetry_onboarding_journeys";

DROP TABLE "_region_copy_telemetry_crash_reports";

DROP TABLE "_region_copy_telemetry_identity_links";

DROP TABLE "_region_copy_telemetry_profile_jobs";

DROP TABLE "_region_copy_workstream_authority_routes";

DROP TABLE "_region_copy_workstream_create_receipts";

DROP TABLE "_region_copy_workspace_product_authority_routes";

DROP TABLE "_region_copy_connector_ingress_routes";

DROP TABLE "_region_copy_workstream_email_routes";

DROP TABLE "_region_copy_platform_workspace_bindings";

DROP TABLE "_region_copy_platform_workspace_operations";

DROP TABLE "_region_copy_demo_seed_receipts";

DROP TABLE "_region_copy_ashby_connection_routes";

CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at, consumed_at);

CREATE UNIQUE INDEX oauth_states_desktop_attempt_idx
  ON oauth_states(desktop_attempt_id)
  WHERE desktop_attempt_id IS NOT NULL;

CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at);

CREATE UNIQUE INDEX desktop_login_tickets_attempt_idx
  ON desktop_login_tickets(desktop_attempt_id)
  WHERE desktop_attempt_id IS NOT NULL;

CREATE INDEX sessions_previous_refresh_token_idx
  ON sessions(previous_refresh_token_hash, refresh_rotated_at);

CREATE INDEX github_installation_routes_active_idx
  ON github_installation_routes(installation_id, status, region);

CREATE INDEX linear_organization_routes_active_idx
  ON linear_organization_routes(organization_id, status, region);

CREATE UNIQUE INDEX linear_organization_routes_connection_idx
  ON linear_organization_routes(connection_id);

CREATE INDEX slack_installation_routes_active_idx
  ON slack_installation_routes(team_id, status, region);

CREATE INDEX notion_workspace_routes_active_idx
  ON notion_workspace_routes(notion_workspace_id, status, region);

CREATE UNIQUE INDEX notion_workspace_routes_connection_idx
  ON notion_workspace_routes(connection_id);

CREATE UNIQUE INDEX workspaces_analytics_workspace_id_idx
  ON workspaces(analytics_workspace_id) WHERE analytics_workspace_id IS NOT NULL;

CREATE INDEX telemetry_accepted_events_delivery_idx
  ON telemetry_accepted_events(delivery_state, next_attempt_at, accepted_at);

CREATE INDEX telemetry_accepted_events_expiry_idx ON telemetry_accepted_events(delete_at);

CREATE INDEX telemetry_accepted_events_subject_idx
  ON telemetry_accepted_events(subject_user_id, delete_at) WHERE subject_user_id IS NOT NULL;

CREATE INDEX telemetry_onboarding_journeys_expiry_idx
  ON telemetry_onboarding_journeys(delete_at);

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

CREATE INDEX telemetry_delivery_receipts_expiry_idx ON telemetry_delivery_receipts(delete_at);

CREATE INDEX telemetry_identity_links_expiry_idx ON telemetry_identity_links(delete_at);

CREATE INDEX connector_ingress_routes_provider_idx
  ON connector_ingress_routes(connector_type, provider_account_id, status, workspace_id);

CREATE INDEX connector_ingress_routes_user_idx
  ON connector_ingress_routes(connector_type, provider_user_id, status, workspace_id);

CREATE INDEX sessions_unrevoked_expiry_idx
    ON sessions(expires_at)
 WHERE revoked_at IS NULL;

CREATE INDEX telemetry_accepted_events_analytics_lakehouse_idx
  ON telemetry_accepted_events(accepted_at DESC)
  WHERE analytics_lakehouse_state IN ('pending', 'queued');

CREATE INDEX workstream_email_routes_destination_idx
  ON workstream_email_routes(
    region, workspace_id, workstream_id, automation_subscription_id
  );

CREATE INDEX platform_workspace_bindings_destination_idx
  ON platform_workspace_bindings(region, workspace_id, status);

CREATE UNIQUE INDEX platform_workspace_bindings_one_pending_idx
  ON platform_workspace_bindings(platform_user_id)
  WHERE status = 'pending';

CREATE INDEX platform_workspace_operations_identity_idx
  ON platform_workspace_operations(platform_user_id, created_at DESC);

CREATE TRIGGER workspaces_region_immutable
BEFORE UPDATE OF region ON workspaces
WHEN NEW.region <> OLD.region
BEGIN
  SELECT RAISE(ABORT, 'workspace_region_immutable');
END;

CREATE TRIGGER telemetry_accepted_event_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_accepted_events
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_onboarding_journey_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_onboarding_journeys
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_crash_report_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_crash_reports
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_delivery_receipt_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_delivery_receipts
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_identity_link_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_identity_links
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_profile_job_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_profile_jobs
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER workstreams_reject_post_cutover_insert
BEFORE INSERT ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
       NOT IN ('legacy_open', 'maintenance_draining')
  AND NEW.do_identity_anchor != 1
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workspace_placement_immutable
BEFORE UPDATE OF placement_affinity ON workspaces
WHEN NEW.placement_affinity <> OLD.placement_affinity
BEGIN
  SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
END;

CREATE TRIGGER workstreams_reject_post_cutover_delete
BEFORE DELETE ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

CREATE TRIGGER workstreams_reject_post_cutover_update
BEFORE UPDATE ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER telemetry_accepted_events_analytics_lakehouse_seed
AFTER INSERT ON telemetry_accepted_events
WHEN NEW.analytics_lakehouse_state IS NULL
BEGIN
  UPDATE telemetry_accepted_events
  SET analytics_lakehouse_state = 'pending'
  WHERE event_id = NEW.event_id;
END;

CREATE TRIGGER workstream_email_routes_identity_immutable
BEFORE UPDATE OF email_address, address_source, region, workspace_id, workstream_id, automation_subscription_id
ON workstream_email_routes
WHEN NEW.region IS NOT OLD.region
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.workstream_id IS NOT OLD.workstream_id
  OR NEW.automation_subscription_id IS NOT OLD.automation_subscription_id
  OR (
    (NEW.email_address IS NOT OLD.email_address OR NEW.address_source IS NOT OLD.address_source)
    AND NOT (OLD.address_source = 'migration' AND NEW.address_source = 'owner')
  )
BEGIN
  SELECT RAISE(ABORT, 'email route identities are immutable');
END;

CREATE TRIGGER workstream_email_routes_no_delete
BEFORE DELETE ON workstream_email_routes
BEGIN
  SELECT RAISE(ABORT, 'email routes are permanent tombstones');
END;

CREATE TRIGGER platform_workspace_binding_placement_immutable
BEFORE UPDATE OF placement_affinity ON platform_workspace_bindings
WHEN NEW.placement_affinity <> OLD.placement_affinity
BEGIN
  SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
END;

PRAGMA defer_foreign_keys = OFF;

DROP TABLE telemetry_eu_crash_contributions;

DROP TABLE telemetry_eu_events;

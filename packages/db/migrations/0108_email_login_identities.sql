-- Email-authenticated users retain the normal immutable user identity.
-- Preserve every referencing table with foreign keys ON: dropping users without
-- emptying the dependent closure would cascade-delete memberships and sessions.
-- Wrangler applies this migration atomically. Admission still requires verified
-- email challenges; nullable google_subject alone is not a new login path.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "users_platform_identity_immutable";

DROP TRIGGER "workspaces_region_immutable";

DROP TRIGGER "telemetry_accepted_event_deadline_immutable";

DROP TRIGGER "telemetry_crash_report_deadline_immutable";

DROP TRIGGER "telemetry_profile_job_deadline_immutable";

DROP TRIGGER "workstreams_reject_post_cutover_insert";

DROP TRIGGER "workspace_placement_immutable";

DROP TRIGGER "workstreams_reject_post_cutover_delete";

DROP TRIGGER "workstreams_reject_post_cutover_update";

DROP TRIGGER "telemetry_accepted_events_analytics_lakehouse_seed";

CREATE TABLE "_email_identity_copy_users" AS SELECT * FROM "users";

CREATE TABLE "_email_identity_copy_demo_operations" AS SELECT * FROM "demo_operations";

CREATE TABLE "_email_identity_copy_demo_operation_phases" AS SELECT * FROM "demo_operation_phases";

CREATE TABLE "_email_identity_copy_telemetry_accepted_events" AS SELECT * FROM "telemetry_accepted_events";

CREATE TABLE "_email_identity_copy_workspaces" AS SELECT * FROM "workspaces";

CREATE TABLE "_email_identity_copy_workspace_members" AS SELECT * FROM "workspace_members";

CREATE TABLE "_email_identity_copy_workspace_invitations" AS SELECT * FROM "workspace_invitations";

CREATE TABLE "_email_identity_copy_telemetry_profile_jobs" AS SELECT * FROM "telemetry_profile_jobs";

CREATE TABLE "_email_identity_copy_workstream_create_receipts" AS SELECT * FROM "workstream_create_receipts";

CREATE TABLE "_email_identity_copy_demo_seed_receipts" AS SELECT * FROM "demo_seed_receipts";

CREATE TABLE "_email_identity_copy_oauth_states" AS SELECT * FROM "oauth_states";

CREATE TABLE "_email_identity_copy_sessions" AS SELECT * FROM "sessions";

CREATE TABLE "_email_identity_copy_desktop_login_tickets" AS SELECT * FROM "desktop_login_tickets";

CREATE TABLE "_email_identity_copy_telemetry_crash_reports" AS SELECT * FROM "telemetry_crash_reports";

CREATE TABLE "_email_identity_copy_connector_ingress_routes" AS SELECT * FROM "connector_ingress_routes";

CREATE TABLE "_email_identity_copy_user_push_devices" AS SELECT * FROM "user_push_devices";

CREATE TABLE "_email_identity_copy_user_push_device_sessions" AS SELECT * FROM "user_push_device_sessions";

CREATE TABLE "_email_identity_copy_push_delivery_receipts" AS SELECT * FROM "push_delivery_receipts";

CREATE TABLE "_email_identity_copy_workstreams" AS SELECT * FROM "workstreams";

CREATE TABLE "_email_identity_copy_audit_events" AS SELECT * FROM "audit_events";

CREATE TABLE "_email_identity_copy_workstream_authority_routes" AS SELECT * FROM "workstream_authority_routes";

CREATE TABLE "_email_identity_copy_workspace_product_authority_routes" AS SELECT * FROM "workspace_product_authority_routes";

DELETE FROM "workspace_product_authority_routes";

DELETE FROM "workstream_authority_routes";

DELETE FROM "audit_events";

DELETE FROM "workstreams";

DELETE FROM "push_delivery_receipts";

DELETE FROM "user_push_device_sessions";

DELETE FROM "user_push_devices";

DELETE FROM "connector_ingress_routes";

DELETE FROM "telemetry_crash_reports";

DELETE FROM "desktop_login_tickets";

DELETE FROM "sessions";

DELETE FROM "oauth_states";

DELETE FROM "demo_seed_receipts";

DELETE FROM "workstream_create_receipts";

DELETE FROM "telemetry_profile_jobs";

DELETE FROM "workspace_invitations";

DELETE FROM "workspace_members";

DELETE FROM "workspaces";

DELETE FROM "telemetry_accepted_events";

DELETE FROM "demo_operation_phases";

DELETE FROM "demo_operations";

DELETE FROM "users";

DROP TABLE users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_subject TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, platform_user_id TEXT, timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles', analytics_person_id TEXT, product_analytics_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (product_analytics_enabled IN (0, 1)), product_analytics_preference_version INTEGER NOT NULL DEFAULT 1
  CHECK (product_analytics_preference_version > 0), preference_subject_handle TEXT, timezone_source TEXT NOT NULL DEFAULT 'client'
  CHECK (timezone_source IN ('client', 'user')), onboarding_eligible INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_eligible IN (0, 1)), onboarding_introduced INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_introduced IN (0, 1)), onboarding_revision INTEGER NOT NULL DEFAULT 0, presentation_json TEXT);

CREATE UNIQUE INDEX users_platform_user_id_idx
  ON users(platform_user_id)
  WHERE platform_user_id IS NOT NULL;

CREATE UNIQUE INDEX users_analytics_person_id_idx
  ON users(analytics_person_id) WHERE analytics_person_id IS NOT NULL;

CREATE UNIQUE INDEX users_preference_subject_handle_idx
  ON users(preference_subject_handle) WHERE preference_subject_handle IS NOT NULL;

INSERT INTO "users" SELECT * FROM "_email_identity_copy_users";

INSERT INTO "demo_operations" SELECT * FROM "_email_identity_copy_demo_operations";

INSERT INTO "demo_operation_phases" SELECT * FROM "_email_identity_copy_demo_operation_phases";

INSERT INTO "telemetry_accepted_events" SELECT * FROM "_email_identity_copy_telemetry_accepted_events";

INSERT INTO "workspaces" SELECT * FROM "_email_identity_copy_workspaces";

INSERT INTO "workspace_members" SELECT * FROM "_email_identity_copy_workspace_members";

INSERT INTO "workspace_invitations" SELECT * FROM "_email_identity_copy_workspace_invitations";

INSERT INTO "telemetry_profile_jobs" SELECT * FROM "_email_identity_copy_telemetry_profile_jobs";

INSERT INTO "workstream_create_receipts" SELECT * FROM "_email_identity_copy_workstream_create_receipts";

INSERT INTO "demo_seed_receipts" SELECT * FROM "_email_identity_copy_demo_seed_receipts";

INSERT INTO "oauth_states" SELECT * FROM "_email_identity_copy_oauth_states";

INSERT INTO "sessions" SELECT * FROM "_email_identity_copy_sessions";

INSERT INTO "desktop_login_tickets" SELECT * FROM "_email_identity_copy_desktop_login_tickets";

INSERT INTO "telemetry_crash_reports" SELECT * FROM "_email_identity_copy_telemetry_crash_reports";

INSERT INTO "connector_ingress_routes" SELECT * FROM "_email_identity_copy_connector_ingress_routes";

INSERT INTO "user_push_devices" SELECT * FROM "_email_identity_copy_user_push_devices";

INSERT INTO "user_push_device_sessions" SELECT * FROM "_email_identity_copy_user_push_device_sessions";

INSERT INTO "push_delivery_receipts" SELECT * FROM "_email_identity_copy_push_delivery_receipts";

INSERT INTO "workstreams" SELECT * FROM "_email_identity_copy_workstreams";

INSERT INTO "audit_events" SELECT * FROM "_email_identity_copy_audit_events";

INSERT INTO "workstream_authority_routes" SELECT * FROM "_email_identity_copy_workstream_authority_routes";

INSERT INTO "workspace_product_authority_routes" SELECT * FROM "_email_identity_copy_workspace_product_authority_routes";

DROP TABLE "_email_identity_copy_users";

DROP TABLE "_email_identity_copy_demo_operations";

DROP TABLE "_email_identity_copy_demo_operation_phases";

DROP TABLE "_email_identity_copy_telemetry_accepted_events";

DROP TABLE "_email_identity_copy_workspaces";

DROP TABLE "_email_identity_copy_workspace_members";

DROP TABLE "_email_identity_copy_workspace_invitations";

DROP TABLE "_email_identity_copy_telemetry_profile_jobs";

DROP TABLE "_email_identity_copy_workstream_create_receipts";

DROP TABLE "_email_identity_copy_demo_seed_receipts";

DROP TABLE "_email_identity_copy_oauth_states";

DROP TABLE "_email_identity_copy_sessions";

DROP TABLE "_email_identity_copy_desktop_login_tickets";

DROP TABLE "_email_identity_copy_telemetry_crash_reports";

DROP TABLE "_email_identity_copy_connector_ingress_routes";

DROP TABLE "_email_identity_copy_user_push_devices";

DROP TABLE "_email_identity_copy_user_push_device_sessions";

DROP TABLE "_email_identity_copy_push_delivery_receipts";

DROP TABLE "_email_identity_copy_workstreams";

DROP TABLE "_email_identity_copy_audit_events";

DROP TABLE "_email_identity_copy_workstream_authority_routes";

DROP TABLE "_email_identity_copy_workspace_product_authority_routes";

CREATE TRIGGER users_platform_identity_immutable
BEFORE UPDATE OF platform_user_id ON users
WHEN OLD.platform_user_id IS NOT NULL
  AND (NEW.platform_user_id IS NULL OR NEW.platform_user_id <> OLD.platform_user_id)
BEGIN
  SELECT RAISE(ABORT, 'platform_user_id_immutable');
END;

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

CREATE TRIGGER telemetry_crash_report_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_crash_reports
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

CREATE TABLE user_login_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'email')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;

CREATE INDEX user_login_identities_user_idx ON user_login_identities(user_id);

CREATE TABLE user_verified_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TEXT NOT NULL
) STRICT;

CREATE INDEX user_verified_emails_user_idx ON user_verified_emails(user_id);

-- Existing Google sign-in requires email_verified before creating the user.
INSERT INTO user_login_identities (provider, subject, user_id, verified_at)
SELECT 'google', google_subject, id, created_at FROM users WHERE google_subject IS NOT NULL;

INSERT INTO user_verified_emails (email, user_id, verified_at)
SELECT email, id, created_at FROM users;

PRAGMA defer_foreign_keys = OFF;

-- Opaque analytics lineage follows existing authentication proofs, never their secrets.
ALTER TABLE oauth_states ADD COLUMN telemetry_flow_id TEXT;
ALTER TABLE desktop_login_tickets ADD COLUMN telemetry_flow_id TEXT;
ALTER TABLE desktop_login_tickets ADD COLUMN signup_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_login_challenges ADD COLUMN telemetry_flow_id TEXT;
ALTER TABLE email_login_challenges ADD COLUMN telemetry_client_platform TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE email_login_challenges ADD COLUMN signup_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN signup_flow_id TEXT;
ALTER TABLE users ADD COLUMN signup_client_platform TEXT;
ALTER TABLE users ADD COLUMN signup_path TEXT;
ALTER TABLE users ADD COLUMN signup_completed_at TEXT;

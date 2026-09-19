-- Worker-first: deploy the reaper that only uses TELEMETRY_DB before applying.
-- PR #835 already routed all producers to the dedicated telemetry/audit databases.
-- These inactive regional copies are intentionally discarded, not backfilled.
DROP TABLE IF EXISTS telemetry_accepted_events;
DROP TABLE IF EXISTS telemetry_delivery_receipts;
DROP TABLE IF EXISTS telemetry_replay_audit;
DROP TABLE IF EXISTS audit_events;

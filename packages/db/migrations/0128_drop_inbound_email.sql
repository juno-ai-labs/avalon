-- Deploy the Worker without email ingestion before applying this migration.
-- Outbound email_delivery_receipts and login challenges remain in service.
DROP TRIGGER workstream_email_routes_identity_immutable;
DROP TRIGGER workstream_email_routes_no_delete;
DROP TABLE workstream_email_routes;
DROP TABLE resend_webhook_receipts;

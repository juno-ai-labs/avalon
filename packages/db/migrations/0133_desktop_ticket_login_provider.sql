-- Migration-first: the Worker before it writes no provider, and a ticket with
-- none is read as Google's, the only provider that wrote tickets until now.
--
-- A desktop sign-in completes in two requests: the provider's callback writes
-- a ticket, and the desktop exchanges it for a session. The exchange reports
-- the sign-in method to signup telemetry, so the ticket carries the provider
-- that verified the person. Tickets live two minutes; no backfill is needed.
ALTER TABLE desktop_login_tickets ADD COLUMN login_provider TEXT;

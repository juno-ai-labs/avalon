-- Migration-first: the Worker that reads this column ships after it, and the
-- Worker before it never names it.
--
-- The receipt time of the last provider lifecycle update (a GitHub
-- installation suspend, unsuspend, deletion or revocation) applied to this
-- connection. A Queue retry can deliver an older lifecycle event after a newer
-- one; `ProviderWebhookService` advances this only forward and skips an update
-- received before it. NULL until the first such update.
ALTER TABLE connector_ingress_routes ADD COLUMN lifecycle_at TEXT;

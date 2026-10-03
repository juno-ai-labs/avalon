-- Migration-first: the Worker that reads these columns ships after it, and the
-- Worker before it never names them.
--
-- A browser's Web Push subscription. `token` holds the subscription endpoint
-- for a `webpush` device; these hold the keys RFC 8291 encrypts its payload
-- to: the browser's P-256 public key and its 16-byte authentication secret,
-- both base64url. NULL for every APNs device.
ALTER TABLE user_push_devices ADD COLUMN web_push_p256dh TEXT;
ALTER TABLE user_push_devices ADD COLUMN web_push_auth TEXT;

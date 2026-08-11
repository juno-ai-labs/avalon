-- Record a hash of the attachment currently posted on a message.
--
-- `rendered_status` says what the card claimed, not what it looked like, so the
-- sweep could only ask "has the status changed?". That is a proxy for the real
-- question — "would the card render differently now?" — and it is too narrow in
-- three independent ways: the code that draws the card can change, the title and
-- activity timestamp both render but were never compared, and an anonymous card
-- renders identically whatever the status does.
--
-- Hashing what `workstreamUnfurlBlocks` actually emits answers the real question
-- directly and subsumes all three. Existing rows are NULL, which never matches a
-- freshly computed hash, so each is rewritten once and then settles.
ALTER TABLE slack_unfurled_links
  ADD COLUMN rendered_hash TEXT;

-- New acknowledgements freeze their author-selected sender alongside the body.
-- Existing requests keep the original transactional sender resolution.
ALTER TABLE access_requests ADD COLUMN acknowledgement_from TEXT;

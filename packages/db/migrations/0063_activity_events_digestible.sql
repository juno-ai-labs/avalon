-- Whether an activity event may be read back to a person in their digest.
--
-- The log stays what it is: everything that happened, for whoever may hear it.
-- What changes is that a digest is no longer the same question as the log. A
-- connector reports both news and machinery through one feed — a pull request
-- opened and the eleven check runs it started, a document written and each of
-- its autosaves — and a digest window filled with the second kind is how a
-- person ends up with an email about seventeen minutes of continuous
-- integration. Which kind an event type is can only be answered by whoever
-- designed the connector, so the connector manifest now states it per activity
-- type and this column carries the answer to the read.
--
-- It is a column rather than a filter in the digest query because the answer is
-- fixed when the event is written and the question is asked far more often than
-- it is answered, and because a filter would have to re-derive a manifest that
-- may have changed, or that this region may not even register.

ALTER TABLE activity_events
  ADD COLUMN digestible INTEGER NOT NULL DEFAULT 1 CHECK (digestible IN (0, 1));

-- Existing connector rows were written before any connector was asked, so their
-- digestibility was never positively confirmed by anybody. Withhold them rather
-- than grandfathering an unreviewed backlog into the next digest: every one of
-- these sits below a live cursor in a window nobody has read yet, and a first
-- digest after this migration should start from events whose connectors have
-- actually declared them. First-party rows — work-stream messages and mentions
-- — keep the default, because Avalon has always known those are worth telling
-- somebody about.
UPDATE activity_events SET digestible = 0 WHERE source_kind = 'activity';

-- No index. The digest read is already anchored on
-- `activity_events_cursor_idx`, which is what makes the window cheap; this
-- column removes rows from a window that has already been narrowed to one
-- workspace and a bounded range of `log_sequence`, and a two-value column
-- ahead of that range would only make the index wider for every other reader.

-- Where Avalon's reaction sits, and which one it is.
--
-- The reaction on the message that started a run is the only status a member
-- sees without opening the thread. Until now it was added once — `eyes`, by the
-- activation hook — and removed by nothing, so a finished run, a failed run, and
-- a run still working were indistinguishable at the message that asked for them.
-- Giving the reaction a lifecycle means a later invocation has to know what
-- Avalon last put there, and on which message.
--
-- `reaction_message_ts` is the *triggering* message, not the thread root, and
-- the two differ whenever a member replies inside an existing Avalon thread.
-- Reacting to the root instead would move the status off the message the member
-- just sent and onto one they may have stopped looking at hours ago.
--
-- `reaction_current` names only what Avalon itself placed. A transition removes
-- that emoji and no other, so a member who reacts to the same message keeps
-- their reaction; a NULL means Avalon has nothing on the message and the next
-- transition is a plain add. It is deliberately nullable rather than defaulted:
-- "no reaction placed" and "the reaction is `eyes`" are different states, and a
-- default would make every legacy row claim the second.
--
-- `reaction_cursor` is the rotation position for the working reaction. It is
-- derived state whose loss costs one out-of-order emoji, which is why it carries
-- a default and the columns above do not.
--
-- Rows written before this migration read as "no source message recorded", so
-- their runs acknowledge and finish exactly as they do today, without a
-- transition. No backfill is possible or needed: the Slack timestamps these
-- columns hold were never stored anywhere else.
ALTER TABLE slack_agent_sessions ADD COLUMN reaction_channel_id TEXT;
ALTER TABLE slack_agent_sessions ADD COLUMN reaction_message_ts TEXT;
ALTER TABLE slack_agent_sessions ADD COLUMN reaction_current TEXT;
ALTER TABLE slack_agent_sessions ADD COLUMN reaction_cursor INTEGER NOT NULL DEFAULT 0;

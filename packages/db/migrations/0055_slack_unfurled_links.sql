-- Remember which Slack message carries which work-stream link, so a posted
-- unfurl card can be rewritten when the work stream moves on.
--
-- Slack reports a shared link exactly once, in `link_shared`, and only permits
-- `chat.unfurl` for a URL whose event the app acknowledged. There is no API to
-- re-enumerate past events, so a link absent from this table can never be
-- refreshed: rows exist only from the moment recording ships.
--
-- Rows are written only for cards that showed a summary. An anonymous card has
-- nothing to keep current, and a work stream outside the connection's workspace
-- must never be named here.
CREATE TABLE slack_unfurled_links (
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  slack_channel_id TEXT NOT NULL,
  slack_message_ts TEXT NOT NULL,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  -- What the posted card claims. The sweep compares these against the work
  -- stream's current status and the channel's current audience, so an unchanged
  -- card costs nothing and is never rewritten to say what it already says.
  rendered_status TEXT NOT NULL,
  rendered_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (rendered_anonymous IN (0, 1)),
  -- Audience is revalidated on its own clock rather than only when the status
  -- moves. A channel that becomes externally shared has to be redacted even
  -- though nothing about the work stream changed.
  audience_checked_at TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, slack_channel_id, slack_message_ts, url)
);

-- The sweep scans by work stream to find cards that have drifted.
CREATE INDEX slack_unfurled_links_workstream_idx
  ON slack_unfurled_links(workstream_id);

-- Refreshing is bounded to recently shared links; older cards are left alone.
CREATE INDEX slack_unfurled_links_shared_at_idx
  ON slack_unfurled_links(shared_at);

-- The sweep also selects the least recently revalidated cards.
CREATE INDEX slack_unfurled_links_audience_idx
  ON slack_unfurled_links(audience_checked_at);

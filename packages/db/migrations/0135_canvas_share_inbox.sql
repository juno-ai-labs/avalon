-- Each person's "Shared with me" inbox: the Canvases someone shared with them
-- in any Organization of this deployment, as each Canvas's own Organization
-- last published it (docs/canvas-share-federation.md). A copy of what a list
-- row shows, never the Canvas itself; the publishing Organization stays its
-- authority. `revision` is the highest that Organization has published for the
-- pair, kept through an unshare (`shared = 0`), so a late delivery can never
-- undo a newer one in either direction.
CREATE TABLE canvas_share_inbox (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  shared INTEGER NOT NULL CHECK (shared IN (0, 1)),
  title TEXT NOT NULL CHECK (length(title) <= 300),
  appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json)),
  canvas_updated_at INTEGER NOT NULL CHECK (canvas_updated_at >= 0),
  PRIMARY KEY (user_id, workspace_id, canvas_id)
) STRICT;
CREATE INDEX canvas_share_inbox_recency_idx ON canvas_share_inbox(user_id, canvas_updated_at DESC) WHERE shared = 1;

-- Whether the inbox joins every Organization's Canvas list. No row is on.
CREATE TABLE canvas_share_inbox_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

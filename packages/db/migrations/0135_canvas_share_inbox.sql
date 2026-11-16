-- Each person's "Shared with me" inbox: which Canvases someone shared with
-- them in any Organization of this deployment (docs/canvas-share-federation.md).
-- Pointers only. Nothing about a Canvas (its title, look or activity) is
-- copied here: a list asks the Canvas's own Organization for those each time,
-- and that Organization checks again that the person may see it.
-- `revision` is the highest that Organization has published for the pair,
-- kept through an unshare (`shared = 0`), so a late delivery can never undo a
-- newer one in either direction.
CREATE TABLE canvas_share_inbox (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  shared INTEGER NOT NULL CHECK (shared IN (0, 1)),
  PRIMARY KEY (user_id, workspace_id, canvas_id)
) STRICT;

-- Whether the inbox joins every Organization's Canvas list. No row is on.
CREATE TABLE canvas_share_inbox_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

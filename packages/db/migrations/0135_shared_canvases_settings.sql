-- Whether Canvases shared with a person as a guest elsewhere join every
-- Organization's Canvas list (docs/canvas-share-federation.md). No row is on.
-- Nothing about a Canvas is stored here or anywhere outside its Organization:
-- lists are built by asking each Canvas's own Organization.
CREATE TABLE shared_canvases_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

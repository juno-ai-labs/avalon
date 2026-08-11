-- One person's pinned work streams, in the order they arranged them.
--
-- Keyed the way `workstream_read_states` is, and for the same reason: a pin is
-- one person's opinion about a shared row, so it cannot live on `workstreams`.
-- It is stored here rather than on the device because the same person's other
-- machines have to see the same pinned list.
--
-- `position` is unique and ascending per person, rewritten as a dense run
-- whenever a pin is removed or the list is rearranged. Sparse or fractional
-- positions would avoid the rewrite, but the list is small and bounded by how
-- many rows a person will tolerate above their recent work, and a dense run is
-- the only representation in which "what order is this list in" has exactly one
-- answer. A new pin takes `MAX(position) + 1` rather than the row count, so a
-- hole left by a cascade delete cannot hand out a position twice; that hole
-- survives until the next rewrite and is harmless while it does. There is
-- deliberately no unique index on `(user_id, position)`: a reorder rewrites
-- every row of the run, and any intermediate state of that rewrite collides
-- with itself.
CREATE TABLE workstream_pins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, user_id)
);

CREATE INDEX workstream_pins_user_idx
ON workstream_pins(workspace_id, user_id, position);

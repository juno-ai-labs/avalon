-- Complete the Durable Object serving cutover and permit a non-authoritative
-- regional identity anchor for work streams created after cutover. The anchor
-- exists only because pre-existing regional control tables have foreign keys
-- to workstreams(id); product reads must use WorkspaceDO or WorkstreamDO.

ALTER TABLE workstreams ADD COLUMN do_identity_anchor INTEGER NOT NULL DEFAULT 0
  CHECK (do_identity_anchor IN (0, 1));

DROP TRIGGER workstreams_reject_post_cutover_insert;

CREATE TRIGGER workstreams_reject_post_cutover_insert
BEFORE INSERT ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
       NOT IN ('legacy_open', 'maintenance_draining')
  AND NEW.do_identity_anchor != 1
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TABLE workstream_create_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'initialized', 'completed', 'failed')),
  message_id TEXT,
  harness_run_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, creator_user_id, client_message_id),
  UNIQUE (workstream_id)
);

/**
 * WorkspaceDO migration 139: a Canvas's directory row, its participants, and
 * the artifacts its conversation generated.
 *
 * A Canvas is a conversation first: `canvas_id` is the parent id of its
 * `canvas`-kind conversation, so one Canvas can generate many artifacts and a
 * new one has none. `canvas_participants` is who besides the creator may open
 * it; an invited guest lands here when their share is claimed, through the
 * same `parent_invitations` and `parent_grants` rows a Channel share writes,
 * keyed by the Canvas id. `canvas_artifacts` is this object's copy of which
 * resources the Canvas generated, written by the publish that attached each
 * one, so the sidebar and the detail read them without asking the
 * conversation. Its Chat's children, effects and per-reader reads use the
 * hosted conversation tables a Sidekick uses (`sidekick_children`,
 * `sidekick_child_projections`, `sidekick_child_receipts`,
 * `sidekick_viewer_reads`), keyed by the Canvas id in their `sidekick_id`
 * column. `docs/canvases.md` owns all of it.
 *
 * `writer_run_id` names the Sidekick run that created a Canvas, so a run's
 * later publishes find the Canvas its first one made; the unique index makes
 * that create idempotent.
 */
export const CANVAS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE canvas_directory (
    canvas_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) <= 300),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    last_editor_kind TEXT CHECK (last_editor_kind IS NULL OR last_editor_kind IN ('person', 'rally', 'sidekick')),
    last_editor_id TEXT,
    writer_sidekick_id TEXT,
    writer_run_id TEXT,
    visibility TEXT NOT NULL CHECK (visibility IN ('creator', 'participants', 'workspace')),
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    CHECK (writer_run_id IS NULL OR writer_sidekick_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX canvas_directory_recency_idx ON canvas_directory(updated_at DESC, canvas_id)`,
  `CREATE INDEX canvas_directory_writer_idx ON canvas_directory(writer_sidekick_id, updated_at DESC)
     WHERE writer_sidekick_id IS NOT NULL`,
  `CREATE UNIQUE INDEX canvas_directory_run_idx ON canvas_directory(writer_sidekick_id, writer_run_id)
     WHERE writer_run_id IS NOT NULL`,
  `CREATE TABLE canvas_participants (
    canvas_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('added', 'invitation', 'sidekick')),
    added_by_user_id TEXT,
    added_at INTEGER NOT NULL CHECK (added_at >= 0),
    PRIMARY KEY (canvas_id, user_id)
  ) STRICT`,
  `CREATE INDEX canvas_participants_user_idx ON canvas_participants(user_id, canvas_id)`,
  `CREATE TABLE canvas_artifacts (
    canvas_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    added_at INTEGER NOT NULL CHECK (added_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (canvas_id, resource_id)
  ) STRICT`,
  `CREATE INDEX canvas_artifacts_resource_idx ON canvas_artifacts(resource_id)`,
  // The Canvas list's waterline beside the other sidebar lists'. The CHECK
  // cannot widen in place; nothing references the table, so it is copied.
  `CREATE TABLE workspace_sidebar_list_state_v139 (
    list TEXT PRIMARY KEY CHECK (list IN ('automations', 'notes', 'canvases')),
    waterline INTEGER NOT NULL CHECK (waterline >= 0)
  ) STRICT`,
  `INSERT INTO workspace_sidebar_list_state_v139 (list, waterline) SELECT list, waterline FROM workspace_sidebar_list_state`,
  `DROP TABLE workspace_sidebar_list_state`,
  `ALTER TABLE workspace_sidebar_list_state_v139 RENAME TO workspace_sidebar_list_state`,
  `INSERT INTO workspace_sidebar_list_state (list, waterline) VALUES ('canvases', 0)`,
];

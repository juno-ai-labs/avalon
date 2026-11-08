/**
 * WorkspaceDO migration 139: a Canvas's directory row and who besides its
 * creator may open it.
 *
 * A Canvas is a conversation first: `canvas_id` is the parent id of its
 * `canvas`-kind conversation, so one Canvas can generate many artifacts and a
 * new one has none. `canvas_participants` is whom its managers added, by hand
 * (`added`) or by a claimed email share (`invitation`, through the same
 * `parent_invitations` and `parent_grants` rows a Channel share writes, keyed
 * by the Canvas id). A Canvas a Sidekick writes also admits the Sidekick's
 * audience, read live from `automation_directory` and `sidekick_audience`;
 * nothing here copies it. `docs/canvases.md` owns all of it.
 *
 * `writer_run_id` names the Sidekick run that created a Canvas, so a run's
 * later publishes can find the Canvas its first one made; the unique index
 * keeps a run to one Canvas. `HostedCanvas.create` looks the run's Canvas up
 * in the same transaction before inserting, so a second create for the same
 * run under another id answers with the first Canvas rather than failing on
 * the index.
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
    source TEXT NOT NULL CHECK (source IN ('added', 'invitation')),
    added_by_user_id TEXT,
    added_at INTEGER NOT NULL CHECK (added_at >= 0),
    PRIMARY KEY (canvas_id, user_id)
  ) STRICT`,
  `CREATE INDEX canvas_participants_user_idx ON canvas_participants(user_id, canvas_id)`,
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

/**
 * WorkspaceDO migration 140: a Sidekick's conversation attachments admit a
 * Canvas's Chat beside a Thread's, so `conversation_post` can name one. The
 * CHECK cannot widen in place; nothing references the table and it has no
 * index or trigger, so it is copied.
 */
export const SIDEKICK_ATTACHMENTS_ADMIT_CANVAS_STATEMENTS: readonly string[] = [
  `CREATE TABLE sidekick_conversation_attachments_v140 (
    automation_id TEXT NOT NULL,
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'canvas')),
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    attached_by_user_id TEXT NOT NULL,
    attached_at INTEGER NOT NULL CHECK (attached_at >= 0),
    PRIMARY KEY (automation_id, parent_kind, parent_id, substream_id)
  ) STRICT`,
  `INSERT INTO sidekick_conversation_attachments_v140 SELECT * FROM sidekick_conversation_attachments`,
  `DROP TABLE sidekick_conversation_attachments`,
  `ALTER TABLE sidekick_conversation_attachments_v140 RENAME TO sidekick_conversation_attachments`,
];

/**
 * WorkspaceDO migration 141: a person pins a Canvas or a Sidekick in its
 * list's Pinned group, in the same `workspace_pins` table and order the other
 * pins use. Neither names a parent, so the CHECK that only a breakout and an
 * artifact carry one holds. A CHECK cannot widen in place; nothing references
 * the table by foreign key and no trigger hangs off it, so it is copied, as
 * migration 110 copied it.
 */
export const CANVAS_SIDEKICK_PINS_STATEMENTS: readonly string[] = [
  `CREATE TABLE workspace_pins_v141 (
    user_id TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('thread', 'channel', 'breakout', 'artifact', 'canvas', 'sidekick')),
    item_id TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((item_kind IN ('breakout', 'artifact')) = (parent_id IS NOT NULL)),
    PRIMARY KEY (user_id, item_kind, item_id)
  ) STRICT`,
  `INSERT INTO workspace_pins_v141
     (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
   SELECT user_id, item_kind, item_id, parent_id, position, created_at, updated_at
     FROM workspace_pins`,
  `DROP TABLE workspace_pins`,
  `ALTER TABLE workspace_pins_v141 RENAME TO workspace_pins`,
  `CREATE INDEX workspace_pins_order_idx
    ON workspace_pins(user_id, item_kind, position, item_id)`,
  `CREATE INDEX workspace_pins_item_idx ON workspace_pins(item_kind, item_id)`,
];

/**
 * WorkspaceDO migration 142: the artifacts a Canvas's conversation generated,
 * written by the publish that attached each one (`HostedCanvas.noteArtifact`),
 * so the Canvas list and the detail read them without asking the
 * conversation. Its own table, not `workspace_workstream_resource_links`,
 * because that projection's foreign key names `workspace_workstream_directory`,
 * where a Canvas has no row. Ordered by the resource's own `updated_at`, so
 * nothing here copies it.
 */
export const CANVAS_ARTIFACTS_STATEMENTS: readonly string[] = [
  `CREATE TABLE canvas_artifacts (
    canvas_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    added_at INTEGER NOT NULL CHECK (added_at >= 0),
    PRIMARY KEY (canvas_id, resource_id)
  ) STRICT`,
  `CREATE INDEX canvas_artifacts_resource_idx ON canvas_artifacts(resource_id)`,
];

/**
 * WorkspaceDO migration 146: the retirement graph admits a Canvas.
 *
 * Retiring an Organization walks `workspace_retirement_graph`, whose CHECK
 * admitted only `workstream`, `automation` and `space`, so a Canvas's Chat was
 * never closed with it. A CHECK cannot widen in place and nothing references
 * the table, so it is copied: every recorded node and its receipt survive.
 */
export const RETIREMENT_GRAPH_CANVAS_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_retirement_graph_v146 (
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space', 'canvas')),
    parent_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    retired_at INTEGER,
    PRIMARY KEY (parent_kind, parent_id)
  ) STRICT`,
  `INSERT INTO workspace_retirement_graph_v146 (parent_kind, parent_id, recorded_at, retired_at)
     SELECT parent_kind, parent_id, recorded_at, retired_at FROM workspace_retirement_graph`,
  `DROP TABLE workspace_retirement_graph`,
  `ALTER TABLE workspace_retirement_graph_v146 RENAME TO workspace_retirement_graph`,
];

/** The alarm kind that titles a Canvas made with no title from its opening message. */
export const CANVAS_NAMING_ALARM_KIND = "canvas_naming";

/**
 * WorkspaceDO migration 149: whether a Canvas's title is still to come.
 * `naming` while a Canvas made with no title waits for the title its opening
 * message gives it, `settled` once that lands, fails, or a person retitles it.
 * Every existing Canvas was titled already, so the default is `settled`.
 * `docs/canvases.md` owns the mechanism.
 */
export const CANVAS_TITLE_STATUS_STATEMENTS: readonly string[] = [
  `ALTER TABLE canvas_directory ADD COLUMN title_status TEXT NOT NULL DEFAULT 'settled'
     CHECK (title_status IN ('naming', 'settled'))`,
];

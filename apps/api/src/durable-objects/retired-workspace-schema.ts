/**
 * WorkspaceDO migration statements whose runtime code is gone.
 *
 * A shipped migration is never edited (docs/durable-object-sqlite.md), so the
 * statements a deleted module exported for one stay here, byte for byte, for
 * the migration lists in `workspace-do.ts` to keep applying to a fresh object.
 * Only a migration list may import them: the tables they create are dropped by a later
 * migration, and their triggers with them.
 */

// --- Channel colour sync (`channel-color-sync.ts`, deleted in plan step C-2) --

/**
 * Every mark takes the next value of one counter, so a thread's revision never
 * repeats, not even after its row is settled and deleted. A conversation keeps
 * the highest revision it applied and refuses an older one (`recolor`), so a
 * job that stalled behind a newer one cannot put the old colour back.
 */
const NEXT_REVISION = "UPDATE channel_color_sync_state SET revision = revision + 1 WHERE id = 1;";
const CURRENT_REVISION = "(SELECT revision FROM channel_color_sync_state WHERE id = 1)";
const REMARK = "ON CONFLICT(workstream_id) DO UPDATE SET revision = excluded.revision, attempts = 0, not_before = 0, in_flight = 0;";

const MARK = (workstreamId: string) => `${NEXT_REVISION}
     INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before)
       VALUES (${workstreamId}, ${CURRENT_REVISION}, 0, 0)
       ${REMARK}`;

/**
 * A Channel recoloured, archived, restored, or made private, which moves it
 * in `canonicalChannelSpaceId`'s order. Every thread placed in it is marked;
 * the consumer works out whether this Channel is the one that decides.
 * Exported because a rebuild of `spaces` (migration 102) drops it and has to
 * put the same text back.
 */
export const CHANNEL_COLOR_SPACE_CHANGE_TRIGGER =
`CREATE TRIGGER channel_color_space_change AFTER UPDATE OF appearance_json, archived_at, scope ON spaces
   WHEN json_extract(OLD.appearance_json, '$.color') IS NOT json_extract(NEW.appearance_json, '$.color')
     OR OLD.archived_at IS NOT NEW.archived_at OR OLD.scope IS NOT NEW.scope BEGIN
     ${NEXT_REVISION}
     INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before)
       SELECT workstream_id, ${CURRENT_REVISION}, 0, 0 FROM space_channel_memberships
        WHERE space_id = NEW.space_id AND state = 'active'
       ${REMARK}
   END`;

/** WorkspaceDO migration 99; the backfill is its last statement. */
export const CHANNEL_COLOR_SYNC_MIGRATION: readonly string[] = [
  `CREATE TABLE channel_color_sync (
    workstream_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0, 1))
  ) STRICT`,
  `CREATE INDEX channel_color_sync_due_idx ON channel_color_sync(not_before, workstream_id)`,
  `CREATE TABLE channel_color_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision > 0)
  ) STRICT`,
  // The backfill below is revision 1; the first mark after it is 2.
  "INSERT INTO channel_color_sync_state(id, revision) VALUES (1, 1)",
  // A placement made, ended, archived with its Channel or restored. `UPDATE OF
  // state` only: the row's ordinal and timestamps move on every feed write.
  `CREATE TRIGGER channel_color_membership_insert AFTER INSERT ON space_channel_memberships BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_membership_state AFTER UPDATE OF state ON space_channel_memberships
   WHEN OLD.state IS NOT NEW.state BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_membership_delete AFTER DELETE ON space_channel_memberships BEGIN
     ${MARK("OLD.workstream_id")}
   END`,
  CHANNEL_COLOR_SPACE_CHANGE_TRIGGER,
  // A thread's or a Breakout's first projection: the conversation exists now,
  // and starts without a colour. A thread restored from the archive is marked
  // too, since its Channels may have changed colour while it was away.
  `CREATE TRIGGER channel_color_thread_insert AFTER INSERT ON channels BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_thread_restore AFTER UPDATE OF archived_at ON channels
   WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_breakout_insert AFTER INSERT ON breakouts BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_breakout_restore AFTER UPDATE OF archived_at ON breakouts
   WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  // Every thread that exists today, so each one and its Breakouts take their
  // Channel's colour once this ships.
  `INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before)
     SELECT workstream_id, 1, 0, 0 FROM channels WHERE archived_at IS NULL`,
];

// --- Thread backfill (`thread-backfill.ts`, deleted in plan step C-2) --------

/**
 * WorkspaceDO migration 100: the work list, and its first job. Every thread
 * that is not archived has its description summarized the way a new one's is
 * (`summarizeExistingDescription`), Breakouts included.
 */
export const THREAD_BACKFILL_MIGRATION: readonly string[] = [
  `CREATE TABLE thread_backfill (
    job TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0, 1)),
    PRIMARY KEY (job, workstream_id)
  ) STRICT`,
  `CREATE INDEX thread_backfill_due_idx ON thread_backfill(not_before, job, workstream_id)`,
  `INSERT INTO thread_backfill(job, workstream_id, attempts, not_before)
     SELECT 'description_summary', workstream_id, 0, 0 FROM channels WHERE archived_at IS NULL`,
];

/**
 * WorkspaceDO migration 115: the suggestion backfill. Every thread that is
 * not archived has the newest settled Rally turn of its Main and of each open
 * Breakout judged for a merge or Breakout suggestion, the way a fresh
 * settlement is (`backfillSuggestion`), so a conversation that was quiet when
 * the chip shipped gets its line without waiting for a new run.
 */
export const SUGGESTION_BACKFILL_MIGRATION: readonly string[] = [
  `INSERT OR IGNORE INTO thread_backfill(job, workstream_id, attempts, not_before)
     SELECT 'suggestion_backfill', workstream_id, 0, 0 FROM channels WHERE archived_at IS NULL`,
];

/**
 * WorkspaceDO migration 133: where a thread's pass stands. `resume_from` is
 * the conversation id a stopped pass resumes at. `admitted_before` is the
 * time (Unix ms) the thread was first worked on; a `conversation_view` pass
 * covers only the conversations registered by then.
 */
export const THREAD_BACKFILL_RESUME_MIGRATION: readonly string[] = [
  "ALTER TABLE thread_backfill ADD COLUMN resume_from TEXT",
  "ALTER TABLE thread_backfill ADD COLUMN admitted_before INTEGER",
];

import { listedResourceVisibilitySql } from "../services/resource-listing";
import { MEMORY_DIGEST_SYNC_TRIGGERS } from "./memory-digest-sync";

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

// --- Spaces (`workspace-space-storage.ts`, deleted in plan step C-2) ---

/**
 * WorkspaceDO's Space tables.
 *
 * Kept beside the storage that reads them, the way `workstream-access-storage.ts`
 * keeps the hosted parents'. The shapes mirror the Project tables wherever the
 * question is the same — per-person order, a waterline, a many-to-many
 * membership with staged generations, generation-fenced delivery targets and
 * their publications — because those are the parts the Project model got right
 * and this one inherits rather than re-derives.
 *
 * The three deliberate differences are worth naming. The directory row is a
 * *projection*: a Space's presentation, scope and lifecycle are owned by its
 * own object and arrive as the same `directory_common` and `directory_user`
 * effects a Channel publishes, so this table carries the generation, source
 * version and payload hash those effects are fenced on rather than being
 * written directly by a mutation. The default tables carry a `kind`, because a
 * resource and a Sidekick recommendation are one mechanism with two consumers.
 * And there is one `revision` rather than the Project's three generations,
 * which is the contract's decision recorded in `SpaceSummarySchema`.
 */
export const WORKSPACE_SPACE_SCHEMA_STATEMENTS: readonly string[] = [
  // `source_version` starts at zero on a reservation and every real projection
  // is version one or higher, which is what lets `reserveSpace` write a row the
  // Space's own first `directory_common` effect then supersedes instead of
  // colliding with at the same version under a different hash.
  `CREATE TABLE workspace_space_directory (
    space_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json)),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
    created_by_user_id TEXT,
    system_role TEXT CHECK (system_role IS NULL OR system_role = 'general'),
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version >= 0),
    payload_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),
    source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0)
  ) STRICT`,
  // One General per Organization, enforced by the index rather than by whoever
  // is writing: `openGeneralSpace` is idempotent and is called from creation,
  // from the cutover, and from a retry of either, and two of those racing is
  // exactly how an Organization ends up with two fallbacks.
  `CREATE UNIQUE INDEX workspace_space_directory_system_role_idx
    ON workspace_space_directory(system_role) WHERE system_role IS NOT NULL`,
  `CREATE INDEX workspace_space_directory_active_idx
    ON workspace_space_directory(archived_at, created_at, space_id)`,
  `CREATE TABLE workspace_space_viewers (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_participant INTEGER NOT NULL CHECK (is_participant IN (0, 1)),
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version >= 0),
    payload_hash TEXT NOT NULL,
    PRIMARY KEY (space_id, user_id)
  ) STRICT`,
  `CREATE INDEX workspace_space_viewers_user_idx
    ON workspace_space_viewers(user_id, is_participant, space_id)`,
  // One table for every list a person arranges by hand, keyed by the container
  // the list belongs to: the Organization's Spaces, the Channels placed in one
  // Space, the Breakouts under one Channel. They are the same question asked of
  // three containers — in what order does this person want these items — and
  // three tables would have been three of everything above them: three writes,
  // three reads, three deliveries. `container_kind` says which list,
  // `container_id` says which container of that kind (the workspace id for
  // `organization`, so a row is addressed without the object it sits in being
  // part of the key), and `item_id` is a Space, a Channel or a Breakout
  // accordingly.
  //
  // Nothing here constrains `item_id` to anything this object knows about. The
  // Organization's and a Space's lists are filtered against this object's own
  // rows when they are written; a Channel's Breakouts are its own object's
  // children, which WorkspaceDO cannot see at all — see
  // `WorkspaceSpaceStorage.writeOrder`.
  `CREATE TABLE workspace_container_order (
    user_id TEXT NOT NULL,
    container_kind TEXT NOT NULL CHECK (container_kind IN ('organization', 'space', 'channel')),
    container_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, container_kind, container_id, item_id)
  ) STRICT`,
  `CREATE INDEX workspace_container_order_position_idx
    ON workspace_container_order(user_id, container_kind, container_id, position, item_id)`,
  `CREATE TABLE workspace_space_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    waterline INTEGER NOT NULL CHECK (waterline >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `INSERT INTO workspace_space_state (id, waterline, updated_at) VALUES (1, 0, 0)`,
  // No uniqueness on `workstream_id`: a Channel belongs to as many Spaces as it
  // was added to, and the Project table's single-assignment behavior was a
  // product rule rather than a storage one.
  `CREATE TABLE space_channel_memberships (
    space_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('joining', 'active', 'removing', 'removed')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    joined_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
    PRIMARY KEY (space_id, workstream_id)
  ) STRICT`,
  `CREATE INDEX space_channel_memberships_space_state_idx
    ON space_channel_memberships(space_id, state, workstream_id)`,
  `CREATE INDEX space_channel_memberships_channel_state_idx
    ON space_channel_memberships(workstream_id, state, space_id)`,
  // One table for every staged cross-object Space operation, keyed by the
  // caller's operation id. `kind` is what it is; the three nullable fences are
  // what it was staged against. A second table per kind would have meant a
  // second alarm sweep per kind for the one thing they all need — being
  // republished when the request that created them died mid-flight.
  //
  // `cursor` is how far the operation's fan-out got, in the same shape
  // `space_bootstrap.cursor` carries the cutover's walk: the Channel id the
  // last finished page stopped at. An audience change, an archive and a
  // restore each walk every member Channel, so without it a resume restarted
  // the whole walk from the top and a Space larger than one invocation's
  // budget had an operation that could never finish.
  //
  // `last_error_code` is the column `space_default_targets` beside it already
  // carries, for the reason it carries it: a resume that keeps failing
  // otherwise leaves its reason in a log line alone, and whoever finds the
  // unsettled row afterwards has the fact without the reason
  // (`docs/naming-a-schema-failure.md`).
  `CREATE TABLE space_intents (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
      'add', 'remove', 'audience', 'archive', 'restore'
    )),
    space_id TEXT NOT NULL,
    workstream_id TEXT,
    space_revision INTEGER NOT NULL CHECK (space_revision > 0),
    membership_generation INTEGER CHECK (membership_generation IS NULL OR membership_generation > 0),
    delivery_generation INTEGER CHECK (delivery_generation IS NULL OR delivery_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'settled', 'cancelled')),
    cursor TEXT,
    last_error_code TEXT,
    receipts_json TEXT NOT NULL CHECK (json_valid(receipts_json)),
    requested_by_user_id TEXT NOT NULL,
    not_before INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX space_intents_unsettled_idx
    ON space_intents(state, not_before, operation_id)`,
  `CREATE TABLE space_defaults (
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('resource', 'sidekick')),
    target_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
    PRIMARY KEY (space_id, kind, target_id)
  ) STRICT`,
  `CREATE TABLE space_default_targets (
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('resource', 'sidekick')),
    target_id TEXT NOT NULL,
    default_generation INTEGER NOT NULL CHECK (default_generation > 0),
    workstream_id TEXT NOT NULL,
    membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'terminal')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
    last_error_code TEXT,
    PRIMARY KEY (space_id, kind, target_id, default_generation, workstream_id, membership_generation),
    FOREIGN KEY (space_id, kind, target_id)
      REFERENCES space_defaults(space_id, kind, target_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE INDEX space_default_targets_pending_idx
    ON space_default_targets(state, space_id, kind, target_id, workstream_id)`,
  `CREATE TABLE space_default_publications (
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('resource', 'sidekick')),
    target_id TEXT NOT NULL,
    default_generation INTEGER NOT NULL CHECK (default_generation > 0),
    workstream_id TEXT NOT NULL,
    membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
    requested_by_user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= 0),
    PRIMARY KEY (space_id, kind, target_id, default_generation, workstream_id, membership_generation),
    FOREIGN KEY (space_id, kind, target_id, default_generation, workstream_id, membership_generation)
      REFERENCES space_default_targets(
        space_id, kind, target_id, default_generation, workstream_id, membership_generation
      ) ON DELETE CASCADE
  ) STRICT`,
  `CREATE INDEX space_default_publications_due_idx
    ON space_default_publications(state, next_attempt_at, space_id, kind, target_id)`,
  // Seeded `pending` for every Organization, new or existing. A new one
  // completes it in a few writes; an existing one is driven through it by the
  // cutover. Both read the same row, so nothing has to ask which kind of
  // Organization it is looking at.
  // `not_before` and `attempts` are the retry gate the alarm claims on, in the
  // shape every other staged fan-out in this object uses: the gate advances
  // *before* the Queue send, so a rejected batch is retried later rather than
  // spinning the alarm, and a page that is delivered but never reported is
  // republished rather than lost. Progress clears it, so the next page follows
  // immediately instead of waiting out a retry interval.
  `CREATE TABLE space_bootstrap (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'general', 'preflight', 'memberships', 'finalize', 'complete')),
    general_space_id TEXT,
    cursor TEXT,
    blocked_json TEXT NOT NULL CHECK (json_valid(blocked_json)),
    not_before INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0)
  ) STRICT`,
  `INSERT INTO space_bootstrap
     (id, phase, general_space_id, cursor, blocked_json, not_before, attempts,
      started_at, updated_at, completed_at)
   VALUES (1, 'pending', NULL, NULL, '[]', 0, 0, 0, 0, NULL)`,
  // Migration 42's CHECK admits two of the three parent kinds, and SQLite
  // cannot widen one in place. Rows are carried through a scratch table rather
  // than recreated from the directories, because the graph is captured
  // *before* the workspace tombstone and its `retired_at` receipts are the only
  // record that a node was already retired — re-deriving it would un-retire
  // whatever the last pass finished. Nothing references this table, so the drop
  // cascades to nothing and the rebuild needs no foreign-key pragma; migration
  // 42 itself is released and is not edited.
  `CREATE TABLE _space_copy_workspace_retirement_graph AS
     SELECT * FROM workspace_retirement_graph`,
  `DROP TABLE workspace_retirement_graph`,
  `CREATE TABLE workspace_retirement_graph (
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space')),
    parent_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    retired_at INTEGER,
    PRIMARY KEY (parent_kind, parent_id)
  ) STRICT`,
  `INSERT INTO workspace_retirement_graph (parent_kind, parent_id, recorded_at, retired_at)
     SELECT parent_kind, parent_id, recorded_at, retired_at
       FROM _space_copy_workspace_retirement_graph`,
  `DROP TABLE _space_copy_workspace_retirement_graph`,
];

/**
 * Migration 87: each person's order for **All**'s Pinned section.
 *
 * A table of its own rather than a fourth `container_kind` in
 * `workspace_container_order`, so a Worker from before it never reads a row it
 * cannot parse — a rollback stays safe. One Organization per object, so the
 * rows key on the person alone.
 */
export const WORKSPACE_PINNED_ORDER_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_pinned_order (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  ) STRICT`,
  `CREATE INDEX workspace_pinned_order_position_idx
    ON workspace_pinned_order(user_id, position, item_id)`,
];

/**
 * Migration 94: every private Space becomes Organization-wide.
 *
 * Spaces can only be Organization-wide, and a Space grants no reader to its
 * Channels (`docs/spaces.md`), so widening a Space here changes who
 * sees the Space and nothing about who reads any Channel in it: a private
 * Channel stays private with the participants it has. Archived Spaces are
 * widened too, so a restore cannot bring a private one back. The waterline
 * moves only when a row did, so every client refetches its Spaces once. The
 * Space revision does not move: a staged add is fenced on it, and an add
 * interrupted by the deploy would otherwise be cancelled as superseded.
 *
 * A private Space's resource defaults were checked against its participants
 * only, and once it is Organization-wide any member can start a Channel in it
 * that picks them up. Whether each resource admits every member is a read per
 * member through `ResourceService`, which a migration cannot make, so they are
 * retired the way `removeDefault` retires one: the generation step also fences
 * every pending delivery. A Sidekick default is already Organization-wide
 * (`assertRecommendableSidekick`) and stays.
 *
 * The four tables that recorded which Space supplied which Channel readers
 * are dropped with the code that wrote them (`docs/space-access-sources.md`).
 * Their receipts stored plans under the old rule, so keeping them would let a
 * retried operation replay a widening or a narrowing nothing decides any more.
 * Readers first: it references the sources table. The readers a Space seated
 * stay seated as `parent_grants` rows, which are the access itself.
 */
/**
 * Migration 96: people invited to the Organization who have not joined,
 * listed in a Space by address. A participant is a user id, which an invitee
 * does not have until they accept; `seatInvitees` turns these rows into
 * participant rows then. No foreign key to `spaces`: a Space is archived, never
 * deleted, and a key would make a future rebuild of `spaces` cascade here.
 * The address index is the acceptance's lookup.
 */
export const SPACE_INVITEES_MIGRATION: readonly string[] = [
  `CREATE TABLE space_invitees (
    space_id TEXT NOT NULL,
    email TEXT NOT NULL CHECK (email = lower(email)),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, email)
  ) STRICT`,
  `CREATE INDEX space_invitees_email_idx ON space_invitees(email)`,
];

export const SPACE_PUBLIC_ONLY_MIGRATION: readonly string[] = [
  `UPDATE workspace_space_state
      SET waterline = waterline + 1, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE id = 1 AND EXISTS (SELECT 1 FROM spaces WHERE scope = 'personal')`,
  `UPDATE space_defaults
      SET state = 'removed', generation = generation + 1,
          updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
          removed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE kind = 'resource' AND state = 'active'
      AND space_id IN (SELECT space_id FROM spaces WHERE scope = 'personal')`,
  `DROP TABLE IF EXISTS parent_space_readers`,
  `DROP TABLE IF EXISTS parent_space_sources`,
  `DROP TABLE IF EXISTS parent_direct_audience`,
  `DROP TABLE IF EXISTS parent_access_operations`,
  `UPDATE spaces
      SET scope = 'workspace', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE scope = 'personal'`,
];

/**
 * WorkspaceDO migration 102: `spaces.scope` admits `individual`, the Personal
 * Channel each member is given (`docs/spaces.md#the-personal-channel`).
 *
 * SQLite cannot change a `CHECK`, so the table is rebuilt: held, dropped,
 * created with the wider check, refilled, and the hold dropped. No rename, so
 * no trigger elsewhere is re-parsed against a missing table. Its two indexes
 * and the colour trigger go with the old table and are created again under the
 * same names and text.
 *
 * One table holds a foreign key to `spaces`: `workspace_workstream_pins`
 * (migration 66, `ON DELETE CASCADE`, repointed from
 * `workspace_space_directory` by migration 72's rename). Dropping `spaces`
 * with enforcement on, which is the only way it runs
 * (`docs/durable-object-sqlite.md`), would delete every pin. So the pins are
 * held and emptied first and put back once `spaces` exists again: the recipe
 * migrations 31 and 55 follow.
 *
 * `spaces_individual_owner_idx` is the one-per-member rule: two seatings
 * racing for the same person cannot both leave a Personal Channel, whatever
 * id each was given.
 */
export const SPACE_INDIVIDUAL_SCOPE_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_workstream_pins_hold AS
     SELECT user_id, space_id, workstream_id, position, created_at, updated_at FROM workspace_workstream_pins`,
  `DELETE FROM workspace_workstream_pins`,
  `CREATE TABLE spaces_hold AS SELECT * FROM spaces`,
  `DROP TABLE spaces`,
  `CREATE TABLE spaces (
    space_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'individual')),
    appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json)),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
    created_by_user_id TEXT,
    system_role TEXT CHECK (system_role IS NULL OR system_role = 'general'),
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version >= 0),
    payload_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),
    source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),
    latest_attention_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (latest_attention_ordinal >= 0),
    unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (unread_tracking_start_ordinal >= 0),
    CHECK (scope <> 'individual' OR (created_by_user_id IS NOT NULL AND system_role IS NULL))
  ) STRICT`,
  `INSERT INTO spaces (
     space_id, title, scope, appearance_json, archived_at, created_by_user_id, system_role,
     authority_generation, source_version, payload_hash, revision, created_at, updated_at,
     source_created_at, source_updated_at, latest_attention_ordinal, unread_tracking_start_ordinal
   )
   SELECT space_id, title, scope, appearance_json, archived_at, created_by_user_id, system_role,
          authority_generation, source_version, payload_hash, revision, created_at, updated_at,
          source_created_at, source_updated_at, latest_attention_ordinal, unread_tracking_start_ordinal
     FROM spaces_hold`,
  `DROP TABLE spaces_hold`,
  `INSERT INTO workspace_workstream_pins (user_id, space_id, workstream_id, position, created_at, updated_at)
     SELECT user_id, space_id, workstream_id, position, created_at, updated_at FROM workspace_workstream_pins_hold`,
  `DROP TABLE workspace_workstream_pins_hold`,
  `CREATE UNIQUE INDEX workspace_space_directory_system_role_idx
    ON spaces(system_role) WHERE system_role IS NOT NULL`,
  `CREATE INDEX workspace_space_directory_active_idx
    ON spaces(archived_at, created_at, space_id)`,
  `CREATE UNIQUE INDEX spaces_individual_owner_idx
    ON spaces(created_by_user_id) WHERE scope = 'individual'`,
  CHANNEL_COLOR_SPACE_CHANGE_TRIGGER,
];

/**
 * WorkspaceDO migration 134: `space_viewers.joined_at`, when each person last
 * became a Channel participant (`docs/digests.md#who-is-told-about-channel-news`).
 *
 * `NOT NULL` with no default, which SQLite adds only by a rebuild; the rebuild
 * restores the user index under its v70 name and the memory digest's
 * participant triggers. Nobody recorded when existing participants joined, so
 * each is dated at the Channel's earliest known creation: the smaller of the
 * local `created_at` and `source_created_at`, because a Space that arrived
 * through its projection has `created_at` set to when it was applied here. A
 * row whose Space row is missing gets 0.
 */
export const SPACE_VIEWER_JOINED_AT_MIGRATION: readonly string[] = [
  `CREATE TABLE space_viewers_next (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_participant INTEGER NOT NULL CHECK (is_participant IN (0, 1)),
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version >= 0),
    payload_hash TEXT NOT NULL,
    joined_at INTEGER NOT NULL CHECK (joined_at >= 0),
    PRIMARY KEY (space_id, user_id)
  ) STRICT`,
  `INSERT INTO space_viewers_next
     (space_id, user_id, is_participant, authority_generation, source_version, payload_hash, joined_at)
   SELECT viewer.space_id, viewer.user_id, viewer.is_participant, viewer.authority_generation,
          viewer.source_version, viewer.payload_hash,
          COALESCE((SELECT MIN(space.created_at, CASE WHEN space.source_created_at > 0
                                                       THEN space.source_created_at ELSE space.created_at END)
                      FROM spaces space WHERE space.space_id = viewer.space_id), 0)
     FROM space_viewers viewer`,
  `DROP TABLE space_viewers`,
  `ALTER TABLE space_viewers_next RENAME TO space_viewers`,
  // Its v70 name, which every object already carries and the rename tests hold.
  `CREATE INDEX workspace_space_viewers_user_idx ON space_viewers(user_id, is_participant, space_id)`,
  ...MEMORY_DIGEST_SYNC_TRIGGERS.space_viewers,
];

/**
 * WorkspaceDO migration 104: messages in a Channel itself, outside any
 * thread (`docs/spaces.md#channel-messages`). A building block beside a
 * Channel's placements: who said it (Rally, or a member), what, and when.
 *
 * `message_id` is derived from the Channel and `message_key` when the poster
 * names a key, which makes that post idempotent, and is otherwise fresh. It is
 * what the feed orders a message by beside the threads' ids. No foreign key to
 * `spaces`, for the reason `SPACE_INVITEES_MIGRATION` gives.
 */
export const SPACE_MESSAGES_MIGRATION: readonly string[] = [
  `CREATE TABLE space_messages (
    message_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    message_key TEXT,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('rally', 'member')),
    author_user_id TEXT,
    body TEXT NOT NULL CHECK (length(body) > 0),
    posted_at INTEGER NOT NULL CHECK (posted_at >= 0),
    CHECK ((author_kind = 'member') = (author_user_id IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX space_messages_feed_idx ON space_messages(space_id, posted_at, message_id)`,
];

/**
 * WorkspaceDO migration 109: a Channel message can be a thread's merged
 * result, and any Channel message can be Channel news (`docs/conversation-merge.md`).
 *
 * `source_workstream_id` is the thread a message is about; the feed shows such
 * a message only to who can open that thread. `attention_ordinal` is the
 * message's place on the Channel's one waterline, NULL for a message that is
 * not news and for every message that predates this, read as zero.
 * `embeds_json` holds `[{id, title, kind}]` as they were when posted, so the
 * feed draws artifact cards with no lookup. `merge_operation_id` is the
 * operation that last wrote the row. `space_message_operations` holds every
 * operation that ever wrote a message, so a retry of any of them, however
 * late, writes nothing: one row per merge a person made, which is human-scale.
 */
export const SPACE_MESSAGE_MERGES_MIGRATION: readonly string[] = [
  `ALTER TABLE space_messages ADD COLUMN source_workstream_id TEXT`,
  `ALTER TABLE space_messages ADD COLUMN attention_ordinal INTEGER CHECK (attention_ordinal IS NULL OR attention_ordinal > 0)`,
  `ALTER TABLE space_messages ADD COLUMN embeds_json TEXT CHECK (embeds_json IS NULL OR json_valid(embeds_json))`,
  `ALTER TABLE space_messages ADD COLUMN merge_operation_id TEXT`,
  `CREATE TABLE space_message_operations (
    message_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, operation_id)
  ) STRICT`,
  // A Breakout merge is a \`merged\` Activity row read from its message's
  // activity event; this keeps that arm of the feed off a scan of every event.
  `CREATE INDEX workspace_activity_events_merged_idx ON workspace_activity_events(occurred_at, event_id)
    WHERE json_extract(metadata_json, '$.mergedFrom.breakoutId') IS NOT NULL`,
];

// --- Channel rails (`channel-rails.ts`, deleted in plan step C-2) ---

/**
 * Advance these Channels' rail waterlines and note them in the ledger. An id
 * that is not a Channel (a Space parent, an unlinked resource) matches nothing.
 */
function bumpRailsSql(channelIds: string): string {
  return `UPDATE channels SET rail_waterline = rail_waterline + 1 WHERE workstream_id IN (${channelIds});
     INSERT INTO channel_rail_changes (workstream_id)
       SELECT workstream_id FROM channels WHERE workstream_id IN (${channelIds})
       ON CONFLICT(workstream_id) DO NOTHING;`;
}

function changed(columns: readonly string[]): string {
  return columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
}

/**
 * What an owned entry shows, and which room owns it. Not the run times or
 * `projected_at`, which move on every scheduled run and are not shown.
 */
const OWNED_AUTOMATION_COLUMNS = [
  "title", "description", "lifecycle", "loadable", "appearance_json", "scope", "owning_workstream_id",
] as const;

/** What a recommended or attached entry shows, and who it is shown to. */
const LISTED_SIDEKICK_COLUMNS = [
  "title", "description", "lifecycle", "loadable", "scope", "owning_workstream_id", "author_user_id", "run_as_user_id",
] as const;

const RAIL_RESOURCE_COLUMNS = ["title", "resource_type", "mime_type", "current_version", "provider"] as const;

const sidekickListers = (row: "NEW" | "OLD") =>
  `SELECT parent_id FROM parent_sidekicks WHERE sidekick_id = ${row}.automation_id
   UNION SELECT workstream_id FROM channel_sidekick_attachments WHERE sidekick_id = ${row}.automation_id`;

const resourceLinkers = (row: "NEW" | "OLD") =>
  `SELECT workstream_id FROM workspace_workstream_resource_links WHERE resource_id = ${row}.id`;

/**
 * WorkspaceDO migration 82: Main's reported attachments, the waterline, the
 * change ledger, and a trigger on every table a rail reads whose writers are
 * not already Channel-row writers. Main's link and attachment lists are
 * compared in `applyDirectoryEnvelope` instead: every Main effect rewrites
 * them, and a trigger there would fire on each one.
 */
export const CHANNEL_RAIL_MIGRATION: readonly string[] = [
  `ALTER TABLE channels ADD COLUMN rail_waterline INTEGER NOT NULL DEFAULT 0 CHECK (rail_waterline >= 0)`,
  `ALTER TABLE channels ADD COLUMN sidekick_attachments_reported INTEGER NOT NULL DEFAULT 0
     CHECK (sidekick_attachments_reported IN (0, 1))`,
  `CREATE TABLE channel_sidekick_attachments (
    workstream_id TEXT NOT NULL REFERENCES channels(workstream_id) ON DELETE CASCADE,
    sidekick_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (workstream_id, sidekick_id)
  ) STRICT`,
  `CREATE INDEX channel_sidekick_attachments_sidekick_idx ON channel_sidekick_attachments(sidekick_id, workstream_id)`,
  `CREATE INDEX parent_sidekicks_sidekick_idx ON parent_sidekicks(sidekick_id, parent_id)`,
  `CREATE TABLE channel_rail_changes (workstream_id TEXT PRIMARY KEY) STRICT`,

  `CREATE TRIGGER channel_rail_viewer_insert AFTER INSERT ON channel_viewers
     WHEN NEW.is_participant = 1
     BEGIN ${bumpRailsSql("SELECT NEW.workstream_id")} END`,
  `CREATE TRIGGER channel_rail_viewer_update
     AFTER UPDATE OF is_participant, authority_generation, participant_added_at ON channel_viewers
     WHEN OLD.is_participant IS NOT NEW.is_participant
       OR (NEW.is_participant = 1 AND (${changed(["authority_generation", "participant_added_at"])}))
     BEGIN ${bumpRailsSql("SELECT NEW.workstream_id")} END`,
  `CREATE TRIGGER channel_rail_viewer_delete AFTER DELETE ON channel_viewers
     WHEN OLD.is_participant = 1
     BEGIN ${bumpRailsSql("SELECT OLD.workstream_id")} END`,
  // `UPDATE OF` names two columns, so the bump's own write cannot fire it again.
  `CREATE TRIGGER channel_rail_channel_update AFTER UPDATE OF scope, authority_generation ON channels
     WHEN ${changed(["scope", "authority_generation"])}
     BEGIN ${bumpRailsSql("SELECT NEW.workstream_id")} END`,

  `CREATE TRIGGER channel_rail_recommendation_insert AFTER INSERT ON parent_sidekicks
     BEGIN ${bumpRailsSql("SELECT NEW.parent_id")} END`,
  `CREATE TRIGGER channel_rail_recommendation_delete AFTER DELETE ON parent_sidekicks
     BEGIN ${bumpRailsSql("SELECT OLD.parent_id")} END`,

  `CREATE TRIGGER channel_rail_sidekick_insert AFTER INSERT ON automation_directory
     BEGIN ${bumpRailsSql(`SELECT NEW.owning_workstream_id UNION ${sidekickListers("NEW")}`)} END`,
  `CREATE TRIGGER channel_rail_sidekick_owner_update
     AFTER UPDATE OF ${OWNED_AUTOMATION_COLUMNS.join(", ")} ON automation_directory
     WHEN ${changed(OWNED_AUTOMATION_COLUMNS)}
     BEGIN ${bumpRailsSql("SELECT OLD.owning_workstream_id UNION SELECT NEW.owning_workstream_id")} END`,
  `CREATE TRIGGER channel_rail_sidekick_listed_update
     AFTER UPDATE OF ${LISTED_SIDEKICK_COLUMNS.join(", ")} ON automation_directory
     WHEN ${changed(LISTED_SIDEKICK_COLUMNS)}
     BEGIN ${bumpRailsSql(sidekickListers("NEW"))} END`,
  `CREATE TRIGGER channel_rail_sidekick_delete AFTER DELETE ON automation_directory
     BEGIN ${bumpRailsSql(`SELECT OLD.owning_workstream_id UNION ${sidekickListers("OLD")}`)} END`,

  // A link can name a resource before its row arrives.
  `CREATE TRIGGER channel_rail_resource_insert AFTER INSERT ON resources
     BEGIN ${bumpRailsSql(resourceLinkers("NEW"))} END`,
  `CREATE TRIGGER channel_rail_resource_update
     AFTER UPDATE OF ${RAIL_RESOURCE_COLUMNS.join(", ")}, metadata_json ON resources
     WHEN ${changed(RAIL_RESOURCE_COLUMNS)}
       OR (${listedResourceVisibilitySql("OLD")}) IS NOT (${listedResourceVisibilitySql("NEW")})
     BEGIN ${bumpRailsSql(resourceLinkers("NEW"))} END`,
  `CREATE TRIGGER channel_rail_resource_delete AFTER DELETE ON resources
     BEGIN ${bumpRailsSql(resourceLinkers("OLD"))} END`,
];

// --- Channel reads (`workspace-channel-read-storage.ts`, deleted in plan step C-2) ---

/**
 * Migration 98: a Channel's (storage `space`) unread waterline and each
 * person's read position in it.
 *
 * The columns are the ones a thread (`channels` / `channel_viewers`) and a
 * breakout (`breakouts` / `breakout_viewers`) already carry, with the same
 * names and the same meaning, so a Channel can later move onto its own
 * AgentLoopDO and write them through directory effects without a second
 * vocabulary. What advances the waterline is a thread being placed in the
 * Channel, and nothing else: each activation of a membership takes the next
 * ordinal and stamps it on the membership, which is what a feed row reports as
 * its `attentionSequenceNumber`.
 *
 * **Why `space_reads` rather than columns on `space_viewers`.** Every Space is
 * Organization-wide (migration 94), so a member reaches most Channels with no
 * `space_viewers` row at all, and that table is a projection from the Space's
 * own authority: a viewer row is deleted when the projection says inactive,
 * and replaced at each newer source version. A read position kept there would
 * have nowhere to live for most readers and would be erased by an unrelated
 * audience change. A row here is written by the reader alone, the way
 * `workspace_activity_seen` and `workspace_pins` are.
 *
 * No foreign key to `spaces`, for the reason `space_invitees` gives: a key
 * would make a future rebuild of `spaces` cascade here.
 *
 * **Backfill.** Every active placement is numbered per Channel in placement
 * order, and the Channel's waterline and tracking start are both set to the
 * count, so nothing is unread on deploy. Rows that are not active keep `NULL`;
 * the feed reads active rows only and treats `NULL` as zero.
 */
export const WORKSPACE_CHANNEL_READS_MIGRATION: readonly string[] = [
  `ALTER TABLE spaces ADD COLUMN latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
     CHECK (latest_attention_ordinal >= 0)`,
  `ALTER TABLE spaces ADD COLUMN unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
     CHECK (unread_tracking_start_ordinal >= 0)`,
  `ALTER TABLE space_channel_memberships ADD COLUMN attention_ordinal INTEGER
     CHECK (attention_ordinal IS NULL OR attention_ordinal > 0)`,
  `CREATE TABLE space_reads (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seen_attention_ordinal INTEGER CHECK (seen_attention_ordinal IS NULL OR seen_attention_ordinal >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
  ) STRICT`,
  `UPDATE space_channel_memberships
      SET attention_ordinal = ranked.ordinal
     FROM (
       SELECT space_id, workstream_id,
              ROW_NUMBER() OVER (PARTITION BY space_id ORDER BY joined_at, workstream_id) AS ordinal
         FROM space_channel_memberships
        WHERE state = 'active'
     ) ranked
    WHERE space_channel_memberships.space_id = ranked.space_id
      AND space_channel_memberships.workstream_id = ranked.workstream_id`,
  `UPDATE spaces
      SET latest_attention_ordinal = placed.count,
          unread_tracking_start_ordinal = placed.count
     FROM (
       SELECT space_id, COUNT(*) AS count
         FROM space_channel_memberships
        WHERE state = 'active'
        GROUP BY space_id
     ) placed
    WHERE spaces.space_id = placed.space_id`,
];

// --- Channel message search (`channel-message-search-projection.ts`, deleted in plan step C-2) ---

/**
 * WorkspaceDO migration 120. `space_id` is kept beside the revision because a
 * deleted message's document id is derived from it. A Channel's rename does
 * not rewrite its rows: the row's title is the name when it was indexed, and
 * nothing reads it (`conversation_search` names a match from its scope). A
 * reader of row titles would add a rename trigger in a migration of its own.
 * Immutable once shipped: each statement is hashed into the migration receipt.
 */
export const CHANNEL_MESSAGE_SEARCH_MIGRATION: readonly string[] = [
  `CREATE TABLE channel_message_search_versions (
    message_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
    not_before INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX channel_message_search_versions_pending_idx
     ON channel_message_search_versions(pending, not_before, message_id)`,
  ...(["INSERT", "DELETE"] as const).map((operation) => {
    const row = operation === "DELETE" ? "OLD" : "NEW";
    return `CREATE TRIGGER space_messages_search_${operation.toLowerCase()} AFTER ${operation} ON space_messages
      BEGIN
        INSERT INTO channel_message_search_versions(message_id, space_id, revision, pending, not_before)
        VALUES (${row}.message_id, ${row}.space_id, 1, 1, 0)
        ON CONFLICT(message_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
      END`;
  }),
  // A merge made again rewrites its row in place with new words and a new time.
  `CREATE TRIGGER space_messages_search_update AFTER UPDATE ON space_messages
    WHEN OLD.body IS NOT NEW.body OR OLD.posted_at IS NOT NEW.posted_at OR OLD.space_id IS NOT NEW.space_id
    BEGIN
      INSERT INTO channel_message_search_versions(message_id, space_id, revision, pending, not_before)
      VALUES (NEW.message_id, NEW.space_id, 1, 1, 0)
      ON CONFLICT(message_id) DO UPDATE SET space_id = NEW.space_id, revision = revision + 1, pending = 1, not_before = 0;
    END`,
  `INSERT INTO channel_message_search_versions(message_id, space_id, revision, pending, not_before)
   SELECT message_id, space_id, 1, 1, 0 FROM space_messages`,
];

// --- Breakout directory (`workspace-breakout-storage.ts`, deleted in plan step C-2) ---

/**
 * WorkspaceDO's breakout directory tables. Migration 63.
 *
 * **Neither table has a foreign key, and that is a measured decision rather
 * than an omission.** `channel_viewers` cascades from the Channel
 * directory, and the obvious reading is that these two should cascade the same
 * way — from the Channel directory, and from the breakout directory. Both were
 * tried on real workerd and both are wrong, because Durable Object SQLite
 * enforces foreign keys and cannot be asked not to:
 *
 * - A breakout's projection can reach the Organization before its Channel's
 *   own `directory_common` does. `reserveChild` writes a provisional row for a
 *   *Channel* before anything else it publishes; nothing reserves a breakout.
 *   A key on `workstream_id` rejects that arrival outright.
 * - A breakout's `directory_user` effect can reach it before its
 *   `directory_common`. They are two Queue messages under two projection keys
 *   and the Queue orders neither; `workstream-do.ts` says so where the forward
 *   is decided, and calls a viewer row that arrives first harmless because the
 *   page joins the directory and lists nothing for it. A composite key on
 *   `(workstream_id, substream_id)` turns that harmless case into a rejected
 *   envelope, redelivered until it reaches the dead-letter queue.
 *
 * What a cascade would have bought is a deletion nothing performs: no path
 * deletes a Channel directory row outside migration 32. So the rule lives here
 * instead, for whoever writes the first one — **deleting a Channel's directory
 * row must delete its breakout rows in the same transaction**, because there
 * is no key that will do it for you.
 */
export const WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS: readonly string[] = [
  // Keyed by `(workstream_id, substream_id)` rather than by the substream id
  // alone. The substream id is unique on its own, but every read here starts
  // from a Channel — the Space page joins from the membership row — so the
  // parent leads the key and the primary-key index is the join's own index.
  //
  // The columns are what the forwarded effect carries, and they are named the
  // way the Channel directory names the same facts, because one code-owned
  // predicate is rendered against both aliases and a column spelled
  // differently here would be a second predicate pretending to be one.
  `CREATE TABLE workspace_breakout_directory (
    workstream_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    waterline INTEGER NOT NULL CHECK (waterline > 0),
    source_event_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    exact_state TEXT NOT NULL,
    title_status TEXT NOT NULL CHECK (title_status IN ('naming', 'automatic', 'settled')),
    created_by_user_id TEXT,
    last_activity_at INTEGER NOT NULL,
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
    latest_attention_ordinal INTEGER NOT NULL CHECK (latest_attention_ordinal >= 0),
    unread_tracking_start_ordinal INTEGER NOT NULL CHECK (unread_tracking_start_ordinal >= 0),
    source_created_at INTEGER NOT NULL CHECK (source_created_at >= 0),
    source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
    projected_at INTEGER NOT NULL,
    PRIMARY KEY (workstream_id, substream_id)
  ) STRICT`,
  // The per-person half. `listable` is the whole visibility answer a breakout
  // gets from its own authority — it already accounts for the breakout being
  // archived and for this person's membership of a private child — and the
  // page asks it rather than re-deriving the question from participation.
  //
  // No index beside the primary key. Every read of this table starts from a
  // `(workstream_id, substream_id)` the page has already chosen, and both
  // deletes are per-envelope ones the projection itself performs: when a
  // person stops being an active member, and when the conversation turns out
  // to be a background agent. `workspace_workstream_viewers` has no
  // user-id index either, and there is no sweep for one to serve: an index
  // here would be a write on every viewer projection buying nothing, and a
  // comment claiming a sweep that somebody would later quote as evidence one
  // exists.
  `CREATE TABLE workspace_breakout_viewers (
    workstream_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    waterline INTEGER NOT NULL CHECK (waterline > 0),
    source_event_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    is_participant INTEGER NOT NULL CHECK (is_participant IN (0, 1)),
    unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
    you_are_mentioned INTEGER NOT NULL CHECK (you_are_mentioned IN (0, 1)),
    unseen INTEGER NOT NULL CHECK (unseen IN (0, 1)),
    listable INTEGER NOT NULL CHECK (listable IN (0, 1)),
    seen_attention_ordinal INTEGER NOT NULL CHECK (seen_attention_ordinal >= 0),
    manual_unread_from_ordinal INTEGER,
    manual_unread_generation INTEGER NOT NULL CHECK (manual_unread_generation >= 0),
    latest_mention_attention_ordinal INTEGER NOT NULL CHECK (latest_mention_attention_ordinal >= 0),
    projected_at INTEGER NOT NULL,
    PRIMARY KEY (workstream_id, substream_id, user_id)
  ) STRICT`,
];

// --- Channel access requests (`conversation-access-request-storage.ts`, deleted in plan step C-2) ---

/**
 * Requests by a member to join a Channel or Breakout, each addressed to one
 * approver (`docs/channel-access-requests.md`). At most one pending request
 * per person per conversation: asking again while one is pending reuses it,
 * so a second press sends no second email.
 *
 * The requester's name is copied in when they ask, because names live in
 * regional D1 and the approver's list is built inside this object. The
 * conversation's title and mark are joined at read time, so a rename shows.
 */
export const CONVERSATION_ACCESS_REQUESTS_MIGRATION: readonly string[] = [
  `CREATE TABLE conversation_access_requests (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    requester_user_id TEXT NOT NULL,
    requester_name TEXT NOT NULL,
    approver_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    -- Set once the approver's email went out; a pending row without it is
    -- emailed again when the person asks again.
    emailed_at INTEGER
  ) STRICT`,
  `CREATE UNIQUE INDEX conversation_access_requests_one_pending
    ON conversation_access_requests (parent_id, substream_id, requester_user_id)
    WHERE status = 'pending'`,
  `CREATE INDEX conversation_access_requests_by_approver
    ON conversation_access_requests (approver_user_id, status)`,
];

// --- Activity reads (`workspace-activity-feed.ts`, deleted in plan step C-2) ---

/**
 * Migration 101: how far each person has read each subject, as the app
 * reported it. Written by the reader alone, like `workspace_activity_seen`,
 * and no foreign key: a subject is a thread, a breakout or a Channel, and a
 * row naming one that is gone costs its reader one row and nobody else
 * anything.
 */
export const WORKSPACE_ACTIVITY_READS_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_activity_reads (
    user_id TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    read_through INTEGER NOT NULL CHECK (read_through >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, subject_key)
  ) STRICT`,
];

// --- Activity pushes (`workspace-activity-push.ts`, deleted in plan step C-2) ---

/** Decision receipts are separate from actual delivery and from a queued reply batch. */
export const WORKSPACE_REPLY_ALERT_MIGRATION: readonly string[] = [
  `ALTER TABLE workspace_activity_pushes ADD COLUMN delivery_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (delivery_enqueued IN (0, 1))`,
  `CREATE INDEX workspace_activity_pushes_recent_idx ON workspace_activity_pushes (user_id, pushed_at)`,
  `CREATE TABLE workspace_activity_alert_claims (
    user_id TEXT NOT NULL, conversation_key TEXT NOT NULL, channel TEXT NOT NULL,
    claim_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_key, channel)
  ) STRICT`,
  `CREATE TABLE workspace_activity_alerts (
    user_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    item_id TEXT NOT NULL,
    alerted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_key, channel)
  ) STRICT`,
  `CREATE INDEX workspace_activity_replies_conversation_idx ON workspace_activity_events
    (subject_id, COALESCE(json_extract(metadata_json, '$.substreamId'), '0'),
     COALESCE(json_extract(metadata_json, '$.attentionOrdinal'), 0) DESC, occurred_at DESC, event_id DESC)
    WHERE event_type = 'workstream_message_created' AND subject_type = 'workstream'
      AND actor_type = 'user' AND json_extract(metadata_json, '$.mergedFrom.breakoutId') IS NULL`,
];

/**
 * Migration 105. `workspace_activity_pushes` is one row per person per
 * Activity row pushed, so a later batch about the same conversation never
 * sends it twice. `workspace_activity_push_origin` is when this object started
 * pushing: a row from before it (a backfill that re-projects old threads, an
 * old run) is never sent.
 */
export const WORKSPACE_ACTIVITY_PUSH_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_activity_pushes (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    pushed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  ) STRICT`,
  `CREATE TABLE workspace_activity_push_origin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at INTEGER NOT NULL
  ) STRICT`,
  `INSERT INTO workspace_activity_push_origin (id, started_at) VALUES (1, unixepoch() * 1000)`,
];

// --- People ranking (`workspace-people-ranking.ts`, deleted in plan step C-2) ---

/** Seek the reader's own messages without visiting other authors' history. */
export const WORKSPACE_PEOPLE_RANKING_MIGRATION: readonly string[] = [
  `CREATE INDEX workspace_activity_people_actor_idx ON workspace_activity_events(actor_user_id, event_id)
    WHERE event_type = 'workstream_message_created' AND subject_type = 'workstream'
      AND actor_type = 'user' AND actor_user_id IS NOT NULL
      AND json_extract(metadata_json, '$.mergedFrom') IS NULL`,
];

// --- Import reservation reclaim (`import-reservation-reclaim.ts`, deleted in plan step C-2) ---

/**
 * How long a reserved import thread may stay unopened before it is archived.
 *
 * - **Without it:** a start cut off before its run was admitted, from a window
 *   that then closed, leaves a listed thread whose conversation never opens and
 *   that its creator cannot remove.
 * - **Who causes it:** a dropped connection, a deploy reset or a crashed window,
 *   not a caller choosing it.
 * - **Why nothing else stops it:** discard and abandon need the window, and the
 *   run-end reclaim needs an admitted run.
 * - **When it trips:** an import whose thread has not opened an hour after its
 *   reservation is archived and its `complete` refused. A real import opens its
 *   thread in 20 to 60 seconds, so only a dead one is reached.
 *
 * The number is the team's: one hour, chosen on 2026-10-19.
 */
const IMPORT_RESERVATION_RECLAIM_AFTER_MS = 60 * 60 * 1000;

/**
 * WorkspaceDO migration 119: the watch, and every import reservation already
 * waiting on it: a hidden child still `reserved` (not a Breakout's preparation)
 * on a listed thread whose main conversation never delivered an effect. Seeded
 * from the child's reservation time, so one already past due is reclaimed on
 * the next alarm.
 */
export const IMPORT_RESERVATION_RECLAIM_MIGRATION: readonly string[] = [
  `CREATE TABLE import_reservation_reclaim (
    parent_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
  ) STRICT`,
  `CREATE INDEX import_reservation_reclaim_due_idx ON import_reservation_reclaim(due_at)`,
  `INSERT OR IGNORE INTO import_reservation_reclaim(parent_id, user_id, due_at, attempts)
     SELECT child.parent_id, child.created_by_user_id, MIN(child.created_at) + ${IMPORT_RESERVATION_RECLAIM_AFTER_MS}, 0
       FROM parent_children child
       JOIN channels channel ON channel.workstream_id = child.parent_id AND channel.archived_at IS NULL
      WHERE child.kind = 'child' AND child.status = 'reserved' AND child.created_by_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM parent_breakout_preparations preparation
                         WHERE preparation.parent_id = child.parent_id
                           AND preparation.substream_id = child.substream_id)
        AND NOT EXISTS (SELECT 1 FROM parent_child_receipts receipt
                         WHERE receipt.parent_id = child.parent_id AND receipt.substream_id = '0')
      GROUP BY child.parent_id, child.created_by_user_id`,
];

// --- The Thread-era drop (plan step C-7) ------------------------------------

/**
 * Tables no reader or writer reaches since phase C, children before the
 * tables they reference so no drop has to cascade. Activity, digests,
 * suggested work, a Channel's own ledgers (messages, defaults, intents,
 * invitees, colour sync, rail ledger, message search), Thread pins and order,
 * Thread access and resource links, batch dispatches, the Thread backfill and
 * the import-reservation reclaim, and a Thread's email receipts.
 *
 * What stays, deliberately:
 * - `channels`, `channel_viewers`, `breakouts`, `breakout_viewers`, `spaces`,
 *   `space_viewers` and every `parent_*` table: the Thread retirement inventory
 *   (`threadRetirementInventory`, `deleteRetiredThreadParent`) reads them to
 *   find the conversation objects `retire_threads` tombstones, and an
 *   Organization where the operator has not run it yet would otherwise lose
 *   the only record of which objects to dump and close
 *   (docs/workspace-retirement.md). Their triggers stay with them.
 * - `digest_schedules`, emptied: `schedules.digest_schedule_id` still names it
 *   in a foreign key, and SQLite refuses every insert into `schedules` once
 *   the parent table is gone, so dropping it would need a rebuild of
 *   `schedules` for no reader's benefit.
 *
 * The triggers on surviving tables that write a dropped table go first: the
 * Channel rail's on `automation_directory`, `resources`, `parent_sidekicks`,
 * `channels` and `channel_viewers`, and the Channel colour's on `channels`,
 * `breakouts` and `spaces`. Left behind, each would fail the write it fires
 * on with "no such table".
 *
 * Thread rows of the shared tables go too: a Thread's or a Channel's memory
 * digest holders (their objects refuse a retired parent kind, so a digest can
 * never land), a Sidekick's attachment to a Thread, the retired pin kinds
 * (the `workspace_pins` CHECK is shipped and still admits them), and a room
 * binding to a Channel or a Thread (room spawn and link were retired in C-4).
 * Nothing here fails on a row: every statement is a DROP or a DELETE.
 */
export const THREAD_ERA_TABLES_DROP_MIGRATION: readonly string[] = [
  ...[
    "channel_rail_sidekick_delete", "channel_rail_sidekick_insert", "channel_rail_sidekick_listed_update",
    "channel_rail_resource_delete", "channel_rail_resource_insert", "channel_rail_resource_update",
    "channel_rail_recommendation_delete", "channel_rail_recommendation_insert",
    "channel_rail_channel_update", "channel_rail_viewer_delete", "channel_rail_viewer_insert", "channel_rail_viewer_update",
    "channel_color_thread_insert", "channel_color_thread_restore",
    "channel_color_breakout_insert", "channel_color_breakout_restore", "channel_color_space_change",
  ].map((trigger) => `DROP TRIGGER IF EXISTS ${trigger}`),
  ...[
    "workspace_activity_event_targets", "workspace_activity_events", "workspace_activity_alert_claims",
    "workspace_activity_alerts", "workspace_activity_push_origin", "workspace_activity_pushes",
    "workspace_activity_reads", "workspace_activity_seen",
    "digest_delivery_targets", "digest_deliveries", "digest_schedule_times",
    "work_opportunity_provenance_roots", "work_opportunity_snapshots", "work_opportunity_user_links",
    "work_opportunity_user_states", "work_opportunities", "opportunity_batch_events", "opportunity_batch_windows",
    "opportunity_provenance_edges", "opportunity_provenance_nodes", "suggested_work_ranking_rounds", "suggested_work_sets",
    "space_bootstrap", "space_channel_memberships", "space_default_publications", "space_default_targets",
    "space_defaults", "space_intents", "space_invitees", "space_message_operations", "space_messages", "space_reads",
    "workspace_space_state",
    "channel_color_sync", "channel_color_sync_state", "channel_message_search_versions", "channel_rail_changes",
    "channel_sidekick_attachments", "conversation_access_requests", "thread_backfill",
    "workspace_workstream_pins", "workspace_pinned_order", "workspace_container_order", "workspace_workstream_access",
    "workspace_workstream_resource_links", "workspace_batch_dispatch_targets", "workspace_batch_dispatches",
    "import_reservation_reclaim", "workstream_email_receipts",
  ].map((table) => `DROP TABLE IF EXISTS ${table}`),
  `DELETE FROM digest_schedules`,
  `DELETE FROM memory_digest_holder_facts WHERE conversation IN (
     SELECT conversation FROM memory_digest_holders WHERE parent_kind IN ('workstream', 'space'))`,
  `DELETE FROM memory_digest_sync WHERE conversation IN (
     SELECT conversation FROM memory_digest_holders WHERE parent_kind IN ('workstream', 'space'))`,
  `DELETE FROM memory_digest_holders WHERE parent_kind IN ('workstream', 'space')`,
  `DELETE FROM sidekick_conversation_attachments WHERE parent_kind = 'workstream'`,
  `DELETE FROM workspace_pins WHERE item_kind IN ('thread', 'channel', 'breakout', 'artifact')`,
  `DELETE FROM external_conversation_bindings WHERE target_kind = 'space' OR parent_kind = 'workstream'`,
];

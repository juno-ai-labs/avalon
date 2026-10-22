import type { SqlStorageValue } from "@cloudflare/workers-types";
import {
  SharedNavigationSpaceSchema,
  type SharedNavigationSpace,
} from "@rally/contracts/scope-grants";

import {
  ContainerOrderSchema,
  OrderedContainerKindSchema,
  PersonalOrderSchema,
  SpaceDirectorySchema,
  SpaceSummarySchema,
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  STORABLE_APPEARANCE_ICON_KEYS,
  SPACE_COLOR_KEYS_STORABLE,
  type ContainerOrder,
  type OrderedContainer,
  type PersonalOrder,
  type SpaceColorKey,
  type SpaceIconKey,
  type SpaceDefaultKind,
  type SpaceDirectory,
  type SpaceReach,
  type ChannelMessage,
  type ChannelMessageAuthor,
  type MergeEmbed,
  type SpaceScope,
  type SpaceSummary,
} from "@rally/contracts";

import { linkSpaceResources } from "./authorization-storage";
import { boundParameterChunks } from "./bound-parameters";
import { stableUuidSync } from "../lib/stable-uuid";
import { uuidV7 } from "../lib/uuid-v7";
import { CHANNEL_COLOR_SPACE_CHANGE_TRIGGER } from "./channel-color-sync";
import { channelReadState, type ChannelReadRow, type ChannelReadState } from "./workspace-channel-read-storage";
import {
  breakoutListedSql,
  mainOpenableSql,
  member,
  channelListedSql,
  organizationWideSql,
  spaceListedSql,
  type AccessClass,
  type Viewer,
} from "./listing-rules";
import type {
  WorkspaceSpaceConversationPageRequest,
  WorkspaceSpaceAudienceNoteRequest,
  WorkspaceSpaceDefaultRequest,
  WorkspaceSpaceDefaultResult,
  WorkspaceSpaceDefaultTarget,
  WorkspaceSpaceMembershipPlanResult,
  WorkspaceSpaceMembershipMoveOutcome,
  WorkspaceSpaceMembershipMoveRequest,
  WorkspaceSpaceMembershipRemovalRequest,
  WorkspaceSpaceMembershipRequest,
  WorkspaceSpaceMembershipSettleRequest,
  WorkspaceSpaceMutationResult,
  WorkspaceSpacePresentationRequest,
  WorkspaceSpaceReserveRequest,
  WorkspaceSpaceBootstrapStatus,
} from "./workspace-space-protocol";

/**
 * One page of a Space's member Channels.
 *
 * Bounds: rows in one `GET /spaces/:id/channels` answer, and therefore the
 *   size of one Durable Object RPC result and one HTTP body.
 * Without it: General holds every Channel in the Organization, so an
 *   unpaginated read grows with the Organization and eventually exceeds what a
 *   single RPC result can carry — the failure being the whole page rather than
 *   a slow one.
 * Direction: upper bound on rows returned; the caller follows `nextCursor`.
 * Trips: nothing visible. The page ends and the cursor continues it.
 * Derive from: the directory page this sits beside.
 *   `WorkspaceDirectoryListRequestSchema` caps its `limit` at 250 and
 *   `WorkspaceDirectoryVisibleIdsPageSchema` caps its items at the same number,
 *   and a Space's member list is the same kind of read over the same rows.
 *   Matching it is transcription rather than a new guess, but the number itself
 *   is still the team's: what it buys is round trips against bytes per answer,
 *   and nobody here has the Organization sizes to weigh them.
 */
export const SPACE_CHANNEL_PAGE_SIZE = 250;

/**
 * Channels one page of a cross-object walk covers.
 *
 * Two walks share it, because they are the same shape. The cutover places
 * every Channel of an Organization in General; the Space fan-outs carry an
 * audience change, an archive or a restore to every member Channel. Each costs
 * several cross-object awaits per Channel and each continues from a cursor, so
 * this is one bound rather than two numbers somebody has to keep in step.
 *
 * Bounds: rows in one `space_bootstrap` Queue message's worth of work, and
 *   therefore the Channels one consumer invocation places; and Channels in one
 *   page of {@link WorkspaceSpaceStorage.members}, which is the unit an
 *   audience change, an archive or a restore records on its intent before
 *   continuing.
 * Without it: a walk would claim the whole Organization in one invocation, and
 *   an Organization larger than one invocation's budget could never finish —
 *   each redelivery would restart the same unbounded pass.
 * Direction: upper bound on Channels per page; the pass continues from the
 *   cursor, on the next alarm or on the next iteration.
 * Trips: nothing visible. The page ends and the cursor continues it.
 * Derive from: the two ceilings this sits between, and the number is the
 *   team's to set. A Cloudflare Queue consumer invocation and a WorkspaceDO
 *   alarm both have to finish the page, and each Channel costs one
 *   containment preflight, one membership staging, one canonical audience
 *   operation and one settlement — four cross-object awaits. A member walk's
 *   per-Channel cost is the same several-hops shape: a retraction and an
 *   application, each a plan-apply-confirm conversation with the Channel's own
 *   authority. 50 is a quarter of `SPACE_CHANNEL_PAGE_SIZE`, which bounds a
 *   read rather than a walk of cross-object writes; what a different number
 *   buys is fewer alarm wakes against a longer invocation, and nobody here has
 *   the Organization sizes or the per-Channel timings to weigh them.
 */
export const SPACE_BOOTSTRAP_PAGE_SIZE = 50;

/** A Space name as `organizationSpaceNamed` compares it: no case, spaces, dashes or underscores. */
function spaceMatchName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/gu, "");
}

/**
 * A message to post in a Channel. `key` makes posting it idempotent: the same
 * key in the same Channel is the same message, so a retry writes nothing.
 * Without one, every post is a new message.
 */
export interface ChannelMessageDraft {
  author: ChannelMessageAuthor;
  body: string;
  key?: string;
  /**
   * With a key: a repost rewrites the body and author and moves the message
   * to the bottom of the feed (a fresh `posted_at`, and a fresh ordinal when
   * it is news), rather than writing nothing.
   */
  replace?: boolean;
  /**
   * Whether posting it is Channel news: it takes an attention ordinal and so
   * lights the Channel's unread dot for everyone but its author. Defaults to
   * true; a Channel's opening messages pass false.
   */
  news?: boolean;
  /** The thread the message is about; the feed shows it only to who can open that thread. */
  sourceWorkstreamId?: string;
  /** The artifacts the body embeds, as they were when posted. */
  embeds?: readonly MergeEmbed[];
  /** The operation that wrote it: a repost with the same id writes nothing. */
  operationId?: string;
}

/** One Channel message as the feed reads it. */
interface ChannelMessageRow extends Record<string, SqlStorageValue> {
  message_id: string;
  author_kind: "rally" | "member";
  author_user_id: string | null;
  body: string;
  posted_at: number;
  attention_ordinal: number | null;
  source_workstream_id: string | null;
  source_title: string | null;
  source_description: string | null;
  embeds_json: string | null;
  /** Whether this reader may open the thread a merge came from; null for any other message. */
  source_openable: number | null;
}

const SPACE_ICON_FALLBACK = "briefcase";
const SPACE_COLOR_FALLBACK = "blue";

const SPACE_ICON_KEY_SET: ReadonlySet<string> = new Set(STORABLE_APPEARANCE_ICON_KEYS);
const SPACE_COLOR_KEY_SET: ReadonlySet<string> = new Set(SPACE_COLOR_KEYS_STORABLE);

/**
 * A stored Space appearance's colour, coerced rather than parsed: the
 * appearance is the Space's own object's, and a key this build does not know
 * still has to draw as something.
 */
function spaceColorKey(appearanceJson: string | null): SpaceColorKey {
  const appearance = appearanceJson ? JSON.parse(appearanceJson) as { color?: unknown } : null;
  const color = typeof appearance?.color === "string" ? appearance.color : null;
  return color && SPACE_COLOR_KEY_SET.has(color) ? color as SpaceColorKey : SPACE_COLOR_FALLBACK;
}

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

/** Recover removed historical merges from their permanent operation receipts during migration 123. */
export function backfillRemovedThreadMerges(sql: DurableObjectStorage["sql"], appliedVersions: readonly number[]): void {
  if (!appliedVersions.includes(123)) return;
  const receipts = new Set(sql.exec<{ message_id: string }>(
    "SELECT DISTINCT message_id FROM space_message_operations",
  ).toArray().map((row) => row.message_id));
  if (receipts.size === 0) return;
  const channels = sql.exec<{ space_id: string }>(
    "SELECT space_id FROM spaces UNION SELECT space_id FROM space_messages",
  ).toArray();
  for (const thread of sql.exec<{ parent_id: string }>(
    "SELECT parent_id FROM parent_children WHERE substream_id = '0' AND resolved = 0",
  ).toArray()) {
    if (channels.some(({ space_id }) => receipts.has(stableUuidSync(["space_message", space_id, `merge:${thread.parent_id}`])))) {
      sql.exec("UPDATE parent_children SET resolved = 1 WHERE parent_id = ? AND substream_id = '0'", thread.parent_id);
    }
  }
}

/**
 * The run states a conversation is live in on its own account.
 *
 * The `exact_state` vocabulary rather than the wire's, because this predicate
 * runs against the stored column. `workstreamHarnessStatus` in `workspace-do.ts`
 * folds the middle three into `running` and `scheduled` stays itself, so these
 * six are exactly the states whose `harnessStatus` is one of `scheduled`,
 * `running` or `needs_input` — the three `conversationNeedsViewer` admits.
 */
const LIVE_EXACT_STATES = [
  "scheduled",
  "running",
  "interrupting",
  "preparing_context",
  "waiting_capacity",
  "needs_input",
] as const;

const LIVE_EXACT_STATE_LIST = LIVE_EXACT_STATES.map((state) => `'${state}'`).join(", ");

/**
 * `conversationNeedsViewer` in SQL, over one directory alias and one viewer
 * alias.
 *
 * **This is the authority.** The page is decided here — a client-side filter
 * over a server-ordered page would hand back short pages and a cursor that had
 * already skipped rows — and `conversationNeedsViewer` in `@rally/contracts` is
 * the desktop's copy of the same decision, used where it draws. Nothing makes
 * the two agree except
 * `apps/api/test-workers/space-conversation-page.test.ts`, which walks every
 * combination of the four inputs and asserts this query and that function
 * reach the same answer.
 *
 * One text rendered twice rather than two texts. The aliases are the only
 * thing that varies, they are code-owned literals, and the breakout tables are
 * deliberately named the way the Channel directory names the same facts so
 * that this is possible — two spellings of the same predicate is how the two
 * kinds of row would have started answering differently.
 *
 * The four clauses are `hasUnread`, `unseen` and `youAreMentioned` as
 * `directoryWorkstream` derives them, plus the run. `seen` falls back to the
 * directory's `unread_tracking_start_ordinal` when this person has no viewer
 * row, exactly as the mapper does, which is what stops a workspace-scoped
 * Channel nobody has opened from reading as unread to every member.
 */
function liveForViewerSql(directory: "directory" | "breakout", viewer: "viewer" | "breakout_viewer"): string {
  return `(${directory}.exact_state IN (${LIVE_EXACT_STATE_LIST})
       OR ${waitingForReaderSql(directory, viewer)})`;
}

/**
 * {@link liveForViewerSql} without the run: unread, unseen or mentioning this
 * person. These are the three reader-owned states the sidebar's attention menu
 * lists (`readerMarkerStatus` on the client), so the dock badge counts the
 * same conversations the menu does.
 */
function waitingForReaderSql(directory: "directory" | "breakout", viewer: "viewer" | "breakout_viewer"): string {
  const seen = `COALESCE(${viewer}.seen_attention_ordinal, ${directory}.unread_tracking_start_ordinal)`;
  return `(${viewer}.manual_unread_from_ordinal IS NOT NULL
       OR ${directory}.latest_attention_ordinal > ${seen}
       OR ${viewer}.unseen = 1
       OR ${mentionedSql(directory, viewer)})`;
}

/** A mention of this person above their read point: the client's `youAreMentioned`. */
function mentionedSql(directory: "directory" | "breakout", viewer: "viewer" | "breakout_viewer"): string {
  const seen = `COALESCE(${viewer}.seen_attention_ordinal, ${directory}.unread_tracking_start_ordinal)`;
  return `COALESCE(${viewer}.latest_mention_attention_ordinal, 0) > ${seen}`;
}

// Who may be told a Space, a Channel or a Breakout exists is decided by the
// rules in `listing-rules.ts`, rendered here against this file's aliases.

/**
 * Why this viewer can see this Space, as a column.
 *
 * Computed by the query that selects the row rather than asked per summary: it
 * is three comparisons over columns already joined, and the alternative is one
 * more statement per Space per socket publication.
 *
 * The strongest relationship wins. `ELSE 'through_channel'` is sound only
 * because every query rendering this has already applied
 * {@link spaceListedSql}, so a row that reaches it is one of the
 * three; a row selected without that filter would be labelled
 * `through_channel` whether or not it is reachable at all.
 */
export function spaceReachSql(space: string, viewer: string, accessClass: AccessClass): string {
  return `CASE WHEN ${viewer}.user_id IS NOT NULL THEN 'participant'
               WHEN ${organizationWideSql(`${space}.scope`, accessClass)} THEN 'organization'
               ELSE 'through_channel' END`;
}

/**
 * Whether a reach may *change* the Space: any of the three but
 * `through_channel`.
 *
 * The rule as a function of the reach alone, so the one place that has already
 * read the reach does not spell it a second time.
 * {@link WorkspaceSpaceStorage.canEdit} is this plus "can see it at all", and
 * {@link WorkspaceSpaceStorage.members} is this after telling the two refusals
 * apart — a Space the caller cannot act on and a Space they cannot see are
 * different answers and were losing that difference at the RPC.
 */
export function editableReach(reach: SpaceReach): boolean {
  return reach !== "through_channel";
}

/**
 * The keyset seek for one arm of the conversation page.
 *
 * Rendered per arm rather than once over the union, because `kind` is a
 * *constant* inside an arm: the three-part comparison collapses to a literal
 * against the cursor's kind, and the whole predicate becomes a range over that
 * arm's own `(last_activity_at, id)` — which is the shape
 * `docs/durable-object-sqlite.md` asks a cursor to be written in.
 *
 * `?3 IS NULL` still guards the first page, and it is the one part of the
 * advice this cannot follow: the alternative is two rendered texts, and one
 * page shape with an unused branch is safer than two page shapes that can
 * disagree. The branch costs nothing after the first row, where `?3` is a
 * bound value rather than a column.
 */
function afterCursorSql(
  kind: "channel" | "breakout",
  activity: string,
  conversationId: string,
): string {
  return `(?3 IS NULL
             OR ${activity} < ?3
             OR (${activity} = ?3
                 AND ('${kind}' > ?4 OR ('${kind}' = ?4 AND ${conversationId} > ?5))))`;
}

interface SpaceRow extends Record<string, SqlStorageValue> {
  /** {@link spaceReachSql}'s column. Every select that builds one renders it. */
  reach: SpaceReach;
  space_id: string;
  title: string;
  scope: SpaceScope;
  appearance_json: string | null;
  archived_at: number | null;
  created_by_user_id: string | null;
  system_role: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceSpaceDefaultPublication extends WorkspaceSpaceDefaultTarget {
  requestedByUserId: string;
  attempts: number;
}

type MovePlan =
  | { kind: "refused"; code: "space_not_found" }
  | { kind: "staged" }
  | {
    kind: "move";
    existingTarget: { state: string; generation: number } | null;
    sourceMembershipGeneration: number;
    targetMembershipGeneration: number;
  };

interface MoveMembershipFences {
  userId: string;
  sourceSpaceId: string;
  targetSpaceId: string;
  workstreamId: string;
  sourceMembershipGeneration: number;
  targetMembershipGeneration: number;
}

/**
 * The kinds of operation that stage an intent.
 *
 * Exactly what `recordIntent` is called with, and nothing else. A default's
 * delivery has `space_default_targets` and the cutover has `space_bootstrap`,
 * each with its own staging, its own retry gate and its own consumer leg — so
 * `default` and `bootstrap` were vocabulary the CHECK admitted and nothing ever
 * wrote, and the resume carried a branch for a message that could not exist.
 */
export type WorkspaceSpaceIntentKind = "add" | "remove" | "move" | "audience" | "archive" | "restore";

export interface WorkspaceSpaceIntentClaim {
  operationId: string;
  kind: WorkspaceSpaceIntentKind;
  spaceId: string;
  workstreamId: string | null;
  spaceRevision: number;
  membershipGeneration: number | null;
  sourceSpaceId: string | null;
  sourceSpaceRevision: number | null;
  sourceMembershipGeneration: number | null;
  /** Where the operation's member walk got to, or `null` if it has not started. */
  cursor: string | null;
  requestedByUserId: string;
}

/** The appearance half of a Space's directory projection. */
export interface SpaceAppearanceProjection {
  iconKey: string | null;
  colorKey: string | null;
}

/** What one `directory_common` effect says about a Space. */
export interface SpaceDirectoryProjection {
  spaceId: string;
  authorityGeneration: number;
  sourceVersion: number;
  payloadHash: string;
  title: string;
  scope: "personal" | "workspace";
  appearance: SpaceAppearanceProjection | null;
  createdByUserId: string | null;
  sourceCreatedAt: number;
  sourceUpdatedAt: number;
}

/** What one `directory_user` effect says about a Space and one viewer. */
export interface SpaceViewerProjection {
  spaceId: string;
  userId: string;
  authorityGeneration: number;
  sourceVersion: number;
  payloadHash: string;
  isParticipant: boolean;
}

function encodeChannelCursor(workstreamId: string): string {
  return btoa(workstreamId).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeChannelCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return null;
  const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  } catch {
    return null;
  }
}

/**
 * One arrangement laid over another: what this write named, then what it did
 * not.
 *
 * The rule every kind of container order is written by, and one function
 * because the reason is one reason. A request carries the ids the person was
 * *looking at* — a search has hidden rows, a page has not been fetched, a
 * Channel has been archived — and never the ids it left out. Read as a complete
 * picture it would delete them; read as a move it says only where the named
 * ones go, which is the whole of what a drag means.
 */
function mergedOrder(named: readonly string[], rest: readonly string[]): string[] {
  const moved = new Set(named);
  return [...named, ...rest.filter((id) => !moved.has(id))];
}

/**
 * Where an activity-ordered page stopped: the whole sort key, not an offset.
 *
 * Three parts because the order is three parts. Activity alone is not unique —
 * a Channel and the breakout that produced the activity share a timestamp to
 * the millisecond — so a cursor carrying only that would repeat or skip the
 * rows either side of it. `kind` then id completes it, and the two are
 * compared in exactly the order the query sorts by.
 *
 * Opaque on the wire for the reason the id cursor was: the ordering is the
 * authority's, and a client that could construct one could ask for a page the
 * ordering no longer has.
 */
interface SpaceConversationCursor {
  lastActivityAt: number;
  /** `message` only in a Channel feed's cursor, which seeks on time and id. */
  kind: "channel" | "breakout" | "message";
  conversationId: string;
}

function encodeConversationCursor(cursor: SpaceConversationCursor): string {
  return encodeChannelCursor(
    `${cursor.lastActivityAt}\u0000${cursor.kind}\u0000${cursor.conversationId}`,
  );
}

function decodeConversationCursor(cursor: string): SpaceConversationCursor | null {
  const decoded = decodeChannelCursor(cursor);
  if (decoded === null) return null;
  const [activity, kind, conversationId] = decoded.split("\u0000");
  if (activity === undefined || conversationId === undefined) return null;
  if (kind !== "channel" && kind !== "breakout" && kind !== "message") return null;
  const lastActivityAt = Number(activity);
  if (!Number.isSafeInteger(lastActivityAt) || lastActivityAt < 0) return null;
  return { lastActivityAt, kind, conversationId };
}

/** What the cutover's alarm claimed, and what the consumer should do with it. */
export interface SpaceBootstrapClaim {
  kind: "general" | "preflight" | "memberships" | "finalize";
  cursor: string | null;
}

/** One Channel the cutover has to place, as the Organization already knows it. */
export interface SpaceBootstrapChannel {
  workstreamId: string;
  scope: "personal" | "workspace";
  placed: boolean;
  participantUserIds: string[];
}

export interface SpaceBootstrapPage {
  items: SpaceBootstrapChannel[];
  nextCursor: string | null;
}

/** A Channel the cutover could not place, and the refusal that stopped it. */
export interface SpaceBootstrapBlocked {
  workstreamId: string;
  code: string;
}

/** One conversation a Space page is about, before the projection. */
export interface SpaceConversationKey {
  kind: "channel" | "breakout";
  /** The Channel: the conversation itself, or the breakout's parent. */
  workstreamId: string;
  /** The breakout's substream id, or `null` on a Channel. */
  substreamId: string | null;
}

/** One page of the conversations a Space read is about, before the projection. */
export interface SpaceConversationPage {
  items: SpaceConversationKey[];
  nextCursor: string | null;
}

/** A directory with nothing in it, for an object whose Space tables are absent. */
const EMPTY_DIRECTORY: SpaceDirectory = SpaceDirectorySchema.parse({ waterline: 0, items: [] });

/** Synchronous repository for the Space state owned by one WorkspaceDO. */
export class WorkspaceSpaceStorage {
  private tablesPresent: boolean | null = null;
  private breakoutTablesPresent: boolean | null = null;
  private readTablesPresent: boolean | null = null;
  /** Sidekick defaults this instance wrote onto a Channel in place; the caller refreshes the rails when nonzero. */
  sidekickDefaultsApplied = 0;

  /**
   * @param canManageChannel Whether this person may manage this Channel,
   *   answered from this database alone (no D1, no await), so a default can
   *   be written inside the transaction that staged it. Absent, every Sidekick
   *   default takes the Queue.
   */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly canManageChannel?: (workstreamId: string, userId: string) => boolean,
  ) {}

  /**
   * Whether this object has reached the migration that created these tables.
   *
   * Not paranoia about the ledger. The meeting-notes retirement holds an object
   * at version 57 until its external cleanup finishes, so an Organization
   * mid-cleanup runs on a schema with no Space tables — and the sidebar's
   * connect payload, the alarm's re-arm, the Channel directory's `spaceIds` and
   * the archival note all read them before anything product-shaped has a chance
   * to refuse. An unguarded read there is not a Space that looks empty; it is a
   * `no such table` that fails the whole connect, so the Organization cannot
   * open its sidebar at all.
   *
   * **This is the only place the question is asked.** Every Space read in
   * WorkspaceDO comes through this class, each answering its own empty state
   * below, and every Space *write* is refused by name (`space_bootstrap_pending`)
   * at the RPC. A second `sqlite_schema` lookup written somewhere else is how
   * the first version of this guard covered the alarm and nothing else.
   *
   * Memoized per instance — one lookup per call site rather than per statement
   * — and an instance lives for one RPC, so it cannot cache across a migration.
   */
  ready(): boolean {
    this.tablesPresent ??= this.storage.sql.exec<{ name: string } & Record<string, SqlStorageValue>>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'spaces'`,
    ).toArray().length === 1;
    return this.tablesPresent;
  }

  /** Whether this object has reached the migration that created Breakout projections. */
  /**
   * The listing rules as this object renders them, with the bindings each
   * fragment takes for one viewer. A Breakout reach binds the user id once
   * more, and only on an object that has the Breakout projection.
   */
  private channelListing(viewer: Viewer, directory = "directory", channelViewer = "viewer"): { sql: string; binds: string[] } {
    const breakouts = this.breakoutsReady();
    return {
      sql: channelListedSql(directory, channelViewer, viewer.accessClass, { breakouts }),
      binds: breakouts ? [viewer.userId] : [],
    };
  }

  private spaceListing(viewer: Viewer, space = "space", spaceViewer = "viewer"): { sql: string; binds: string[] } {
    const breakouts = this.breakoutsReady();
    return {
      sql: spaceListedSql(space, spaceViewer, viewer.accessClass, { breakouts }),
      binds: breakouts ? [viewer.userId, viewer.userId] : [viewer.userId],
    };
  }

  /**
   * Whether this object has reached migration 98, which gave a Channel its
   * waterline. Asked for the reason {@link ready} is: an object can hold Space
   * tables on a schema that stops short of the newest migration.
   */
  readsReady(): boolean {
    this.readTablesPresent ??= this.storage.sql.exec<{ name: string } & Record<string, SqlStorageValue>>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'space_reads'`,
    ).toArray().length === 1;
    return this.readTablesPresent;
  }

  breakoutsReady(): boolean {
    this.breakoutTablesPresent ??= this.storage.sql.exec<{ name: string } & Record<string, SqlStorageValue>>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'breakouts'`,
    ).toArray().length === 1;
    return this.breakoutTablesPresent;
  }

  /**
   * Allocate a Space and write the rows a client can be answered from before
   * its own object has published anything.
   *
   * The directory row is a *reservation*: source version zero, so the Space's
   * first real `directory_common` effect supersedes it under the ordinary
   * fence rather than colliding with it. Without that the creator would wait on
   * a Queue round trip to see the Space they just made.
   */
  reserve(
    request: WorkspaceSpaceReserveRequest,
    spaceId: string,
    options: {
      systemRole?: "general" | null;
      now?: number;
      scope?: SpaceScope;
      /** What the Channel opens with, posted as it is made; see {@link postStartingMessages}. */
      messages?: readonly ChannelMessageDraft[];
    } = {},
  ): SpaceSummary {
    const { systemRole = null, now = Date.now(), scope = request.space.scope, messages = [] } = options;
    return this.storage.transactionSync(() => {
      const previousCreatedAt = this.storage.sql.exec<{ created_at: number | null } & Record<string, SqlStorageValue>>(
        "SELECT MAX(created_at) AS created_at FROM spaces",
      ).one().created_at;
      const createdAt = Math.max(now, (previousCreatedAt ?? -1) + 1);
      this.storage.sql.exec(
        `INSERT INTO spaces (
           space_id, title, scope, appearance_json, archived_at,
           created_by_user_id, system_role, authority_generation, source_version,
           payload_hash, revision, created_at, updated_at, source_created_at, source_updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 0, '', 1, ?, ?, ?, ?)`,
        spaceId,
        request.space.name.trim(),
        scope,
        JSON.stringify({ icon: request.space.iconKey, color: request.space.colorKey }),
        request.userId,
        systemRole,
        createdAt,
        createdAt,
        createdAt,
        createdAt,
      );
      this.storage.sql.exec(
        `INSERT INTO space_viewers
           (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
         VALUES (?, ?, 1, 1, 0, '')`,
        spaceId,
        request.userId,
      );
      this.appendOrder(request.workspaceId, request.userId, spaceId, createdAt);
      this.postStartingMessages(spaceId, messages);
      this.advanceWaterline(createdAt);
      return this.writtenSpace(spaceId, request.userId);
    });
  }

  /** Reserve once, preserving an inaccessible identity without revealing its Space. */
  reserveForCreation(request: WorkspaceSpaceReserveRequest, spaceId: string): {
    space: SpaceSummary | false; created: boolean;
  } {
    return this.storage.transactionSync(() => {
      const exists = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        "SELECT space_id FROM spaces WHERE space_id = ?", spaceId,
      ).toArray().length > 0;
      if (exists) return { space: this.readable(member(request.userId), spaceId), created: false };
      return { space: this.reserve(request, spaceId), created: true };
    });
  }

  /**
   * The Organization's one General Space, reserved once.
   *
   * The unique partial index on `system_role` is the decision, and it is the
   * *only* decision: there is deliberately no read of `generalSpaceId()` in
   * front of the insert. A check-then-write is what this shape is trying not to
   * be — the read and the write are two statements, every caller that reaches
   * here is a retry of some other caller, and the loser of that race has to be
   * answered with the Space the winner made rather than with a bare
   * `UNIQUE constraint failed` across an RPC hop.
   *
   * The re-read happens outside the failed transaction because the statement
   * that aborted took its transaction with it. A failure the index did not
   * cause has no winner to find, and is rethrown as itself.
   */
  ensureGeneral(
    request: WorkspaceSpaceReserveRequest,
    spaceId: string,
    messages: readonly ChannelMessageDraft[] = [],
    now = Date.now(),
  ): { space: SpaceSummary; created: boolean } {
    try {
      return { space: this.reserve(request, spaceId, { systemRole: "general", now, messages }), created: true };
    } catch (error) {
      const winner = this.generalSpaceId();
      if (winner === null) throw error;
      return { space: this.writtenSpace(winner, request.userId), created: false };
    }
  }

  /**
   * This member's Personal Channel under `spaceId`, reserved once.
   *
   * Present already (a redelivery, or a member who left and came back), it
   * only seats its owner again: leaving the Organization deleted their viewer
   * row, and the Space is still theirs. `spaces_individual_owner_idx` refuses a
   * second one under another id, and the caller is answered with the first.
   */
  reservePersonal(
    workspaceId: string,
    userId: string,
    spaceId: string,
    start: { name: string; iconKey: SpaceIconKey; colorKey: SpaceColorKey; messages: readonly ChannelMessageDraft[] },
    now = Date.now(),
  ): { space: SpaceSummary; created: boolean } {
    return this.storage.transactionSync(() => {
      const existing = this.personalSpaceId(userId);
      if (existing !== null) {
        this.seat(existing, userId, now);
        return { space: this.writtenSpace(existing, userId), created: false };
      }
      const space = this.reserve({
        workspaceId: asWorkspaceId(workspaceId),
        userId: asUserId(userId),
        space: { name: start.name, iconKey: start.iconKey, colorKey: start.colorKey, scope: "workspace" },
      }, spaceId, { now, scope: "individual", messages: start.messages });
      return { space, created: true };
    });
  }

  /**
   * Post messages in a Channel, at `postedAt`, in order. A keyed draft that
   * is already there writes nothing, unless it asks to replace. Returns the
   * ids, posted or found.
   */
  postMessages(spaceId: string, drafts: readonly ChannelMessageDraft[], postedAt: number): string[] {
    return drafts.map((draft) => this.postMessage(spaceId, draft, postedAt).messageId);
  }

  /**
   * Post one message in a Channel. `replayed` is true when nothing was
   * written: a keyed draft already there that does not replace, or a draft
   * whose `operationId` is the one that last wrote the row. A written news
   * message takes the Channel's next attention ordinal, and its member author
   * reads through it.
   */
  postMessage(
    spaceId: string,
    draft: ChannelMessageDraft,
    postedAt: number,
  ): { messageId: string; replayed: boolean } {
    const messageId = draft.key === undefined
      ? uuidV7()
      : stableUuidSync(["space_message", spaceId, draft.key]);
    // Every operation that ever wrote this message is a receipt, not only the
    // last: a late retry of an older one must not overwrite a newer write.
    if (draft.operationId !== undefined && this.storage.sql.exec(
      "SELECT 1 FROM space_message_operations WHERE message_id = ? AND operation_id = ?",
      messageId,
      draft.operationId,
    ).toArray().length > 0) return { messageId, replayed: true };
    const authorUserId = draft.author.kind === "member" ? draft.author.userId : null;
    const written = this.storage.sql.exec<{ message_id: string } & Record<string, SqlStorageValue>>(
      `INSERT INTO space_messages (
         message_id, space_id, message_key, author_kind, author_user_id, body, posted_at,
         source_workstream_id, embeds_json, merge_operation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO ${draft.replace === true
         ? `UPDATE SET
             author_kind = excluded.author_kind,
             author_user_id = excluded.author_user_id,
             body = excluded.body,
             posted_at = excluded.posted_at,
             source_workstream_id = excluded.source_workstream_id,
             embeds_json = excluded.embeds_json,
             merge_operation_id = excluded.merge_operation_id,
             attention_ordinal = NULL`
         : "NOTHING"}
       RETURNING message_id`,
      messageId,
      spaceId,
      draft.key ?? null,
      draft.author.kind,
      authorUserId,
      draft.body,
      postedAt,
      draft.sourceWorkstreamId ?? null,
      draft.embeds === undefined ? null : JSON.stringify(draft.embeds),
      draft.operationId ?? null,
    ).toArray().length === 1;
    if (!written) return { messageId, replayed: true };
    // Posting is the subscription action; Rally's own messages seat nobody.
    if (authorUserId !== null) this.seat(spaceId, authorUserId, postedAt);
    if (draft.operationId !== undefined) {
      this.storage.sql.exec(
        "INSERT INTO space_message_operations (message_id, operation_id, created_at) VALUES (?, ?, ?)",
        messageId,
        draft.operationId,
        postedAt,
      );
    }
    if (draft.news !== false) {
      const ordinal = this.stampChannelNews(spaceId, authorUserId, postedAt);
      if (ordinal !== null) {
        this.storage.sql.exec(
          "UPDATE space_messages SET attention_ordinal = ? WHERE message_id = ?",
          ordinal,
          messageId,
        );
      }
    }
    return { messageId, replayed: false };
  }

  /**
   * The titles a Breakout's merge is written with: the Breakout's, frozen
   * into its byline, and its Thread's, for the result. Empty when the
   * projection has no row.
   */
  breakoutMergeTitles(workstreamId: string, substreamId: string): { breakout: string; thread: string } {
    const thread = this.storage.sql.exec<{ title: string } & Record<string, SqlStorageValue>>(
      "SELECT title FROM channels WHERE workstream_id = ?",
      workstreamId,
    ).toArray()[0]?.title ?? "";
    const breakout = !this.breakoutsReady() ? "" : this.storage.sql.exec<{ title: string } & Record<string, SqlStorageValue>>(
      "SELECT title FROM breakouts WHERE workstream_id = ? AND substream_id = ?",
      workstreamId,
      substreamId,
    ).toArray()[0]?.title ?? "";
    return { breakout, thread };
  }

  /**
   * Where a thread's merge goes, and the Channels it could go to instead.
   *
   * The thread's current, unarchived placements in placement order, each with
   * whether this viewer may post in it (any reach but `through_channel`).
   * Without `spaceId` the target is the earliest one, the Channel the thread
   * was started in unless it was taken out. A private thread merges too: the
   * Channel's readers who cannot open it see the result without its name.
   */
  channelMergeTarget(viewer: Viewer, workstreamId: string, spaceId: string | null):
    | { ok: true; spaceId: string; name: string; channels: Array<{ id: string; name: string }> }
    | {
      ok: false;
      code: "workstream_not_found" | "conversation_archived" | "merge_channel_not_placed" | "merge_target_not_writable";
      channels: Array<{ id: string; name: string }>;
    } {
    const thread = this.storage.sql.exec<{ archived_at: number | null } & Record<string, SqlStorageValue>>(
      "SELECT archived_at FROM channels WHERE workstream_id = ?",
      workstreamId,
    ).toArray()[0];
    if (thread === undefined) return { ok: false, code: "workstream_not_found", channels: [] };
    if (thread.archived_at !== null) return { ok: false, code: "conversation_archived", channels: [] };
    const placed = this.storage.sql.exec<{ space_id: string; title: string } & Record<string, SqlStorageValue>>(
      `SELECT space.space_id, space.title
         FROM space_channel_memberships membership
         JOIN spaces space ON space.space_id = membership.space_id
        WHERE membership.workstream_id = ? AND membership.state = 'active' AND space.archived_at IS NULL
        ORDER BY membership.joined_at, membership.space_id`,
      workstreamId,
    ).toArray().map((row) => {
      const reach = viewer.accessClass === "member" ? this.reach(viewer, row.space_id, true) : null;
      return { id: row.space_id, name: row.title, writable: reach !== null && editableReach(reach) };
    });
    const channels = placed.filter((channel) => channel.writable).map(({ id, name }) => ({ id, name }));
    const target = spaceId === null ? placed[0] : placed.find((channel) => channel.id === spaceId);
    if (target === undefined) return { ok: false, code: "merge_channel_not_placed", channels };
    if (!target.writable) return { ok: false, code: "merge_target_not_writable", channels };
    return { ok: true, spaceId: target.id, name: target.name, channels };
  }

  /**
   * Where a thread's merge would land with nobody asking: its earliest active
   * Organization-wide placement. Only Organization-wide, because the answer is
   * stored on a suggestion row that every reader of the thread receives; a
   * private Channel's name is not theirs to learn from it.
   */
  threadMergePlacement(workstreamId: string):
    | { ok: true; spaceId: string; title: string }
    | { ok: false; code: "workstream_not_found" | "conversation_archived" | "merge_channel_not_placed" } {
    const thread = this.storage.sql.exec<{ archived_at: number | null } & Record<string, SqlStorageValue>>(
      "SELECT archived_at FROM channels WHERE workstream_id = ?",
      workstreamId,
    ).toArray()[0];
    if (thread === undefined) return { ok: false, code: "workstream_not_found" };
    if (thread.archived_at !== null) return { ok: false, code: "conversation_archived" };
    const placed = this.storage.sql.exec<{ space_id: string; title: string } & Record<string, SqlStorageValue>>(
      `SELECT space.space_id, space.title
         FROM space_channel_memberships membership
         JOIN spaces space ON space.space_id = membership.space_id
        WHERE membership.workstream_id = ? AND membership.state = 'active' AND space.archived_at IS NULL
          AND space.scope = 'workspace'
        ORDER BY membership.joined_at, membership.space_id
        LIMIT 1`,
      workstreamId,
    ).toArray()[0];
    if (placed === undefined) return { ok: false, code: "merge_channel_not_placed" };
    return { ok: true, spaceId: placed.space_id, title: placed.title };
  }

  /**
   * Merge a thread into one of its Channels: the Channel message keyed by the
   * thread, replaced at the bottom when it is already there, and its embeds
   * linked to the Channel in the same commit, so whoever reads the Channel,
   * now or later, can open them. The target is resolved again inside the
   * transaction, so a placement that moved since the caller asked is refused
   * rather than written.
   */
  mergeThreadIntoChannel(
    viewer: Viewer,
    request: {
      workstreamId: string;
      spaceId: string | null;
      body: string;
      embeds: readonly MergeEmbed[];
      operationId: string;
    },
    now: number,
  ):
    | { ok: true; spaceId: string; name: string; messageId: string; replayed: boolean; linked: string[] }
    | Extract<ReturnType<WorkspaceSpaceStorage["channelMergeTarget"]>, { ok: false }> {
    return this.storage.transactionSync(() => {
      const target = this.channelMergeTarget(viewer, request.workstreamId, request.spaceId);
      if (!target.ok) return target;
      const posted = this.postMessage(target.spaceId, {
        author: { kind: "member", userId: asUserId(viewer.userId) },
        body: request.body,
        key: `merge:${request.workstreamId}`,
        replace: true,
        sourceWorkstreamId: request.workstreamId,
        embeds: request.embeds,
        operationId: request.operationId,
      }, now);
      this.storage.sql.exec(
        `UPDATE parent_children SET resolved = 1 WHERE parent_id = ? AND substream_id = '0' AND resolved = 0`,
        request.workstreamId,
      );
      // Only a merge that was written shares what it embeds: a replay wrote
      // nothing, so embeds a retry adds are not the merge's and stay unshared.
      const linked = posted.replayed ? []
        : linkSpaceResources(this.storage.sql, target.spaceId, request.embeds.map((embed) => embed.id));
      return { ok: true, spaceId: target.spaceId, name: target.name, ...posted, linked };
    });
  }

  /**
   * The Activity tab's `merged` rows for a thread's merges into Channels:
   * news merge messages in Channels this viewer may list, by somebody else,
   * newest first after `after`, as the Channel feed shows them to every
   * reader. `merged_thread_private` marks a thread this viewer may not open,
   * whose row must not name it. Shaped as the feed's keys. The id carries
   * `posted_at`, so a merge replaced later is a new row (and a new push)
   * rather than the old one moved.
   */
  mergeActivityKeys(viewer: Viewer, after: { occurredAt: number; id: string } | null, limit: number): Array<{
    id: string;
    kind: "merged";
    occurred_at: number;
    actor_user_id: string | null;
    actor_label: string;
    thread_id: string;
    substream_id: string;
    attention_ordinal: number;
    merged_channel_id: string;
    merged_channel_name: string;
    merged_thread_private: number;
  }> {
    const spaceIds = this.visibleSpaceIds(viewer);
    if (spaceIds.length === 0) return [];
    return this.storage.sql.exec<{
      id: string;
      kind: "merged";
      occurred_at: number;
      actor_user_id: string | null;
      actor_label: string;
      thread_id: string;
      substream_id: string;
      attention_ordinal: number;
      merged_channel_id: string;
      merged_channel_name: string;
      merged_thread_private: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT * FROM (
         SELECT 'merged:' || m.message_id || ':' || m.posted_at AS id, 'merged' AS kind,
                m.posted_at AS occurred_at, m.author_user_id AS actor_user_id, '' AS actor_label,
                m.source_workstream_id AS thread_id, '0' AS substream_id,
                m.attention_ordinal AS attention_ordinal,
                m.space_id AS merged_channel_id, space.title AS merged_channel_name,
                CASE WHEN ${mainOpenableSql("directory", "viewer", viewer.accessClass)} THEN 0 ELSE 1 END AS merged_thread_private
           FROM space_messages m
           JOIN spaces space ON space.space_id = m.space_id
           JOIN channels directory ON directory.workstream_id = m.source_workstream_id
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?1
            AND viewer.authority_generation = directory.authority_generation
          WHERE m.source_workstream_id IS NOT NULL
            AND m.attention_ordinal IS NOT NULL
            AND (m.author_user_id IS NULL OR m.author_user_id <> ?1)
            AND m.space_id IN (SELECT value FROM json_each(?2))
            AND directory.archived_at IS NULL)
        WHERE (?3 IS NULL OR occurred_at < ?3 OR (occurred_at = ?3 AND id < ?4))
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?5`,
      viewer.userId,
      JSON.stringify(spaceIds),
      after?.occurredAt ?? null,
      after?.id ?? "",
      limit,
    ).toArray();
  }

  /**
   * Delete one Channel message. Returns its author and the thread it was
   * about, so the caller can decide who may, or null when it is not there.
   * With `allow`, the delete happens only when `allow` says yes.
   */
  removeMessage(
    spaceId: string,
    messageId: string,
    allow: (message: { author: ChannelMessageAuthor; sourceWorkstreamId: string | null }) => boolean,
  ): "removed" | "not_found" | "forbidden" {
    const row = this.storage.sql.exec<{
      author_kind: "rally" | "member";
      author_user_id: string | null;
      source_workstream_id: string | null;
    } & Record<string, SqlStorageValue>>(
      "SELECT author_kind, author_user_id, source_workstream_id FROM space_messages WHERE message_id = ? AND space_id = ?",
      messageId,
      spaceId,
    ).toArray()[0];
    if (row === undefined) return "not_found";
    const author: ChannelMessageAuthor = row.author_kind === "member"
      ? { kind: "member", userId: asUserId(row.author_user_id!) }
      : { kind: "rally" };
    if (!allow({ author, sourceWorkstreamId: row.source_workstream_id })) return "forbidden";
    this.storage.sql.exec("DELETE FROM space_messages WHERE message_id = ?", messageId);
    return "removed";
  }

  /**
   * What a Channel opens with: posted at the moment it was made, so it is the
   * first thing in its feed, and keyed by position, so posting the same list
   * again (a retry, or a backfill for a Channel made before it had them)
   * writes nothing twice.
   */
  postStartingMessages(spaceId: string, drafts: readonly ChannelMessageDraft[]): void {
    if (drafts.length === 0) return;
    const madeAt = this.storage.sql.exec<{ created_at: number } & Record<string, SqlStorageValue>>(
      "SELECT created_at FROM spaces WHERE space_id = ?", spaceId,
    ).toArray()[0]?.created_at;
    if (madeAt === undefined) return;
    this.postMessages(
      spaceId,
      drafts.map((draft, index) => ({ ...draft, key: draft.key ?? `start:${index}`, news: false })),
      madeAt,
    );
  }

  /** Whether this Space is somebody's Personal Channel. */
  isPersonalSpace(spaceId: string): boolean {
    if (!this.ready()) return false;
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      "SELECT space_id FROM spaces WHERE space_id = ? AND scope = 'individual'",
      spaceId,
    ).toArray().length > 0;
  }

  /** This member's Personal Channel, archived or not, or nothing. */
  personalSpaceId(userId: string): string | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      "SELECT space_id FROM spaces WHERE scope = 'individual' AND created_by_user_id = ?",
      userId,
    ).toArray()[0]?.space_id ?? null;
  }

  /**
   * Make an active member a participant of General and of their own Personal
   * Channel, whichever exist. A member who left and came back lost both viewer
   * rows when they left. False when nothing changed, so a redelivery writes
   * nothing.
   */
  seatMember(userId: string, now = Date.now()): boolean {
    return this.storage.transactionSync(() => [this.generalSpaceId(), this.personalSpaceId(userId)]
      .filter((spaceId): spaceId is string => spaceId !== null)
      .map((spaceId) => this.seat(spaceId, userId, now))
      .some(Boolean));
  }

  list(workspaceId: string, viewer: Viewer, now = Date.now()): SpaceDirectory {
    if (!this.ready()) return EMPTY_DIRECTORY;
    return this.storage.transactionSync(() => {
      for (const spaceId of this.visibleSpaceIds(viewer)) {
        this.appendOrder(workspaceId, viewer.userId, spaceId, now);
      }
      return this.directory(workspaceId, viewer);
    });
  }

  /**
   * The archived Spaces this viewer may see.
   *
   * Under the same visibility text as the active list, and today its third
   * clause never widens this one: an archive stages every membership out of
   * `active` before it commits, so nobody reaches an archived Space through a
   * Channel placed in it — and no surface draws a Channel under an archived
   * Space either, so there would be nothing for the mark and name to explain.
   * That is a property of the archive rather than of the predicate, and the
   * predicate is written once so a change to the archive carries here instead
   * of being re-derived.
   */
  listInactive(viewer: Viewer): SpaceDirectory {
    if (!this.ready()) return EMPTY_DIRECTORY;
    const listed = this.spaceListing(viewer);
    const rows = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*, ${spaceReachSql("space", "viewer", viewer.accessClass)} AS reach
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.archived_at IS NOT NULL
          AND ${listed.sql}
        ORDER BY space.updated_at DESC, space.space_id`,
      viewer.userId,
      ...listed.binds,
    ).toArray();
    return SpaceDirectorySchema.parse({
      waterline: this.waterline(),
      items: rows.map((row) => this.summary(row, viewer, 0)),
    });
  }

  /**
   * Every list this person has arranged by hand, whatever contains it.
   *
   * One read for all three kinds, because the socket sends all three in one
   * field: a reader that asked per container would be one query per Space on
   * screen, on the connect payload of every session.
   *
   * The Organization's own list is in here too, although the Space directory
   * beside it already arrives sorted by these same rows. That duplication is
   * the point: with it the client has *one* rule — apply the stored order to
   * the list you are drawing — and without it the Spaces would be the one list
   * whose arrangement came from the order the server happened to serialize,
   * which is not a thing a drag can move optimistically or roll back. One
   * mechanism that is redundant for one of its three callers is cheaper than
   * two mechanisms, and the redundancy is a few ids on a payload that already
   * carries every Space's name.
   */
  readOrders(workspaceId: string, viewer: Viewer): PersonalOrder {
    const userId = viewer.userId;
    if (!this.ready()) return [];
    const rows = this.storage.sql.exec<{
      container_kind: string;
      container_id: string;
      item_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT container_kind, container_id, item_id
         FROM workspace_container_order
        WHERE user_id = ?
        ORDER BY container_kind, container_id, position, item_id`,
      userId,
    ).toArray();
    const byContainer = new Map<string, ContainerOrder>();
    for (const row of rows) {
      if (row.container_kind === "organization" && row.container_id !== workspaceId) continue;
      const key = `${row.container_kind}:${row.container_id}`;
      const existing = byContainer.get(key);
      if (existing) existing.itemIds.push(row.item_id);
      else {
        // The stored row keys on the workspace id for the Organization, because
        // a row should say what it is about; the wire shape does not carry it,
        // because a request is already addressed to one Organization.
        // `container_kind` is narrowed by the table's own CHECK — the parse is
        // the shape the reader is owed rather than a check it can fail.
        const kind = OrderedContainerKindSchema.parse(row.container_kind);
        byContainer.set(key, {
          container: kind === "organization" ? { kind } : { kind, id: row.container_id },
          itemIds: [row.item_id],
        });
      }
    }
    const visibleSpaces = new Set(this.visibleSpaceIds(viewer));
    const visible: ContainerOrder[] = [];
    for (const order of byContainer.values()) {
      if (order.container.kind === "organization") {
        visible.push({ ...order, itemIds: order.itemIds.filter((id) => visibleSpaces.has(id)) });
        continue;
      }
      if (order.container.kind === "space") {
        if (!this.readable(viewer, order.container.id)) continue;
        const orderable = this.orderableChannelIds(viewer, order.container.id, order.itemIds);
        visible.push({ ...order, itemIds: order.itemIds.filter((id) => orderable.has(id)) });
        continue;
      }
      if (this.listableChannelIds(viewer, [order.container.id]).length > 0) visible.push(order);
    }
    return PersonalOrderSchema.parse(visible);
  }

  /**
   * Put one container's items in the order this person asked for, and answer
   * with what was actually stored.
   *
   * The three kinds differ only in what may be in the list, and each answer is
   * one this object already holds:
   *
   * - `organization` keeps the Space ordering's semantics exactly, because the
   *   Space directory is read *through* these rows: every visible Space is
   *   appended first so none is unorderable and none falls out of the
   *   directory, the request is filtered to the Spaces this viewer can see, and
   *   the ids nobody mentioned keep their relative order behind the ones that
   *   were. A partial list is what the sidebar sends when a search has hidden
   *   rows.
   * - `space` keeps the Channels actually placed in that Space that this viewer
   *   can read, and nothing else. `spaceIdsByChannel` answers the membership
   *   and the Space's own visibility in one read, and the directory answers
   *   whether the viewer may see the Channel at all — a placement whose Channel
   *   is not on this person's sidebar is not a row they were arranging.
   * - `channel` is stored as given. A Channel's Breakouts are its own object's
   *   children and WorkspaceDO has never seen them, so there is nothing here to
   *   validate against; the client drops the ids it cannot draw. Storing an id
   *   that names nothing costs this person one row and nobody else anything —
   *   the rows are theirs, and the only reader is their own sidebar.
   *
   * **All three merge, and a write never deletes a position it was not about.**
   * The ids the request names go first in the order it named them, and every
   * other id this person already has for that container follows in the order it
   * already had. The request is not a picture of the list: the only client there
   * is sends the ids it is *drawing*, which is what is left after an archived
   * Channel, a Breakout on a page this device never loaded, or a Channel outside
   * the sidebar's first page of 250 has already been dropped. Replacing would
   * read that silence as "delete these", so one drag on a laptop that has loaded
   * one page would throw away the arrangement made on a desktop that had loaded
   * four — everywhere, with no error and no signal.
   */
  writeOrder(
    workspaceId: string,
    userId: string,
    order: ContainerOrder,
    now = Date.now(),
  ): ContainerOrder {
    return this.storage.transactionSync(() => {
      const requested = [...new Set(order.itemIds)];
      const stored = this.storableOrder(workspaceId, userId, order.container, requested, now);
      if (order.container.kind !== "organization") {
        this.storage.sql.exec(
          `DELETE FROM workspace_container_order
            WHERE user_id = ? AND container_kind = ? AND container_id = ?`,
          userId,
          order.container.kind,
          order.container.id,
        );
        for (const [position, itemId] of stored.entries()) {
          this.storage.sql.exec(
            `INSERT INTO workspace_container_order
               (user_id, container_kind, container_id, item_id, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            userId,
            order.container.kind,
            order.container.id,
            itemId,
            position,
            now,
            now,
          );
        }
      }
      this.advanceWaterline(now);
      return ContainerOrderSchema.parse({ container: order.container, itemIds: stored });
    });
  }

  /**
   * This person's order for **All**'s Pinned section, naming only Channels
   * they can still list. A Channel they lost leaves its row behind, harmless,
   * and is simply not named; a pin it never named is the client's to place.
   */
  readPinnedOrder(viewer: Viewer): string[] {
    const stored = this.storedPinnedOrder(viewer.userId);
    const listable = new Set(this.listableChannelIds(viewer, stored));
    return stored.filter((id) => listable.has(id));
  }

  /**
   * Put All's Pinned section in the order this person asked for, and answer
   * with what was stored: the Channels they can list, each once, then any
   * stored id the request did not name, so a pin outside the client's loaded
   * page keeps its place. Whether each is pinned right now is the client's to
   * draw, since a pin and its place here move apart whenever one is unpinned
   * on another device.
   */
  writePinnedOrder(userId: string, requestedIds: readonly string[], now: number): string[] {
    const requested = [...new Set(requestedIds)];
    const listable = new Set(this.listableChannelIds(member(userId), requested));
    const stored = mergedOrder(requested.filter((id) => listable.has(id)), this.storedPinnedOrder(userId));
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`DELETE FROM workspace_pinned_order WHERE user_id = ?`, userId);
      for (const [position, itemId] of stored.entries()) {
        this.storage.sql.exec(
          `INSERT INTO workspace_pinned_order (user_id, item_id, position, updated_at) VALUES (?, ?, ?, ?)`,
          userId,
          itemId,
          position,
          now,
        );
      }
    });
    return this.readPinnedOrder(member(userId));
  }

  private storedPinnedOrder(userId: string): string[] {
    return this.storage.sql.exec<{ item_id: string } & Record<string, SqlStorageValue>>(
      `SELECT item_id FROM workspace_pinned_order WHERE user_id = ? ORDER BY position, item_id`,
      userId,
    ).toArray().map((row) => row.item_id);
  }

  /** Whether this viewer may name the container whose private order they write. */
  canArrange(userId: string, container: OrderedContainer): boolean {
    if (container.kind === "organization") return true;
    if (container.kind === "space") return this.readable(member(userId), container.id) !== false;
    return this.listableChannelIds(member(userId), [container.id]).length > 0;
  }

  /** What is left of a requested list once this container's rule has run. */
  private storableOrder(
    workspaceId: string,
    userId: string,
    container: OrderedContainer,
    requestedIds: readonly string[],
    now: number,
  ): string[] {
    if (container.kind === "organization") {
      return this.organizationOrder(workspaceId, userId, requestedIds, now);
    }
    const stored = this.storedContainerOrder(userId, container.kind, container.id);
    if (container.kind !== "space") return mergedOrder(requestedIds, stored);
    // Validate only what this request is trying to move. Stored positions can
    // name Channels this device cannot currently see (or a concurrent move has
    // just removed); filtering the merged result would turn that incomplete
    // view into a deletion of somebody else's valid arrangement.
    const orderable = this.orderableChannelIds(member(userId), container.id, requestedIds);
    return mergedOrder(requestedIds.filter((id) => orderable.has(id)), stored);
  }

  /** What this person currently has stored for one container, in its own order. */
  private storedContainerOrder(userId: string, kind: string, containerId: string): string[] {
    return this.storage.sql.exec<{ item_id: string } & Record<string, SqlStorageValue>>(
      `SELECT item_id FROM workspace_container_order
        WHERE user_id = ? AND container_kind = ? AND container_id = ?
        ORDER BY position, item_id`,
      userId,
      kind,
      containerId,
    ).toArray().map((row) => row.item_id);
  }

  /**
   * The Organization's Spaces, arranged and written in place.
   *
   * Separate from the two lists above because it is the one whose rows another
   * read depends on: a Space with no row is a Space the directory join cannot
   * answer with, so this appends before it arranges and updates rather than
   * replacing.
   */
  private organizationOrder(
    workspaceId: string,
    userId: string,
    requestedIds: readonly string[],
    now: number,
  ): string[] {
    const visible = this.visibleSpaceIds(member(userId));
    for (const spaceId of visible) this.appendOrder(workspaceId, userId, spaceId, now);
    const visibleSet = new Set(visible);
    const ordered = mergedOrder(
      requestedIds.filter((id) => visibleSet.has(id)),
      this.storedContainerOrder(userId, "organization", workspaceId)
        .filter((id) => visibleSet.has(id)),
    );
    for (const [position, spaceId] of ordered.entries()) {
      this.storage.sql.exec(
        `UPDATE workspace_container_order SET position = ?, updated_at = ?
          WHERE user_id = ? AND container_kind = 'organization'
            AND container_id = ? AND item_id = ?`,
        position,
        now,
        userId,
        workspaceId,
        spaceId,
      );
    }
    return ordered;
  }

  /**
   * Which of these Channels this person could be arranging inside this Space.
   *
   * Two facts, and neither is a new read. `spaceIdsByChannel` — the one the
   * sidebar payload already asks for every row it draws — answers the active
   * membership *and* the Space's own visibility to this viewer, and
   * `listableChannelIds`, which a Space refusal already uses to decide what it
   * may name, answers whether this viewer may see the Channel at all. A
   * membership cannot answer the second: a placement is the Organization's fact
   * about a Channel, and visibility is the reader's.
   */
  private orderableChannelIds(
    viewer: Viewer,
    spaceId: string,
    workstreamIds: readonly string[],
  ): Set<string> {
    const placed = [...this.spaceIdsByChannel(viewer, workstreamIds)]
      .filter(([, spaceIds]) => spaceIds.includes(spaceId))
      .map(([workstreamId]) => workstreamId);
    return new Set(this.listableChannelIds(viewer, placed));
  }

  /**
   * One Space as this viewer may see it, archived or not.
   *
   * The read is its own gate: {@link WorkspaceSpaceStorage.space} renders the
   * visibility predicate, so asking `canRead` first would be the same question
   * twice and a second place for the answer to drift.
   */
  readable(viewer: Viewer, spaceId: string): SpaceSummary | false {
    return this.space(spaceId, viewer);
  }

  /**
   * Record the presentation the Space's own authority accepted, so the
   * mutation can answer without waiting on the projection.
   *
   * The fence columns are deliberately untouched. The real projection carries
   * the same change at a higher source version and overwrites this, which is
   * what keeps the Space's own object authoritative for what a Space is.
   */
  applyPresentation(request: WorkspaceSpacePresentationRequest, now = Date.now()): SpaceSummary | "stale" | false {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId)) return false;
      const updated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE spaces
            SET title = ?, appearance_json = ?, revision = revision + 1, updated_at = ?
          WHERE space_id = ? AND (? IS NULL OR revision = ?) RETURNING space_id`,
        request.presentation.name.trim(),
        JSON.stringify({ icon: request.presentation.iconKey, color: request.presentation.colorKey }),
        now,
        request.spaceId,
        request.ifRevision ?? null,
        request.ifRevision ?? null,
      ).toArray()[0];
      // `canEdit` found the row, so a miss here is the revision fence.
      if (!updated) return request.ifRevision === undefined ? false : "stale";
      this.advanceWaterline(now);
      return this.space(request.spaceId, member(request.userId));
    });
  }

  /**
   * Record the scope and participants the Space's own authority accepted.
   *
   * Participants are the viewer rows, which is the same table the
   * `directory_user` projection writes: the Space's own object decides who its
   * participants are, and this is the provisional copy of that answer.
   *
   * `"left"` is the actor taking themselves out of a private Space: the change
   * is written, and the Space no longer exists for them, so there is no
   * summary to answer with.
   */
  applyAudience(
    request: WorkspaceSpaceAudienceNoteRequest,
    now = Date.now(),
  ): SpaceSummary | "left" | false {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId)) return false;
      const updated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE spaces
            SET scope = ?, revision = revision + 1, updated_at = ?
          WHERE space_id = ? AND archived_at IS NULL RETURNING space_id`,
        request.audience.scope,
        now,
        request.spaceId,
      ).toArray()[0];
      if (!updated) return false;
      const requested = new Set<string>(request.audience.participantUserIds);
      for (const row of this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
        "SELECT user_id FROM space_viewers WHERE space_id = ?",
        request.spaceId,
      ).toArray()) {
        this.storage.sql.exec(
          `UPDATE space_viewers SET is_participant = ? WHERE space_id = ? AND user_id = ?`,
          requested.has(row.user_id) ? 1 : 0,
          request.spaceId,
          row.user_id,
        );
        requested.delete(row.user_id);
      }
      for (const userId of requested) {
        this.storage.sql.exec(
          `INSERT INTO space_viewers
             (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
           VALUES (?, ?, 1, 1, 0, '')`,
          request.spaceId,
          userId,
        );
      }
      if (request.audience.inviteeEmails !== undefined) {
        this.storage.sql.exec("DELETE FROM space_invitees WHERE space_id = ?", request.spaceId);
        for (const email of new Set(request.audience.inviteeEmails.map((address) => address.toLowerCase()))) {
          this.storage.sql.exec(
            "INSERT INTO space_invitees (space_id, email, added_at) VALUES (?, ?, ?)",
            request.spaceId,
            email,
            now,
          );
        }
      }
      this.advanceWaterline(now);
      return this.space(request.spaceId, member(request.userId)) || "left";
    });
  }

  /** The addresses listed in one Space, waiting for their owners to join. */
  invitees(spaceId: string): string[] {
    return this.storage.sql.exec<{ email: string } & Record<string, SqlStorageValue>>(
      "SELECT email FROM space_invitees WHERE space_id = ? ORDER BY email",
      spaceId,
    ).toArray().map((row) => row.email);
  }

  /**
   * Seat a new member in every active Space that listed their address, and
   * forget the address there. One transaction, so an address is never both
   * seated and still waiting. Returns the Spaces it seated them in.
   */
  seatInvitees(userId: string, email: string, now = Date.now()): string[] {
    return this.storage.transactionSync(() => {
      const spaceIds = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        "DELETE FROM space_invitees WHERE email = ? RETURNING space_id",
        email.toLowerCase(),
      ).toArray().map((row) => row.space_id);
      return spaceIds.filter((spaceId) => this.seat(spaceId, userId, now));
    });
  }

  /**
   * Make `userId` a participant of a live Space, advancing its revision and the
   * waterline. False, writing nothing, when the Space is archived or they
   * already are one. Inside the caller's transaction.
   */
  private seat(spaceId: string, userId: string, now: number): boolean {
    const seated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT space_id FROM space_viewers WHERE space_id = ? AND user_id = ? AND is_participant = 1`,
      spaceId,
      userId,
    ).toArray().length > 0;
    if (seated) return false;
    const space = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE spaces SET revision = revision + 1, updated_at = ?
        WHERE space_id = ? AND archived_at IS NULL RETURNING space_id`,
      now,
      spaceId,
    ).toArray()[0];
    if (!space) return false;
    this.storage.sql.exec(
      `INSERT INTO space_viewers
         (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
       VALUES (?, ?, 1, 1, 0, '')
       ON CONFLICT(space_id, user_id) DO UPDATE SET is_participant = 1`,
      spaceId,
      userId,
    );
    this.advanceWaterline(now);
    return true;
  }

  /**
   * Apply one `directory_common` effect a Space published.
   *
   * The same generation-then-version fence the Channel directory uses, and the
   * same conflict when two payloads claim one version: a Space is the same
   * primitive publishing the same effect, so the ordering rules are the ones
   * that already exist rather than a second set written for this table.
   */
  applyDirectoryProjection(projection: SpaceDirectoryProjection, now = Date.now()): boolean {
    const current = this.storage.sql.exec<{
      authority_generation: number;
      source_version: number;
      payload_hash: string;
      title: string;
      scope: string;
      appearance_json: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT authority_generation, source_version, payload_hash, title, scope,
              appearance_json
         FROM spaces WHERE space_id = ?`,
      projection.spaceId,
    ).toArray()[0];
    if (current
      && projection.authorityGeneration === current.authority_generation
      && projection.sourceVersion === current.source_version
      && projection.payloadHash !== current.payload_hash) {
      throw new Error("workspace_space_directory_projection_version_conflict");
    }
    const applies = !current
      || projection.authorityGeneration > current.authority_generation
      || (projection.authorityGeneration === current.authority_generation
        && projection.sourceVersion > current.source_version);
    if (!applies) return false;
    const appearanceJson = projection.appearance
      ? JSON.stringify({ icon: projection.appearance.iconKey, color: projection.appearance.colorKey })
      : current?.appearance_json ?? null;
    // A projection never writes `archived_at`: only `finalizeArchive` and
    // `restore` do. Taking the conversation's value, always null, un-archived a
    // Space on its next rename and left it where `restore` refused it.
    // A Space's scope is WorkspaceDO's (`applyAudience`, or `individual` from
    // the reservation); its parent's projection never moves it. A new row
    // starts Organization-wide, as every creation does.
    const scope = current?.scope ?? "workspace";
    const changed = !current
      || current.title !== projection.title
      || current.scope !== scope
      || current.appearance_json !== appearanceJson;
    this.storage.sql.exec(
      `INSERT INTO spaces (
         space_id, title, scope, appearance_json, archived_at,
         created_by_user_id, system_role, authority_generation, source_version,
         payload_hash, revision, created_at, updated_at, source_created_at, source_updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(space_id) DO UPDATE SET
         title = excluded.title,
         scope = excluded.scope,
         appearance_json = excluded.appearance_json,
         created_by_user_id = COALESCE(
           spaces.created_by_user_id, excluded.created_by_user_id
         ),
         authority_generation = excluded.authority_generation,
         source_version = excluded.source_version,
         payload_hash = excluded.payload_hash,
         revision = spaces.revision + ?,
         updated_at = excluded.updated_at,
         source_created_at = excluded.source_created_at,
         source_updated_at = excluded.source_updated_at`,
      projection.spaceId,
      projection.title,
      scope,
      appearanceJson,
      projection.createdByUserId,
      projection.authorityGeneration,
      projection.sourceVersion,
      projection.payloadHash,
      now,
      now,
      projection.sourceCreatedAt,
      projection.sourceUpdatedAt,
      changed ? 1 : 0,
    );
    if (changed) this.advanceWaterline(now);
    return changed;
  }

  /** Apply one `directory_user` effect a Space published for one viewer. */
  applyViewerProjection(projection: SpaceViewerProjection, active: boolean, now = Date.now()): boolean {
    if (!active) {
      const deleted = this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
        `DELETE FROM space_viewers WHERE space_id = ? AND user_id = ? RETURNING user_id`,
        projection.spaceId,
        projection.userId,
      ).toArray().length === 1;
      if (deleted) this.advanceWaterline(now);
      return deleted;
    }
    const current = this.storage.sql.exec<{
      authority_generation: number;
      source_version: number;
      payload_hash: string;
      is_participant: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT authority_generation, source_version, payload_hash, is_participant
         FROM space_viewers WHERE space_id = ? AND user_id = ?`,
      projection.spaceId,
      projection.userId,
    ).toArray()[0];
    if (current
      && projection.authorityGeneration === current.authority_generation
      && projection.sourceVersion === current.source_version
      && projection.payloadHash !== current.payload_hash) {
      throw new Error("workspace_space_viewer_projection_version_conflict");
    }
    const applies = !current
      || projection.authorityGeneration > current.authority_generation
      || (projection.authorityGeneration === current.authority_generation
        && projection.sourceVersion > current.source_version);
    if (!applies) return false;
    const changed = current?.is_participant !== (projection.isParticipant ? 1 : 0);
    this.storage.sql.exec(
      `INSERT INTO space_viewers
         (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET
         is_participant = excluded.is_participant,
         authority_generation = excluded.authority_generation,
         source_version = excluded.source_version,
         payload_hash = excluded.payload_hash`,
      projection.spaceId,
      projection.userId,
      projection.isParticipant ? 1 : 0,
      projection.authorityGeneration,
      projection.sourceVersion,
      projection.payloadHash,
    );
    if (changed) {
      this.storage.sql.exec(
        `UPDATE spaces SET revision = revision + 1, updated_at = ?
          WHERE space_id = ?`,
        now,
        projection.spaceId,
      );
      this.advanceWaterline(now);
    }
    return changed;
  }

  /**
   * One page of the conversations in this Space that currently need this
   * viewer, newest activity first.
   *
   * Keys rather than rows, because the rows belong to the Channel directory
   * and the breakout directory and the projection that turns either into a
   * `SpaceConversation` is WorkspaceDO's — the same mapper `listDirectory`
   * uses. This decides *which* conversations a page is about and *in what
   * order*; the caller decides what each one looks like to this viewer.
   *
   * Three decisions are made here and nowhere else.
   *
   * **Both kinds in one list.** A `UNION ALL` of the Space's active member
   * Channels and those Channels' breakouts. The alternative — a page of
   * Channels with each one's breakouts fetched beside it — cannot be ordered
   * by activity across the two without reading every breakout of every member
   * Channel first, which is the unbounded read the page bound exists to
   * prevent.
   *
   * **Stale is left out here by default, not on the client.** Internal
   * all-visible reads omit only this attention predicate; kind is also filtered
   * before pagination. `liveForViewerSql` is
   * applied inside the query, so the page is `SPACE_CHANNEL_PAGE_SIZE`
   * conversations that need this viewer rather than that many rows of which
   * some do. A client-side filter would have made every page arbitrarily short
   * and the cursor a promise about rows it had already discarded.
   *
   * **A breakout is visible only through its parent.** The Channel's own
   * visibility predicate is applied to the breakout arm too — the same
   * `scope = 'workspace' OR is_participant` test, against the same Channel row
   * — and then the breakout's own viewer row has to say `listable`. Two gates
   * rather than one because they answer different questions: the first is
   * whether this person may know the Channel exists, the second is whether the
   * breakout is one of theirs. Dropping the first would list a private
   * Channel's side thread to somebody who cannot open the Channel.
   *
   * **Each arm takes its own page, and the union merges two of them.** The
   * cursor and the `LIMIT` are applied inside each arm, before the
   * `UNION ALL`, so what the outer statement sorts is at most two pages rather
   * than every live conversation in the Space. Within an arm `kind` is
   * constant, so the three-part cursor is a plain range over that arm's
   * `(last_activity_at, id)` — see {@link afterCursorSql} — and the arm's own
   * `ORDER BY` is exactly the restriction of the page's order to it, which is
   * what makes merging the two arms' heads the globally first page.
   *
   * What that does **not** buy is the scan: the planner drives both arms from
   * `space_channel_memberships(space_id, state, workstream_id)`, so one page
   * still costs one pass over the Space's active membership set, with a
   * primary-key lookup into the Channel directory and the viewer row per
   * member. For General that set is the whole Organization. Removing the pass
   * needs an index that orders a *Space's* members by activity, which does not
   * exist and is not worth guessing at before anybody here has Organization
   * sizes; `docs/spaces.md` records the cost so the next person does not have
   * to re-derive it.
   */
  conversationPage(
    viewer: Viewer,
    spaceId: string,
    cursor: string | null,
    options: Pick<WorkspaceSpaceConversationPageRequest, "kind" | "needsViewerOnly"> = {},
  ): SpaceConversationPage | "invalid_cursor" | false {
    if (this.reach(viewer, spaceId) === null) return false;
    const userId = viewer.userId;
    const breakouts = this.breakoutsReady();
    const after = cursor === null ? null : decodeConversationCursor(cursor);
    // Named apart from "no such Space", which is what an unreadable cursor was
    // answered with. The two ask opposite things of the caller: one says stop,
    // the other says drop the cursor and read the first page.
    if (cursor !== null && after === null) return "invalid_cursor";
    const rows = this.storage.sql.exec<{
      kind: "channel" | "breakout";
      workstream_id: string;
      substream_id: string | null;
      conversation_id: string;
      last_activity_at: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT kind, workstream_id, substream_id, conversation_id, last_activity_at FROM (
         SELECT * FROM (
           SELECT 'channel' AS kind,
                  directory.workstream_id AS workstream_id,
                  NULL AS substream_id,
                  directory.workstream_id AS conversation_id,
                  directory.last_activity_at AS last_activity_at
             FROM space_channel_memberships membership
             JOIN channels directory
               ON directory.workstream_id = membership.workstream_id
             LEFT JOIN channel_viewers viewer
               ON viewer.workstream_id = directory.workstream_id
              AND viewer.user_id = ?1
              AND viewer.authority_generation = directory.authority_generation
            WHERE membership.space_id = ?2 AND membership.state = 'active'
              AND directory.archived_at IS NULL
              AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
              AND ${options.kind === "breakout" ? "0" : "1"}
              AND ${options.needsViewerOnly === false ? "1" : liveForViewerSql("directory", "viewer")}
              AND ${afterCursorSql("channel", "directory.last_activity_at", "directory.workstream_id")}
            ORDER BY directory.last_activity_at DESC, directory.workstream_id
            LIMIT ?6
         )
         UNION ALL
         SELECT * FROM (
           SELECT 'breakout' AS kind,
                  breakout.workstream_id AS workstream_id,
                  breakout.substream_id AS substream_id,
                  breakout.substream_id AS conversation_id,
                  breakout.last_activity_at AS last_activity_at
             FROM space_channel_memberships membership
             JOIN channels directory
               ON directory.workstream_id = membership.workstream_id
             LEFT JOIN channel_viewers viewer
               ON viewer.workstream_id = directory.workstream_id
              AND viewer.user_id = ?1
              AND viewer.authority_generation = directory.authority_generation
             JOIN breakouts breakout
               ON breakout.workstream_id = membership.workstream_id
             LEFT JOIN breakout_viewers breakout_viewer
               ON breakout_viewer.workstream_id = breakout.workstream_id
              AND breakout_viewer.substream_id = breakout.substream_id
              AND breakout_viewer.user_id = ?1
              AND breakout_viewer.authority_generation = breakout.authority_generation
            WHERE membership.space_id = ?2 AND membership.state = 'active'
              AND directory.archived_at IS NULL
              AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts, userId: "?1" })}
              AND breakout.archived_at IS NULL
              AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
              AND ${options.kind === "channel" ? "0" : "1"}
              AND ${options.needsViewerOnly === false ? "1" : liveForViewerSql("breakout", "breakout_viewer")}
              AND ${afterCursorSql("breakout", "breakout.last_activity_at", "breakout.substream_id")}
            ORDER BY breakout.last_activity_at DESC, breakout.substream_id
            LIMIT ?6
         )
       )
       ORDER BY last_activity_at DESC, kind, conversation_id
       LIMIT ?6`,
      userId,
      spaceId,
      after?.lastActivityAt ?? null,
      after?.kind ?? "",
      after?.conversationId ?? "",
      SPACE_CHANNEL_PAGE_SIZE + 1,
    ).toArray();
    const hasMore = rows.length > SPACE_CHANNEL_PAGE_SIZE;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        kind: row.kind,
        workstreamId: row.workstream_id,
        substreamId: row.substream_id,
      })),
      nextCursor: hasMore && last
        ? encodeConversationCursor({
          lastActivityAt: last.last_activity_at,
          kind: last.kind,
          conversationId: last.conversation_id,
        })
        : null,
    };
  }

  /**
   * One page of a Channel's feed: the threads placed in it that this viewer
   * may open, newest placement first.
   *
   * A Channel is the storage `space`, and a thread the storage Channel. A
   * private thread this viewer is not in is left out, for a member exactly as
   * for a guest: the feed does not say it is there. Archived threads and
   * system conversations are left out too.
   *
   * Ordered by `(joined_at, workstream_id)`, which migration 97's index on the
   * membership table serves directly; the cursor is the conversation cursor
   * with the placement time where the activity time would be.
   */
  feedPage(
    viewer: Viewer,
    spaceId: string,
    cursor: string | null,
  ): {
    items: Array<
      | { kind: "thread"; workstreamId: string; placedAt: number; attentionOrdinal: number }
      | { kind: "message"; message: ChannelMessage; placedAt: number; attentionOrdinal: number }
    >;
    nextCursor: string | null;
    /** The Channel's latest placement ordinal as this first page was read; null on a later page. */
    latestAttentionOrdinal: number | null;
  } | "invalid_cursor" | false {
    if (this.reach(viewer, spaceId) === null) return false;
    const after = cursor === null ? null : decodeConversationCursor(cursor);
    if (cursor !== null && after === null) return "invalid_cursor";
    const attention = this.readsReady() ? "COALESCE(membership.attention_ordinal, 0)" : "0";
    const rows = this.storage.sql.exec<{
      workstream_id: string;
      joined_at: number;
      attention_ordinal: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT membership.workstream_id, membership.joined_at, ${attention} AS attention_ordinal
         FROM space_channel_memberships membership
         JOIN channels directory
           ON directory.workstream_id = membership.workstream_id
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?1
          AND viewer.authority_generation = directory.authority_generation
        WHERE membership.space_id = ?2 AND membership.state = 'active'
          AND directory.archived_at IS NULL
          AND directory.system_kind IS NULL
          AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
          AND (?3 IS NULL
               OR membership.joined_at < ?3
               OR (membership.joined_at = ?3 AND membership.workstream_id > ?4))
        ORDER BY membership.joined_at DESC, membership.workstream_id
        LIMIT ?5`,
      viewer.userId,
      spaceId,
      after?.lastActivityAt ?? null,
      after?.conversationId ?? "",
      SPACE_CHANNEL_PAGE_SIZE + 1,
    ).toArray();
    // The Channel's own messages, under the same seek, merged with the
    // placements by time and then id: one order across both, so a cursor from
    // either kind of row resumes the other correctly.
    //
    // A message about a thread (a merge) shows to every reader of the
    // Channel. Whether this reader may open that thread, the placement seek's
    // own predicate through a primary-key join, decides only whether the
    // thread's name goes with it.
    const messages = this.storage.sql.exec<ChannelMessageRow>(
      `SELECT m.message_id, m.author_kind, m.author_user_id, m.body, m.posted_at,
              m.attention_ordinal, m.source_workstream_id, m.embeds_json,
              directory.title AS source_title, directory.description AS source_description,
              ${mainOpenableSql("directory", "viewer", viewer.accessClass)} AS source_openable
         FROM space_messages m
         LEFT JOIN channels directory
           ON directory.workstream_id = m.source_workstream_id
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?5
          AND viewer.authority_generation = directory.authority_generation
        WHERE m.space_id = ?1
          AND (m.source_workstream_id IS NULL OR directory.workstream_id IS NOT NULL)
          AND (?2 IS NULL OR m.posted_at < ?2 OR (m.posted_at = ?2 AND m.message_id > ?3))
        ORDER BY m.posted_at DESC, m.message_id
        LIMIT ?4`,
      spaceId,
      after?.lastActivityAt ?? null,
      after?.conversationId ?? "",
      SPACE_CHANNEL_PAGE_SIZE + 1,
      viewer.userId,
    ).toArray();
    const merged = [
      ...rows.map((row) => ({
        kind: "thread" as const, workstreamId: row.workstream_id, placedAt: row.joined_at,
        attentionOrdinal: row.attention_ordinal, id: row.workstream_id,
      })),
      ...messages.map((row) => ({
        kind: "message" as const, message: channelMessage(row), placedAt: row.posted_at, id: row.message_id,
        attentionOrdinal: row.attention_ordinal ?? 0,
      })),
    ].sort((a, b) => b.placedAt - a.placedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const hasMore = merged.length > SPACE_CHANNEL_PAGE_SIZE;
    const page = merged.slice(0, SPACE_CHANNEL_PAGE_SIZE);
    const last = page.at(-1);
    // Read with the page, in the same synchronous turn: every placement at or
    // below it is on this page, gone, or not this viewer's to open, so reading
    // the page reads the Channel through it, including a newest placement since
    // removed or archived, or one placed privately.
    const latestAttentionOrdinal = cursor !== null || !this.readsReady() ? null
      : this.storage.sql.exec<{ latest_attention_ordinal: number } & Record<string, SqlStorageValue>>(
        "SELECT latest_attention_ordinal FROM spaces WHERE space_id = ?",
        spaceId,
      ).toArray()[0]?.latest_attention_ordinal ?? null;
    return {
      latestAttentionOrdinal,
      items: page.map((item) => item.kind === "thread"
        ? { kind: item.kind, workstreamId: item.workstreamId, placedAt: item.placedAt, attentionOrdinal: item.attentionOrdinal }
        : { kind: item.kind, message: item.message, placedAt: item.placedAt, attentionOrdinal: item.attentionOrdinal }),
      nextCursor: hasMore && last
        ? encodeConversationCursor({
          lastActivityAt: last.placedAt, kind: last.kind === "thread" ? "channel" : "message", conversationId: last.id,
        })
        : null,
    };
  }

  /**
   * One page of the threads and breakouts this person takes part in or has
   * pinned, newest activity first: the Threads tab.
   *
   * The conversation page's two-arm shape, started from the person rather than
   * from a Space: migration 97's `(user_id, is_participant)` index on each
   * viewer table drives each arm, and the pin table adds what the person
   * pinned without taking part. A breakout is listed only under a thread this
   * person may list, the same two gates the conversation page asks. Archived
   * and system conversations are left out; stale ones are not, because this is
   * the list of a person's work, not of what needs them.
   */
  participatingPage(
    viewer: Viewer,
    cursor: string | null,
    /**
     * Every thread and breakout this person pinned and may still list, in one
     * answer: the Pinned section, which a page of the whole list cannot be
     * trusted to hold. Bounded by the pin limit rather than the page size.
     */
    { pinnedOnly = false }: { pinnedOnly?: boolean } = {},
  ): SpaceConversationPage | "invalid_cursor" {
    const breakouts = this.breakoutsReady();
    const pins = this.storage.sql.exec(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_pins'`,
    ).toArray().length === 1;
    if (pinnedOnly && !pins) return { items: [], nextCursor: null };
    const after = cursor === null ? null : decodeConversationCursor(cursor);
    if (cursor !== null && after === null) return "invalid_cursor";
    const pinned = (kind: "thread" | "breakout", id: string) => (pins
      ? `EXISTS (SELECT 1 FROM workspace_pins pin
                  WHERE pin.user_id = ?1 AND pin.item_kind = '${kind}' AND pin.item_id = ${id})`
      : "0");
    const rows = this.storage.sql.exec<{
      kind: "channel" | "breakout";
      workstream_id: string;
      substream_id: string | null;
      conversation_id: string;
      last_activity_at: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT kind, workstream_id, substream_id, conversation_id, last_activity_at FROM (
         SELECT * FROM (
           SELECT 'channel' AS kind,
                  directory.workstream_id AS workstream_id,
                  NULL AS substream_id,
                  directory.workstream_id AS conversation_id,
                  directory.last_activity_at AS last_activity_at
             FROM channels directory
             LEFT JOIN channel_viewers viewer
               ON viewer.workstream_id = directory.workstream_id
              AND viewer.user_id = ?1
              AND viewer.authority_generation = directory.authority_generation
            WHERE directory.archived_at IS NULL
              AND directory.system_kind IS NULL
              AND (${pinnedOnly ? "0" : "viewer.is_participant = 1"} OR ${pinned("thread", "directory.workstream_id")})
              AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
              AND ${afterCursorSql("channel", "directory.last_activity_at", "directory.workstream_id")}
            ORDER BY directory.last_activity_at DESC, directory.workstream_id
            LIMIT ?6
         )
         ${breakouts ? `UNION ALL
         SELECT * FROM (
           SELECT 'breakout' AS kind,
                  breakout.workstream_id AS workstream_id,
                  breakout.substream_id AS substream_id,
                  breakout.substream_id AS conversation_id,
                  breakout.last_activity_at AS last_activity_at
             FROM breakouts breakout
             LEFT JOIN breakout_viewers breakout_viewer
               ON breakout_viewer.workstream_id = breakout.workstream_id
              AND breakout_viewer.substream_id = breakout.substream_id
              AND breakout_viewer.user_id = ?1
              AND breakout_viewer.authority_generation = breakout.authority_generation
             JOIN channels directory
               ON directory.workstream_id = breakout.workstream_id
             LEFT JOIN channel_viewers viewer
               ON viewer.workstream_id = directory.workstream_id
              AND viewer.user_id = ?1
              AND viewer.authority_generation = directory.authority_generation
            WHERE breakout.archived_at IS NULL
              AND directory.archived_at IS NULL
              AND (${pinnedOnly ? "0" : "breakout_viewer.is_participant = 1"} OR ${pinned("breakout", "breakout.substream_id")})
              AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts, userId: "?1" })}
              AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
              AND ${afterCursorSql("breakout", "breakout.last_activity_at", "breakout.substream_id")}
            ORDER BY breakout.last_activity_at DESC, breakout.substream_id
            LIMIT ?6
         )` : ""}
       )
       ORDER BY last_activity_at DESC, kind, conversation_id
       LIMIT ?6`,
      viewer.userId,
      null,
      after?.lastActivityAt ?? null,
      after?.kind ?? "",
      after?.conversationId ?? "",
      // SQLite reads a negative LIMIT as none; the pin limit bounds the rows.
      pinnedOnly ? -1 : SPACE_CHANNEL_PAGE_SIZE + 1,
    ).toArray();
    const hasMore = !pinnedOnly && rows.length > SPACE_CHANNEL_PAGE_SIZE;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        kind: row.kind,
        workstreamId: row.workstream_id,
        substreamId: row.substream_id,
      })),
      nextCursor: hasMore && last
        ? encodeConversationCursor({
          lastActivityAt: last.last_activity_at,
          kind: last.kind,
          conversationId: last.conversation_id,
        })
        : null,
    };
  }

  /**
   * For each Space this viewer may list, how many threads in it they may list,
   * when the newest of those last moved, and the viewer's read state in it:
   * the Channels tab's second line and its unread dot.
   *
   * One grouped pass over the active memberships of the listed Spaces, the
   * same cost {@link attentionCounts} pays, plus the listing query reading the
   * waterline columns beside each Space id. A Space with nothing listable in
   * it is still answered, with zero and no time.
   *
   * `newThreadCount` counts the rows the Channel feed would show this viewer
   * above their read position; a placement moved out again is not a row and
   * is not counted. A guest is never unread, so zero. The read position is the
   * Channel's, over every placement, so a private thread placed since this
   * member last read it moves `latestAttentionSequenceNumber` without being
   * a row: `hasUnread` is true only while there is a row to count, or the
   * Channel would read as unread over nothing they can see, and
   * `firstUnreadSequenceNumber` is the first such row.
   */
  channelStats(viewer: Viewer, onlySpaceId?: string): Array<{
    spaceId: string;
    threadCount: number;
    newThreadCount: number;
    lastActivityAt: number | null;
    read: ChannelReadState;
  }> {
    if (!this.ready()) return [];
    const reads = this.visibleSpaceReads(viewer, onlySpaceId);
    const spaceIds = [...reads.keys()];
    if (spaceIds.length === 0) return [];
    const listed = this.channelListing(viewer);
    const counted = new Map<string, { count: number; last: number | null }>();
    for (const chunk of boundParameterChunks(spaceIds)) {
      for (const row of this.storage.sql.exec<{
        space_id: string;
        count: number;
        last_activity_at: number | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT membership.space_id, COUNT(*) AS count, MAX(directory.last_activity_at) AS last_activity_at
           FROM space_channel_memberships membership
           JOIN channels directory
             ON directory.workstream_id = membership.workstream_id
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?
            AND viewer.authority_generation = directory.authority_generation
          WHERE membership.state = 'active'
            AND directory.archived_at IS NULL
            AND directory.system_kind IS NULL
            AND ${listed.sql}
            AND membership.space_id IN (${chunk.map(() => "?").join(", ")})
          GROUP BY membership.space_id`,
        viewer.userId,
        ...listed.binds,
        ...chunk,
      ).toArray()) {
        counted.set(row.space_id, { count: row.count, last: row.last_activity_at });
      }
    }
    const fresh = new Map<string, { count: number; first: number }>();
    if (viewer.accessClass === "member" && this.readsReady()) {
      for (const chunk of boundParameterChunks(spaceIds)) {
        // The feed's predicate, above the read position unreadState
        // derives: the reader's own, else where tracking started.
        for (const row of this.storage.sql.exec<{ space_id: string; count: number; first: number } & Record<string, SqlStorageValue>>(
          `SELECT membership.space_id, COUNT(*) AS count,
                  MIN(COALESCE(membership.attention_ordinal, 0)) AS first
             FROM space_channel_memberships membership
             JOIN spaces space ON space.space_id = membership.space_id
             LEFT JOIN space_reads reads
               ON reads.space_id = membership.space_id AND reads.user_id = ?1
             JOIN channels directory
               ON directory.workstream_id = membership.workstream_id
             LEFT JOIN channel_viewers viewer
               ON viewer.workstream_id = directory.workstream_id
              AND viewer.user_id = ?1
              AND viewer.authority_generation = directory.authority_generation
            WHERE membership.state = 'active'
              AND directory.archived_at IS NULL
              AND directory.system_kind IS NULL
              AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
              AND COALESCE(membership.attention_ordinal, 0)
                  > COALESCE(reads.seen_attention_ordinal, space.unread_tracking_start_ordinal)
              AND membership.space_id IN (${chunk.map(() => "?").join(", ")})
            GROUP BY membership.space_id`,
          viewer.userId,
          ...chunk,
        ).toArray()) {
          fresh.set(row.space_id, { count: row.count, first: row.first });
        }
        // The second arm: Channel messages that are news, above the same
        // position, under the feed's own message predicate. They light the
        // dot and can be the first unread row; they are not new threads.
        for (const row of this.storage.sql.exec<{ space_id: string; first: number } & Record<string, SqlStorageValue>>(
          `SELECT m.space_id, MIN(m.attention_ordinal) AS first
             FROM space_messages m
             JOIN spaces space ON space.space_id = m.space_id
             LEFT JOIN space_reads reads
               ON reads.space_id = m.space_id AND reads.user_id = ?1
             LEFT JOIN channels directory
               ON directory.workstream_id = m.source_workstream_id
            WHERE m.attention_ordinal IS NOT NULL
              AND m.attention_ordinal
                  > COALESCE(reads.seen_attention_ordinal, space.unread_tracking_start_ordinal)
              AND (m.source_workstream_id IS NULL OR directory.workstream_id IS NOT NULL)
              AND m.space_id IN (${chunk.map(() => "?").join(", ")})
            GROUP BY m.space_id`,
          viewer.userId,
          ...chunk,
        ).toArray()) {
          const threads = fresh.get(row.space_id);
          fresh.set(row.space_id, {
            count: threads?.count ?? 0,
            first: threads === undefined ? row.first : Math.min(threads.first, row.first),
          });
        }
      }
    }
    return spaceIds.map((spaceId) => {
      const read = reads.get(spaceId) as ChannelReadState;
      const visible = fresh.get(spaceId);
      return {
        spaceId,
        threadCount: counted.get(spaceId)?.count ?? 0,
        newThreadCount: visible?.count ?? 0,
        lastActivityAt: counted.get(spaceId)?.last ?? null,
        // The first unread row is the first one this viewer can see, so the
        // three unread fields agree with each other and with the feed.
        read: {
          ...read,
          hasUnread: read.hasUnread && visible !== undefined,
          firstUnreadSequenceNumber: read.hasUnread && visible ? visible.first : null,
        },
      };
    });
  }

  /**
   * {@link visibleSpaceIds} with each Space's read state for this viewer, in
   * the same order. On an object short of migration 98 every Channel reads as
   * caught up at zero.
   */
  private visibleSpaceReads(viewer: Viewer, onlySpaceId?: string): Map<string, ChannelReadState> {
    const listed = this.spaceListing(viewer);
    const columns = this.readsReady()
      ? `space.latest_attention_ordinal, space.unread_tracking_start_ordinal,
         reads.seen_attention_ordinal`
      : `0 AS latest_attention_ordinal, 0 AS unread_tracking_start_ordinal,
         NULL AS seen_attention_ordinal`;
    const join = this.readsReady()
      ? "LEFT JOIN space_reads reads ON reads.space_id = space.space_id AND reads.user_id = ?1"
      : "";
    const rows = this.storage.sql.exec<{ space_id: string } & ChannelReadRow & Record<string, SqlStorageValue>>(
      `SELECT space.space_id, ${columns}
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ?1 AND viewer.is_participant = 1
         ${join}
        WHERE space.archived_at IS NULL
          AND (?2 IS NULL OR space.space_id = ?2)
          AND ${listed.sql}
        ORDER BY space.created_at, space.space_id`,
      viewer.userId,
      onlySpaceId ?? null,
      ...listed.binds,
    ).toArray();
    return new Map(rows.map((row) => [row.space_id, channelReadState(row, viewer.accessClass === "guest")]));
  }

  /**
   * Move this viewer's read position in a Channel forward, never back.
   *
   * The thread acknowledgement's rule (`acknowledgeRead` in
   * `workstream-object-product.ts`) against this Channel's columns, except
   * that a position past the waterline is clamped rather than refused: a
   * client can hold a feed row a moment longer than the waterline it read, and
   * the answer is the same either way. `false` for a Channel this viewer
   * cannot list, the same refusal the feed gives.
   */
  acknowledgeRead(
    viewer: Viewer,
    spaceId: string,
    readThrough: number,
    now = Date.now(),
  ): ChannelReadState | false {
    if (!this.ready() || !this.readsReady()) return false;
    return this.storage.transactionSync(() => {
      const current = this.visibleSpaceReads(viewer, spaceId).get(spaceId);
      if (!current) return false;
      const seen = Math.min(readThrough, current.latestAttentionSequenceNumber);
      this.storage.sql.exec(
        `INSERT INTO space_reads (space_id, user_id, seen_attention_ordinal, updated_at)
         SELECT ?1, ?2, MAX(space.unread_tracking_start_ordinal, ?3), ?4
           FROM spaces space WHERE space.space_id = ?1
         ON CONFLICT(space_id, user_id) DO UPDATE SET
           seen_attention_ordinal = MAX(
             COALESCE(space_reads.seen_attention_ordinal, excluded.seen_attention_ordinal),
             excluded.seen_attention_ordinal),
           updated_at = excluded.updated_at`,
        spaceId,
        viewer.userId,
        seen,
        now,
      );
      return this.visibleSpaceReads(viewer, spaceId).get(spaceId) ?? false;
    });
  }

  /**
   * Every Channel and Breakout in one Space that the dashboard would list for
   * this viewer. This is the dashboard query's admission predicate without its
   * page bound or ordering, so a sidebar badge never counts a different state.
   */
  attentionCounts(viewer: Viewer, spaceIds: readonly string[]): Map<string, number> {
    const userId = viewer.userId;
    const result = new Map<string, number>();
    if (!this.ready()) return result;
    const ids = [...new Set(spaceIds)];
    if (ids.length === 0) return result;
    const includeBreakouts = this.breakoutsReady();
    const rows = this.storage.sql.exec<{
      space_id: string;
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT space_id, COUNT(*) AS count FROM (
         SELECT membership.space_id, directory.workstream_id AS conversation_id
           FROM space_channel_memberships membership
           JOIN channels directory
             ON directory.workstream_id = membership.workstream_id
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?
            AND viewer.authority_generation = directory.authority_generation
          WHERE membership.space_id IN (SELECT value FROM json_each(?))
            AND membership.state = 'active'
            AND directory.archived_at IS NULL
            AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
            AND ${liveForViewerSql("directory", "viewer")}
         ${includeBreakouts ? `UNION ALL
         SELECT membership.space_id, breakout.substream_id AS conversation_id
           FROM space_channel_memberships membership
           JOIN channels directory
             ON directory.workstream_id = membership.workstream_id
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?
            AND viewer.authority_generation = directory.authority_generation
           JOIN breakouts breakout
             ON breakout.workstream_id = membership.workstream_id
           LEFT JOIN breakout_viewers breakout_viewer
             ON breakout_viewer.workstream_id = breakout.workstream_id
            AND breakout_viewer.substream_id = breakout.substream_id
            AND breakout_viewer.user_id = ?
            AND breakout_viewer.authority_generation = breakout.authority_generation
          WHERE membership.space_id IN (SELECT value FROM json_each(?))
            AND membership.state = 'active'
            AND directory.archived_at IS NULL
            AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: true })}
            AND breakout.archived_at IS NULL
            AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
            AND ${liveForViewerSql("breakout", "breakout_viewer")}` : ""}
       ) GROUP BY space_id`,
      userId,
      JSON.stringify(ids),
      ...(includeBreakouts ? [userId, userId, JSON.stringify(ids), userId] : []),
    ).toArray();
    for (const row of rows) result.set(row.space_id, row.count);
    return result;
  }

  attentionCount(viewer: Viewer, spaceId: string): number {
    return this.attentionCounts(viewer, [spaceId]).get(spaceId) ?? 0;
  }

  /**
   * How many conversations wait for this reader across the Organization: each
   * Main and each Breakout they take part in that is unread, unseen or
   * mentions them, in unarchived, non-system Channels, plus each Main that
   * mentions them without their taking part: a mention in an
   * Organization-wide thread does not seat the person mentioned. Otherwise a
   * workspace-wide thread somebody else is working in does not count. The sidebar's Threads badge shows the
   * same number from the rows it holds; this is that count for a reader whose
   * sidebar is not open, which is what an APNs `badge` needs.
   */
  readerAttentionCount(viewer: Viewer): number {
    const mains = this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM channels directory
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE directory.archived_at IS NULL
          AND directory.system_kind IS NULL
          AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
          AND (viewer.is_participant = 1 OR ${mentionedSql("directory", "viewer")})
          AND ${waitingForReaderSql("directory", "viewer")}`,
      viewer.userId,
    ).one().count;
    if (!this.breakoutsReady()) return mains;
    const breakouts = this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM breakouts breakout
         JOIN channels directory
           ON directory.workstream_id = breakout.workstream_id
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
         LEFT JOIN breakout_viewers breakout_viewer
           ON breakout_viewer.workstream_id = breakout.workstream_id
          AND breakout_viewer.substream_id = breakout.substream_id
          AND breakout_viewer.user_id = ?
          AND breakout_viewer.authority_generation = breakout.authority_generation
        WHERE directory.archived_at IS NULL
          AND directory.system_kind IS NULL
          AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: true })}
          AND breakout.archived_at IS NULL
          AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
          AND breakout_viewer.is_participant = 1
          AND ${waitingForReaderSql("breakout", "breakout_viewer")}`,
      viewer.userId,
      viewer.userId,
      viewer.userId,
    ).one().count;
    return mains + breakouts;
  }

  /** Viewer-specific live Breakout totals, grouped under the Channels they list. */
  breakoutAttentionCounts(viewer: Viewer, workstreamIds: readonly string[]): Map<string, number> {
    const userId = viewer.userId;
    const result = new Map<string, number>();
    if (!this.breakoutsReady()) return result;
    for (const ids of boundParameterChunks([...new Set(workstreamIds)])) {
      if (ids.length === 0) continue;
      const rows = this.storage.sql.exec<{
        workstream_id: string;
        count: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT breakout.workstream_id, COUNT(*) AS count
           FROM breakouts breakout
           JOIN channels directory
             ON directory.workstream_id = breakout.workstream_id
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?
            AND viewer.authority_generation = directory.authority_generation
           LEFT JOIN breakout_viewers breakout_viewer
             ON breakout_viewer.workstream_id = breakout.workstream_id
            AND breakout_viewer.substream_id = breakout.substream_id
            AND breakout_viewer.user_id = ?
            AND breakout_viewer.authority_generation = breakout.authority_generation
          WHERE breakout.workstream_id IN (${ids.map(() => "?").join(", ")})
            AND directory.archived_at IS NULL
            AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: true })}
            AND breakout.archived_at IS NULL
            AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
            AND ${liveForViewerSql("breakout", "breakout_viewer")}
          GROUP BY breakout.workstream_id`,
        userId,
        userId,
        ...ids,
        userId,
      ).toArray();
      for (const row of rows) result.set(row.workstream_id, row.count);
    }
    return result;
  }

  /**
   * The Channels this person reaches only through a breakout: they may list
   * one of its breakouts, and cannot see the Channel itself.
   *
   * Candidates for the conversation-scoped directory, beside the scope grant
   * directory's, and never admission: each is re-asked of its own work stream,
   * which decides every conversation it releases. A Channel whose Main this
   * person can already open is left out: its own entry needs no candidate.
   *
   * Reads `breakout_viewers` by user, which has no index for it. The
   * table holds one row per breakout member, so the scan is the cheaper choice
   * until an Organization's breakouts say otherwise.
   */
  channelsReachedOnlyThroughBreakouts(viewer: Viewer): string[] {
    const userId = viewer.userId;
    if (!this.breakoutsReady()) return [];
    return this.storage.sql.exec<{ workstream_id: string }>(
      `SELECT DISTINCT breakout.workstream_id
         FROM breakout_viewers breakout_viewer
         JOIN breakouts breakout
           ON breakout.workstream_id = breakout_viewer.workstream_id
          AND breakout.substream_id = breakout_viewer.substream_id
          AND breakout.authority_generation = breakout_viewer.authority_generation
         JOIN channels directory
           ON directory.workstream_id = breakout.workstream_id
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?1
          AND viewer.authority_generation = directory.authority_generation
        WHERE breakout_viewer.user_id = ?1
          AND breakout_viewer.listable = 1
          AND breakout.archived_at IS NULL
          AND directory.archived_at IS NULL
          -- A missing viewer row makes the predicate NULL, and NOT NULL is
          -- NULL: "IS NOT 1" is what reads that as "cannot see the Channel".
          AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)} IS NOT 1
        ORDER BY breakout.workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
  }

  /**
   * Every active Space each of these Channels sits in, as this viewer may see
   * them.
   *
   * One fan-in read rather than one per row: a directory page is up to 250
   * Channels and each may be in several Spaces, and asking per row would put
   * 250 statements behind one sidebar paint. It lives here rather than beside
   * its caller because it is a Space read, and every Space read goes through
   * {@link WorkspaceSpaceStorage.ready} — this one used to be the hole, reading
   * the Space tables straight out of the sidebar payload.
   *
   * Shaped for the viewer, because the ids ride a *Channel* that several people
   * can read: a Channel in somebody's personal Space would otherwise put that
   * Space's id, and its count, on every reader's row — the existence of a
   * private Space and how many Channels are in it, to people who cannot see it.
   */
  spaceIdsByChannel(viewer: Viewer, workstreamIds: readonly string[]): Map<string, string[]> {
    const byWorkstream = new Map<string, string[]>();
    if (!this.ready()) return byWorkstream;
    const listed = this.spaceListing(viewer);
    for (const chunk of boundParameterChunks(workstreamIds)) {
      for (const row of this.storage.sql.exec<{
        workstream_id: string;
        space_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT membership.workstream_id, membership.space_id
           FROM space_channel_memberships membership
           JOIN spaces space ON space.space_id = membership.space_id
           LEFT JOIN space_viewers viewer
             ON viewer.space_id = space.space_id
            AND viewer.user_id = ? AND viewer.is_participant = 1
          WHERE membership.state = 'active' AND space.archived_at IS NULL
            AND ${listed.sql}
            AND membership.workstream_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY membership.workstream_id, (space.scope <> 'workspace'), membership.space_id`,
        viewer.userId,
        ...listed.binds,
        ...chunk,
      ).toArray()) {
        const existing = byWorkstream.get(row.workstream_id);
        if (existing) existing.push(row.space_id);
        else byWorkstream.set(row.workstream_id, [row.space_id]);
      }
    }
    return byWorkstream;
  }

  /**
   * Each placement these threads have had in a Channel this viewer may list,
   * with the ordinal the placement took (migration 98), whether or not it is
   * still active. The Activity tab clears a thread's start by a read of the
   * Channel past it, and a cleared start has to stay cleared when the thread
   * later moves out. A placement made again takes a fresh, higher ordinal on
   * the same row, which is the one way a start cleared through that Channel
   * reads unread again until the Channel is read past it.
   */
  placementOrdinals(
    viewer: Viewer,
    workstreamIds: readonly string[],
  ): Map<string, Array<{ channelId: string; ordinal: number }>> {
    const placements = new Map<string, Array<{ channelId: string; ordinal: number }>>();
    if (!this.ready() || !this.readsReady()) return placements;
    const listed = this.spaceListing(viewer);
    for (const chunk of boundParameterChunks(workstreamIds)) {
      for (const row of this.storage.sql.exec<{
        workstream_id: string;
        space_id: string;
        attention_ordinal: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT membership.workstream_id, membership.space_id, membership.attention_ordinal
           FROM space_channel_memberships membership
           JOIN spaces space ON space.space_id = membership.space_id
           LEFT JOIN space_viewers viewer
             ON viewer.space_id = space.space_id
            AND viewer.user_id = ? AND viewer.is_participant = 1
          WHERE membership.attention_ordinal IS NOT NULL
            AND ${listed.sql}
            AND membership.workstream_id IN (${chunk.map(() => "?").join(", ")})`,
        viewer.userId,
        ...listed.binds,
        ...chunk,
      ).toArray()) {
        const placement = { channelId: row.space_id, ordinal: Number(row.attention_ordinal) };
        const existing = placements.get(row.workstream_id);
        if (existing) existing.push(placement);
        else placements.set(row.workstream_id, [placement]);
      }
    }
    return placements;
  }

  /** The active Spaces a Channel is in, as this viewer may see them. */
  channelSpaceIds(viewer: Viewer, workstreamId: string): string[] {
    return this.spaceIdsByChannel(viewer, [workstreamId]).get(workstreamId) ?? [];
  }

  /**
   * The colour a thread and its Breakouts carry: that of its canonical
   * Channel, as that Channel's summary draws it. `null` when it sits in no
   * active Channel. See `channel-color-sync.ts`.
   */
  channelColor(workstreamId: string): SpaceColorKey | null {
    const spaceId = this.canonicalChannelSpaceId(workstreamId);
    if (spaceId === null) return null;
    const row = this.storage.sql.exec<{ appearance_json: string | null } & Record<string, SqlStorageValue>>(
      "SELECT appearance_json FROM spaces WHERE space_id = ?", spaceId,
    ).toArray()[0];
    return row ? spaceColorKey(row.appearance_json) : null;
  }

  /** Stable placement used by links minted without a currently selected Space. */
  canonicalChannelSpaceId(workstreamId: string): string | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT membership.space_id
         FROM space_channel_memberships membership
         JOIN spaces space ON space.space_id = membership.space_id
        WHERE membership.workstream_id = ?
          AND membership.state = 'active'
          AND space.archived_at IS NULL
        ORDER BY (space.scope <> 'workspace'), membership.space_id
        LIMIT 1`,
      workstreamId,
    ).toArray()[0]?.space_id ?? null;
  }

  /**
   * Space marks for Channels whose canonical grant owner has admitted a guest.
   *
   * The caller supplies only Channels already re-read from their hosted parents.
   * This read therefore exposes the Space's presentation and containment edge,
   * even when the guest is not a Space participant — for an Organization-wide
   * Space only. A private Space is named to its participants alone, and a guest
   * who is one already lists it by the ordinary rule. The candidate Channel is
   * the associative permission; no roster, defaults, lifecycle or writes leave.
   */
  sharedNavigationSpaces(workstreamIds: readonly string[]): SharedNavigationSpace[] {
    if (!this.ready() || workstreamIds.length === 0) return [];
    const spaces = new Map<string, {
      createdAt: number;
      space: Omit<SharedNavigationSpace, "workstreamIds">;
      workstreamIds: string[];
    }>();
    for (const chunk of boundParameterChunks([...new Set(workstreamIds)])) {
      for (const row of this.storage.sql.exec<{
        space_id: string;
        title: string;
        appearance_json: string | null;
        scope: "personal" | "workspace";
        system_role: "general" | null;
        created_at: number;
        workstream_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT space.space_id, space.title, space.appearance_json, space.scope, space.system_role, space.created_at,
                membership.workstream_id
           FROM space_channel_memberships membership
           JOIN spaces space ON space.space_id = membership.space_id
           WHERE membership.state = 'active' AND space.archived_at IS NULL
            AND space.scope = 'workspace'
            AND membership.workstream_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY space.created_at, space.space_id, membership.workstream_id`,
        ...chunk,
      ).toArray()) {
        const appearance = row.appearance_json
          ? JSON.parse(row.appearance_json) as { icon?: unknown; color?: unknown }
          : null;
        const icon = typeof appearance?.icon === "string" ? appearance.icon : null;
        const existing = spaces.get(row.space_id);
        if (existing) {
          if (!existing.workstreamIds.includes(row.workstream_id)) existing.workstreamIds.push(row.workstream_id);
          continue;
        }
        spaces.set(row.space_id, {
          createdAt: row.created_at,
          space: SharedNavigationSpaceSchema.omit({ workstreamIds: true }).parse({
            id: row.space_id,
            name: row.title,
            iconKey: icon && SPACE_ICON_KEY_SET.has(icon) ? icon : SPACE_ICON_FALLBACK,
            colorKey: spaceColorKey(row.appearance_json),
            scope: row.scope,
            systemRole: row.system_role,
          }),
          workstreamIds: [row.workstream_id],
        });
      }
    }
    return [...spaces.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.space.id.localeCompare(right.space.id))
      .map(({ space, workstreamIds: ids }) => SharedNavigationSpaceSchema.parse({
        ...space,
        workstreamIds: ids.sort(),
      }));
  }

  /**
   * Move a Channel between two Spaces in one transaction: the target placement
   * and the source's retirement commit together or not at all. A Space grants
   * no reader, so nothing about the Channel moves with it.
   *
   * `moved: false` is the one case left for the caller's add-then-remove path:
   * a target somebody else already staged as `joining` before migration 94.
   */
  moveMembership(request: WorkspaceSpaceMembershipMoveRequest, now = Date.now()): WorkspaceSpaceMembershipMoveOutcome {
    return this.storage.transactionSync((): WorkspaceSpaceMembershipMoveOutcome => {
      const plan = this.planMove(request);
      if (plan.kind === "refused") {
        return { ok: false, code: plan.code, unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      if (plan.kind === "staged") return { ok: true, moved: false };
      this.stageMoveTarget(request, plan, now);
      this.switchMoveMemberships({
        ...request,
        sourceMembershipGeneration: plan.sourceMembershipGeneration,
        targetMembershipGeneration: plan.targetMembershipGeneration,
      }, plan.existingTarget?.state === "active" ? "active" : "joining", now);
      const source = this.authoritativeSpace(request.sourceSpaceId, request.userId);
      const target = this.authoritativeSpace(request.targetSpaceId, request.userId);
      if (source === false || target === false) throw new Error("space_move_summary_missing");
      return { ok: true, moved: true, source, target };
    });
  }

  /** The fences a move runs at, or why it cannot run here. */
  private planMove(request: WorkspaceSpaceMembershipMoveRequest): MovePlan {
    if (!this.canEdit(request.userId, request.sourceSpaceId)
      || !this.canEdit(request.userId, request.targetSpaceId, true)) {
      return { kind: "refused", code: "space_not_found" };
    }
    const sourceMembership = this.storage.sql.exec<{
      generation: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT generation FROM space_channel_memberships
        WHERE space_id = ? AND workstream_id = ? AND state = 'active'`,
      request.sourceSpaceId,
      request.workstreamId,
    ).toArray()[0];
    if (!sourceMembership) return { kind: "refused", code: "space_not_found" };
    const existingTarget = this.storage.sql.exec<{
      state: string;
      generation: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT state, generation FROM space_channel_memberships
        WHERE space_id = ? AND workstream_id = ?`,
      request.targetSpaceId,
      request.workstreamId,
    ).toArray()[0] ?? null;
    if (existingTarget?.state === "joining") return { kind: "staged" };
    return {
      kind: "move",
      existingTarget,
      sourceMembershipGeneration: sourceMembership.generation,
      targetMembershipGeneration: existingTarget?.state === "active"
        ? existingTarget.generation
        : (existingTarget?.generation ?? 0) + 1,
    };
  }

  /** Write the target placement as `joining` unless it is already active. */
  private stageMoveTarget(
    request: WorkspaceSpaceMembershipMoveRequest,
    plan: Extract<MovePlan, { kind: "move" }>,
    now: number,
  ): void {
    const existingTarget = plan.existingTarget;
    if (existingTarget) {
      if (existingTarget.state !== "active") {
        this.storage.sql.exec(
          `UPDATE space_channel_memberships
              SET state = 'joining', generation = ?, joined_at = ?, updated_at = ?, removed_at = NULL
            WHERE space_id = ? AND workstream_id = ?`,
          plan.targetMembershipGeneration,
          now,
          now,
          request.targetSpaceId,
          request.workstreamId,
        );
      }
    } else {
      this.storage.sql.exec(
        `INSERT INTO space_channel_memberships
           (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
         VALUES (?, ?, 'joining', 1, ?, ?, NULL)`,
        request.targetSpaceId,
        request.workstreamId,
        now,
        now,
      );
    }
    this.advanceWaterline(now);
  }

  /**
   * Finish a `move` intent staged before migration 94, in the caller's
   * transaction: switch the memberships if they are still at its fences, else
   * cancel what it staged.
   */
  private resumeStagedMove(move: MoveMembershipFences & { operationId: string }, now: number): "moved" | "superseded" {
    const membership = (spaceId: string) => this.storage.sql.exec<{
      state: string;
      generation: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT state, generation FROM space_channel_memberships
        WHERE space_id = ? AND workstream_id = ?`,
      spaceId,
      move.workstreamId,
    ).toArray()[0];
    const sourceMembership = membership(move.sourceSpaceId);
    const targetMembership = membership(move.targetSpaceId);
    if (sourceMembership?.state !== "active"
      || sourceMembership.generation !== move.sourceMembershipGeneration
      || !targetMembership
      || !["joining", "active"].includes(targetMembership.state)
      || targetMembership.generation !== move.targetMembershipGeneration) {
      this.cancelMembershipMoveRows(move, now);
      return "superseded";
    }
    this.switchMoveMemberships(move, targetMembership.state, now);
    this.settleIntent(move.operationId, "membership_moved", true, now);
    return "moved";
  }

  /**
   * Publish the target placement and retire the source one. A target that was
   * `joining` is a new member and inherits the target's defaults; the source's
   * undelivered defaults, its arrangement and its pins go with it.
   */
  private switchMoveMemberships(
    request: MoveMembershipFences,
    targetState: string,
    now: number,
  ): void {
    this.storage.sql.exec(
      `UPDATE space_channel_memberships
          SET state = 'active', updated_at = ?, removed_at = NULL
        WHERE space_id = ? AND workstream_id = ? AND generation = ?`,
      now,
      request.targetSpaceId,
      request.workstreamId,
      request.targetMembershipGeneration,
    );
    if (targetState !== "active") {
      this.stampPlacements(request.targetSpaceId, [request.workstreamId], request.userId, now);
    }
    this.storage.sql.exec(
      `UPDATE space_channel_memberships
          SET state = 'removed', generation = generation + 1, updated_at = ?, removed_at = ?
        WHERE space_id = ? AND workstream_id = ? AND state = 'active' AND generation = ?`,
      now,
      now,
      request.sourceSpaceId,
      request.workstreamId,
      request.sourceMembershipGeneration,
    );
    if (targetState === "joining") {
      const targets: WorkspaceSpaceDefaultTarget[] = this.storage.sql.exec<{
        kind: SpaceDefaultKind;
        target_id: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT kind, target_id, generation FROM space_defaults
          WHERE space_id = ? AND state = 'active' ORDER BY kind, target_id`,
        request.targetSpaceId,
      ).toArray().map((row) => ({
        spaceId: asSpaceId(request.targetSpaceId),
        kind: row.kind,
        targetId: row.target_id,
        defaultGeneration: row.generation,
        workstreamId: asWorkstreamId(request.workstreamId),
        membershipGeneration: request.targetMembershipGeneration,
      }));
      for (const target of targets) this.insertDefaultTarget(target, now);
      this.stageDefaultPublications(targets, request.userId, now);
    }
    this.storage.sql.exec(
      `UPDATE space_default_targets SET state = 'terminal', updated_at = ?,
           last_error_code = 'space_membership_removed'
         WHERE space_id = ? AND workstream_id = ? AND state = 'pending'`,
      now,
      request.sourceSpaceId,
      request.workstreamId,
    );
    this.storage.sql.exec(
      `DELETE FROM workspace_container_order
        WHERE container_kind = 'space' AND container_id = ? AND item_id = ?`,
      request.sourceSpaceId,
      request.workstreamId,
    );
    this.storage.sql.exec(
      `DELETE FROM workspace_workstream_pins WHERE space_id = ? AND workstream_id = ?`,
      request.sourceSpaceId,
      request.workstreamId,
    );
    this.storage.sql.exec(
      `UPDATE workspace_directory_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
      now,
    );
    this.advanceWaterline(now);
  }

  private cancelMembershipMoveRows(
    request: MoveMembershipFences & { operationId: string },
    now: number,
  ): void {
    this.storage.sql.exec(
      `UPDATE space_channel_memberships
          SET state = 'removed', updated_at = ?, removed_at = ?
        WHERE space_id = ? AND workstream_id = ? AND state = 'joining' AND generation = ?`,
      now,
      now,
      request.targetSpaceId,
      request.workstreamId,
      request.targetMembershipGeneration,
    );
    this.cancelIntent(request.operationId, now);
    this.advanceWaterline(now);
  }

  prepareMembership(
    request: WorkspaceSpaceMembershipRequest,
    now = Date.now(),
  ): WorkspaceSpaceMembershipPlanResult {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId, true)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const existing = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ?`,
        request.spaceId,
        request.workstreamId,
      ).toArray()[0];
      if (existing?.state === "active") {
        const space = this.space(request.spaceId, member(request.userId));
        if (space === false) {
          return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
        }
        return { ok: true, space, membershipGeneration: existing.generation };
      }
      const membershipGeneration = (existing?.generation ?? 0) + 1;
      if (existing) {
        this.storage.sql.exec(
          `UPDATE space_channel_memberships
              SET state = 'joining', generation = ?, joined_at = ?, updated_at = ?, removed_at = NULL
            WHERE space_id = ? AND workstream_id = ?`,
          membershipGeneration,
          now,
          now,
          request.spaceId,
          request.workstreamId,
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO space_channel_memberships
             (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
           VALUES (?, ?, 'joining', 1, ?, ?, NULL)`,
          request.spaceId,
          request.workstreamId,
          now,
          now,
        );
      }
      this.advanceWaterline(now);
      const space = this.space(request.spaceId, member(request.userId));
      if (space === false) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      return { ok: true, space, membershipGeneration };
    });
  }

  /**
   * Activate a staged membership, refusing one whose Space moved underneath it.
   *
   * Both fences are re-read here rather than trusted from the plan: the
   * generation says this is the same staging, and the revision says the Space
   * is the same Space the audience was applied from. A membership finalized
   * against a Space that has since been narrowed would publish a placement
   * whose access was granted from an audience that no longer exists.
   */
  finalizeMembership(request: WorkspaceSpaceMembershipSettleRequest, now = Date.now()): SpaceSummary | "conflict" | false {
    return this.storage.transactionSync(() => {
      const space = this.storage.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
        "SELECT revision FROM spaces WHERE space_id = ? AND archived_at IS NULL",
        request.spaceId,
      ).toArray()[0];
      if (!space) return false;
      if (space.revision !== request.spaceRevision) return "conflict";
      // Read before the update so an idempotent re-add of a row that is
      // already active does not take a fresh ordinal: only a placement does.
      const wasActive = this.storage.sql.exec<{ state: string } & Record<string, SqlStorageValue>>(
        `SELECT state FROM space_channel_memberships WHERE space_id = ? AND workstream_id = ?`,
        request.spaceId,
        request.workstreamId,
      ).toArray()[0]?.state === "active";
      // `active` as well as `joining`, at the *same* generation. `prepareMembership`
      // answers an already-active row with its current generation rather than
      // staging a new one, so re-adding a Channel a Space already holds arrives
      // here with nothing to activate — and settling that as "not found" made
      // an idempotent add answer 404. A different generation is still refused:
      // that is a staging this settlement is not about.
      const activated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE space_channel_memberships
            SET state = 'active', updated_at = ?, removed_at = NULL
          WHERE space_id = ? AND workstream_id = ?
            AND state IN ('joining', 'active') AND generation = ?
          RETURNING space_id`,
        now,
        request.spaceId,
        request.workstreamId,
        request.membershipGeneration,
      ).toArray()[0];
      if (!activated) return false;
      if (!wasActive) this.stampPlacements(request.spaceId, [request.workstreamId], request.userId, now);
      this.advanceWaterline(now);
      return this.space(request.spaceId, member(request.userId));
    });
  }

  cancelMembership(request: WorkspaceSpaceMembershipSettleRequest, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      const cancelled = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE space_channel_memberships
            SET state = 'removed', updated_at = ?, removed_at = ?
          WHERE space_id = ? AND workstream_id = ? AND state = 'joining' AND generation = ?
          RETURNING space_id`,
        now,
        now,
        request.spaceId,
        request.workstreamId,
        request.membershipGeneration,
      ).toArray()[0];
      if (!cancelled) return false;
      this.advanceWaterline(now);
      return this.space(request.spaceId, member(request.userId));
    });
  }

  /**
   * Put a Channel that is being created straight into a Space, active.
   *
   * No `joining` stage and no intent: the caller writes the membership, the
   * Channel's parent and its memberships in one transaction, so there is no
   * moment between a staged row and its settlement for a crash to land in and
   * nothing for an alarm to finish. A row that is already active (a retry of
   * the same create) keeps its generation; a removed one is reactivated at the
   * next generation, as `prepareMembership` would stage it.
   */
  enterMembershipAtBirth(
    request: WorkspaceSpaceMembershipRequest,
    now = Date.now(),
  ): { ok: true; space: SpaceSummary; membershipGeneration: number } | { ok: false } {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId, true)) return { ok: false as const };
      const existing = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ?`,
        request.spaceId,
        request.workstreamId,
      ).toArray()[0];
      const membershipGeneration = existing?.state === "active"
        ? existing.generation
        : (existing?.generation ?? 0) + 1;
      if (existing?.state !== "active") {
        this.storage.sql.exec(
          `INSERT INTO space_channel_memberships
             (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
           VALUES (?, ?, 'active', ?, ?, ?, NULL)
           ON CONFLICT (space_id, workstream_id) DO UPDATE
             SET state = 'active', generation = excluded.generation, joined_at = excluded.joined_at,
                 updated_at = excluded.updated_at, removed_at = NULL`,
          request.spaceId,
          request.workstreamId,
          membershipGeneration,
          now,
          now,
        );
        this.stampPlacements(request.spaceId, [request.workstreamId], request.userId, now);
        // The Channel composer posts by starting a thread. Only the first
        // placement subscribes its author; a replay must not undo a leave.
        this.seat(request.spaceId, request.userId, now);
        this.advanceWaterline(now);
      }
      const space = this.space(request.spaceId, member(request.userId));
      if (space === false) return { ok: false as const };
      return { ok: true as const, space, membershipGeneration };
    });
  }

  /** Stage a membership removal, refusing one that would leave no home. */
  prepareMembershipRemoval(
    request: WorkspaceSpaceMembershipRemovalRequest,
    now = Date.now(),
  ): WorkspaceSpaceMembershipPlanResult {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const membership = this.storage.sql.exec<{
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ? AND state IN ('joining', 'active')`,
        request.spaceId,
        request.workstreamId,
      ).toArray()[0];
      if (!membership) return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      const remainingSpaceIds = this.otherActiveSpaceIds(request.workstreamId, request.spaceId);
      if (remainingSpaceIds.length === 0) {
        return { ok: false, code: "space_membership_final", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const generation = membership.generation + 1;
      this.storage.sql.exec(
        `UPDATE space_channel_memberships
            SET state = 'removing', generation = ?, updated_at = ?
          WHERE space_id = ? AND workstream_id = ?`,
        generation,
        now,
        request.spaceId,
        request.workstreamId,
      );
      this.advanceWaterline(now);
      const space = this.space(request.spaceId, member(request.userId));
      if (space === false) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      return { ok: true, space, membershipGeneration: generation };
    });
  }

  /**
   * A Channel leaves a Space, and its place in that Space's list leaves with
   * it.
   *
   * Everybody's place, not the remover's: the placement is the Organization's
   * fact, so once it is gone nobody's sidebar is drawing that row under this
   * Space and the position is about nothing. A write to the container would
   * filter it out — `spaceIdsByChannel` only answers with active memberships —
   * but only for the next person who happens to arrange that Space, so without
   * this the row outlives the thing it describes for everybody who does not.
   *
   * Archive is deliberately not this. An archived Channel keeps its membership
   * and its position, because `directory()` is what hides it and a restore is
   * meant to bring the arrangement back with the row.
   */
  finalizeMembershipRemoval(
    request: { userId: string; spaceId: string; workstreamId: string; membershipGeneration: number },
    now = Date.now(),
  ): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      const removed = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE space_channel_memberships
            SET state = 'removed', updated_at = ?, removed_at = ?
          WHERE space_id = ? AND workstream_id = ? AND state = 'removing' AND generation = ?
          RETURNING space_id`,
        now,
        now,
        request.spaceId,
        request.workstreamId,
        request.membershipGeneration,
      ).toArray()[0];
      if (!removed) return false;
      // A pending default delivery for a Channel that has left is stale work.
      // Invalidating it here rather than letting the consumer discover it keeps
      // the Queue from carrying messages whose only outcome is an ack.
      this.storage.sql.exec(
        `UPDATE space_default_targets SET state = 'terminal', updated_at = ?,
             last_error_code = 'space_membership_removed'
           WHERE space_id = ? AND workstream_id = ? AND state = 'pending'`,
        now,
        request.spaceId,
        request.workstreamId,
      );
      this.storage.sql.exec(
        `DELETE FROM workspace_container_order
          WHERE container_kind = 'space' AND container_id = ? AND item_id = ?`,
        request.spaceId,
        request.workstreamId,
      );
      // A pin belongs to this placement, not to the Channel in every Space.
      // Once the placement is gone, retaining it would let a later re-add
      // resurrect a choice the person made about an earlier membership.
      this.storage.sql.exec(
        `DELETE FROM workspace_workstream_pins
          WHERE space_id = ? AND workstream_id = ?`,
        request.spaceId,
        request.workstreamId,
      );
      // The same transaction removes the placement and every viewer's pin for
      // it. Directory pages carry both `spaceIds` and `spacePins`, so their
      // waterline must move with that deletion rather than after it.
      this.storage.sql.exec(
        `UPDATE workspace_directory_state
            SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
        now,
      );
      this.advanceWaterline(now);
      return this.space(request.spaceId, member(request.userId));
    });
  }

  /**
   * Put a Channel in a Space: stage and activate the membership and stage the
   * Space's defaults for it, in one transaction. A Space grants no reader, so
   * nothing outside this object takes part.
   */
  addMembership(request: WorkspaceSpaceMembershipRequest, now = Date.now()): WorkspaceSpaceMutationResult {
    return this.storage.transactionSync((): WorkspaceSpaceMutationResult => {
      const prepared = this.prepareMembership(request, now);
      if (!prepared.ok) return prepared;
      const space = this.finalizeMembership({
        ...request, spaceRevision: prepared.space.revision, membershipGeneration: prepared.membershipGeneration,
      }, now);
      if (space === false || space === "conflict") {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      this.stageDefaultsForMember(request.spaceId, request.workstreamId, prepared.membershipGeneration, request.userId, now);
      return { ok: true, space };
    });
  }

  /** Take a Channel out of a Space that is not its last, in one transaction. */
  removeMembership(request: WorkspaceSpaceMembershipRemovalRequest, now = Date.now()): WorkspaceSpaceMutationResult {
    return this.storage.transactionSync((): WorkspaceSpaceMutationResult => {
      const prepared = this.prepareMembershipRemoval(request, now);
      if (!prepared.ok) return prepared;
      const space = this.finalizeMembershipRemoval({ ...request, membershipGeneration: prepared.membershipGeneration }, now);
      if (space === false) return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      return { ok: true, space };
    });
  }

  /** Archive a Channel and durably request normal archival of its exclusive threads. */
  archive(
    userId: string,
    spaceId: string,
    now = Date.now(),
  ): { result: WorkspaceSpaceMutationResult; threadArchives: WorkspaceSpaceIntentClaim[] } {
    try {
      return this.storage.transactionSync(() => {
        const exclusive = this.liveMemberWorkstreamIds(spaceId)
          .filter((workstreamId) => this.otherActiveSpaceIds(workstreamId, spaceId).length === 0);
        const prepared = this.prepareArchive(userId, spaceId, now, exclusive);
        if (!prepared.ok) throw new ArchiveRefused(prepared);
        const space = this.finalizeArchive(userId, spaceId, now);
        if (space === "protected") {
          throw new ArchiveRefused({ ok: false, code: "space_protected", unreachableUserIds: [], blockedWorkstreamIds: [] });
        }
        if (space === false) {
          throw new ArchiveRefused({ ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] });
        }
        const threadArchives = exclusive.map((workstreamId): WorkspaceSpaceIntentClaim => ({
          operationId: uuidV7(), kind: "archive", spaceId, workstreamId,
          spaceRevision: space.revision, membershipGeneration: null,
          sourceSpaceId: null, sourceSpaceRevision: null, sourceMembershipGeneration: null,
          cursor: null, requestedByUserId: userId,
        }));
        for (const intent of threadArchives) {
          this.recordIntent({ ...intent, deliveryGeneration: null, notBefore: now }, now);
        }
        return { result: { ok: true, space }, threadArchives };
      });
    } catch (error) {
      if (error instanceof ArchiveRefused) return { result: error.result, threadArchives: [] };
      throw error;
    }
  }

  /**
   * Finish one intent staged before migration 94, in one transaction.
   *
   * Nothing stages these any more: each operation is one transaction. An
   * intent still unsettled at the deploy is finished here from its own
   * fences, with no Channel involved, because a Space grants no reader.
   * Answers what changed so the caller can publish it.
   */
  resumeLegacyIntent(intent: WorkspaceSpaceIntentClaim, now = Date.now()): {
    spaceIds: string[]; workstreamId: string | null; membershipChanged: boolean; spaceChanged: boolean;
  } {
    return this.storage.transactionSync(() => {
      const none = { spaceIds: [intent.spaceId], workstreamId: intent.workstreamId, membershipChanged: false, spaceChanged: false };
      const settle = (receipt: string) => this.settleIntent(intent.operationId, receipt, true, now);
      const workstreamId = intent.workstreamId;
      const generation = intent.membershipGeneration;
      switch (intent.kind) {
        case "add": {
          if (!workstreamId || !generation) { settle("add_fences_missing"); return none; }
          const activated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
            `UPDATE space_channel_memberships SET state = 'active', updated_at = ?, removed_at = NULL
              WHERE space_id = ? AND workstream_id = ? AND state = 'joining' AND generation = ?
              RETURNING space_id`,
            now, intent.spaceId, workstreamId, generation,
          ).toArray()[0];
          if (activated) {
            this.stampPlacements(intent.spaceId, [workstreamId], intent.requestedByUserId, now);
            this.stageDefaultsForMember(intent.spaceId, workstreamId, generation, intent.requestedByUserId, now);
            this.advanceWaterline(now);
          }
          settle(activated ? "membership_finalized" : "add_superseded");
          return { ...none, membershipChanged: Boolean(activated) };
        }
        case "remove": {
          if (!workstreamId || !generation) { settle("remove_fences_missing"); return none; }
          const removed = this.finalizeMembershipRemoval({
            userId: intent.requestedByUserId, spaceId: intent.spaceId, workstreamId, membershipGeneration: generation,
          }, now);
          settle(removed === false ? "remove_superseded" : "membership_removed");
          return { ...none, membershipChanged: removed !== false };
        }
        case "move": {
          if (!workstreamId || !generation || !intent.sourceSpaceId || !intent.sourceMembershipGeneration) {
            this.cancelIntent(intent.operationId, now);
            return none;
          }
          const moved = this.resumeStagedMove({
            operationId: intent.operationId, userId: intent.requestedByUserId,
            sourceSpaceId: intent.sourceSpaceId, targetSpaceId: intent.spaceId, workstreamId,
            sourceMembershipGeneration: intent.sourceMembershipGeneration, targetMembershipGeneration: generation,
          }, now);
          return { ...none, spaceIds: [intent.sourceSpaceId, intent.spaceId], membershipChanged: moved === "moved" };
        }
        case "archive": {
          const archived = this.finalizeArchive(intent.requestedByUserId, intent.spaceId, now);
          if (archived === false || archived === "protected") {
            // The archive cannot finish as its requester, so it is taken back:
            // the memberships it staged return rather than sit `removing`
            // under a Space that is still live.
            const returned = this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
              `UPDATE space_channel_memberships SET state = 'active', generation = generation + 1, updated_at = ?
                WHERE space_id = ? AND state = 'removing'
                RETURNING workstream_id`,
              now, intent.spaceId,
            ).toArray().map((row) => row.workstream_id);
            this.stampPlacements(intent.spaceId, returned, intent.requestedByUserId, now);
            this.advanceWaterline(now);
            settle("archive_abandoned");
          } else {
            settle("archived");
          }
          return { ...none, spaceChanged: true };
        }
        case "restore":
        case "audience":
          settle(`${intent.kind}_settled`);
          return none;
      }
    });
  }

  /**
   * Refuse only an archive that would leave a live Channel with no home.
   *
   * An exclusive thread may leave the active hierarchy only when its normal
   * archive is staged by the caller. Do not silently archive a thread the
   * requester cannot read. Already-archived threads never block the operation.
   */
  prepareArchive(userId: string, spaceId: string, now = Date.now(), archiveThreadIds: readonly string[] = []): WorkspaceSpaceMutationResult {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(userId, spaceId, true)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const row = this.storage.sql.exec<{
        system_role: string | null;
        scope: SpaceScope;
        revision: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT system_role, scope, revision FROM spaces WHERE space_id = ?",
        spaceId,
      ).one();
      // General is every thread's fallback home; a Personal Channel is its
      // owner's for as long as they are a member.
      if (row.system_role === "general" || row.scope === "individual") {
        return { ok: false, code: "space_protected", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const stranded: string[] = [];
      for (const workstreamId of this.liveMemberWorkstreamIds(spaceId)) {
        const remainingSpaceIds = this.otherActiveSpaceIds(workstreamId, spaceId);
        if (remainingSpaceIds.length === 0) {
          stranded.push(workstreamId);
        }
      }
      const listable = new Set(this.listableChannelIds(member(userId), stranded));
      const archiving = new Set(archiveThreadIds);
      const blocked = stranded.filter((id) => !archiving.has(id) || !listable.has(id));
      if (blocked.length > 0) {
        return {
          ok: false,
          code: "space_membership_final",
          unreachableUserIds: [],
          blockedWorkstreamIds: blocked.filter((id) => listable.has(id)).map(asWorkstreamId),
        };
      }
      // Keep the archived threads' placement in their archived Channel. This
      // also prevents the orphan-repair backstop from moving them into General
      // while their canonical archive effects are still on the Queue.
      this.storage.sql.exec(
        `UPDATE space_channel_memberships SET state = 'removing', generation = generation + 1, updated_at = ?
          WHERE space_id = ? AND state = 'active'
            AND workstream_id NOT IN (SELECT value FROM json_each(?))`,
        now,
        spaceId,
        JSON.stringify(archiveThreadIds),
      );
      this.advanceWaterline(now);
      const space = this.space(spaceId, member(userId));
      if (space === false) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      return { ok: true, space };
    });
  }

  /** Commit the archive the preflight staged. General is refused here too. */
  finalizeArchive(userId: string, spaceId: string, now = Date.now()): SpaceSummary | "protected" | false {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(userId, spaceId, true)) return false;
      const protectedRow = this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS one FROM spaces
          WHERE space_id = ? AND system_role = 'general'`,
        spaceId,
      ).toArray()[0];
      if (protectedRow) return "protected";
      const archived = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE spaces
            SET archived_at = ?, revision = revision + 1, updated_at = ?
          WHERE space_id = ? AND archived_at IS NULL RETURNING space_id`,
        now,
        now,
        spaceId,
      ).toArray()[0];
      if (!archived) return false;
      this.storage.sql.exec(
        `UPDATE space_default_targets SET state = 'terminal', updated_at = ?,
             last_error_code = 'space_archived'
           WHERE space_id = ? AND state = 'pending'`,
        now,
        spaceId,
      );
      this.advanceWaterline(now);
      return this.space(spaceId, member(userId));
    });
  }

  /**
   * Restore an archived Space and put its memberships back.
   *
   * A membership that was `removing` when the archive committed returns as
   * `active`: the archive is what took it out, so the restore is what puts it
   * back. One that was already `removed` stays removed — that was a decision
   * about the Channel rather than about the Space.
   */
  restore(workspaceId: string, userId: string, spaceId: string, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      // One this person may change: a viewer who reaches it only through a
      // Channel in it is told it exists so the Channel has somewhere to be
      // drawn, and restoring it is not theirs. Deliberately *not* also "an
      // archived Space" — `canEdit` does not read `archived_at`, and it must
      // not here, because a restore is one of the two operations that reach an
      // archived Space on purpose. `AND archived_at IS NOT NULL` on the
      // statement below is what refuses a Space that is not archived, and its
      // empty `RETURNING` is the refusal.
      if (!this.canEdit(userId, spaceId)) return false;
      const restored = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE spaces
            SET archived_at = NULL, revision = revision + 1, updated_at = ?
          WHERE space_id = ? AND archived_at IS NOT NULL RETURNING space_id`,
        now,
        spaceId,
      ).toArray()[0];
      if (!restored) return false;
      const returned = this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE space_channel_memberships
            SET state = 'active', generation = generation + 1, updated_at = ?
          WHERE space_id = ? AND state = 'removing'
          RETURNING workstream_id`,
        now,
        spaceId,
      ).toArray().map((row) => row.workstream_id);
      this.stampPlacements(spaceId, returned, userId, now);
      this.appendOrder(workspaceId, userId, spaceId, now);
      this.advanceWaterline(now);
      return this.space(spaceId, member(userId));
    });
  }

  /**
   * Register a default and stage one fenced delivery target per active member.
   *
   * `kind` is carried through every row and every message, so a Sidekick
   * recommendation and a resource travel the same staging, the same outbox and
   * the same currency recheck.
   */
  addDefault(request: WorkspaceSpaceDefaultRequest, now = Date.now()): WorkspaceSpaceDefaultResult {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId, true)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const existing = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM space_defaults
          WHERE space_id = ? AND kind = ? AND target_id = ?`,
        request.spaceId,
        request.kind,
        request.targetId,
      ).toArray()[0];
      if (existing?.state === "active") {
        const targets = this.pendingTargets(request, existing.generation);
        this.stageDefaultPublications(targets, request.userId, now);
        const space = this.space(request.spaceId, member(request.userId));
        if (space === false) {
          return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
        }
        return { ok: true, space, targets };
      }
      const defaultGeneration = (existing?.generation ?? 0) + 1;
      if (existing) {
        this.storage.sql.exec(
          `UPDATE space_defaults SET state = 'active', generation = ?, updated_at = ?, removed_at = NULL
            WHERE space_id = ? AND kind = ? AND target_id = ?`,
          defaultGeneration,
          now,
          request.spaceId,
          request.kind,
          request.targetId,
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO space_defaults
             (space_id, kind, target_id, state, generation, created_at, updated_at, removed_at)
           VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)`,
          request.spaceId,
          request.kind,
          request.targetId,
          now,
          now,
        );
      }
      const targets: WorkspaceSpaceDefaultTarget[] = this.storage.sql.exec<{
        workstream_id: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT workstream_id, generation FROM space_channel_memberships
          WHERE space_id = ? AND state = 'active' ORDER BY workstream_id`,
        request.spaceId,
      ).toArray().map((membership) => ({
        spaceId: request.spaceId,
        kind: request.kind,
        targetId: request.targetId,
        defaultGeneration,
        workstreamId: asWorkstreamId(membership.workstream_id),
        membershipGeneration: membership.generation,
      }));
      for (const target of targets) this.insertDefaultTarget(target, now);
      this.stageDefaultPublications(targets, request.userId, now);
      this.advanceWaterline(now);
      const space = this.space(request.spaceId, member(request.userId));
      if (space === false) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      return { ok: true, space, targets };
    });
  }

  removeDefault(request: WorkspaceSpaceDefaultRequest, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId, true)) return false;
      const removed = this.storage.sql.exec<{ target_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE space_defaults
            SET state = 'removed', generation = generation + 1, updated_at = ?, removed_at = ?
          WHERE space_id = ? AND kind = ? AND target_id = ? AND state = 'active'
          RETURNING target_id`,
        now,
        now,
        request.spaceId,
        request.kind,
        request.targetId,
      ).toArray()[0];
      if (!removed) return false;
      this.advanceWaterline(now);
      return this.space(request.spaceId, member(request.userId));
    });
  }

  /** Stage delivery of every current default to one Channel that just joined. */
  stageDefaultsForMember(
    spaceId: string,
    workstreamId: string,
    membershipGeneration: number,
    requestedByUserId: string,
    now = Date.now(),
  ): WorkspaceSpaceDefaultTarget[] {
    return this.storage.transactionSync(() => {
      const targets: WorkspaceSpaceDefaultTarget[] = this.storage.sql.exec<{
        kind: SpaceDefaultKind;
        target_id: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT kind, target_id, generation FROM space_defaults
          WHERE space_id = ? AND state = 'active' ORDER BY kind, target_id`,
        spaceId,
      ).toArray().map((row) => ({
        spaceId: asSpaceId(spaceId),
        kind: row.kind,
        targetId: row.target_id,
        defaultGeneration: row.generation,
        workstreamId: asWorkstreamId(workstreamId),
        membershipGeneration,
      }));
      for (const target of targets) this.insertDefaultTarget(target, now);
      this.stageDefaultPublications(targets, requestedByUserId, now);
      return targets;
    });
  }

  defaultTargetCurrent(target: WorkspaceSpaceDefaultTarget): boolean {
    if (!this.ready()) return false;
    return this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS one
         FROM space_default_targets target
         JOIN space_defaults registered
           ON registered.space_id = target.space_id AND registered.kind = target.kind
          AND registered.target_id = target.target_id
         JOIN space_channel_memberships membership
           ON membership.space_id = target.space_id AND membership.workstream_id = target.workstream_id
         JOIN spaces space ON space.space_id = target.space_id
        WHERE target.space_id = ? AND target.kind = ? AND target.target_id = ?
          AND target.default_generation = ? AND target.workstream_id = ?
          AND target.membership_generation = ?
          AND target.state = 'pending' AND registered.state = 'active'
          AND space.archived_at IS NULL
          AND registered.generation = target.default_generation
          AND membership.state = 'active' AND membership.generation = target.membership_generation`,
      target.spaceId,
      target.kind,
      target.targetId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    ).toArray().length === 1;
  }

  completeDefaultTarget(target: WorkspaceSpaceDefaultTarget, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      if (!this.defaultTargetCurrent(target)) return false;
      return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE space_default_targets
            SET state = 'applied', attempts = attempts + 1, updated_at = ?, applied_at = ?
          WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
            AND workstream_id = ? AND membership_generation = ? AND state = 'pending'
          RETURNING workstream_id`,
        now,
        now,
        target.spaceId,
        target.kind,
        target.targetId,
        target.defaultGeneration,
        target.workstreamId,
        target.membershipGeneration,
      ).toArray().length === 1;
    });
  }

  recordDefaultTargetFailure(
    target: WorkspaceSpaceDefaultTarget,
    errorCode: string,
    now = Date.now(),
  ): boolean {
    if (!this.ready()) return false;
    return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE space_default_targets
          SET attempts = attempts + 1, updated_at = ?, last_error_code = ?
        WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
          AND workstream_id = ? AND membership_generation = ? AND state = 'pending'
        RETURNING workstream_id`,
      now,
      errorCode,
      target.spaceId,
      target.kind,
      target.targetId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    ).toArray().length === 1;
  }

  failDefaultTarget(
    target: WorkspaceSpaceDefaultTarget,
    errorCode: string,
    now = Date.now(),
  ): boolean {
    if (!this.ready()) return false;
    return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE space_default_targets
          SET state = 'terminal', attempts = attempts + 1, updated_at = ?, last_error_code = ?
        WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
          AND workstream_id = ? AND membership_generation = ? AND state = 'pending'
        RETURNING workstream_id`,
      now,
      errorCode,
      target.spaceId,
      target.kind,
      target.targetId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    ).toArray().length === 1;
  }

  nextDefaultPublicationDueAt(): number | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ due_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MIN(publication.next_attempt_at) AS due_at
         FROM space_default_publications publication
         JOIN space_default_targets target
           ON target.space_id = publication.space_id AND target.kind = publication.kind
          AND target.target_id = publication.target_id
          AND target.default_generation = publication.default_generation
          AND target.workstream_id = publication.workstream_id
          AND target.membership_generation = publication.membership_generation
        WHERE publication.state = 'pending' AND target.state = 'pending'`,
    ).one().due_at;
  }

  claimDefaultPublications(
    now: number,
    retryAt: (attempt: number) => number,
  ): WorkspaceSpaceDefaultPublication[] {
    return this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<{
        space_id: string;
        kind: SpaceDefaultKind;
        target_id: string;
        default_generation: number;
        workstream_id: string;
        membership_generation: number;
        requested_by_user_id: string;
        attempts: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT publication.space_id, publication.kind, publication.target_id,
                publication.default_generation, publication.workstream_id,
                publication.membership_generation, publication.requested_by_user_id,
                publication.attempts
           FROM space_default_publications publication
           JOIN space_default_targets target
             ON target.space_id = publication.space_id AND target.kind = publication.kind
            AND target.target_id = publication.target_id
            AND target.default_generation = publication.default_generation
            AND target.workstream_id = publication.workstream_id
            AND target.membership_generation = publication.membership_generation
          WHERE publication.state = 'pending' AND publication.next_attempt_at <= ?
            AND target.state = 'pending'
          ORDER BY publication.next_attempt_at, publication.space_id, publication.kind,
                   publication.target_id, publication.workstream_id
          LIMIT 100`,
        now,
      ).toArray();
      for (const row of rows) {
        const attempt = row.attempts + 1;
        this.storage.sql.exec(
          `UPDATE space_default_publications
              SET attempts = ?, next_attempt_at = ?, updated_at = ?
            WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
              AND workstream_id = ? AND membership_generation = ? AND state = 'pending'`,
          attempt,
          retryAt(attempt),
          now,
          row.space_id,
          row.kind,
          row.target_id,
          row.default_generation,
          row.workstream_id,
          row.membership_generation,
        );
      }
      return rows.map((row) => ({
        spaceId: asSpaceId(row.space_id),
        kind: row.kind,
        targetId: row.target_id,
        defaultGeneration: row.default_generation,
        workstreamId: asWorkstreamId(row.workstream_id),
        membershipGeneration: row.membership_generation,
        requestedByUserId: row.requested_by_user_id,
        attempts: row.attempts + 1,
      }));
    });
  }

  acceptDefaultPublications(
    publications: readonly WorkspaceSpaceDefaultPublication[],
    now = Date.now(),
  ): void {
    this.storage.transactionSync(() => {
      for (const publication of publications) {
        this.storage.sql.exec(
          `UPDATE space_default_publications
              SET state = 'accepted', updated_at = ?, accepted_at = ?
            WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
              AND workstream_id = ? AND membership_generation = ? AND state = 'pending'`,
          now,
          now,
          publication.spaceId,
          publication.kind,
          publication.targetId,
          publication.defaultGeneration,
          publication.workstreamId,
          publication.membershipGeneration,
        );
      }
    });
  }

  /**
   * Record one staged cross-object operation.
   *
   * The receipt is what makes a resumed operation converge rather than repeat:
   * a service step writes what it has finished, and the alarm republishes only
   * what is still `pending`.
   */
  recordIntent(input: {
    operationId: string;
    kind: WorkspaceSpaceIntentClaim["kind"];
    spaceId: string;
    workstreamId: string | null;
    spaceRevision: number;
    membershipGeneration: number | null;
    sourceSpaceId?: string | null;
    sourceSpaceRevision?: number | null;
    sourceMembershipGeneration?: number | null;
    deliveryGeneration: number | null;
    requestedByUserId: string;
    notBefore: number;
  }, now = Date.now()): void {
    this.storage.sql.exec(
      `INSERT INTO space_intents (
         operation_id, kind, space_id, workstream_id, space_revision,
         membership_generation, source_space_id, source_space_revision,
         source_membership_generation, delivery_generation, state, receipts_json,
         requested_by_user_id, not_before, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', ?, ?, 0, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      input.operationId,
      input.kind,
      input.spaceId,
      input.workstreamId,
      input.spaceRevision,
      input.membershipGeneration,
      input.sourceSpaceId ?? null,
      input.sourceSpaceRevision ?? null,
      input.sourceMembershipGeneration ?? null,
      input.deliveryGeneration,
      input.requestedByUserId,
      input.notBefore,
      now,
      now,
    );
  }

  /**
   * Append one receipt and, when the operation is done, settle it.
   *
   * `cursor` is how a paged fan-out records where it got to: the id its last
   * finished page stopped at, or `null` once the walk is exhausted. Passing
   * `undefined` leaves the column where it is, which is what every
   * single-Channel operation does — it has no walk to continue.
   *
   * One receipt per *page* rather than per Channel, which is the other half of
   * the cursor's job. `receipts_json` is rewritten whole by `json_insert`, so a
   * receipt per member Channel cost O(N²) bytes in one row and one extra hop
   * into this single-threaded object per Channel — and none of it was what a
   * resume read, because a resume reads the cursor.
   */
  settleIntent(
    operationId: string,
    receipt: string,
    settled: boolean,
    now = Date.now(),
    cursor?: string | null,
  ): void {
    if (!this.ready()) return;
    this.storage.sql.exec(
      `UPDATE space_intents
          SET receipts_json = json_insert(receipts_json, '$[#]', ?),
              state = CASE WHEN ? = 1 THEN 'settled' ELSE 'applied' END,
              cursor = CASE WHEN ? = 1 THEN ? ELSE cursor END,
              updated_at = ?
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      receipt,
      settled ? 1 : 0,
      cursor === undefined ? 0 : 1,
      cursor ?? null,
      now,
      operationId,
    );
  }

  /**
   * Record why a resume did not finish, on the row rather than only in a log.
   *
   * The sibling `space_default_targets.last_error_code`, applied to the other
   * half of the same machinery. The alarm republishes an unsettled intent
   * forever, so without this the only account of *why* one is still unsettled
   * is a log line — and the row that outlives it says the operation did not
   * finish without saying what stopped it.
   *
   * It does not settle anything and does not touch the retry gate. A resume
   * that fails is still a resume to retry. Two conditions end an intent
   * without success instead, and neither is retryable because no later
   * delivery gives the requester back what they lost: they are no longer an
   * active member of the Organization, which the resume records by name, and
   * they no longer have an editable reach into the Space, which the resume
   * settles by name, writing the code here first, because this statement only
   * matches a row that is still unsettled.
   */
  recordIntentFailure(operationId: string, errorCode: string, now = Date.now()): void {
    if (!this.ready()) return;
    this.storage.sql.exec(
      `UPDATE space_intents SET last_error_code = ?, updated_at = ?
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      errorCode,
      now,
      operationId,
    );
  }

  /**
   * Make an unsettled intent due at `notBefore` with a fresh retry gate: a
   * walk that just finished a page has more to do and did not fail.
   */
  rescheduleIntent(operationId: string, notBefore: number, now = Date.now()): void {
    this.storage.sql.exec(
      `UPDATE space_intents SET not_before = ?, attempts = 0, updated_at = ?
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      notBefore,
      now,
      operationId,
    );
  }

  cancelIntent(operationId: string, now = Date.now()): void {
    this.storage.sql.exec(
      `UPDATE space_intents SET state = 'cancelled', updated_at = ?
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      now,
      operationId,
    );
  }

  /**
   * One intent as it stands now, or `null` once it is settled or cancelled.
   *
   * What a resume acts on: the cursor and fences on the row, which a page of
   * the walk may have advanced since a message naming the intent was sent.
   */
  unsettledIntent(operationId: string): WorkspaceSpaceIntentClaim | null {
    if (!this.ready()) return null;
    const row = this.storage.sql.exec<{
      operation_id: string;
      kind: WorkspaceSpaceIntentClaim["kind"];
      space_id: string;
      workstream_id: string | null;
      space_revision: number;
      membership_generation: number | null;
      source_space_id: string | null;
      source_space_revision: number | null;
      source_membership_generation: number | null;
      cursor: string | null;
      requested_by_user_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT operation_id, kind, space_id, workstream_id, space_revision,
              membership_generation, source_space_id, source_space_revision,
              source_membership_generation, cursor, requested_by_user_id
         FROM space_intents
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      operationId,
    ).toArray()[0];
    return row === undefined ? null : {
      operationId: row.operation_id,
      kind: row.kind,
      spaceId: row.space_id,
      workstreamId: row.workstream_id,
      spaceRevision: row.space_revision,
      membershipGeneration: row.membership_generation,
      sourceSpaceId: row.source_space_id,
      sourceSpaceRevision: row.source_space_revision,
      sourceMembershipGeneration: row.source_membership_generation,
      cursor: row.cursor,
      requestedByUserId: row.requested_by_user_id,
    };
  }

  /** The Space's current revision, whoever is asking; `null` when there is no such Space. */
  spaceRevision(spaceId: string): number | null {
    return this.storage.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
      "SELECT revision FROM spaces WHERE space_id = ?",
      spaceId,
    ).toArray()[0]?.revision ?? null;
  }

  nextIntentResumeDueAt(): number | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ due_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MIN(not_before) AS due_at FROM space_intents
        WHERE state IN ('pending', 'applied')`,
    ).one().due_at;
  }

  claimIntentResumes(
    now: number,
    retryAt: (attempt: number) => number,
  ): WorkspaceSpaceIntentClaim[] {
    return this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<{
        operation_id: string;
        kind: WorkspaceSpaceIntentClaim["kind"];
        space_id: string;
        workstream_id: string | null;
        space_revision: number;
        membership_generation: number | null;
        source_space_id: string | null;
        source_space_revision: number | null;
        source_membership_generation: number | null;
        cursor: string | null;
        requested_by_user_id: string;
        attempts: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT operation_id, kind, space_id, workstream_id, space_revision,
                membership_generation, source_space_id, source_space_revision,
                source_membership_generation, cursor, requested_by_user_id, attempts
           FROM space_intents
          WHERE state IN ('pending', 'applied') AND not_before <= ?
          ORDER BY not_before, operation_id LIMIT 100`,
        now,
      ).toArray();
      for (const row of rows) {
        this.storage.sql.exec(
          `UPDATE space_intents SET attempts = ?, not_before = ?, updated_at = ?
            WHERE operation_id = ?`,
          row.attempts + 1,
          retryAt(row.attempts + 1),
          now,
          row.operation_id,
        );
      }
      return rows.map((row) => ({
        operationId: row.operation_id,
        kind: row.kind,
        spaceId: row.space_id,
        workstreamId: row.workstream_id,
        spaceRevision: row.space_revision,
        membershipGeneration: row.membership_generation,
        sourceSpaceId: row.source_space_id,
        sourceSpaceRevision: row.source_space_revision,
        sourceMembershipGeneration: row.source_membership_generation,
        cursor: row.cursor,
        requestedByUserId: row.requested_by_user_id,
      }));
    });
  }

  /**
   * Every Space this Organization has, archived ones included.
   *
   * For the retirement walk, which has to close an object rather than list a
   * product surface: a Space created before 2026-09-26 still holds a hidden
   * main conversation (a `SubstreamAgent`), and a graph that skipped it would
   * report the Organization closed with that object still open. Guarded like every
   * other Space read, so an Organization the cutover never reached enumerates
   * nothing rather than aborting the tombstone on a missing table.
   */
  allSpaceIds(): string[] {
    if (!this.ready()) return [];
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      "SELECT space_id FROM spaces ORDER BY space_id",
    ).toArray().map((row) => row.space_id);
  }

  /** The Organization's one General Space, or nothing if it has none yet. */
  generalSpaceId(): string | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      "SELECT space_id FROM spaces WHERE system_role = 'general'",
    ).toArray()[0]?.space_id ?? null;
  }

  /**
   * The oldest live Organization-wide Space named `name`, compared as
   * `spaceMatchName` reads both, or nothing. Compared in TypeScript because the
   * separators it drops and SQLite's ASCII-only `NOCASE` are both out of reach
   * of an index.
   */
  organizationSpaceNamed(name: string): { spaceId: string; createdByUserId: string | null } | null {
    if (!this.ready()) return null;
    const wanted = spaceMatchName(name);
    if (wanted === "") return null;
    const rows = this.storage.sql.exec<
      { space_id: string; title: string; created_by_user_id: string | null } & Record<string, SqlStorageValue>
    >(
      `SELECT space_id, title, created_by_user_id FROM spaces
        WHERE scope = 'workspace' AND archived_at IS NULL
        ORDER BY created_at, space_id`,
    );
    for (const row of rows) {
      if (spaceMatchName(row.title) === wanted) return { spaceId: row.space_id, createdByUserId: row.created_by_user_id };
    }
    return null;
  }

  /**
   * Take the next piece of cutover work, and move its retry gate out of reach.
   *
   * One claim at a time, because the phases are ordered and a page's cursor is
   * only known once the page before it has been reported. The gate advances
   * before the caller sends anything, exactly as a default target's does: a
   * rejected Queue batch, or a delivered page whose consumer died, is
   * republished on a later alarm rather than immediately or never.
   *
   * `phase` is the pass that is *running*, so it maps to a message kind
   * directly. `pending` and `general` both publish `general` because
   * `ensureGeneral` is idempotent — the second one through is answered with the
   * Space the first one made. `preflight` and `memberships` are the two passes
   * that walk the directory, so they are the two that carry a cursor.
   */
  claimBootstrap(now: number, retryAt: (attempt: number) => number): SpaceBootstrapClaim | null {
    if (!this.ready()) return null;
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{
        phase: WorkspaceSpaceBootstrapStatus["phase"];
        cursor: string | null;
        not_before: number;
        attempts: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT phase, cursor, not_before, attempts FROM space_bootstrap WHERE id = 1",
      ).one();
      if (row.phase === "complete" || row.not_before > now) return null;
      this.storage.sql.exec(
        `UPDATE space_bootstrap SET attempts = ?, not_before = ?, updated_at = ?,
                started_at = CASE WHEN started_at = 0 THEN ? ELSE started_at END
          WHERE id = 1`,
        row.attempts + 1,
        retryAt(row.attempts + 1),
        now,
        now,
      );
      return {
        kind: row.phase === "memberships" ? "memberships"
          : row.phase === "preflight" ? "preflight"
          : row.phase === "finalize" ? "finalize" : "general",
        cursor: row.phase === "memberships" || row.phase === "preflight" ? row.cursor : null,
      };
    });
  }

  /**
   * Record that a pass moved, and make the next piece of work due now.
   *
   * Clearing the gate is the difference between a cutover that walks an
   * Organization at the speed of its Queue and one that waits out a retry
   * interval per page. A pass that did *not* move leaves the gate where the
   * claim put it.
   */
  advanceBootstrap(
    phase: WorkspaceSpaceBootstrapStatus["phase"],
    cursor: string | null,
    now = Date.now(),
  ): void {
    if (!this.ready()) return;
    this.storage.sql.exec(
      `UPDATE space_bootstrap
          SET phase = ?, cursor = ?, not_before = 0, attempts = 0, updated_at = ?
        WHERE id = 1 AND phase <> 'complete'`,
      phase,
      cursor,
      now,
    );
  }

  nextBootstrapDueAt(): number | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{
      phase: string;
      not_before: number;
    } & Record<string, SqlStorageValue>>(
      "SELECT phase, not_before FROM space_bootstrap WHERE id = 1",
    ).toArray().filter((row) => row.phase !== "complete").map((row) => row.not_before)[0] ?? null;
  }

  /**
   * One page of the Channels the cutover has to place.
   *
   * Active and archived alike, and every one of them with `system_kind IS NULL`:
   * a system Channel's audience and home belong to the subsystem that writes
   * it, and the hierarchy invariant is about the Channels a person can see.
   * Ordered by id so the cursor is the id it stopped at and an interrupted
   * pass resumes from a row rather than from an offset.
   *
   * Everything a placement needs travels with the row, because the alternative
   * is a cross-object read per Channel to learn what the Organization already
   * knows: the scope its directory projection carries, whether some Space
   * already holds it, and the participants who could act on it.
   */
  bootstrapPage(cursor: string | null, limit = SPACE_BOOTSTRAP_PAGE_SIZE): SpaceBootstrapPage {
    if (!this.ready()) return { items: [], nextCursor: null };
    const rows = this.storage.sql.exec<{
      workstream_id: string;
      scope: "personal" | "workspace";
      placed: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT directory.workstream_id, directory.scope,
              EXISTS (SELECT 1 FROM space_channel_memberships membership
                       WHERE membership.workstream_id = directory.workstream_id
                         AND membership.state = 'active') AS placed
         FROM channels directory
        WHERE directory.system_kind IS NULL
          AND (? IS NULL OR directory.workstream_id > ?)
        ORDER BY directory.workstream_id
        LIMIT ?`,
      cursor,
      cursor ?? "",
      limit + 1,
    ).toArray();
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const participants = this.channelParticipants(rows.map((row) => row.workstream_id));
    return {
      items: rows.map((row) => ({
        workstreamId: row.workstream_id,
        scope: row.scope,
        placed: row.placed === 1,
        participantUserIds: participants.get(row.workstream_id) ?? [],
      })),
      nextCursor: hasMore ? (rows.at(-1)?.workstream_id ?? null) : null,
    };
  }

  /**
   * Record a Channel the cutover could not place, and why.
   *
   * A blocker is not a failure to retry: an immutable content fence is never
   * bypassed and never deleted, so the Organization stays where it is until
   * somebody remediates the Channel. Keyed by Channel so a redelivery of the
   * same page reports the same blocker once.
   */
  recordBootstrapBlocked(
    blocked: ReadonlyArray<{ workstreamId: string; code: string }>,
    now = Date.now(),
  ): void {
    if (!this.ready() || blocked.length === 0) return;
    this.storage.transactionSync(() => {
      const current = this.blockedEntries();
      const merged = new Map(current.map((entry) => [entry.workstreamId, entry]));
      for (const entry of blocked) merged.set(entry.workstreamId, entry);
      this.storage.sql.exec(
        "UPDATE space_bootstrap SET blocked_json = ?, updated_at = ? WHERE id = 1",
        JSON.stringify([...merged.values()]),
        now,
      );
    });
  }

  /** Stop reporting a Channel as blocked once the cutover has placed it. */
  clearBootstrapBlocked(workstreamIds: readonly string[], now = Date.now()): void {
    if (!this.ready() || workstreamIds.length === 0) return;
    this.storage.transactionSync(() => {
      const cleared = new Set(workstreamIds);
      const remaining = this.blockedEntries().filter((entry) => !cleared.has(entry.workstreamId));
      this.storage.sql.exec(
        "UPDATE space_bootstrap SET blocked_json = ?, updated_at = ? WHERE id = 1",
        JSON.stringify(remaining),
        now,
      );
    });
  }

  /**
   * Whether any Channel is still outside every Space.
   *
   * The cutover's gate is this rather than a count of receipts. A Channel
   * created while the cutover is running is placed by the creation path and has
   * no receipt, so counting receipts against the directory would leave an
   * Organization permanently one short of complete.
   *
   * `workstreamIds` narrows the same question to a named set, which is what the
   * directory handoff's guard asks about the Channels one batch projected that
   * the Organization was already holding. One SQL text deliberately: the close
   * and the guard have to mean the same thing by "outside every Space", and a
   * second query written to the same description is how the two come to
   * disagree about a system Channel or a `joining` membership. `json_each`
   * rather than a placeholder list so that stays one text whatever the caller
   * passes.
   */
  unplacedChannelExists(workstreamIds?: readonly string[]): boolean {
    if (!this.ready()) return false;
    if (workstreamIds !== undefined && workstreamIds.length === 0) return false;
    const scoped = workstreamIds !== undefined;
    return this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS one FROM channels directory
        WHERE directory.system_kind IS NULL
          AND NOT EXISTS (SELECT 1 FROM space_channel_memberships membership
                           WHERE membership.workstream_id = directory.workstream_id
                             AND membership.state = 'active')
          ${scoped ? "AND directory.workstream_id IN (SELECT value FROM json_each(?))" : ""}
        LIMIT 1`,
      ...(scoped ? [JSON.stringify([...workstreamIds])] : []),
    ).toArray().length > 0;
  }

  /** The Channels the cutover is stuck on, with the reason each one is stuck. */
  blockedEntries(): SpaceBootstrapBlocked[] {
    if (!this.ready()) return [];
    const parsed = JSON.parse(this.storage.sql.exec<{ blocked_json: string } & Record<string, SqlStorageValue>>(
      "SELECT blocked_json FROM space_bootstrap WHERE id = 1",
    ).one().blocked_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => (
      entry !== null && typeof entry === "object"
        && typeof (entry as { workstreamId?: unknown }).workstreamId === "string"
        && typeof (entry as { code?: unknown }).code === "string"
        ? [entry as SpaceBootstrapBlocked]
        : []
    ));
  }

  /**
   * Send the cutover back to the pass that re-walks the directory, keeping the
   * retry gate the claim advanced.
   *
   * The one way an Organization that has stopped moving starts again, and it
   * has two callers because it answers two questions with the same state. A
   * `finalize` that refused has to re-walk or the refusal is permanent: the
   * only writer that takes a Channel off `blocked_json` is a pass that reaches
   * it, so an Organization whose fence somebody has since remediated would
   * otherwise sit at `finalize` forever. And a `complete` Organization that
   * turns out to hold a Channel in no Space has to re-walk for the same reason
   * — the hierarchy invariant is false of it until something places that
   * Channel.
   *
   * **The gate is kept rather than cleared**, which is the difference between
   * re-walking on `scheduledAlarmRetryDelay`'s interval and spinning: a
   * permanently blocked Organization re-walks about once a minute, and each
   * page of that walk clears the gate itself because a page is progress.
   *
   * Idempotent: an Organization already on the walk is left where it is. The
   * answer is whether this took one out of `complete`, which is the only
   * transition a client can see — `spacesReady` goes false, so the directory
   * waterline advances and the caller republishes.
   */
  reopenBootstrap(now = Date.now()): boolean {
    if (!this.ready()) return false;
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{
        phase: WorkspaceSpaceBootstrapStatus["phase"];
        general_space_id: string | null;
      } & Record<string, SqlStorageValue>>(
        "SELECT phase, general_space_id FROM space_bootstrap WHERE id = 1",
      ).one();
      // Without General there is nothing to place a Channel in, so the walk
      // starts one step earlier. `ensureGeneral` is idempotent either way.
      const next = row.general_space_id === null ? "general" : "preflight";
      if (row.phase === next) return false;
      this.storage.sql.exec(
        `UPDATE space_bootstrap
            SET phase = ?, cursor = NULL, completed_at = NULL, updated_at = ?
          WHERE id = 1`,
        next,
        now,
      );
      if (row.phase !== "complete") return false;
      this.advanceWaterline(now);
      return true;
    });
  }

  /** Close the cutover, or say why it cannot close yet. */
  completeBootstrap(now = Date.now()): "complete" | "blocked" | "unplaced" {
    if (this.blockedEntries().length > 0) return "blocked";
    if (this.unplacedChannelExists()) return "unplaced";
    this.storage.sql.exec(
      `UPDATE space_bootstrap
          SET phase = 'complete', cursor = NULL, not_before = 0, attempts = 0,
              completed_at = ?, updated_at = ?
        WHERE id = 1`,
      now,
      now,
    );
    this.advanceWaterline(now);
    return "complete";
  }

  private channelParticipants(workstreamIds: readonly string[]): Map<string, string[]> {
    const byChannel = new Map<string, string[]>();
    for (const chunk of boundParameterChunks(workstreamIds)) {
      for (const row of this.storage.sql.exec<{
        workstream_id: string;
        user_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT workstream_id, user_id FROM channel_viewers
          WHERE is_participant = 1 AND workstream_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY workstream_id, user_id`,
        ...chunk,
      ).toArray()) {
        const existing = byChannel.get(row.workstream_id);
        if (existing) existing.push(row.user_id);
        else byChannel.set(row.workstream_id, [row.user_id]);
      }
    }
    return byChannel;
  }

  bootstrapStatus(): WorkspaceSpaceBootstrapStatus {
    // An object that has not reached migration 63 has not started its cutover
    // either, which is what `pending` says — and `ready: false` is what keeps a
    // client on the Organization-opening state rather than showing a hierarchy
    // that does not exist yet.
    if (!this.ready()) {
      return { phase: "pending", generalSpaceId: null, blockedWorkstreamIds: [], ready: false };
    }
    const row = this.storage.sql.exec<{
      phase: WorkspaceSpaceBootstrapStatus["phase"];
      general_space_id: string | null;
    } & Record<string, SqlStorageValue>>(
      "SELECT phase, general_space_id FROM space_bootstrap WHERE id = 1",
    ).one();
    return {
      phase: row.phase,
      generalSpaceId: row.general_space_id === null ? null : asSpaceId(row.general_space_id),
      // Ids only. The reason each one is stuck is on the row for whoever reads
      // it with SQL; what a client needs is whether the hierarchy is renderable.
      blockedWorkstreamIds: this.blockedEntries().map((entry) => asWorkstreamId(entry.workstreamId)),
      ready: row.phase === "complete",
    };
  }

  /** Record that General exists and that the cutover may move past that phase. */
  noteGeneralSpace(spaceId: string, now = Date.now()): void {
    this.storage.sql.exec(
      `UPDATE space_bootstrap
          SET general_space_id = ?,
              phase = CASE WHEN phase = 'pending' THEN 'general' ELSE phase END,
              started_at = CASE WHEN started_at = 0 THEN ? ELSE started_at END,
              updated_at = ?
        WHERE id = 1`,
      spaceId,
      now,
      now,
    );
  }

  /**
   * Say whether any of these Channels is in a Space, and advance the waterline
   * when one is.
   *
   * The same shape as `noteMemberArchivalChange` on the Project storage and for
   * the same reason: most directory projections are ordinary activity on a
   * Channel no Space cares about, and republishing both Space directories to
   * every socket on each of those costs far more than the count is worth. The
   * waterline advance is not optional — a Space directory at a waterline a
   * client already holds is dropped as a replay.
   *
   * Named for the directory rather than for the archive because two different
   * moves ask it now: a Channel arriving in or leaving the archive, which
   * changes what its Spaces say about themselves to everybody, and a person's
   * participation in a Channel changing, which changes which Spaces that one
   * person can see at all. The question either one asks is the same.
   */
  noteMemberDirectoryChange(workstreamIds: readonly string[], now = Date.now()): boolean {
    if (!this.ready()) return false;
    return this.storage.transactionSync(() => {
      const holdsMembership = boundParameterChunks(workstreamIds).some((chunk) => (
        this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
          `SELECT 1 AS one FROM space_channel_memberships
            WHERE state = 'active'
              AND workstream_id IN (${chunk.map(() => "?").join(", ")})
            LIMIT 1`,
          ...chunk,
        ).toArray().length > 0
      ));
      if (holdsMembership) this.advanceWaterline(now);
      return holdsMembership;
    });
  }

  private waterline(): number {
    if (!this.ready()) return 0;
    return this.storage.sql.exec<{ waterline: number } & Record<string, SqlStorageValue>>(
      "SELECT waterline FROM workspace_space_state WHERE id = 1",
    ).one().waterline;
  }

  private pendingTargets(
    request: WorkspaceSpaceDefaultRequest,
    defaultGeneration: number,
  ): WorkspaceSpaceDefaultTarget[] {
    return this.storage.sql.exec<{
      workstream_id: string;
      membership_generation: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT workstream_id, membership_generation FROM space_default_targets
        WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
          AND state = 'pending' ORDER BY workstream_id`,
      request.spaceId,
      request.kind,
      request.targetId,
      defaultGeneration,
    ).toArray().map((target) => ({
      spaceId: request.spaceId,
      kind: request.kind,
      targetId: request.targetId,
      defaultGeneration,
      workstreamId: asWorkstreamId(target.workstream_id),
      membershipGeneration: target.membership_generation,
    }));
  }

  private insertDefaultTarget(target: WorkspaceSpaceDefaultTarget, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO space_default_targets
         (space_id, kind, target_id, default_generation, workstream_id,
          membership_generation, state, attempts, created_at, updated_at,
          applied_at, last_error_code)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL)`,
      target.spaceId,
      target.kind,
      target.targetId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
      now,
      now,
    );
  }

  /**
   * Deliver each target, in the caller's transaction where the target lives in
   * this database, and through the activity Queue otherwise.
   *
   * A Sidekick default's target is the member Channel's `parent_sidekicks`
   * row, which is in this object's SQLite whenever the Channel's parent is
   * hosted here, so it is written now rather than sent out and back in. The
   * rest take the Queue: a resource is attached through the Channel's main
   * conversation (a SubstreamAgent), and a Sidekick target whose Channel parent
   * is not hosted yet, is archived, whose Sidekick this Organization's
   * directory does not show as a live workspace Sidekick, or whose requester
   * cannot manage the Channel (or is not known here yet) keeps the canonical
   * path, which checks the Sidekick and the Channel and names what it refused.
   */
  private stageDefaultPublications(
    targets: readonly WorkspaceSpaceDefaultTarget[],
    requestedByUserId: string,
    now: number,
  ): void {
    for (const target of targets) {
      if (target.kind === "sidekick" && this.applySidekickDefaultInPlace(target, requestedByUserId, now)) continue;
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO space_default_publications (
           space_id, kind, target_id, default_generation, workstream_id,
           membership_generation, requested_by_user_id, state, attempts,
           next_attempt_at, created_at, updated_at, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
        target.spaceId,
        target.kind,
        target.targetId,
        target.defaultGeneration,
        target.workstreamId,
        target.membershipGeneration,
        requestedByUserId,
        now,
        now,
        now,
      );
    }
  }

  /**
   * Write one Sidekick default onto its member Channel, if everything it needs
   * is in this database. False leaves the target for the Queue.
   *
   * The requester's management of the Channel is asked here, as the Queue
   * path's `setSidekickRecommendation` asks it. The Space's own write check
   * is not enough: an Organization-wide Space admits any active member, and a
   * default's instructions run in every agent in the Channel, including
   * personal and restricted Channels that member cannot manage. A refusal,
   * or a requester this table has not heard of, is not decided here: it takes
   * the Queue, whose canonical path asks again and records the reason on the
   * target.
   */
  private applySidekickDefaultInPlace(target: WorkspaceSpaceDefaultTarget, requestedByUserId: string, now: number): boolean {
    const eligible = this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS one FROM parent_metadata parent, channels channel, automation_directory sidekick
        WHERE parent.parent_id = ? AND parent.parent_kind = 'workstream'
          AND channel.workstream_id = parent.parent_id AND channel.archived_at IS NULL
          AND sidekick.automation_id = ? AND sidekick.scope = 'workspace' AND sidekick.lifecycle <> 'deleted'`,
      target.workstreamId,
      target.targetId,
    ).toArray().length === 1;
    if (!eligible || !this.canManageChannel?.(target.workstreamId, requestedByUserId)) return false;
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO parent_sidekicks (parent_id, sidekick_id, attached_at) VALUES (?, ?, ?)`,
      target.workstreamId,
      target.targetId,
      now,
    );
    this.storage.sql.exec(
      `UPDATE space_default_targets
          SET state = 'applied', attempts = attempts + 1, updated_at = ?, applied_at = ?
        WHERE space_id = ? AND kind = ? AND target_id = ? AND default_generation = ?
          AND workstream_id = ? AND membership_generation = ? AND state = 'pending'`,
      now,
      now,
      target.spaceId,
      target.kind,
      target.targetId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    );
    this.sidekickDefaultsApplied += 1;
    return true;
  }

  /** The active Spaces a Channel keeps once this one stops reaching it. */
  private otherActiveSpaceIds(workstreamId: string, departingSpaceId: string): string[] {
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT membership.space_id
         FROM space_channel_memberships membership
         JOIN spaces space ON space.space_id = membership.space_id
        WHERE membership.workstream_id = ? AND membership.state = 'active'
          AND membership.space_id <> ? AND space.archived_at IS NULL
        ORDER BY membership.space_id`,
      workstreamId,
      departingSpaceId,
    ).toArray().map((row) => row.space_id);
  }

  /**
   * The subset of these Channels this viewer may already list.
   *
   * A refusal about a Space names Channels, and a Space's membership can hold a
   * Channel this person has no access to. Naming that one would disclose that
   * it exists, and they could not move it either — so the list a refusal
   * carries is what the caller can act on, and the sentence beside it still has
   * to be true when the list comes back empty.
   *
   * A dashboard nudge is addressed with the same answer to the same question:
   * a socket whose viewer cannot list the Channel that moved has no row to
   * re-read, and naming the Space it moved in would disclose the Channel by
   * another door.
   */
  listableChannelIds(viewer: Viewer, workstreamIds: readonly string[]): string[] {
    const listable: string[] = [];
    const listed = this.channelListing(viewer);
    for (const chunk of boundParameterChunks(workstreamIds)) {
      for (const row of this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `SELECT directory.workstream_id
           FROM channels directory
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?
            AND viewer.authority_generation = directory.authority_generation
          WHERE directory.workstream_id IN (${chunk.map(() => "?").join(", ")})
            AND ${listed.sql}
          ORDER BY directory.workstream_id`,
        viewer.userId,
        ...chunk,
        ...listed.binds,
      ).toArray()) listable.push(row.workstream_id);
    }
    return listable;
  }

  /**
   * Active memberships that still count as a live home.
   *
   * Excludes only a Channel the directory already records as archived. A
   * membership whose projection has not landed is treated as live: the
   * directory row is an async projection, and dropping it here would let
   * archive strand a Channel that is still open. `channelCount` inner-joins
   * for display; this guard fails closed.
   */
  private liveMemberWorkstreamIds(spaceId: string): string[] {
    return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `SELECT membership.workstream_id
         FROM space_channel_memberships membership
        WHERE membership.space_id = ? AND membership.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM channels directory
             WHERE directory.workstream_id = membership.workstream_id
               AND directory.archived_at IS NOT NULL
          )
        ORDER BY membership.workstream_id`,
      spaceId,
    ).toArray().map((row) => row.workstream_id);
  }

  private participantUserIds(spaceId: string): string[] {
    return this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
      `SELECT user_id FROM space_viewers
        WHERE space_id = ? AND is_participant = 1 ORDER BY user_id`,
      spaceId,
    ).toArray().map((row) => row.user_id);
  }

  /**
   * Which of these Spaces this viewer may be told about, archived ones
   * included.
   *
   * The archive filter {@link visibleSpaceIds} applies is deliberately absent.
   * This answers "may I name this Space on this person's socket", and a Space
   * being archived is itself one of the events a dashboard holding its page
   * has to hear about — filtering archived Spaces out here would drop exactly
   * that notice.
   */
  visibleSpaceIdsAmong(viewer: Viewer, spaceIds: readonly string[]): string[] {
    if (!this.ready() || spaceIds.length === 0) return [];
    const visible: string[] = [];
    const listed = this.spaceListing(viewer);
    for (const chunk of boundParameterChunks(spaceIds)) {
      for (const row of this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `SELECT space.space_id
           FROM spaces space
           LEFT JOIN space_viewers viewer
             ON viewer.space_id = space.space_id
            AND viewer.user_id = ? AND viewer.is_participant = 1
          WHERE ${listed.sql}
            AND space.space_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY space.space_id`,
        viewer.userId,
        ...listed.binds,
        ...chunk,
      ).toArray()) visible.push(row.space_id);
    }
    return visible;
  }

  /** Active Spaces this viewer may see, in creation order. */
  visibleSpaceIds(viewer: Viewer): string[] {
    if (!this.ready()) return [];
    const listed = this.spaceListing(viewer);
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT space.space_id
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.archived_at IS NULL
          AND ${listed.sql}
        ORDER BY space.created_at, space.space_id`,
      viewer.userId,
      ...listed.binds,
    ).toArray().map((row) => row.space_id);
  }

  /**
   * Why this viewer can see this Space, or `null` when they cannot see it at
   * all.
   *
   * The one predicate every Space authorization decision is derived from — the
   * read below, the edit rule beside it, and the word `WorkspaceDO` refuses a
   * write with. One indexed lookup rather than the two whole-directory scans
   * `canRead` used to intersect.
   *
   * `activeOnly` is for the operations that are about a Space that is *there*:
   * an archive, a membership, a default. A read, a restore and a removal reach
   * an archived Space on purpose.
   */
  reach(viewer: Viewer, spaceId: string, activeOnly = false): SpaceReach | null {
    if (!this.ready()) return null;
    const listed = this.spaceListing(viewer);
    return this.storage.sql.exec<{ reach: SpaceReach } & Record<string, SqlStorageValue>>(
      `SELECT ${spaceReachSql("space", "viewer", viewer.accessClass)} AS reach
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.space_id = ?
          AND (? = 0 OR space.archived_at IS NULL)
          AND ${listed.sql}`,
      viewer.userId,
      spaceId,
      activeOnly ? 1 : 0,
      ...listed.binds,
    ).toArray()[0]?.reach ?? null;
  }

  private canRead(userId: string, spaceId: string): boolean {
    return this.reach(member(userId), spaceId) !== null;
  }

  /**
   * Whether this viewer may *change* this Space: any reach but
   * `through_channel`.
   *
   * The same rule `WorkspaceDO.spaceRefusalCode` renders as
   * `space_access_denied`, kept here as the fence inside the transaction — one
   * predicate, two depths, the way the Channel visibility text is one text in
   * several queries. Somebody who reaches a Space only through a Channel in it
   * has been told the Space's mark and name so the Channel can be drawn under
   * it; every write on it is somebody else's.
   */
  private canEdit(userId: string, spaceId: string, activeOnly = false): boolean {
    // Writes are a member's; a guest is refused before reaching here.
    const reach = this.reach(member(userId), spaceId, activeOnly);
    return reach !== null && editableReach(reach);
  }

  /**
   * Give this person a row for a Space they can now see, at the end of their
   * Organization order.
   *
   * On first visibility rather than on creation, because the order is per
   * person and a Space becomes visible to somebody long after it was made — a
   * personal Space they were added to, an archived one restored. Without a row
   * the Space would not be in {@link WorkspaceSpaceStorage.directory} at all,
   * which is why this runs on the read as well as on every write.
   */
  private appendOrder(workspaceId: string, userId: string, spaceId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_container_order
         (user_id, container_kind, container_id, item_id, position, created_at, updated_at)
       VALUES (?, 'organization', ?, ?,
               COALESCE((SELECT MAX(position) + 1 FROM workspace_container_order
                          WHERE user_id = ? AND container_kind = 'organization'
                            AND container_id = ?), 0), ?, ?)`,
      userId,
      workspaceId,
      spaceId,
      userId,
      workspaceId,
      now,
      now,
    );
  }

  private directory(workspaceId: string, viewer: Viewer): SpaceDirectory {
    const listed = this.spaceListing(viewer);
    const rows = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*, ${spaceReachSql("space", "viewer", viewer.accessClass)} AS reach
         FROM workspace_container_order ordering
         JOIN spaces space ON space.space_id = ordering.item_id
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE ordering.user_id = ? AND ordering.container_kind = 'organization'
          AND ordering.container_id = ? AND space.archived_at IS NULL
          AND ${listed.sql}
        ORDER BY ordering.position, space.space_id`,
      viewer.userId,
      viewer.userId,
      workspaceId,
      ...listed.binds,
    ).toArray();
    const attentionCounts = this.attentionCounts(viewer, rows.map((row) => row.space_id));
    return SpaceDirectorySchema.parse({
      waterline: this.waterline(),
      items: rows.map((row) => this.summary(row, viewer, attentionCounts.get(row.space_id) ?? 0)),
    });
  }

  /**
   * The summary for a Space the statements above just wrote, where "not
   * visible to you" is not an answer.
   *
   * {@link WorkspaceSpaceStorage.space} refuses a Space this viewer may not
   * see, which is the right answer everywhere it can happen. These two callers
   * wrote the directory row and this caller's own participant row in the same
   * transaction, so a refusal here is one of those statements not having
   * landed — thrown in the shape the other broken-invariant guards in this
   * object are thrown, because a Space summary is the one thing it must not
   * invent.
   */
  private writtenSpace(spaceId: string, userId: string): SpaceSummary {
    const space = this.space(spaceId, member(userId));
    if (space === false) throw new Error("workspace_space_unreadable_after_write");
    return space;
  }

  /**
   * One Space as this viewer is answered with it, or `false` when it is not
   * theirs to see.
   *
   * Takes the viewer because the summary now carries one viewer-dependent
   * field, and renders {@link spaceListedSql} because
   * {@link spaceReachSql} is only sound beside it: its `ELSE 'through_channel'`
   * is the label for a row that reached it having passed the filter, so a row
   * selected without the filter is labelled `through_channel` whether or not
   * it is reachable at all. This was the one renderer without it, and the one
   * mutation that can take its own caller's visibility away answers through
   * it — an audience change to `personal` that leaves the actor off the list
   * used to answer them a summary labelled `through_channel`, with an empty
   * participant list and a viewer-scoped count that could be zero, which the
   * contract says such a viewer's count never is.
   *
   * Every other caller ran `canEdit` or `canRead` in this same transaction and
   * changed nothing about who may see the Space, so their `false` is those two
   * predicates disagreeing; each passes it on as its own "no such Space"
   * rather than rendering a row it cannot account for.
   */
  private space(spaceId: string, viewer: Viewer): SpaceSummary | false {
    const listed = this.spaceListing(viewer);
    const row = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*, ${spaceReachSql("space", "viewer", viewer.accessClass)} AS reach
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.space_id = ?
          AND ${listed.sql}`,
      viewer.userId,
      spaceId,
      ...listed.binds,
    ).toArray()[0];
    return row === undefined
      ? false
      : this.summary(row, viewer, this.attentionCount(viewer, row.space_id));
  }

  /**
   * Read the current Space authority for an already-authorized durable intent.
   * Unlike a product read this deliberately does not re-evaluate the actor's
   * mutable reach: the intent row is the authorization and the current roster
   * is what its recovery must converge onto.
   */
  private authoritativeSpace(spaceId: string, userId: string): SpaceSummary | false {
    const row = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*,
              CASE WHEN space.scope = 'workspace' THEN 'organization' ELSE 'participant' END AS reach
         FROM spaces space
        WHERE space.space_id = ? AND space.archived_at IS NULL`,
      spaceId,
    ).toArray()[0];
    return row === undefined
      ? false
      : this.summary(row, member(userId), this.attentionCount(member(userId), row.space_id));
  }

  /**
   * A Space as this viewer sees it.
   *
   * Almost viewer-independent, and the exception is the whole of the
   * disclosure rule. Every field here but three is the Organization's fact
   * about the Space, and the two that never were — which Spaces a person can
   * see at all, and their order — are still decided by the queries that select
   * the rows rather than by this projection.
   *
   * What the reach decides: a `through_channel` viewer has been told a Space's
   * mark, name, audience setting and lifecycle so the Channel they *can* read
   * has somewhere to be drawn. They are told nothing else about it. The
   * participants and the defaults are emptied rather than made optional —
   * empty is a state each of them already has, and a second summary schema
   * would be a second shape every reader has to branch on — and the Channel
   * count is taken over the Channels that viewer can see, which is the
   * disclosure `spaceIdsByChannel` used to keep a personal Space's id off a
   * Channel row to avoid.
   */
  private summary(row: SpaceRow, viewer: Viewer, attentionCount: number): SpaceSummary {
    const appearance = row.appearance_json
      ? JSON.parse(row.appearance_json) as { icon?: unknown; color?: unknown }
      : null;
    const icon = typeof appearance?.icon === "string" ? appearance.icon : null;
    return SpaceSummarySchema.parse({
      id: row.space_id,
      name: row.title,
      // Coerced rather than parsed. The appearance is the Space's own object's,
      // and its icon vocabulary is the Channel's wider one — a key outside the
      // Space picker still has to render as something rather than throw on a
      // read of the whole directory.
      iconKey: icon && SPACE_ICON_KEY_SET.has(icon) ? icon : SPACE_ICON_FALLBACK,
      colorKey: spaceColorKey(row.appearance_json),
      scope: row.scope,
      status: row.archived_at === null ? "active" : "archived",
      systemRole: row.system_role,
      revision: row.revision,
      reach: row.reach,
      participants: row.reach === "through_channel"
        ? []
        : this.participantUserIds(row.space_id).map((participantId) => ({ userId: participantId })),
      channelCount: this.channelCount(row.space_id, viewer, row.reach),
      attentionCount: row.archived_at === null ? attentionCount : 0,
      defaultResourceIds: row.reach === "through_channel" ? [] : this.defaultIds(row.space_id, "resource"),
      defaultSidekickIds: row.reach === "through_channel" ? [] : this.defaultIds(row.space_id, "sidekick"),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  /**
   * Channels a surface can show in this Space: a listable active membership
   * whose Channel is not archived.
   *
   * An inner join on the directory, because `archived_at IS NULL` is true of a
   * missing row as well as of an active Channel: outer-joined, a membership
   * whose projection has not landed — or whose Channel has been deleted —
   * would be counted as an active one.
   *
   * Narrowed to this viewer for a `through_channel` reach and to nobody for
   * the other two, which is two readings of one number on purpose. For a
   * member of the Space it is the Organization's count: it is what keeps an
   * expansion holding no rows from claiming the Space is empty, and being
   * short of it is not proof a page is missing. For somebody who reaches the
   * Space through one Channel the Organization's count is the *size of a
   * participants-only Space*, which is the disclosure the whole of this change
   * is written around not making. Narrowing it also makes the two agree by
   * construction: this predicate is exactly the one
   * `spaceReachedThroughChannelSql` tests for existence, so such a
   * viewer's count is never zero.
   */
  private channelCount(spaceId: string, viewer: Viewer, reach: SpaceReach): number {
    const viewerScoped = reach === "through_channel";
    const listed = this.channelListing(viewer);
    return this.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count
         FROM space_channel_memberships membership
         JOIN channels directory
           ON directory.workstream_id = membership.workstream_id
         ${viewerScoped
           ? `LEFT JOIN channel_viewers viewer
                ON viewer.workstream_id = directory.workstream_id
               AND viewer.user_id = ?
               AND viewer.authority_generation = directory.authority_generation`
           : ""}
        WHERE membership.space_id = ? AND membership.state = 'active'
          AND directory.archived_at IS NULL
          ${viewerScoped ? `AND ${listed.sql}` : ""}`,
      ...(viewerScoped ? [viewer.userId] : []),
      spaceId,
      ...(viewerScoped ? listed.binds : []),
    ).one().count;
  }

  private defaultIds(spaceId: string, kind: SpaceDefaultKind): string[] {
    return this.storage.sql.exec<{ target_id: string } & Record<string, SqlStorageValue>>(
      `SELECT target_id FROM space_defaults
        WHERE space_id = ? AND kind = ? AND state = 'active' ORDER BY target_id`,
      spaceId,
      kind,
    ).toArray().map((row) => row.target_id);
  }

  /**
   * Give each newly active placement the Channel's next attention ordinal, in
   * the caller's transaction, and count it read for whoever placed it.
   *
   * The one place a Channel's waterline moves. Called only on a transition
   * into `active` — a fresh placement, a re-add of a removed one, a move's
   * target, a restore — never on an idempotent settle of a row that was
   * already active, so a re-add after a removal takes a higher ordinal than
   * the one it had and a removal never lowers the waterline. Ordered by
   * `(joined_at, workstream_id)` so a restore numbers its rows the way the
   * migration 98 backfill does.
   *
   * The placer's read position rises to the newest ordinal: your own placement
   * is not news to you, the way your own message is not unread to you.
   */
  private stampPlacements(spaceId: string, workstreamIds: readonly string[], placerUserId: string, now: number): void {
    if (workstreamIds.length === 0 || !this.readsReady()) return;
    let latest = 0;
    const ordered = this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `SELECT workstream_id FROM space_channel_memberships
        WHERE space_id = ? AND workstream_id IN (SELECT value FROM json_each(?))
        ORDER BY joined_at, workstream_id`,
      spaceId,
      JSON.stringify(workstreamIds),
    ).toArray().map((row) => row.workstream_id);
    for (const workstreamId of ordered) {
      latest = this.nextAttentionOrdinal(spaceId);
      this.storage.sql.exec(
        `UPDATE space_channel_memberships SET attention_ordinal = ? WHERE space_id = ? AND workstream_id = ?`,
        latest,
        spaceId,
        workstreamId,
      );
    }
    if (latest === 0) return;
    this.readThrough(spaceId, placerUserId, latest, now);
  }

  /**
   * One piece of Channel news of any kind: take the Channel's next attention
   * ordinal and read its author through it, since your own news is not news
   * to you. Rally as author (`actorUserId` null) reads nobody through. Null on
   * an object short of migration 98, which has no waterline.
   */
  private stampChannelNews(spaceId: string, actorUserId: string | null, now: number): number | null {
    if (!this.readsReady()) return null;
    const ordinal = this.nextAttentionOrdinal(spaceId);
    if (actorUserId !== null) this.readThrough(spaceId, actorUserId, ordinal, now);
    return ordinal;
  }

  private nextAttentionOrdinal(spaceId: string): number {
    return this.storage.sql.exec<{ latest_attention_ordinal: number } & Record<string, SqlStorageValue>>(
      `UPDATE spaces SET latest_attention_ordinal = latest_attention_ordinal + 1
        WHERE space_id = ? RETURNING latest_attention_ordinal`,
      spaceId,
    ).one().latest_attention_ordinal;
  }

  /** Raise one person's read position in a Channel to `ordinal`, never lower it. */
  private readThrough(spaceId: string, userId: string, ordinal: number, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO space_reads (space_id, user_id, seen_attention_ordinal, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(space_id, user_id) DO UPDATE SET
         seen_attention_ordinal = MAX(COALESCE(space_reads.seen_attention_ordinal, 0), excluded.seen_attention_ordinal),
         updated_at = excluded.updated_at`,
      spaceId,
      userId,
      ordinal,
      now,
    );
  }

  private advanceWaterline(now: number): void {
    this.storage.sql.exec(
      "UPDATE workspace_space_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1",
      now,
    );
  }
}

function channelMessage(row: ChannelMessageRow): ChannelMessage {
  return {
    id: row.message_id,
    author: row.author_kind === "member" ? { kind: "member", userId: asUserId(row.author_user_id!) } : { kind: "rally" },
    body: row.body,
    ...(row.source_workstream_id === null ? {} : {
      // A reader who cannot open the thread is told nothing about it, not its
      // name or its prompt. The embeds go to every reader: the merge shared
      // them with the Channel.
      merge: {
        threadId: asWorkstreamId(row.source_workstream_id),
        title: row.source_openable === 1 ? row.source_title ?? "" : "",
        summary: row.source_openable !== 1 || row.source_description === null || row.source_description.trim() === ""
          ? null : row.source_description,
        embeds: row.embeds_json === null ? [] : JSON.parse(row.embeds_json) as MergeEmbed[],
        ...(row.source_openable === 1 ? {} : { private: true as const }),
      },
    }),
  };
}

/** A refused archive, thrown so its transaction rolls back. */
class ArchiveRefused extends Error {
  constructor(readonly result: WorkspaceSpaceMutationResult) {
    super(result.ok ? "space_archive_refused" : result.code);
  }
}

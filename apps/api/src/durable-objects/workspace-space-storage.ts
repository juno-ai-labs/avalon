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
  asWorkstreamId,
  SPACE_ICON_KEYS,
  SPACE_COLOR_KEYS_STORABLE,
  type ContainerOrder,
  type OrderedContainer,
  type PersonalOrder,
  type SpaceDefaultKind,
  type SpaceDirectory,
  type SpaceReach,
  type SpaceSummary,
} from "@rally/contracts";

import { boundParameterChunks } from "./bound-parameters";
import type {
  SpaceMember,
  MemberWalkReach,
  WorkspaceSpaceAudienceNoteRequest,
  WorkspaceSpaceDefaultRequest,
  WorkspaceSpaceDefaultResult,
  WorkspaceSpaceDefaultTarget,
  WorkspaceSpaceMembershipPlanResult,
  WorkspaceSpaceMembershipMoveOutcome,
  WorkspaceSpaceMembershipMovePlanResult,
  WorkspaceSpaceMembershipMoveRequest,
  WorkspaceSpaceMembershipMoveSettleRequest,
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

const SPACE_ICON_FALLBACK = "briefcase";
const SPACE_COLOR_FALLBACK = "blue";

const SPACE_ICON_KEY_SET: ReadonlySet<string> = new Set(SPACE_ICON_KEYS);
const SPACE_COLOR_KEY_SET: ReadonlySet<string> = new Set(SPACE_COLOR_KEYS_STORABLE);

/**
 * WorkspaceDO's Space tables.
 *
 * Kept beside the storage that reads them, the way `workstream-access-storage.ts`
 * keeps WorkstreamDO's. The shapes mirror the Project tables wherever the
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
  // is writing: `ensureGeneralSpace` is idempotent and is called from creation,
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
  const seen = `COALESCE(${viewer}.seen_attention_ordinal, ${directory}.unread_tracking_start_ordinal)`;
  return `(${directory}.exact_state IN (${LIVE_EXACT_STATE_LIST})
       OR ${viewer}.manual_unread_from_ordinal IS NOT NULL
       OR ${directory}.latest_attention_ordinal > ${seen}
       OR ${viewer}.unseen = 1
       OR COALESCE(${viewer}.latest_mention_attention_ordinal, 0) > ${seen})`;
}

/**
 * Whether this person may know a Channel exists, in SQL.
 *
 * One code-owned text rendered wherever the question is asked, for the reason
 * {@link liveForViewerSql} is one: the Space page counts rows against
 * `SPACE_CHANNEL_PAGE_SIZE` and projects them afterwards, so a second spelling
 * that drifted looser would produce silently short pages with a cursor that
 * had already skipped the rows it dropped. The same test decides who a
 * dashboard nudge is addressed to, which is the same question asked of a
 * socket instead of a page.
 *
 * `viewer` is a left-joined alias fenced on the directory row's authority
 * generation, so a missing or stale viewer row reads as "not a participant" —
 * the right answer for a personal-scope Channel and irrelevant for an
 * Organization-wide one.
 */
export function channelVisibleToViewerSql(directory: string, viewer: string): string {
  return `(${directory}.scope = 'workspace' OR ${viewer}.is_participant = 1)`;
}

/**
 * Whether this person reaches a Space through a Channel placed in it, in SQL.
 *
 * The third way a Space becomes visible, beside its own Organization-wide
 * scope and this person's participation in it: **if you can see a Channel in a
 * Space, you can see that Space's mark and name.** Without it a Channel in a
 * participants-only Space is drawn under no Space at all for everybody but
 * that Space's participants — in **Other channels**, a flat list whose whole
 * purpose was to keep such a Channel reachable — and the hierarchy is silent
 * about where the Channel actually lives.
 *
 * The Channel half is {@link channelVisibleToViewerSql}, the one code-owned
 * text, rendered here against this subquery's own aliases. The membership has
 * to be `active` (a `joining` one has granted nobody anything yet) and the
 * Channel's directory row not archived — the same pair the viewer-scoped
 * channel count is taken over, so a Space that is reachable this way always
 * has at least one Channel to draw under it rather than a row a reader cannot
 * account for.
 *
 * **Binds one `?` for the user id**, at the position this fragment sits in the
 * statement — the convention every viewer-scoped query in this file already
 * follows.
 */
export function spaceReachedThroughChannelSql(space: string): string {
  return `EXISTS (SELECT 1
            FROM space_channel_memberships reach_membership
            JOIN channels reach_directory
              ON reach_directory.workstream_id = reach_membership.workstream_id
            LEFT JOIN channel_viewers reach_viewer
              ON reach_viewer.workstream_id = reach_directory.workstream_id
             AND reach_viewer.user_id = ?
             AND reach_viewer.authority_generation = reach_directory.authority_generation
           WHERE reach_membership.space_id = ${space}.space_id
             AND reach_membership.state = 'active'
             AND reach_directory.archived_at IS NULL
             AND ${channelVisibleToViewerSql("reach_directory", "reach_viewer")})`;
}

/**
 * Whether this person may be told a Space exists, in SQL: the three ways, in
 * one text.
 *
 * `viewer` is the Space's own left-joined viewer row, already narrowed to
 * `is_participant = 1` by its join. One text rather than one per query for the
 * reason {@link channelVisibleToViewerSql} is one: the directory, the inactive
 * list, the per-Channel placement read and the nudge's addressing all decide
 * the same question, and a spelling that drifted looser in one of them would
 * disclose a Space through whichever query was left behind.
 *
 * **Binds one `?` for the user id**, for
 * {@link spaceReachedThroughChannelSql}, after whatever the viewer join binds.
 */
export function spaceVisibleToViewerSql(space: string, viewer: string): string {
  return `(${space}.scope = 'workspace'
            OR ${viewer}.user_id IS NOT NULL
            OR ${spaceReachedThroughChannelSql(space)})`;
}

/**
 * Why this viewer can see this Space, as a column.
 *
 * Computed by the query that selects the row rather than asked per summary: it
 * is three comparisons over columns already joined, and the alternative is one
 * more statement per Space per socket publication.
 *
 * The strongest relationship wins. `ELSE 'through_channel'` is sound only
 * because every query rendering this has already applied
 * {@link spaceVisibleToViewerSql}, so a row that reaches it is one of the
 * three; a row selected without that filter would be labelled
 * `through_channel` whether or not it is reachable at all.
 */
export function spaceReachSql(space: string, viewer: string): string {
  return `CASE WHEN ${viewer}.user_id IS NOT NULL THEN 'participant'
               WHEN ${space}.scope = 'workspace' THEN 'organization'
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
/**
 * Whether this person may list a breakout, in SQL.
 *
 * The breakout half of {@link channelVisibleToViewerSql}, and shaped the same
 * way on purpose: the viewer row is left-joined under the generation fence, so
 * **a missing row and `listable = 0` are two different answers**, and only the
 * second one is the authority saying no.
 *
 * A missing row is this person's projection not having caught up — the case
 * that made this a `LEFT JOIN`. `directory_user` effects only go out for the
 * users an update affects, so when a Channel's authority generation advances,
 * a breakout's next message carries its shared row forward and leaves every
 * unaffected person's viewer row a generation behind. Under an inner join
 * every one of them lost the row until they happened to become an affected
 * user, which is a disappearance nothing would ever have reported.
 *
 * What fills the gap is the breakout's **own scope**, exactly as the Channel
 * directory's scope fills it for a Channel with no viewer row: an
 * Organization-wide breakout is one everybody who can see the Channel may
 * list, and the Channel gate has already been applied by the time this is
 * asked. A personal one still needs the row, and is left out without it —
 * the same answer a personal Channel gets, and the safe one, because nothing
 * else in the Organization knows who a private child's participants are.
 */
function breakoutListableToViewerSql(breakout: string, viewer: string): string {
  return `(${breakout}.scope = 'workspace' OR ${viewer}.listable = 1)`;
}

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
  scope: "personal" | "workspace";
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

/** The audience and fences an equal-audience move hands the Channel's parent. */
export interface EquivalentMoveFences {
  scope: SpaceSummary["scope"];
  participantUserIds: SpaceSummary["participants"][number]["userId"][];
  sourceSpaceRevision: number;
  sourceMembershipGeneration: number;
  targetSpaceRevision: number;
  targetMembershipGeneration: number;
}

type EquivalentMovePlan =
  | { kind: "refused"; code: "space_not_found" }
  | { kind: "different" }
  | {
    kind: "equivalent";
    source: SpaceSummary;
    target: SpaceSummary;
    existingTarget: { state: string; generation: number } | null;
    sourceMembershipGeneration: number;
    targetMembershipGeneration: number;
  };

type MoveMembershipFences = Pick<WorkspaceSpaceMembershipMoveSettleRequest,
  "userId" | "sourceSpaceId" | "targetSpaceId" | "workstreamId"
  | "sourceMembershipGeneration" | "targetMembershipGeneration">;

/** Thrown inside the move transaction to roll it back when the Channel declines the swap. */
class EquivalentMoveDeclined extends Error {
  constructor() {
    super("space_move_equivalent_declined");
  }
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
  archivedAt: number | null;
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
  kind: "channel" | "breakout";
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
  if (kind !== "channel" && kind !== "breakout") return null;
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

/** One page of the memberships a Space fan-out still has work for. */
export interface SpaceMemberPage {
  members: SpaceMember[];
  nextCursor: string | null;
}

/** A directory with nothing in it, for an object whose Space tables are absent. */
const EMPTY_DIRECTORY: SpaceDirectory = SpaceDirectorySchema.parse({ waterline: 0, items: [] });

/** Synchronous repository for the Space state owned by one WorkspaceDO. */
export class WorkspaceSpaceStorage {
  private tablesPresent: boolean | null = null;
  private breakoutTablesPresent: boolean | null = null;

  constructor(private readonly storage: DurableObjectStorage) {}

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
  private breakoutsReady(): boolean {
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
    systemRole: "general" | null,
    now = Date.now(),
  ): SpaceSummary {
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
        request.space.scope,
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
      if (exists) return { space: this.readable(request.userId, spaceId), created: false };
      return { space: this.reserve(request, spaceId, null), created: true };
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
    now = Date.now(),
  ): { space: SpaceSummary; created: boolean } {
    try {
      return { space: this.reserve(request, spaceId, "general", now), created: true };
    } catch (error) {
      const winner = this.generalSpaceId();
      if (winner === null) throw error;
      return { space: this.writtenSpace(winner, request.userId), created: false };
    }
  }

  /**
   * Undo a reservation whose Space object could not be provisioned.
   *
   * Only this caller's own reservation. `source_version = 0` alone is a window
   * every Space passes through for the seconds between being reserved and its
   * first projection, so a cancel that did not name the creator was a member
   * able to delete whatever anybody else was in the middle of creating.
   */
  cancelReservation(spaceId: string, createdByUserId: string, now = Date.now()): boolean {
    if (!this.ready()) return false;
    return this.storage.transactionSync(() => {
      const removed = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        // Only a row nothing has projected onto yet: once the Space's own
        // object has published a version, cancelling the reservation would
        // delete a Space that exists.
        `DELETE FROM spaces
          WHERE space_id = ? AND source_version = 0 AND created_by_user_id = ?
          RETURNING space_id`,
        spaceId,
        createdByUserId,
      ).toArray().length === 1;
      if (!removed) return false;
      this.storage.sql.exec("DELETE FROM space_viewers WHERE space_id = ?", spaceId);
      // Both directions: the Space leaves everybody's Organization order, and
      // the order of the Channels somebody had arranged inside it goes with the
      // container it was about.
      this.storage.sql.exec(
        `DELETE FROM workspace_container_order
          WHERE (container_kind = 'organization' AND item_id = ?)
             OR (container_kind = 'space' AND container_id = ?)`,
        spaceId,
        spaceId,
      );
      this.advanceWaterline(now);
      return true;
    });
  }

  list(workspaceId: string, userId: string, now = Date.now()): SpaceDirectory {
    if (!this.ready()) return EMPTY_DIRECTORY;
    return this.storage.transactionSync(() => {
      for (const spaceId of this.visibleSpaceIds(userId)) {
        this.appendOrder(workspaceId, userId, spaceId, now);
      }
      return this.directory(workspaceId, userId);
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
  listInactive(userId: string): SpaceDirectory {
    if (!this.ready()) return EMPTY_DIRECTORY;
    const rows = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*, ${spaceReachSql("space", "viewer")} AS reach
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.archived_at IS NOT NULL
          AND ${spaceVisibleToViewerSql("space", "viewer")}
        ORDER BY space.updated_at DESC, space.space_id`,
      userId,
      userId,
    ).toArray();
    return SpaceDirectorySchema.parse({
      waterline: this.waterline(),
      items: rows.map((row) => this.summary(row, userId, 0)),
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
  readOrders(workspaceId: string, userId: string): PersonalOrder {
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
    const visibleSpaces = new Set(this.visibleSpaceIds(userId));
    const visible: ContainerOrder[] = [];
    for (const order of byContainer.values()) {
      if (order.container.kind === "organization") {
        visible.push({ ...order, itemIds: order.itemIds.filter((id) => visibleSpaces.has(id)) });
        continue;
      }
      if (order.container.kind === "space") {
        if (!this.readable(userId, order.container.id)) continue;
        const orderable = this.orderableChannelIds(userId, order.container.id, order.itemIds);
        visible.push({ ...order, itemIds: order.itemIds.filter((id) => orderable.has(id)) });
        continue;
      }
      if (this.listableChannelIds(userId, [order.container.id]).length > 0) visible.push(order);
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

  /** Whether this viewer may name the container whose private order they write. */
  canArrange(userId: string, container: OrderedContainer): boolean {
    if (container.kind === "organization") return true;
    if (container.kind === "space") return this.readable(userId, container.id) !== false;
    return this.listableChannelIds(userId, [container.id]).length > 0;
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
    const orderable = this.orderableChannelIds(userId, container.id, requestedIds);
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
    const visible = this.visibleSpaceIds(userId);
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
    userId: string,
    spaceId: string,
    workstreamIds: readonly string[],
  ): Set<string> {
    const placed = [...this.spaceIdsByChannel(userId, workstreamIds)]
      .filter(([, spaceIds]) => spaceIds.includes(spaceId))
      .map(([workstreamId]) => workstreamId);
    return new Set(this.listableChannelIds(userId, placed));
  }

  /**
   * One Space as this viewer may see it, archived or not.
   *
   * The read is its own gate: {@link WorkspaceSpaceStorage.space} renders the
   * visibility predicate, so asking `canRead` first would be the same question
   * twice and a second place for the answer to drift.
   */
  readable(userId: string, spaceId: string): SpaceSummary | false {
    return this.space(spaceId, userId);
  }

  /**
   * Record the presentation the Space's own authority accepted, so the
   * mutation can answer without waiting on the projection.
   *
   * The fence columns are deliberately untouched. The real projection carries
   * the same change at a higher source version and overwrites this, which is
   * what keeps the Space's own object authoritative for what a Space is.
   */
  applyPresentation(request: WorkspaceSpacePresentationRequest, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId)) return false;
      const updated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE spaces
            SET title = ?, appearance_json = ?, revision = revision + 1, updated_at = ?
          WHERE space_id = ? RETURNING space_id`,
        request.presentation.name.trim(),
        JSON.stringify({ icon: request.presentation.iconKey, color: request.presentation.colorKey }),
        now,
        request.spaceId,
      ).toArray()[0];
      if (!updated) return false;
      this.advanceWaterline(now);
      return this.space(request.spaceId, request.userId);
    });
  }

  /**
   * Record the scope and participants the Space's own authority accepted.
   *
   * Participants are the viewer rows, which is the same table the
   * `directory_user` projection writes: the Space's own object decides who its
   * participants are, and this is the provisional copy of that answer.
   */
  applyAudience(
    request: WorkspaceSpaceAudienceNoteRequest,
    now = Date.now(),
  ): SpaceSummary | "self_excluded" | false {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(request.userId, request.spaceId)) return false;
      // Before the write, because there is no undo: `personal` admits its
      // participants and nobody else, so a caller who leaves themselves off
      // the list has made a Space they can no longer change — and, unless a
      // Channel in it is one they can read, no longer see. The walk would
      // carry it to every member Channel and the one person who would ask for
      // it back is the one who cannot. Removing somebody *else* is a different
      // rule and belongs to an Organization owner or admin, which the service
      // decides because it is the layer that knows the caller's role.
      if (request.audience.scope === "personal"
        && !request.audience.participantUserIds.includes(request.userId)) {
        return "self_excluded";
      }
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
      this.advanceWaterline(now);
      return this.space(request.spaceId, request.userId);
    });
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
      archived_at: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT authority_generation, source_version, payload_hash, title, scope,
              appearance_json, archived_at
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
    const changed = !current
      || current.title !== projection.title
      || current.scope !== projection.scope
      || current.appearance_json !== appearanceJson
      || current.archived_at !== projection.archivedAt;
    this.storage.sql.exec(
      `INSERT INTO spaces (
         space_id, title, scope, appearance_json, archived_at,
         created_by_user_id, system_role, authority_generation, source_version,
         payload_hash, revision, created_at, updated_at, source_created_at, source_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(space_id) DO UPDATE SET
         title = excluded.title,
         scope = excluded.scope,
         appearance_json = excluded.appearance_json,
         archived_at = excluded.archived_at,
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
      projection.scope,
      appearanceJson,
      projection.archivedAt,
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
   * **Stale is left out here, not on the client.** `liveForViewerSql` is
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
    userId: string,
    spaceId: string,
    cursor: string | null,
  ): SpaceConversationPage | "invalid_cursor" | false {
    if (!this.canRead(userId, spaceId)) return false;
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
              AND ${channelVisibleToViewerSql("directory", "viewer")}
              AND ${liveForViewerSql("directory", "viewer")}
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
              AND ${channelVisibleToViewerSql("directory", "viewer")}
              AND breakout.archived_at IS NULL
              AND ${breakoutListableToViewerSql("breakout", "breakout_viewer")}
              AND ${liveForViewerSql("breakout", "breakout_viewer")}
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
   * Every Channel and Breakout in one Space that the dashboard would list for
   * this viewer. This is the dashboard query's admission predicate without its
   * page bound or ordering, so a sidebar badge never counts a different state.
   */
  attentionCounts(userId: string, spaceIds: readonly string[]): Map<string, number> {
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
            AND ${channelVisibleToViewerSql("directory", "viewer")}
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
            AND ${channelVisibleToViewerSql("directory", "viewer")}
            AND breakout.archived_at IS NULL
            AND ${breakoutListableToViewerSql("breakout", "breakout_viewer")}
            AND ${liveForViewerSql("breakout", "breakout_viewer")}` : ""}
       ) GROUP BY space_id`,
      userId,
      JSON.stringify(ids),
      ...(includeBreakouts ? [userId, userId, JSON.stringify(ids)] : []),
    ).toArray();
    for (const row of rows) result.set(row.space_id, row.count);
    return result;
  }

  attentionCount(userId: string, spaceId: string): number {
    return this.attentionCounts(userId, [spaceId]).get(spaceId) ?? 0;
  }

  /**
   * Viewer-specific live Breakout totals, grouped under visible parent Channels.
   * Guests need an explicit Breakout viewer grant; members retain workspace scope.
   */
  breakoutAttentionCounts(
    userId: string,
    workstreamIds: readonly string[],
    accessClass: "member" | "guest" = "member",
  ): Map<string, number> {
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
            AND ${channelVisibleToViewerSql("directory", "viewer")}
            AND breakout.archived_at IS NULL
            AND ${accessClass === "guest"
              ? "breakout_viewer.listable = 1"
              : breakoutListableToViewerSql("breakout", "breakout_viewer")}
            AND ${liveForViewerSql("breakout", "breakout_viewer")}
          GROUP BY breakout.workstream_id`,
        userId,
        userId,
        ...ids,
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
   * which decides every conversation it releases. A Channel this person can
   * already see is left out because the member directory already lists it.
   *
   * Reads `breakout_viewers` by user, which has no index for it. The
   * table holds one row per breakout member, so the scan is the cheaper choice
   * until an Organization's breakouts say otherwise.
   */
  channelsReachedOnlyThroughBreakouts(userId: string): string[] {
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
          AND ${channelVisibleToViewerSql("directory", "viewer")} IS NOT 1
        ORDER BY breakout.workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
  }

  /**
   * One page of the Channels this Space holds, archived ones included.
   *
   * `walkReach` is the difference between what a surface means by a member and
   * what a retraction fan-out is about — and it is not `SpaceSummary.reach`,
   * which is a *viewer's* relationship to the Space and is what the gate two
   * lines below reads. `prepareArchive` and `prepareMembershipRemoval`
   * flip a membership to `removing` *before* the Channel is asked to withdraw
   * the source, so the set a staged operation still has work for is
   * `active` plus `removing` — and an archive that read the active set would
   * walk nothing and leave its source on every Channel it reached.
   *
   * Paged for the reason {@link SPACE_CHANNEL_PAGE_SIZE} pages the read beside
   * it, and then some: every caller of this is a *walk* that spends several
   * cross-object awaits per row, so an unbounded answer is not one slow
   * invocation but an operation that can never finish — each redelivery
   * restarting the same pass from the top. Ordered by Channel id, so the
   * cursor is the id the page stopped at and a resumed walk continues from a
   * row rather than from an offset.
   *
   * **`canEdit`, and there is deliberately no viewer-scoped variant.** This
   * answers the Space's whole membership with no viewer predicate in the
   * query, because its callers — an audience walk, an archive, a restore, the
   * containment preflight — are operations *on* the Space and have to reach
   * every Channel it holds or they converge on nothing. A walk narrowed to
   * what the caller can see would leave the rest of the Space half-applied,
   * silently. So the answer stays the Organization's and the gate is the
   * stronger one: somebody who reaches a Space only through a Channel in it is
   * told its mark so that Channel can be drawn, and this would hand them the
   * complete membership of a participants-only Space — the ids of Channels
   * they cannot open, which is the disclosure the viewer-scoped
   * {@link WorkspaceSpaceStorage.conversationPage} and `channelCount` exist to
   * refuse.
   *
   * The two refusals are told apart because only this knows which one it made:
   * `"not_editable"` is a Space the caller is looking at and may not act on,
   * and `false` is one they cannot see at all. Collapsed into `false` the RPC
   * would have to pick one word for both, and the word it picked was "no such
   * Space" about a Space whose name is on that person's sidebar.
   */
  members(
    userId: string,
    spaceId: string,
    walkReach: MemberWalkReach = "active",
    cursor: string | null = null,
  ): SpaceMemberPage | "not_editable" | false {
    const viewerReach = this.reach(userId, spaceId);
    if (viewerReach === null) return false;
    if (!editableReach(viewerReach)) return "not_editable";
    const after = cursor === null ? null : decodeChannelCursor(cursor);
    if (cursor !== null && after === null) return false;
    const rows = this.storage.sql.exec<{
      workstream_id: string;
      generation: number;
    } & Record<string, SqlStorageValue>>(
      walkReach === "reaching"
        ? `SELECT workstream_id, generation FROM space_channel_memberships
            WHERE space_id = ? AND state IN ('active', 'removing')
              AND (? IS NULL OR workstream_id > ?)
            ORDER BY workstream_id LIMIT ?`
        : `SELECT workstream_id, generation FROM space_channel_memberships
            WHERE space_id = ? AND state = 'active'
              AND (? IS NULL OR workstream_id > ?)
            ORDER BY workstream_id LIMIT ?`,
      spaceId,
      after,
      after ?? "",
      SPACE_BOOTSTRAP_PAGE_SIZE + 1,
    ).toArray();
    const hasMore = rows.length > SPACE_BOOTSTRAP_PAGE_SIZE;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      members: rows.map((row) => ({
        workstreamId: asWorkstreamId(row.workstream_id),
        membershipGeneration: row.generation,
      })),
      nextCursor: hasMore && last ? encodeChannelCursor(last.workstream_id) : null,
    };
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
  spaceIdsByChannel(userId: string, workstreamIds: readonly string[]): Map<string, string[]> {
    const byWorkstream = new Map<string, string[]>();
    if (!this.ready()) return byWorkstream;
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
            AND ${spaceVisibleToViewerSql("space", "viewer")}
            AND membership.workstream_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY membership.workstream_id, (space.scope = 'personal'), membership.space_id`,
        userId,
        userId,
        ...chunk,
      ).toArray()) {
        const existing = byWorkstream.get(row.workstream_id);
        if (existing) existing.push(row.space_id);
        else byWorkstream.set(row.workstream_id, [row.space_id]);
      }
    }
    return byWorkstream;
  }

  /** The active Spaces a Channel is in, as this viewer may see them. */
  channelSpaceIds(userId: string, workstreamId: string): string[] {
    return this.spaceIdsByChannel(userId, [workstreamId]).get(workstreamId) ?? [];
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
        ORDER BY (space.scope = 'personal'), membership.space_id
        LIMIT 1`,
      workstreamId,
    ).toArray()[0]?.space_id ?? null;
  }

  /**
   * Space marks for Channels whose canonical grant owner has admitted a guest.
   *
   * The caller supplies only Channels already re-read from their WorkstreamDOs.
   * This read therefore exposes the Space's presentation and containment edge,
   * even when the guest is not a Space participant. The candidate Channel is
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
        created_at: number;
        workstream_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT space.space_id, space.title, space.appearance_json, space.scope, space.created_at,
                membership.workstream_id
           FROM space_channel_memberships membership
           JOIN spaces space ON space.space_id = membership.space_id
           WHERE membership.state = 'active' AND space.archived_at IS NULL
            AND membership.workstream_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY space.created_at, space.space_id, membership.workstream_id`,
        ...chunk,
      ).toArray()) {
        const appearance = row.appearance_json
          ? JSON.parse(row.appearance_json) as { icon?: unknown; color?: unknown }
          : null;
        const icon = typeof appearance?.icon === "string" ? appearance.icon : null;
        const color = typeof appearance?.color === "string" ? appearance.color : null;
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
            colorKey: color && SPACE_COLOR_KEY_SET.has(color) ? color : SPACE_COLOR_FALLBACK,
            scope: row.scope,
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
   * Stage the fast path for a move whose two Space sources grant the same
   * audience. The source stays active until settlement; the target is either
   * already active or remains invisible as `joining` while the Channel's
   * parent moves the provenance.
   *
   * Only a Worker from before `moveEquivalentMembership` calls this, during a
   * rollout; the intents it stages are resumed by `SpaceService.resumeIntent`.
   */
  prepareMembershipMove(
    request: WorkspaceSpaceMembershipMoveRequest,
    operationId: string,
    notBefore: number,
    now = Date.now(),
  ): WorkspaceSpaceMembershipMovePlanResult {
    return this.storage.transactionSync(() => {
      const plan = this.planEquivalentMove(request);
      if (plan.kind === "refused") {
        return { ok: false, code: plan.code, unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      if (plan.kind === "different") return { ok: true, equivalentAudience: false };
      this.stageMoveTarget(request, plan, now);
      this.recordIntent({
        operationId,
        kind: "move",
        spaceId: request.targetSpaceId,
        workstreamId: request.workstreamId,
        spaceRevision: plan.target.revision,
        membershipGeneration: plan.targetMembershipGeneration,
        sourceSpaceId: request.sourceSpaceId,
        sourceSpaceRevision: plan.source.revision,
        sourceMembershipGeneration: plan.sourceMembershipGeneration,
        deliveryGeneration: null,
        requestedByUserId: request.userId,
        notBefore,
      }, now);
      return {
        ok: true,
        equivalentAudience: true,
        operationId,
        source: plan.source,
        target: plan.target,
        sourceMembershipGeneration: plan.sourceMembershipGeneration,
        targetMembershipGeneration: plan.targetMembershipGeneration,
      };
    });
  }

  /**
   * Move a Channel between two Spaces that grant the same audience, in one
   * transaction: the target placement, the Channel's provenance swap and the
   * source's retirement commit together or not at all.
   *
   * `replaceSource` is the Channel's hosted parent swapping its recorded Space
   * source, which lives in this same database. When it refuses (the Channel's
   * record is behind the Spaces' revisions, or does not hold the source) the
   * transaction is rolled back and the answer is `moved: false`, which sends
   * the caller down the ordinary add-then-remove path. There is no intent: a
   * move that commits needs no resume, and one that does not left nothing.
   */
  moveEquivalentMembership(
    request: WorkspaceSpaceMembershipMoveRequest,
    replaceSource: (fences: EquivalentMoveFences) => boolean,
    now = Date.now(),
  ): WorkspaceSpaceMembershipMoveOutcome {
    try {
      return this.storage.transactionSync((): WorkspaceSpaceMembershipMoveOutcome => {
        const plan = this.planEquivalentMove(request);
        if (plan.kind === "refused") {
          return { ok: false, code: plan.code, unreachableUserIds: [], blockedWorkstreamIds: [] };
        }
        if (plan.kind === "different") return { ok: true, moved: false };
        if (!replaceSource({
          scope: plan.target.scope,
          participantUserIds: plan.target.participants.map((participant) => participant.userId),
          sourceSpaceRevision: plan.source.revision,
          sourceMembershipGeneration: plan.sourceMembershipGeneration,
          targetSpaceRevision: plan.target.revision,
          targetMembershipGeneration: plan.targetMembershipGeneration,
        })) throw new EquivalentMoveDeclined();
        this.stageMoveTarget(request, plan, now);
        this.switchMoveMemberships({
          ...request,
          sourceMembershipGeneration: plan.sourceMembershipGeneration,
          targetMembershipGeneration: plan.targetMembershipGeneration,
        }, plan.existingTarget?.state === "active" ? "active" : "joining", false, now);
        const source = this.authoritativeSpace(request.sourceSpaceId, request.userId);
        const target = this.authoritativeSpace(request.targetSpaceId, request.userId);
        if (source === false || target === false) throw new Error("space_move_summary_missing");
        return { ok: true, moved: true, source, target };
      });
    } catch (error) {
      if (error instanceof EquivalentMoveDeclined) return { ok: true, moved: false };
      throw error;
    }
  }

  /**
   * Whether a move is an equal-audience one, and the fences it runs at.
   *
   * A target already `joining` is an add somebody else staged; the ordinary
   * path lets it converge rather than taking over its generation and its
   * recovery receipt, so it answers `different`.
   */
  private planEquivalentMove(request: WorkspaceSpaceMembershipMoveRequest): EquivalentMovePlan {
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
    const source = this.space(request.sourceSpaceId, request.userId);
    const target = this.space(request.targetSpaceId, request.userId);
    if (source === false || target === false) return { kind: "refused", code: "space_not_found" };
    const sourceParticipants = new Set(source.participants.map((participant) => participant.userId));
    const equivalentAudience = source.scope === target.scope
      && sourceParticipants.size === target.participants.length
      && target.participants.every((participant) => sourceParticipants.has(participant.userId));
    if (!equivalentAudience) return { kind: "different" };
    const existingTarget = this.storage.sql.exec<{
      state: string;
      generation: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT state, generation FROM space_channel_memberships
        WHERE space_id = ? AND workstream_id = ?`,
      request.targetSpaceId,
      request.workstreamId,
    ).toArray()[0] ?? null;
    if (existingTarget?.state === "joining") return { kind: "different" };
    return {
      kind: "equivalent",
      source,
      target,
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
    plan: Extract<EquivalentMovePlan, { kind: "equivalent" }>,
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
   * Keep the original move intent but switch its delivery to the canonical
   * audience path. This is the recovery path when the cheap provenance swap
   * loses a revision fence after the move was staged (or even after the swap
   * itself committed): the destination is rebuilt before the source is finally
   * retracted, and the same membership generations are finalized.
   */
  replanMembershipMoveForAudience(
    request: WorkspaceSpaceMembershipMoveSettleRequest,
    now = Date.now(),
  ): WorkspaceSpaceMembershipMovePlanResult {
    return this.storage.transactionSync(() => {
      const intent = this.moveIntent(request);
      if (!intent) {
        return { ok: false, code: "space_revision_conflict", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const sourceMembership = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ?`,
        request.sourceSpaceId,
        request.workstreamId,
      ).toArray()[0];
      const targetMembership = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ?`,
        request.targetSpaceId,
        request.workstreamId,
      ).toArray()[0];
      if (sourceMembership?.state !== "active"
        || sourceMembership.generation !== request.sourceMembershipGeneration
        || !targetMembership
        || !["joining", "active"].includes(targetMembership.state)
        || targetMembership.generation !== request.targetMembershipGeneration) {
        // A competing move may already have retired the source. Its target is
        // active; this intent's target is still joining and must never be
        // published as a second destination.
        this.cancelMembershipMoveRows(request, now);
        return { ok: false, code: "space_revision_conflict", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const source = this.authoritativeSpace(request.sourceSpaceId, request.userId);
      const target = this.authoritativeSpace(request.targetSpaceId, request.userId);
      if (source === false || target === false) {
        this.cancelMembershipMoveRows(request, now);
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      this.storage.sql.exec(
        `UPDATE space_intents
            SET space_revision = ?, source_space_revision = ?,
                updated_at = ?
          WHERE operation_id = ? AND state IN ('pending', 'applied')`,
        target.revision,
        source.revision,
        now,
        request.operationId,
      );
      return {
        ok: true,
        equivalentAudience: true,
        operationId: request.operationId,
        source,
        target,
        sourceMembershipGeneration: request.sourceMembershipGeneration,
        targetMembershipGeneration: request.targetMembershipGeneration,
      };
    });
  }

  /** Atomically publish the target placement and retire the source placement. */
  finalizeMembershipMove(
    request: WorkspaceSpaceMembershipMoveSettleRequest,
    now = Date.now(),
  ): { source: SpaceSummary; target: SpaceSummary } | "conflict" | false {
    return this.storage.transactionSync(() => {
      const intent = this.moveIntent(request, true, true);
      if (!intent) return false;
      if (intent.state === "settled") {
        const source = this.authoritativeSpace(request.sourceSpaceId, request.userId);
        const target = this.authoritativeSpace(request.targetSpaceId, request.userId);
        return source === false || target === false ? false : { source, target };
      }
      const revisions = this.storage.sql.exec<{
        space_id: string;
        revision: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT space_id, revision FROM spaces
          WHERE space_id IN (?, ?) AND archived_at IS NULL`,
        request.sourceSpaceId,
        request.targetSpaceId,
      ).toArray();
      const revisionOf = (spaceId: string): number | null =>
        revisions.find((row) => row.space_id === spaceId)?.revision ?? null;
      if (revisionOf(request.sourceSpaceId) !== request.sourceSpaceRevision
        || revisionOf(request.targetSpaceId) !== request.targetSpaceRevision) return "conflict";

      const targetBefore = this.storage.sql.exec<{ state: string } & Record<string, SqlStorageValue>>(
        `SELECT state FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ? AND generation = ?`,
        request.targetSpaceId,
        request.workstreamId,
        request.targetMembershipGeneration,
      ).toArray()[0];
      const sourceBefore = this.storage.sql.exec<{ state: string; generation: number } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ?`,
        request.sourceSpaceId,
        request.workstreamId,
      ).toArray()[0];
      const sourceSettled = sourceBefore?.state === "removed"
        && sourceBefore.generation === request.sourceMembershipGeneration + 1;
      if (!targetBefore || !["joining", "active"].includes(targetBefore.state)
        || (sourceSettled && targetBefore.state !== "active")
        || (!sourceSettled && (sourceBefore?.state !== "active"
          || sourceBefore.generation !== request.sourceMembershipGeneration))) return false;

      this.switchMoveMemberships(request, targetBefore.state, sourceSettled, now);
      this.settleIntent(request.operationId, "membership_moved", true, now);
      // Both summaries are read after the membership switch so their counts
      // describe the same committed result. The persisted move intent, not
      // mutable reach, authorized this exact actor and set of fences.
      const source = this.authoritativeSpace(request.sourceSpaceId, request.userId);
      const target = this.authoritativeSpace(request.targetSpaceId, request.userId);
      return source === false || target === false ? false : { source, target };
    });
  }

  /**
   * Publish the target placement and retire the source one. A target that was
   * `joining` is a new member and inherits the target's defaults; the source's
   * undelivered defaults, its arrangement and its pins go with it.
   */
  private switchMoveMemberships(
    request: MoveMembershipFences,
    targetState: string,
    sourceSettled: boolean,
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
    if (!sourceSettled) {
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
    }
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
    request: WorkspaceSpaceMembershipMoveSettleRequest,
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
        const space = this.space(request.spaceId, request.userId);
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
      const space = this.space(request.spaceId, request.userId);
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
      this.advanceWaterline(now);
      return this.space(request.spaceId, request.userId);
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
      return this.space(request.spaceId, request.userId);
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
      const space = this.space(request.spaceId, request.userId);
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
  finalizeMembershipRemoval(request: WorkspaceSpaceMembershipSettleRequest, now = Date.now()): SpaceSummary | false {
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
      return this.space(request.spaceId, request.userId);
    });
  }

  /** Refuse only an archive that would leave a member Channel with no home. */
  prepareArchive(userId: string, spaceId: string, now = Date.now()): WorkspaceSpaceMutationResult {
    return this.storage.transactionSync(() => {
      if (!this.canEdit(userId, spaceId, true)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const row = this.storage.sql.exec<{
        system_role: string | null;
        revision: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT system_role, revision FROM spaces WHERE space_id = ?",
        spaceId,
      ).one();
      if (row.system_role === "general") {
        return { ok: false, code: "space_protected", unreachableUserIds: [], blockedWorkstreamIds: [] };
      }
      const stranded: string[] = [];
      for (const workstreamId of this.memberWorkstreamIdsUnchecked(spaceId)) {
        const remainingSpaceIds = this.otherActiveSpaceIds(workstreamId, spaceId);
        if (remainingSpaceIds.length === 0) {
          stranded.push(workstreamId);
        }
      }
      if (stranded.length > 0) {
        return {
          ok: false,
          code: "space_membership_final",
          unreachableUserIds: [],
          blockedWorkstreamIds: this.listableChannelIds(userId, stranded).map(asWorkstreamId),
        };
      }
      this.storage.sql.exec(
        `UPDATE space_channel_memberships SET state = 'removing', generation = generation + 1, updated_at = ?
          WHERE space_id = ? AND state = 'active'`,
        now,
        spaceId,
      );
      this.advanceWaterline(now);
      const space = this.space(spaceId, userId);
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
      return this.space(spaceId, userId);
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
      this.storage.sql.exec(
        `UPDATE space_channel_memberships
            SET state = 'active', generation = generation + 1, updated_at = ?
          WHERE space_id = ? AND state = 'removing'`,
        now,
        spaceId,
      );
      this.appendOrder(workspaceId, userId, spaceId, now);
      this.advanceWaterline(now);
      return this.space(spaceId, userId);
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
        const space = this.space(request.spaceId, request.userId);
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
      const space = this.space(request.spaceId, request.userId);
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
      return this.space(request.spaceId, request.userId);
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

  defaultTargetActors(target: WorkspaceSpaceDefaultTarget): string[] {
    if (!this.defaultTargetCurrent(target)) return [];
    return this.participantUserIds(target.spaceId);
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
   * active member of the Organization, which the consumer settles by name, and
   * they no longer have an editable reach into the Space, which
   * `SpaceService.resumeIntent` settles by name — writing the code here first,
   * because this statement only matches a row that is still unsettled.
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

  cancelIntent(operationId: string, now = Date.now()): void {
    this.storage.sql.exec(
      `UPDATE space_intents SET state = 'cancelled', updated_at = ?
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      now,
      operationId,
    );
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

  /** The durable authorization and fences for a staged move. */
  private moveIntent(
    request: WorkspaceSpaceMembershipMoveSettleRequest,
    requireRevisions = false,
    allowSettled = false,
  ): { state: string } | null {
    const row = this.storage.sql.exec<{
      state: string;
      space_revision: number;
      source_space_revision: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT state, space_revision, source_space_revision
         FROM space_intents
        WHERE operation_id = ? AND kind = 'move' AND state <> 'cancelled'
          AND requested_by_user_id = ? AND space_id = ? AND source_space_id = ?
          AND workstream_id = ? AND membership_generation = ?
          AND source_membership_generation = ?`,
      request.operationId,
      request.userId,
      request.targetSpaceId,
      request.sourceSpaceId,
      request.workstreamId,
      request.targetMembershipGeneration,
      request.sourceMembershipGeneration,
    ).toArray()[0];
    if (!row) return null;
    if (!allowSettled && !["pending", "applied"].includes(row.state)) return null;
    if (requireRevisions && (row.space_revision !== request.targetSpaceRevision
      || row.source_space_revision !== request.sourceSpaceRevision)) return null;
    return row;
  }

  /**
   * Every Space this Organization has, archived ones included.
   *
   * For the retirement walk, which has to close an object rather than list a
   * product surface: an archived Space is still a `SpaceDO` holding a hidden
   * main conversation, and a graph that skipped it would report the
   * Organization closed with one of its objects still open. Guarded like every
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

  private stageDefaultPublications(
    targets: readonly WorkspaceSpaceDefaultTarget[],
    requestedByUserId: string,
    now: number,
  ): void {
    for (const target of targets) {
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
  listableChannelIds(userId: string, workstreamIds: readonly string[]): string[] {
    const listable: string[] = [];
    for (const chunk of boundParameterChunks(workstreamIds)) {
      for (const row of this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `SELECT directory.workstream_id
           FROM channels directory
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?
            AND viewer.authority_generation = directory.authority_generation
          WHERE directory.workstream_id IN (${chunk.map(() => "?").join(", ")})
            AND ${channelVisibleToViewerSql("directory", "viewer")}
          ORDER BY directory.workstream_id`,
        userId,
        ...chunk,
      ).toArray()) listable.push(row.workstream_id);
    }
    return listable;
  }

  private memberWorkstreamIdsUnchecked(spaceId: string): string[] {
    return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `SELECT workstream_id FROM space_channel_memberships
        WHERE space_id = ? AND state = 'active' ORDER BY workstream_id`,
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
  visibleSpaceIdsAmong(userId: string, spaceIds: readonly string[]): string[] {
    if (!this.ready() || spaceIds.length === 0) return [];
    const visible: string[] = [];
    for (const chunk of boundParameterChunks(spaceIds)) {
      for (const row of this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `SELECT space.space_id
           FROM spaces space
           LEFT JOIN space_viewers viewer
             ON viewer.space_id = space.space_id
            AND viewer.user_id = ? AND viewer.is_participant = 1
          WHERE ${spaceVisibleToViewerSql("space", "viewer")}
            AND space.space_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY space.space_id`,
        userId,
        userId,
        ...chunk,
      ).toArray()) visible.push(row.space_id);
    }
    return visible;
  }

  /** Active Spaces this viewer may see, in creation order. */
  private visibleSpaceIds(userId: string): string[] {
    if (!this.ready()) return [];
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT space.space_id
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.archived_at IS NULL
          AND ${spaceVisibleToViewerSql("space", "viewer")}
        ORDER BY space.created_at, space.space_id`,
      userId,
      userId,
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
  reach(userId: string, spaceId: string, activeOnly = false): SpaceReach | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ reach: SpaceReach } & Record<string, SqlStorageValue>>(
      `SELECT ${spaceReachSql("space", "viewer")} AS reach
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.space_id = ?
          AND (? = 0 OR space.archived_at IS NULL)
          AND ${spaceVisibleToViewerSql("space", "viewer")}`,
      userId,
      spaceId,
      activeOnly ? 1 : 0,
      userId,
    ).toArray()[0]?.reach ?? null;
  }

  private canRead(userId: string, spaceId: string): boolean {
    return this.reach(userId, spaceId) !== null;
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
    const reach = this.reach(userId, spaceId, activeOnly);
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

  private directory(workspaceId: string, userId: string): SpaceDirectory {
    const rows = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*, ${spaceReachSql("space", "viewer")} AS reach
         FROM workspace_container_order ordering
         JOIN spaces space ON space.space_id = ordering.item_id
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE ordering.user_id = ? AND ordering.container_kind = 'organization'
          AND ordering.container_id = ? AND space.archived_at IS NULL
          AND ${spaceVisibleToViewerSql("space", "viewer")}
        ORDER BY ordering.position, space.space_id`,
      userId,
      userId,
      workspaceId,
      userId,
    ).toArray();
    const attentionCounts = this.attentionCounts(userId, rows.map((row) => row.space_id));
    return SpaceDirectorySchema.parse({
      waterline: this.waterline(),
      items: rows.map((row) => this.summary(row, userId, attentionCounts.get(row.space_id) ?? 0)),
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
    const space = this.space(spaceId, userId);
    if (space === false) throw new Error("workspace_space_unreadable_after_write");
    return space;
  }

  /**
   * One Space as this viewer is answered with it, or `false` when it is not
   * theirs to see.
   *
   * Takes the viewer because the summary now carries one viewer-dependent
   * field, and renders {@link spaceVisibleToViewerSql} because
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
  private space(spaceId: string, userId: string): SpaceSummary | false {
    const row = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*, ${spaceReachSql("space", "viewer")} AS reach
         FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.space_id = ?
          AND ${spaceVisibleToViewerSql("space", "viewer")}`,
      userId,
      spaceId,
      userId,
    ).toArray()[0];
    return row === undefined
      ? false
      : this.summary(row, userId, this.attentionCount(userId, row.space_id));
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
      : this.summary(row, userId, this.attentionCount(userId, row.space_id));
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
  private summary(row: SpaceRow, userId: string, attentionCount: number): SpaceSummary {
    const appearance = row.appearance_json
      ? JSON.parse(row.appearance_json) as { icon?: unknown; color?: unknown }
      : null;
    const icon = typeof appearance?.icon === "string" ? appearance.icon : null;
    const color = typeof appearance?.color === "string" ? appearance.color : null;
    return SpaceSummarySchema.parse({
      id: row.space_id,
      name: row.title,
      // Coerced rather than parsed. The appearance is the Space's own object's,
      // and its icon vocabulary is the Channel's wider one — a key outside the
      // Space picker still has to render as something rather than throw on a
      // read of the whole directory.
      iconKey: icon && SPACE_ICON_KEY_SET.has(icon) ? icon : SPACE_ICON_FALLBACK,
      colorKey: color && SPACE_COLOR_KEY_SET.has(color) ? color : SPACE_COLOR_FALLBACK,
      scope: row.scope,
      status: row.archived_at === null ? "active" : "archived",
      systemRole: row.system_role,
      revision: row.revision,
      reach: row.reach,
      participants: row.reach === "through_channel"
        ? []
        : this.participantUserIds(row.space_id).map((participantId) => ({ userId: participantId })),
      channelCount: this.channelCount(row.space_id, userId, row.reach),
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
   * {@link spaceReachedThroughChannelSql} tests for existence, so such a
   * viewer's count is never zero.
   */
  private channelCount(spaceId: string, userId: string, reach: SpaceReach): number {
    const viewerScoped = reach === "through_channel";
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
          ${viewerScoped ? `AND ${channelVisibleToViewerSql("directory", "viewer")}` : ""}`,
      ...(viewerScoped ? [userId] : []),
      spaceId,
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

  private advanceWaterline(now: number): void {
    this.storage.sql.exec(
      "UPDATE workspace_space_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1",
      now,
    );
  }
}

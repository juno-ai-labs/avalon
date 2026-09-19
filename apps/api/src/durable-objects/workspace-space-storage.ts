import type { SqlStorageValue } from "@cloudflare/workers-types";

import {
  SpaceChannelPageSchema,
  SpaceDirectorySchema,
  SpaceSummarySchema,
  asSpaceId,
  asUserId,
  asWorkstreamId,
  SPACE_ICON_KEYS,
  SPACE_COLOR_KEYS_STORABLE,
  type SpaceChannelPage,
  type SpaceDirectory,
  type SpaceSummary,
  type UserId,
} from "@rally/contracts";

import { boundParameterChunks } from "./bound-parameters";
import type {
  RemainingChannelAudience,
  SpaceDefaultKind,
  SpaceMember,
  SpaceMembershipReach,
  WorkspaceSpaceAudienceNoteRequest,
  WorkspaceSpaceDefaultRequest,
  WorkspaceSpaceDefaultResult,
  WorkspaceSpaceDefaultTarget,
  WorkspaceSpaceMembershipPlanResult,
  WorkspaceSpaceMutationResult,
  WorkspaceSpaceMembershipRemovalRequest,
  WorkspaceSpaceMembershipRequest,
  WorkspaceSpaceMembershipSettleRequest,
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
  `CREATE TABLE workspace_space_order (
    user_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, space_id)
  ) STRICT`,
  `CREATE INDEX workspace_space_order_user_position_idx
    ON workspace_space_order(user_id, position, space_id)`,
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
  `CREATE TABLE space_intents (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
      'add', 'remove', 'audience', 'archive', 'restore', 'default', 'bootstrap'
    )),
    space_id TEXT NOT NULL,
    workstream_id TEXT,
    space_revision INTEGER NOT NULL CHECK (space_revision > 0),
    membership_generation INTEGER CHECK (membership_generation IS NULL OR membership_generation > 0),
    delivery_generation INTEGER CHECK (delivery_generation IS NULL OR delivery_generation > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'settled', 'cancelled')),
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
  `CREATE TABLE space_bootstrap (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'general', 'memberships', 'audience', 'complete')),
    general_space_id TEXT,
    cursor TEXT,
    blocked_json TEXT NOT NULL CHECK (json_valid(blocked_json)),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0)
  ) STRICT`,
  `INSERT INTO space_bootstrap
     (id, phase, general_space_id, cursor, blocked_json, started_at, updated_at, completed_at)
   VALUES (1, 'pending', NULL, NULL, '[]', 0, 0, NULL)`,
  `CREATE TABLE space_bootstrap_receipts (
    workstream_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
    PRIMARY KEY (workstream_id, phase)
  ) STRICT`,
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

interface SpaceRow extends Record<string, SqlStorageValue> {
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

export interface WorkspaceSpaceIntentClaim {
  operationId: string;
  kind: "add" | "remove" | "audience" | "archive" | "restore" | "default" | "bootstrap";
  spaceId: string;
  workstreamId: string | null;
  spaceRevision: number;
  membershipGeneration: number | null;
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

/** A directory with nothing in it, for an object whose Space tables are absent. */
const EMPTY_DIRECTORY: SpaceDirectory = SpaceDirectorySchema.parse({ waterline: 0, items: [] });

/** Synchronous repository for the Space state owned by one WorkspaceDO. */
export class WorkspaceSpaceStorage {
  private tablesPresent: boolean | null = null;

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
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_space_directory'`,
    ).toArray().length === 1;
    return this.tablesPresent;
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
        "SELECT MAX(created_at) AS created_at FROM workspace_space_directory",
      ).one().created_at;
      const createdAt = Math.max(now, (previousCreatedAt ?? -1) + 1);
      this.storage.sql.exec(
        `INSERT INTO workspace_space_directory (
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
        `INSERT INTO workspace_space_viewers
           (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
         VALUES (?, ?, 1, 1, 0, '')`,
        spaceId,
        request.userId,
      );
      this.appendOrder(request.userId, spaceId, createdAt);
      this.advanceWaterline(createdAt);
      return this.space(spaceId);
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
      return { space: this.space(winner), created: false };
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
        `DELETE FROM workspace_space_directory
          WHERE space_id = ? AND source_version = 0 AND created_by_user_id = ?
          RETURNING space_id`,
        spaceId,
        createdByUserId,
      ).toArray().length === 1;
      if (!removed) return false;
      this.storage.sql.exec("DELETE FROM workspace_space_viewers WHERE space_id = ?", spaceId);
      this.storage.sql.exec("DELETE FROM workspace_space_order WHERE space_id = ?", spaceId);
      this.advanceWaterline(now);
      return true;
    });
  }

  list(userId: string, now = Date.now()): SpaceDirectory {
    if (!this.ready()) return EMPTY_DIRECTORY;
    return this.storage.transactionSync(() => {
      for (const spaceId of this.visibleSpaceIds(userId)) this.appendOrder(userId, spaceId, now);
      return this.directory(userId);
    });
  }

  listInactive(userId: string): SpaceDirectory {
    if (!this.ready()) return EMPTY_DIRECTORY;
    const rows = this.storage.sql.exec<SpaceRow>(
      `SELECT space.* FROM workspace_space_directory space
         LEFT JOIN workspace_space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.archived_at IS NOT NULL
          AND (space.scope = 'workspace' OR viewer.user_id IS NOT NULL)
        ORDER BY space.updated_at DESC, space.space_id`,
      userId,
    ).toArray();
    return SpaceDirectorySchema.parse({
      waterline: this.waterline(),
      items: rows.map((row) => this.summary(row)),
    });
  }

  reorder(userId: string, requestedIds: readonly string[], now = Date.now()): SpaceDirectory {
    return this.storage.transactionSync(() => {
      const visible = this.visibleSpaceIds(userId);
      for (const spaceId of visible) this.appendOrder(userId, spaceId, now);
      const visibleSet = new Set(visible);
      const current = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `SELECT space_id FROM workspace_space_order
          WHERE user_id = ? ORDER BY position, space_id`,
        userId,
      ).toArray().map((row) => row.space_id).filter((id) => visibleSet.has(id));
      const requested = [...new Set(requestedIds)].filter((id) => visibleSet.has(id));
      const requestedSet = new Set(requested);
      const ordered = [...requested, ...current.filter((id) => !requestedSet.has(id))];
      for (const [position, spaceId] of ordered.entries()) {
        this.storage.sql.exec(
          `UPDATE workspace_space_order SET position = ?, updated_at = ?
            WHERE user_id = ? AND space_id = ?`,
          position,
          now,
          userId,
          spaceId,
        );
      }
      this.advanceWaterline(now);
      return this.directory(userId);
    });
  }

  /** One Space as this viewer may see it, archived or not. */
  readable(userId: string, spaceId: string): SpaceSummary | false {
    if (!this.canRead(userId, spaceId)) return false;
    return this.space(spaceId);
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
      if (!this.canRead(request.userId, request.spaceId)) return false;
      const updated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE workspace_space_directory
            SET title = ?, appearance_json = ?, revision = revision + 1, updated_at = ?
          WHERE space_id = ? RETURNING space_id`,
        request.presentation.name.trim(),
        JSON.stringify({ icon: request.presentation.iconKey, color: request.presentation.colorKey }),
        now,
        request.spaceId,
      ).toArray()[0];
      if (!updated) return false;
      this.advanceWaterline(now);
      return this.space(request.spaceId);
    });
  }

  /**
   * Record the scope and participants the Space's own authority accepted.
   *
   * Participants are the viewer rows, which is the same table the
   * `directory_user` projection writes: the Space's own object decides who its
   * participants are, and this is the provisional copy of that answer.
   */
  applyAudience(request: WorkspaceSpaceAudienceNoteRequest, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.canRead(request.userId, request.spaceId)) return false;
      const updated = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE workspace_space_directory
            SET scope = ?, revision = revision + 1, updated_at = ?
          WHERE space_id = ? AND archived_at IS NULL RETURNING space_id`,
        request.audience.scope,
        now,
        request.spaceId,
      ).toArray()[0];
      if (!updated) return false;
      const requested = new Set<string>(request.audience.participantUserIds);
      for (const row of this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
        "SELECT user_id FROM workspace_space_viewers WHERE space_id = ?",
        request.spaceId,
      ).toArray()) {
        this.storage.sql.exec(
          `UPDATE workspace_space_viewers SET is_participant = ? WHERE space_id = ? AND user_id = ?`,
          requested.has(row.user_id) ? 1 : 0,
          request.spaceId,
          row.user_id,
        );
        requested.delete(row.user_id);
      }
      for (const userId of requested) {
        this.storage.sql.exec(
          `INSERT INTO workspace_space_viewers
             (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
           VALUES (?, ?, 1, 1, 0, '')`,
          request.spaceId,
          userId,
        );
      }
      this.advanceWaterline(now);
      return this.space(request.spaceId);
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
         FROM workspace_space_directory WHERE space_id = ?`,
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
      `INSERT INTO workspace_space_directory (
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
           workspace_space_directory.created_by_user_id, excluded.created_by_user_id
         ),
         authority_generation = excluded.authority_generation,
         source_version = excluded.source_version,
         payload_hash = excluded.payload_hash,
         revision = workspace_space_directory.revision + ?,
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
        `DELETE FROM workspace_space_viewers WHERE space_id = ? AND user_id = ? RETURNING user_id`,
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
         FROM workspace_space_viewers WHERE space_id = ? AND user_id = ?`,
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
      `INSERT INTO workspace_space_viewers
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
        `UPDATE workspace_space_directory SET revision = revision + 1, updated_at = ?
          WHERE space_id = ?`,
        now,
        projection.spaceId,
      );
      this.advanceWaterline(now);
    }
    return changed;
  }

  /** The Channels a surface can list, one page at a time. */
  channelPage(userId: string, spaceId: string, cursor: string | null): SpaceChannelPage | false {
    if (!this.canRead(userId, spaceId)) return false;
    const after = cursor === null ? null : decodeChannelCursor(cursor);
    if (cursor !== null && after === null) return false;
    const rows = this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `SELECT membership.workstream_id
         FROM space_channel_memberships membership
         LEFT JOIN workspace_workstream_directory directory
           ON directory.workstream_id = membership.workstream_id
        WHERE membership.space_id = ? AND membership.state = 'active'
          AND directory.archived_at IS NULL
          AND (? IS NULL OR membership.workstream_id > ?)
        ORDER BY membership.workstream_id
        LIMIT ?`,
      spaceId,
      after,
      after ?? "",
      SPACE_CHANNEL_PAGE_SIZE + 1,
    ).toArray();
    const hasMore = rows.length > SPACE_CHANNEL_PAGE_SIZE;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return SpaceChannelPageSchema.parse({
      items: rows.map((row) => row.workstream_id),
      nextCursor: hasMore && last ? encodeChannelCursor(last.workstream_id) : null,
    });
  }

  /**
   * Every Channel this Space holds, archived ones included.
   *
   * `reach` is the difference between what a surface means by a member and what
   * a retraction fan-out is about. `prepareArchive` and `prepareMembershipRemoval`
   * flip a membership to `removing` *before* the Channel is asked to withdraw
   * the source, so the set a staged operation still has work for is
   * `active` plus `removing` — and an archive that read the active set would
   * walk nothing and leave its source on every Channel it reached.
   */
  members(
    userId: string,
    spaceId: string,
    reach: SpaceMembershipReach = "active",
  ): SpaceMember[] | false {
    if (!this.canRead(userId, spaceId)) return false;
    return this.storage.sql.exec<{
      workstream_id: string;
      generation: number;
    } & Record<string, SqlStorageValue>>(
      reach === "reaching"
        ? `SELECT workstream_id, generation FROM space_channel_memberships
            WHERE space_id = ? AND state IN ('active', 'removing') ORDER BY workstream_id`
        : `SELECT workstream_id, generation FROM space_channel_memberships
            WHERE space_id = ? AND state = 'active' ORDER BY workstream_id`,
      spaceId,
    ).toArray().map((row) => ({
      workstreamId: asWorkstreamId(row.workstream_id),
      membershipGeneration: row.generation,
    }));
  }

  /**
   * Every active Space each of these Channels sits in.
   *
   * One fan-in read rather than one per row: a directory page is up to 250
   * Channels and each may be in several Spaces, and asking per row would put
   * 250 statements behind one sidebar paint. It lives here rather than beside
   * its caller because it is a Space read, and every Space read goes through
   * {@link WorkspaceSpaceStorage.ready} — this one used to be the hole, reading
   * the Space tables straight out of the sidebar payload.
   */
  spaceIdsByChannel(workstreamIds: readonly string[]): Map<string, string[]> {
    const byWorkstream = new Map<string, string[]>();
    if (!this.ready()) return byWorkstream;
    for (const chunk of boundParameterChunks(workstreamIds)) {
      for (const row of this.storage.sql.exec<{
        workstream_id: string;
        space_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT membership.workstream_id, membership.space_id
           FROM space_channel_memberships membership
           JOIN workspace_space_directory space ON space.space_id = membership.space_id
          WHERE membership.state = 'active' AND space.archived_at IS NULL
            AND membership.workstream_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY membership.workstream_id, membership.space_id`,
        ...chunk,
      ).toArray()) {
        const existing = byWorkstream.get(row.workstream_id);
        if (existing) existing.push(row.space_id);
        else byWorkstream.set(row.workstream_id, [row.space_id]);
      }
    }
    return byWorkstream;
  }

  /** The active Spaces a Channel is in, whether or not the reader can see them. */
  channelSpaceIds(workstreamId: string): string[] {
    if (!this.ready()) return [];
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT membership.space_id
         FROM space_channel_memberships membership
         JOIN workspace_space_directory space ON space.space_id = membership.space_id
        WHERE membership.workstream_id = ? AND membership.state = 'active'
          AND space.archived_at IS NULL
        ORDER BY membership.space_id`,
      workstreamId,
    ).toArray().map((row) => row.space_id);
  }

  prepareMembership(
    request: WorkspaceSpaceMembershipRequest,
    now = Date.now(),
  ): WorkspaceSpaceMembershipPlanResult {
    return this.storage.transactionSync(() => {
      if (!this.visibleSpaceIds(request.userId).includes(request.spaceId)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [] };
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
        return {
          ok: true,
          space: this.space(request.spaceId),
          membershipGeneration: existing.generation,
        };
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
      return { ok: true, space: this.space(request.spaceId), membershipGeneration };
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
        "SELECT revision FROM workspace_space_directory WHERE space_id = ? AND archived_at IS NULL",
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
      return this.space(request.spaceId);
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
      return this.space(request.spaceId);
    });
  }

  /**
   * Stage a membership removal, refusing the two removals that would strand a
   * Channel.
   *
   * `space_membership_final` is the invariant every Channel has a home;
   * `space_audience_incompatible` is the weaker one that also has to hold — a
   * reader who keeps access through some other source must still be able to
   * *find* the Channel, which means discovering one of the Spaces it stays in.
   */
  prepareMembershipRemoval(
    request: WorkspaceSpaceMembershipRemovalRequest,
    now = Date.now(),
  ): WorkspaceSpaceMembershipPlanResult {
    return this.storage.transactionSync(() => {
      if (!this.canRead(request.userId, request.spaceId)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [] };
      }
      const membership = this.storage.sql.exec<{
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT generation FROM space_channel_memberships
          WHERE space_id = ? AND workstream_id = ? AND state IN ('joining', 'active')`,
        request.spaceId,
        request.workstreamId,
      ).toArray()[0];
      if (!membership) return { ok: false, code: "space_not_found", unreachableUserIds: [] };
      const remainingSpaceIds = this.otherActiveSpaceIds(request.workstreamId, request.spaceId);
      if (remainingSpaceIds.length === 0) {
        return { ok: false, code: "space_membership_final", unreachableUserIds: [] };
      }
      const unreachable = this.unreachableReaders(remainingSpaceIds, request.remainingAudience);
      if (unreachable.length > 0 || (request.remainingAudience.scope === "workspace"
        && !this.holdsOrganizationWideSpace(remainingSpaceIds))) {
        return { ok: false, code: "space_audience_incompatible", unreachableUserIds: unreachable };
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
      return { ok: true, space: this.space(request.spaceId), membershipGeneration: generation };
    });
  }

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
      this.advanceWaterline(now);
      return this.space(request.spaceId);
    });
  }

  /**
   * The same two tests as a removal, over every member Channel at once.
   *
   * The audience tested here is the Space's own — who it supplies — rather than
   * each Channel's remaining readers, because those live in the Channels' own
   * authorities and reading N of them would put N cross-object awaits inside
   * one refusal. What it proves is the thing that matters for an archive: no
   * Channel is stranded, and nobody this Space was the discovery path for loses
   * every way of finding one.
   */
  prepareArchive(userId: string, spaceId: string, now = Date.now()): WorkspaceSpaceMutationResult {
    return this.storage.transactionSync(() => {
      if (!this.visibleSpaceIds(userId).includes(spaceId)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [] };
      }
      const row = this.storage.sql.exec<{
        scope: "personal" | "workspace";
        system_role: string | null;
        revision: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT scope, system_role, revision FROM workspace_space_directory WHERE space_id = ?",
        spaceId,
      ).one();
      if (row.system_role === "general") {
        return { ok: false, code: "space_protected", unreachableUserIds: [] };
      }
      const audience: RemainingChannelAudience = {
        scope: row.scope,
        participantUserIds: this.participantUserIds(spaceId).map(asUserId),
      };
      for (const workstreamId of this.memberWorkstreamIdsUnchecked(spaceId)) {
        const remainingSpaceIds = this.otherActiveSpaceIds(workstreamId, spaceId);
        if (remainingSpaceIds.length === 0) {
          return { ok: false, code: "space_membership_final", unreachableUserIds: [] };
        }
        const unreachable = this.unreachableReaders(remainingSpaceIds, audience);
        if (unreachable.length > 0 || (audience.scope === "workspace"
          && !this.holdsOrganizationWideSpace(remainingSpaceIds))) {
          return { ok: false, code: "space_audience_incompatible", unreachableUserIds: unreachable };
        }
      }
      this.storage.sql.exec(
        `UPDATE space_channel_memberships SET state = 'removing', generation = generation + 1, updated_at = ?
          WHERE space_id = ? AND state = 'active'`,
        now,
        spaceId,
      );
      this.advanceWaterline(now);
      return { ok: true, space: this.space(spaceId) };
    });
  }

  /** Commit the archive the preflight staged. General is refused here too. */
  finalizeArchive(userId: string, spaceId: string, now = Date.now()): SpaceSummary | "protected" | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleSpaceIds(userId).includes(spaceId)) return false;
      const protectedRow = this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS one FROM workspace_space_directory
          WHERE space_id = ? AND system_role = 'general'`,
        spaceId,
      ).toArray()[0];
      if (protectedRow) return "protected";
      const archived = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE workspace_space_directory
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
      return this.space(spaceId);
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
  restore(userId: string, spaceId: string, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      const readable = this.listInactive(userId).items.some((space) => space.id === spaceId);
      if (!readable) return false;
      const restored = this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE workspace_space_directory
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
      this.appendOrder(userId, spaceId, now);
      this.advanceWaterline(now);
      return this.space(spaceId);
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
      if (!this.visibleSpaceIds(request.userId).includes(request.spaceId)) {
        return { ok: false, code: "space_not_found", unreachableUserIds: [] };
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
        return { ok: true, space: this.space(request.spaceId), targets };
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
      return { ok: true, space: this.space(request.spaceId), targets };
    });
  }

  removeDefault(request: WorkspaceSpaceDefaultRequest, now = Date.now()): SpaceSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleSpaceIds(request.userId).includes(request.spaceId)) return false;
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
      return this.space(request.spaceId);
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
         JOIN workspace_space_directory space ON space.space_id = target.space_id
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
    deliveryGeneration: number | null;
    requestedByUserId: string;
    notBefore: number;
  }, now = Date.now()): void {
    this.storage.sql.exec(
      `INSERT INTO space_intents (
         operation_id, kind, space_id, workstream_id, space_revision,
         membership_generation, delivery_generation, state, receipts_json,
         requested_by_user_id, not_before, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '[]', ?, ?, 0, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      input.operationId,
      input.kind,
      input.spaceId,
      input.workstreamId,
      input.spaceRevision,
      input.membershipGeneration,
      input.deliveryGeneration,
      input.requestedByUserId,
      input.notBefore,
      now,
      now,
    );
  }

  /** Append one receipt and, when the operation is done, settle it. */
  settleIntent(operationId: string, receipt: string, settled: boolean, now = Date.now()): void {
    if (!this.ready()) return;
    this.storage.sql.exec(
      `UPDATE space_intents
          SET receipts_json = json_insert(receipts_json, '$[#]', ?),
              state = CASE WHEN ? = 1 THEN 'settled' ELSE 'applied' END,
              updated_at = ?
        WHERE operation_id = ? AND state IN ('pending', 'applied')`,
      receipt,
      settled ? 1 : 0,
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
        requested_by_user_id: string;
        attempts: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT operation_id, kind, space_id, workstream_id, space_revision,
                membership_generation, requested_by_user_id, attempts
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
        requestedByUserId: row.requested_by_user_id,
      }));
    });
  }

  /** The Organization's one General Space, or nothing if it has none yet. */
  generalSpaceId(): string | null {
    if (!this.ready()) return null;
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      "SELECT space_id FROM workspace_space_directory WHERE system_role = 'general'",
    ).toArray()[0]?.space_id ?? null;
  }

  bootstrapStatus(): WorkspaceSpaceBootstrapStatus {
    // An object that has not reached migration 61 has not started its cutover
    // either, which is what `pending` says — and `ready: false` is what keeps a
    // client on the Organization-opening state rather than showing a hierarchy
    // that does not exist yet.
    if (!this.ready()) {
      return { phase: "pending", generalSpaceId: null, blockedWorkstreamIds: [], ready: false };
    }
    const row = this.storage.sql.exec<{
      phase: WorkspaceSpaceBootstrapStatus["phase"];
      general_space_id: string | null;
      blocked_json: string;
    } & Record<string, SqlStorageValue>>(
      "SELECT phase, general_space_id, blocked_json FROM space_bootstrap WHERE id = 1",
    ).one();
    const blocked = JSON.parse(row.blocked_json) as unknown;
    return {
      phase: row.phase,
      generalSpaceId: row.general_space_id === null ? null : asSpaceId(row.general_space_id),
      blockedWorkstreamIds: Array.isArray(blocked)
        ? blocked.filter((value): value is string => typeof value === "string").map(asWorkstreamId)
        : [],
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
   */
  noteMemberArchivalChange(workstreamIds: readonly string[], now = Date.now()): boolean {
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

  waterline(): number {
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
         JOIN workspace_space_directory space ON space.space_id = membership.space_id
        WHERE membership.workstream_id = ? AND membership.state = 'active'
          AND membership.space_id <> ? AND space.archived_at IS NULL
        ORDER BY membership.space_id`,
      workstreamId,
      departingSpaceId,
    ).toArray().map((row) => row.space_id);
  }

  private holdsOrganizationWideSpace(spaceIds: readonly string[]): boolean {
    return boundParameterChunks(spaceIds).some((chunk) => (
      this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS one FROM workspace_space_directory
          WHERE scope = 'workspace' AND archived_at IS NULL
            AND space_id IN (${chunk.map(() => "?").join(", ")}) LIMIT 1`,
        ...chunk,
      ).toArray().length > 0
    ));
  }

  /**
   * Readers who could discover none of these Spaces.
   *
   * An Organization-wide Space is discoverable by any active member, so one of
   * those covers everybody and the answer is empty. Otherwise a reader is
   * covered when they participate in one of the remaining personal Spaces.
   */
  private unreachableReaders(
    spaceIds: readonly string[],
    audience: RemainingChannelAudience,
  ): UserId[] {
    if (spaceIds.length === 0) return [...new Set(audience.participantUserIds)];
    if (this.holdsOrganizationWideSpace(spaceIds)) return [];
    const reachable = new Set<string>();
    for (const chunk of boundParameterChunks(spaceIds)) {
      for (const row of this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
        `SELECT DISTINCT user_id FROM workspace_space_viewers
          WHERE is_participant = 1 AND space_id IN (${chunk.map(() => "?").join(", ")})`,
        ...chunk,
      ).toArray()) reachable.add(row.user_id);
    }
    return [...new Set(audience.participantUserIds)].filter((userId) => !reachable.has(userId));
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
      `SELECT user_id FROM workspace_space_viewers
        WHERE space_id = ? AND is_participant = 1 ORDER BY user_id`,
      spaceId,
    ).toArray().map((row) => row.user_id);
  }

  /** Active Spaces this viewer may see, in creation order. */
  private visibleSpaceIds(userId: string): string[] {
    if (!this.ready()) return [];
    return this.storage.sql.exec<{ space_id: string } & Record<string, SqlStorageValue>>(
      `SELECT space.space_id
         FROM workspace_space_directory space
         LEFT JOIN workspace_space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE space.archived_at IS NULL
          AND (space.scope = 'workspace' OR viewer.user_id IS NOT NULL)
        ORDER BY space.created_at, space.space_id`,
      userId,
    ).toArray().map((row) => row.space_id);
  }

  private canRead(userId: string, spaceId: string): boolean {
    return this.visibleSpaceIds(userId).includes(spaceId)
      || this.listInactive(userId).items.some((space) => space.id === spaceId);
  }

  private appendOrder(userId: string, spaceId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_space_order
         (user_id, space_id, position, created_at, updated_at)
       VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM workspace_space_order
                                WHERE user_id = ?), 0), ?, ?)`,
      userId,
      spaceId,
      userId,
      now,
      now,
    );
  }

  private directory(userId: string): SpaceDirectory {
    const rows = this.storage.sql.exec<SpaceRow>(
      `SELECT space.*
         FROM workspace_space_order ordering
         JOIN workspace_space_directory space ON space.space_id = ordering.space_id
         LEFT JOIN workspace_space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE ordering.user_id = ? AND space.archived_at IS NULL
          AND (space.scope = 'workspace' OR viewer.user_id IS NOT NULL)
        ORDER BY ordering.position, space.space_id`,
      userId,
      userId,
    ).toArray();
    return SpaceDirectorySchema.parse({
      waterline: this.waterline(),
      items: rows.map((row) => this.summary(row)),
    });
  }

  private space(spaceId: string): SpaceSummary {
    return this.summary(this.storage.sql.exec<SpaceRow>(
      "SELECT * FROM workspace_space_directory WHERE space_id = ?",
      spaceId,
    ).one());
  }

  private summary(row: SpaceRow): SpaceSummary {
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
      participants: this.participantUserIds(row.space_id).map((userId) => ({ userId })),
      channelCount: this.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
        `SELECT COUNT(*) AS count
           FROM space_channel_memberships membership
           LEFT JOIN workspace_workstream_directory directory
             ON directory.workstream_id = membership.workstream_id
          WHERE membership.space_id = ? AND membership.state = 'active'
            AND directory.archived_at IS NULL`,
        row.space_id,
      ).one().count,
      defaultResourceIds: this.defaultIds(row.space_id, "resource"),
      defaultSidekickIds: this.defaultIds(row.space_id, "sidekick"),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
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

import type { SqlStorageValue } from "@cloudflare/workers-types";

import type { ParentEffectEnvelope } from "@rally/contracts/conversation-effects";

import { projectionSupersedes, type StoredProjection } from "./projection-fence";

/**
 * The Organization's projection of a Channel's breakouts.
 *
 * A breakout is a conversation under a Channel, owned by that Channel's
 * hosted parent. Until the Space dashboard had to list one, the Organization
 * had no reason to know it existed: `aggregatesChildProjection` folded only the
 * main conversation into the Channel's row, and a breakout's own
 * `directory_common` and `directory_user` effects were stored in the Channel
 * object's `substream_directory` and stopped there. The dashboard's list is
 * "every conversation in this Space that needs you", which a breakout can be
 * while its Channel is not, so the projection now travels the rest of the way.
 *
 * These are **two more directory tables, not a widening of the Channel's.**
 * `channels` is read as "one row per Channel" by every
 * sidebar page, pin, watch registration, retirement enumeration and cutover
 * query in WorkspaceDO; a `substream_id` column there would have made each of
 * those learn a filter it does not have today, and the first one that forgot
 * would have listed a breakout as a Channel. Keeping them apart means the only
 * query that has to know both exist is the one that deliberately lists both.
 *
 * Nothing publishes these rows to the sidebar socket. The Organization holds
 * them so one paginated read can answer with them; no other surface draws a
 * breakout, and a projection nobody draws does not belong on every member's
 * socket.
 */

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

/** One breakout's row, as the page reads it back. */
export interface WorkspaceBreakoutRow extends Record<string, SqlStorageValue> {
  workstream_id: string;
  substream_id: string;
  title: string;
  description: string;
  scope: "personal" | "workspace";
  exact_state: string;
  title_status: "naming" | "automatic" | "settled";
  created_by_user_id: string | null;
  last_activity_at: number;
  archived_at: number | null;
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  source_created_at: number;
  source_updated_at: number;
  seen_attention_ordinal: number | null;
  manual_unread_from_ordinal: number | null;
  manual_unread_generation: number | null;
  latest_mention_attention_ordinal: number | null;
  unseen: number | null;
  parent_title: string;
  appearance_json: string | null;
  parent_appearance_json: string | null;
}

/**
 * Everything one breakout row needs, joined to this viewer's half and to the
 * parent Channel's title.
 *
 * The parent's title comes from the Channel directory in the same statement
 * because the row prints it — a breakout called "Pricing" says nothing on its
 * own — and a second read per row would be a round trip per breakout.
 */
export const SELECT_WORKSPACE_BREAKOUT = `SELECT breakout.workstream_id, breakout.substream_id,
    breakout.title, breakout.description, breakout.scope, breakout.exact_state,
    breakout.appearance_json,
    breakout.title_status, breakout.created_by_user_id, breakout.last_activity_at,
    breakout.archived_at, breakout.latest_attention_ordinal,
    breakout.unread_tracking_start_ordinal, breakout.source_created_at,
    breakout.source_updated_at,
    viewer.seen_attention_ordinal, viewer.manual_unread_from_ordinal,
    viewer.manual_unread_generation, viewer.latest_mention_attention_ordinal,
    viewer.unseen, parent.title AS parent_title,
    parent.appearance_json AS parent_appearance_json
  FROM breakouts breakout
  LEFT JOIN breakout_viewers viewer
    ON viewer.workstream_id = breakout.workstream_id
   AND viewer.substream_id = breakout.substream_id
   AND viewer.user_id = ?
   AND viewer.authority_generation = breakout.authority_generation
  JOIN channels parent
    ON parent.workstream_id = breakout.workstream_id`;

/**
 * Synchronous repository for one WorkspaceDO's breakout projections.
 *
 * Every method assumes it is already inside the caller's transaction, the way
 * the Channel directory's own writes in `workspace-do.ts` are: the receipt
 * that makes a redelivery a no-op is written by the caller in the same commit,
 * and a row committed without its receipt would be applied twice.
 */
export class WorkspaceBreakoutStorage {
  private tablesPresent: boolean | null = null;
  private appearanceColumnPresent = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Whether this object has reached migration 63.
   *
   * The same guard, for the same reason, as `WorkspaceSpaceStorage.ready`: an
   * Organization held at schema 57 by the meeting-notes retirement runs on a
   * database with none of these tables. The caller must leave a breakout
   * projection unaccepted in that state: a live child update will eventually
   * supersede an ordinary dropped projection, but WorkstreamDO migration 19 is
   * a once-only replay for quiet existing breakouts and has no later update to
   * rely on. An incomplete acceptance makes the Queue retry after migration 63
   * creates the destination tables.
   */
  ready(): boolean {
    if (this.tablesPresent === null) {
      const columns = this.storage.sql.exec<{ name: string } & Record<string, SqlStorageValue>>(
        `PRAGMA table_info(breakouts)`,
      ).toArray();
      this.tablesPresent = columns.length > 0;
      this.appearanceColumnPresent = columns.some((column) => column.name === "appearance_json");
    }
    return this.tablesPresent;
  }

  /**
   * Apply one breakout's shared projection, fenced generation-then-version.
   *
   * The fence is {@link projectionSupersedes}, which is the Channel
   * directory's too: an out-of-order redelivery must not overwrite a newer
   * row, and two different payloads claiming one version are a conflict rather
   * than a silent last-writer-wins. The code it throws names this table, so a
   * log says which projection was rejected.
   */
  applyCommon(envelope: ParentEffectEnvelope, now: number): boolean {
    if (!this.ready()) return false;
    if (envelope.effect.kind !== "directory_common" || envelope.substreamId === undefined) return false;
    const effect = envelope.effect;
    const current = this.storage.sql.exec<StoredProjection & Record<string, SqlStorageValue>>(
      `SELECT authority_generation, waterline, payload_hash
         FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
      envelope.parentId,
      envelope.substreamId,
    ).toArray()[0];
    if (!projectionSupersedes(envelope, current, "workspace_breakout_projection_version_conflict")) {
      return false;
    }
    // A background agent is not a breakout. Its Channel forwards one only to
    // withdraw a row it published before the agent was marked. The row is kept
    // as an archived tombstone rather than deleted: every reader lists only
    // unarchived rows, and keeping it keeps the version fence, so an older
    // unmarked projection the Queue delivers late cannot bring it back. Its
    // viewer rows go; one that arrives late joins an archived row and lists
    // nothing.
    const tombstone = effect.backgroundAgent === true;
    if (tombstone) {
      this.storage.sql.exec(
        `DELETE FROM breakout_viewers WHERE workstream_id = ? AND substream_id = ?`,
        envelope.parentId,
        envelope.substreamId,
      );
    }
    // A schema-57 Organization can receive the migration-63 tables while its
    // cleanup still holds later migrations. Keep the once-only replay retryable
    // through that interval, then persist appearance once migration 69 lands.
    const appearanceColumn = this.appearanceColumnPresent ? ", appearance_json" : "";
    const appearanceValue = this.appearanceColumnPresent ? ", ?" : "";
    const appearanceUpdate = this.appearanceColumnPresent
      ? ", appearance_json = excluded.appearance_json" : "";
    this.storage.sql.exec(
      `INSERT INTO breakouts
         (workstream_id, substream_id, authority_generation, waterline, source_event_id,
          payload_hash, title, description, scope, exact_state${appearanceColumn}, title_status,
          created_by_user_id, last_activity_at, completed_at, archived_at,
          latest_attention_ordinal, unread_tracking_start_ordinal,
          source_created_at, source_updated_at, projected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${appearanceValue}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workstream_id, substream_id) DO UPDATE SET
         authority_generation = excluded.authority_generation,
         waterline = excluded.waterline,
         source_event_id = excluded.source_event_id,
         payload_hash = excluded.payload_hash,
         title = excluded.title, description = excluded.description,
         scope = excluded.scope, exact_state = excluded.exact_state${appearanceUpdate},
         title_status = excluded.title_status,
         created_by_user_id = excluded.created_by_user_id,
         last_activity_at = excluded.last_activity_at,
         completed_at = excluded.completed_at, archived_at = excluded.archived_at,
         latest_attention_ordinal = excluded.latest_attention_ordinal,
         unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
         source_created_at = excluded.source_created_at,
         source_updated_at = excluded.source_updated_at,
         projected_at = excluded.projected_at`,
      envelope.parentId,
      envelope.substreamId,
      envelope.generation,
      envelope.sourceVersion,
      envelope.messageId,
      envelope.payloadHash,
      effect.title,
      effect.description,
      effect.scope,
      effect.state,
      ...(this.appearanceColumnPresent ? [effect.appearance ? JSON.stringify(effect.appearance) : null] : []),
      effect.titleStatus ?? "settled",
      effect.createdByUserId ?? null,
      epochMilliseconds(effect.lastActivityAt) ?? now,
      epochMilliseconds(effect.completedAt),
      tombstone ? epochMilliseconds(effect.archivedAt) ?? now : epochMilliseconds(effect.archivedAt),
      effect.latestAttentionOrdinal ?? 0,
      effect.unreadTrackingStartOrdinal ?? 0,
      epochMilliseconds(effect.createdAt ?? effect.lastActivityAt) ?? now,
      epochMilliseconds(effect.updatedAt ?? effect.lastActivityAt) ?? now,
      now,
    );
    return true;
  }

  /**
   * Apply one person's projection of one breakout.
   *
   * A person who is no longer an active member of the Organization has their
   * row deleted rather than written, exactly as the Channel viewers do: the
   * projection is discovery state for somebody who can no longer discover
   * anything here, and leaving it would list a breakout for an account that
   * has been removed.
   *
   * `participationChanged` says the person joined or left the breakout, the
   * same flip the Channel viewer write reports; everything else a projection
   * carries (unread, mention, first open) moves only `moved`.
   */
  applyViewer(
    envelope: ParentEffectEnvelope,
    activeMember: boolean,
    now: number,
  ): { moved: boolean; participationChanged: boolean } {
    const unchanged = { moved: false, participationChanged: false };
    if (!this.ready()) return unchanged;
    if (envelope.effect.kind !== "directory_user" || envelope.substreamId === undefined) return unchanged;
    const effect = envelope.effect;
    if (!activeMember) {
      const deleted = this.storage.sql.exec<{ is_participant: number } & Record<string, SqlStorageValue>>(
        `DELETE FROM breakout_viewers
          WHERE workstream_id = ? AND substream_id = ? AND user_id = ? RETURNING is_participant`,
        envelope.parentId,
        envelope.substreamId,
        effect.userId,
      ).toArray()[0];
      return { moved: deleted !== undefined, participationChanged: deleted?.is_participant === 1 };
    }
    const current = this.storage.sql.exec<StoredProjection & {
      is_participant: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT authority_generation, waterline, payload_hash, is_participant
         FROM breakout_viewers
        WHERE workstream_id = ? AND substream_id = ? AND user_id = ?`,
      envelope.parentId,
      envelope.substreamId,
      effect.userId,
    ).toArray()[0];
    if (!projectionSupersedes(envelope, current, "workspace_breakout_viewer_version_conflict")) {
      return unchanged;
    }
    this.storage.sql.exec(
      `INSERT INTO breakout_viewers
         (workstream_id, substream_id, user_id, authority_generation, waterline,
          source_event_id, payload_hash, is_participant, unread_count,
          you_are_mentioned, unseen, listable, seen_attention_ordinal,
          manual_unread_from_ordinal, manual_unread_generation,
          latest_mention_attention_ordinal, projected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workstream_id, substream_id, user_id) DO UPDATE SET
         authority_generation = excluded.authority_generation,
         waterline = excluded.waterline,
         source_event_id = excluded.source_event_id,
         payload_hash = excluded.payload_hash,
         is_participant = excluded.is_participant,
         unread_count = excluded.unread_count,
         you_are_mentioned = excluded.you_are_mentioned,
         unseen = excluded.unseen, listable = excluded.listable,
         seen_attention_ordinal = excluded.seen_attention_ordinal,
         manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
         manual_unread_generation = excluded.manual_unread_generation,
         latest_mention_attention_ordinal = excluded.latest_mention_attention_ordinal,
         projected_at = excluded.projected_at`,
      envelope.parentId,
      envelope.substreamId,
      effect.userId,
      envelope.generation,
      envelope.sourceVersion,
      envelope.messageId,
      envelope.payloadHash,
      effect.isParticipant ? 1 : 0,
      effect.unreadCount,
      effect.youAreMentioned ? 1 : 0,
      effect.unseen === true ? 1 : 0,
      effect.listable ? 1 : 0,
      effect.seenAttentionOrdinal ?? 0,
      effect.manualUnreadFromOrdinal ?? null,
      effect.manualUnreadGeneration ?? 0,
      effect.latestMentionAttentionOrdinal ?? 0,
      now,
    );
    return { moved: true, participationChanged: (current?.is_participant === 1) !== effect.isParticipant };
  }
}

function epochMilliseconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

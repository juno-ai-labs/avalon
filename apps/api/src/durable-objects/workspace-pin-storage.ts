import type { Pin, PinKind } from "@rally/contracts";

/**
 * Migration 97: one table for everything a person pins, and the indexes the
 * Channels and Threads tabs read through.
 *
 * **Pins.** A thread, a Channel (storage `space`) and a breakout are pinned the
 * same way — one person, one item, a position in that person's list of that
 * kind — so they are one table keyed by kind rather than three. The old
 * per-Space thread pins (`workspace_workstream_pins`, migration 66) and All's
 * order (`workspace_pinned_order`, migration 87) are copied in as thread pins:
 * a thread pinned in two Spaces is one pin now, placed by All's order where the
 * person had arranged it and by its earliest Space position after that. The old
 * tables stay, and the old routes keep writing them, so a Worker from before
 * this migration still reads what it wrote; see `docs/workstream-pinning.md`.
 *
 * No foreign key to `channels` or `spaces`, for the reason `space_invitees`
 * gives: a key would make a future rebuild of either cascade here. A pin whose
 * item is gone is dropped where it is read.
 *
 * **Indexes.** The Threads tab lists the threads and breakouts one person takes
 * part in, which is the first read of either viewer table to start from the
 * person rather than the conversation, so each gets its `(user_id,
 * is_participant)` index now. The Channel feed lists a Channel's threads newest
 * placement first, which the membership table's existing
 * `(space_id, state, workstream_id)` index cannot order.
 *
 * **Activity.** `workspace_activity_seen` is how far each person has read the
 * Activity tab; see `workspace-activity-feed.ts`.
 */
export const WORKSPACE_PINS_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_pins (
    user_id TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('thread', 'channel', 'breakout')),
    item_id TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((item_kind = 'breakout') = (parent_id IS NOT NULL)),
    PRIMARY KEY (user_id, item_kind, item_id)
  ) STRICT`,
  `CREATE INDEX workspace_pins_order_idx
    ON workspace_pins(user_id, item_kind, position, item_id)`,
  `INSERT INTO workspace_pins
     (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
   SELECT user_id, 'thread', workstream_id, NULL,
          ROW_NUMBER() OVER (
            PARTITION BY user_id
            ORDER BY arranged IS NULL, arranged, first_position, first_created, workstream_id
          ) - 1,
          first_created,
          CAST(unixepoch('subsec') * 1000 AS INTEGER)
     FROM (
       SELECT pin.user_id, pin.workstream_id,
              MIN(pin.position) AS first_position,
              MIN(pin.created_at) AS first_created,
              (SELECT arranged.position FROM workspace_pinned_order arranged
                WHERE arranged.user_id = pin.user_id AND arranged.item_id = pin.workstream_id) AS arranged
         FROM workspace_workstream_pins pin
        GROUP BY pin.user_id, pin.workstream_id
     )`,
  `CREATE INDEX channel_viewers_user_participant_idx
    ON channel_viewers(user_id, is_participant, workstream_id)`,
  `CREATE INDEX breakout_viewers_user_participant_idx
    ON breakout_viewers(user_id, is_participant, workstream_id, substream_id)`,
  `CREATE INDEX space_channel_memberships_placed_idx
    ON space_channel_memberships(space_id, state, joined_at, workstream_id)`,
  // How far down the Activity tab this person has looked. One time per person
  // rather than a row per item: opening the tab reads everything above it, so
  // a per-item ledger would record the same fact once per row.
  `CREATE TABLE workspace_activity_seen (
    user_id TEXT PRIMARY KEY,
    seen_through INTEGER NOT NULL CHECK (seen_through >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * Migration 110: `workspace_pins` admits an `artifact`, which carries the
 * thread it was generated in as its `parent_id`, the way a breakout carries its
 * thread. A CHECK cannot be altered in place, so the table is rebuilt; nothing
 * references it by foreign key, so the copy, drop and rename need no
 * hold-and-restore (`docs/durable-object-sqlite.md`).
 */
export const WORKSPACE_ARTIFACT_PINS_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_pins_v110 (
    user_id TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('thread', 'channel', 'breakout', 'artifact')),
    item_id TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((item_kind IN ('breakout', 'artifact')) = (parent_id IS NOT NULL)),
    PRIMARY KEY (user_id, item_kind, item_id)
  ) STRICT`,
  `INSERT INTO workspace_pins_v110
     (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
   SELECT user_id, item_kind, item_id, parent_id, position, created_at, updated_at
     FROM workspace_pins`,
  `DROP TABLE workspace_pins`,
  `ALTER TABLE workspace_pins_v110 RENAME TO workspace_pins`,
  `CREATE INDEX workspace_pins_order_idx
    ON workspace_pins(user_id, item_kind, position, item_id)`,
];

/**
 * Whether one `resource_versions` row is news to the person who pinned the
 * artifact: a republish or a replacement (never the first version, a refetch,
 * or the bookkeeping captures that carry no cause), made after they pinned it,
 * and neither by them nor by a run acting for them (`on_behalf_of_user_id`,
 * migration 112): a change somebody made is never news to them. A version from
 * before that migration names nobody and counts. `version` and `pin` are the
 * aliases in scope.
 * One definition, read by the Artifacts list's unread state and the Activity
 * row, so the two cannot disagree; {@link isArtifactNewsCause} is its cause
 * test for a version already drained, where the push starts.
 */
export function artifactUpdateSql(version: string, pin: string): string {
  return `${version}.version > 1
    AND ${version}.cause IN ('published', 'replaced')
    AND (${version}.author_user_id IS NULL OR ${version}.author_user_id <> ${pin}.user_id)
    AND (${version}.on_behalf_of_user_id IS NULL OR ${version}.on_behalf_of_user_id <> ${pin}.user_id)
    AND CAST(unixepoch(${version}.captured_at, 'subsec') * 1000 AS INTEGER) > ${pin}.created_at`;
}

/** Whether a drained version's cause can be news to a pinner, as {@link artifactUpdateSql} decides. */
export function isArtifactNewsCause(cause: string | null): boolean {
  return cause === "published" || cause === "replaced";
}

/** The waterline key a pinned artifact's reads move (`activitySubjectKey`). */
export function artifactSubjectKeySql(resourceId: string): string {
  return `'artifact:' || ${resourceId}`;
}

/**
 * The ledger's trigger, which migration 113 drops and restores around the
 * cause column it replaces, and migration 114 replaces with one for every
 * resource (`workspace-resource-versions.ts`).
 */
export const RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE = `CREATE TRIGGER resource_versions_queue_artifact_update
     AFTER INSERT ON resource_versions
     WHEN NEW.version > 1 AND NEW.cause IN ('published', 'replaced')
      AND EXISTS (SELECT 1 FROM workspace_pins WHERE item_kind = 'artifact' AND item_id = NEW.resource_id)
   BEGIN
     INSERT OR IGNORE INTO workspace_artifact_updates (resource_id, version) VALUES (NEW.resource_id, NEW.version);
   END`;

/**
 * Migration 111: a ledger of new versions of pinned artifacts, filled by a
 * trigger on `resource_versions` and drained after the write that filled it,
 * the way the Channel rail's ledger is (`channel-rails.ts`). Versions are only
 * ever written by `resources` triggers, from many producers (a Terminal
 * republish, an image edit), so the ledger is the one place every one of them
 * passes. The trigger's test is coarser than {@link artifactUpdateSql}: the
 * drain applies the per-person part when it reads each pinner's Activity.
 * The index is the trigger's and the drain's lookup from an artifact to the
 * people who pinned it. Migration 114 renames the table and widens it to every
 * resource; this is the shape it shipped in.
 */
export const WORKSPACE_ARTIFACT_UPDATES_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_artifact_updates (
    resource_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 1),
    PRIMARY KEY (resource_id, version)
  ) STRICT`,
  `CREATE INDEX workspace_pins_item_idx ON workspace_pins(item_kind, item_id)`,
  RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE,
];

/**
 * Every kind the table stores. `artifact`, `canvas` and `sidekick` are not a
 * `PinKind`: each travels in a list of its own (`ArtifactPinSchema` says why;
 * a Canvas's and a Sidekick's ride their own sidebar rows as
 * `pinnedPosition`), so `list` never returns them, and a released client that
 * parses `PinKind` as a closed enum is never sent one.
 */
export type StoredPinKind = PinKind | "artifact" | "canvas" | "sidekick";

/** One stored artifact pin: the resource and the thread it was generated in. */
export interface StoredArtifactPin {
  itemId: string;
  threadId: string;
}

interface PinRow extends Record<string, SqlStorageValue> {
  item_kind: PinKind;
  item_id: string;
  parent_id: string | null;
}

/**
 * Synchronous repository for one Organization's pins. Visibility of the item is
 * the caller's question; this owns only the list and its order.
 */
export class WorkspacePinStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Whether this object has reached migration 97. */
  ready(): boolean {
    return this.storage.sql.exec(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_pins'`,
    ).toArray().length === 1;
  }

  /** Every thread, Channel and breakout pin this person has, kind by kind, each in their order. */
  list(userId: string): Pin[] {
    if (!this.ready()) return [];
    return this.storage.sql.exec<PinRow>(
      `SELECT item_kind, item_id, parent_id FROM workspace_pins
        WHERE user_id = ? AND item_kind IN ('thread', 'channel', 'breakout') ORDER BY item_kind, position, item_id`,
      userId,
    ).toArray().map((row) => ({
      kind: row.item_kind,
      id: row.item_id,
      parentId: row.parent_id,
    }) as Pin);
  }

  /** Everyone who pinned this artifact, and the thread each pinned it under. */
  artifactPinners(resourceId: string): Array<{ userId: string; threadId: string }> {
    return this.storage.sql.exec<{ user_id: string; parent_id: string }>(
      `SELECT user_id, parent_id FROM workspace_pins WHERE item_kind = 'artifact' AND item_id = ?`,
      resourceId,
    ).toArray().map((row) => ({ userId: row.user_id, threadId: row.parent_id }));
  }

  /** This person's artifact pins in their order, whether or not the artifact is still visible. */
  listArtifacts(userId: string): StoredArtifactPin[] {
    if (!this.ready()) return [];
    return this.storage.sql.exec<{ item_id: string; parent_id: string }>(
      `SELECT item_id, parent_id FROM workspace_pins
        WHERE user_id = ? AND item_kind = 'artifact' ORDER BY position, item_id`,
      userId,
    ).toArray().map((row) => ({ itemId: row.item_id, threadId: row.parent_id }));
  }

  count(userId: string): number {
    return this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workspace_pins WHERE user_id = ?`,
      userId,
    ).one().count;
  }

  /** Pin at the end of the person's list of that kind. True when it was not pinned before. */
  pin(userId: string, kind: StoredPinKind, itemId: string, parentId: string | null, now: number): boolean {
    return this.storage.sql.exec<{ item_id: string }>(
      `INSERT INTO workspace_pins
         (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4,
               COALESCE((SELECT MAX(position) + 1 FROM workspace_pins
                          WHERE user_id = ?1 AND item_kind = ?2), 0),
               ?5, ?5)
       ON CONFLICT(user_id, item_kind, item_id) DO NOTHING
       RETURNING item_id`,
      userId,
      kind,
      itemId,
      parentId,
      now,
    ).toArray().length === 1;
  }

  /** True when the item was pinned. */
  unpin(userId: string, kind: StoredPinKind, itemId: string): boolean {
    return this.storage.sql.exec<{ item_id: string }>(
      `DELETE FROM workspace_pins WHERE user_id = ? AND item_kind = ? AND item_id = ? RETURNING item_id`,
      userId,
      kind,
      itemId,
    ).toArray().length === 1;
  }

  /**
   * Put one kind's pins in the requested order. Ids that are not pinned are
   * ignored, and pins the request leaves out keep their order after the ones it
   * names, so a client holding a stale list cannot drop a pin by reordering.
   */
  reorder(userId: string, kind: StoredPinKind, requestedIds: readonly string[], now: number): void {
    const current = this.storage.sql.exec<{ item_id: string }>(
      `SELECT item_id FROM workspace_pins WHERE user_id = ? AND item_kind = ? ORDER BY position, item_id`,
      userId,
      kind,
    ).toArray().map((row) => row.item_id);
    const pinned = new Set(current);
    const requested = [...new Set(requestedIds)].filter((id) => pinned.has(id));
    const named = new Set(requested);
    const ordered = [...requested, ...current.filter((id) => !named.has(id))];
    for (const [position, itemId] of ordered.entries()) {
      this.storage.sql.exec(
        `UPDATE workspace_pins SET position = ?, updated_at = ?
          WHERE user_id = ? AND item_kind = ? AND item_id = ?`,
        position,
        now,
        userId,
        kind,
        itemId,
      );
    }
  }
}

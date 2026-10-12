import type { SqlStorageValue } from "@cloudflare/workers-types";
import type { ActivityFilter, ActivityItem, ActivityItemKind } from "@rally/contracts";

import { boundParameterChunks } from "./bound-parameters";
import { breakoutListedSql, channelListedSql, type Viewer } from "./listing-rules";
import { SPACE_CHANNEL_PAGE_SIZE, type WorkspaceSpaceStorage } from "./workspace-space-storage";

/**
 * The Activity tab: what happened to this person, newest first.
 *
 * Nothing here is a new log. Every row is read from what the Organization
 * already records — the activity events a conversation emits through its
 * regional effects, and the directory's run state — and shaped for one viewer:
 *
 * - **added** and **mentioned** are events that name the viewer as a target
 *   with that relation;
 * - **thread_started** and **breakout_started** are a conversation the viewer
 *   may list, started by somebody else, read from its directory row;
 * - **run_finished** is a thread or breakout the viewer takes part in whose
 *   run is `completed`, at its `completed_at`, so each conversation shows its
 *   latest finish once rather than one row per run.
 *
 * Every arm applies the listing rules in its own SQL, a breakout through both
 * of the conversation page's gates, so neither a row nor the page cursor ever
 * names a conversation the viewer cannot list. A breakout's mention reaches
 * the shared log emptied and readable by its author alone
 * (`breakout-activity.ts`, `docs/digests.md`); the viewer's target edge is
 * what lists it here. Titles are read now, not from the event's snapshot, so a
 * renamed thread reads under its new name.
 *
 * Read state is one time per person (`workspace_activity_seen`): opening the
 * tab reads everything above it.
 */

interface ActivityKey extends Record<string, SqlStorageValue> {
  id: string;
  kind: ActivityItemKind;
  occurred_at: number;
  actor_user_id: string | null;
  actor_label: string;
  thread_id: string;
  substream_id: string | null;
}

interface ActivityCursor {
  occurredAt: number;
  id: string;
}

function encodeCursor(cursor: ActivityCursor): string {
  return btoa(`${cursor.occurredAt}\u0000${cursor.id}`);
}

function decodeCursor(cursor: string): ActivityCursor | null {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    return null;
  }
  const [time, id] = decoded.split("\u0000");
  const occurredAt = Number(time);
  if (!id || !Number.isSafeInteger(occurredAt) || occurredAt < 0) return null;
  return { occurredAt, id };
}

/** Newest first, ties by id, the order every arm and the merge sort by. */
function newestFirst(left: ActivityKey, right: ActivityKey): number {
  return right.occurred_at - left.occurred_at || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
}

/** The viewer's `channel_viewers` row for `directory`, under its authority generation. */
const CHANNEL_VIEWER = `LEFT JOIN channel_viewers viewer
                  ON viewer.workstream_id = directory.workstream_id
                 AND viewer.user_id = ?1
                 AND viewer.authority_generation = directory.authority_generation`;

/** The viewer's `breakout_viewers` row for `breakout`, under its authority generation. */
const BREAKOUT_VIEWER = `LEFT JOIN breakout_viewers breakout_viewer
                  ON breakout_viewer.workstream_id = breakout.workstream_id
                 AND breakout_viewer.substream_id = breakout.substream_id
                 AND breakout_viewer.user_id = ?1
                 AND breakout_viewer.authority_generation = breakout.authority_generation`;

const AFTER = `(?2 IS NULL OR occurred_at < ?2 OR (occurred_at = ?2 AND id < ?3))`;

export class WorkspaceActivityFeed {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly spaces: WorkspaceSpaceStorage,
  ) {}

  /** Whether this object has reached migration 97. */
  ready(): boolean {
    return this.storage.sql.exec(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_activity_seen'`,
    ).toArray().length === 1;
  }

  /**
   * One page, newest first. `only: "mentions"` runs the first arm alone,
   * narrowed to the `mentioned` relation.
   */
  page(
    viewer: Viewer,
    cursor: string | null,
    only: ActivityFilter | null = null,
  ): { items: ActivityItem[]; nextCursor: string | null } | "invalid_cursor" {
    const after = cursor === null ? null : decodeCursor(cursor);
    if (cursor !== null && after === null) return "invalid_cursor";
    if (!this.ready()) return { items: [], nextCursor: null };
    const limit = SPACE_CHANNEL_PAGE_SIZE + 1;
    const binds = [viewer.userId, after?.occurredAt ?? null, after?.id ?? "", limit] as const;
    const arm = (sql: string) => this.storage.sql.exec<ActivityKey>(
      `SELECT * FROM (${sql}) WHERE ${AFTER} ORDER BY occurred_at DESC, id DESC LIMIT ?4`,
      ...binds,
    ).toArray();
    const breakouts = this.spaces.breakoutsReady();
    // Every arm applies the listing rules itself, before its LIMIT, so a page
    // and the cursor cut from it only ever hold keys this viewer may list: a
    // key filtered afterwards would still leak through the cursor, and could
    // leave a page empty that has more behind it.
    const threadListed = channelListedSql("directory", "viewer", viewer.accessClass, { breakouts, userId: "?1" });
    const breakoutListed = breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass);
    const mentionsOnly = only === "mentions";
    const relations = mentionsOnly ? "('mentioned')" : "('added', 'mentioned')";
    const keys = [
      ...arm(`SELECT event.event_id AS id,
                     CASE target.relation WHEN 'added' THEN 'added' ELSE 'mentioned' END AS kind,
                     event.occurred_at, event.actor_user_id, event.actor_label,
                     event.subject_id AS thread_id,
                     json_extract(event.metadata_json, '$.substreamId') AS substream_id
                FROM workspace_activity_event_targets target
                JOIN workspace_activity_events event ON event.event_id = target.event_id
                JOIN channels directory ON directory.workstream_id = event.subject_id
                ${CHANNEL_VIEWER}
               WHERE target.user_id = ?1
                 AND target.relation IN ${relations}
                 AND event.subject_type = 'workstream'
                 AND event.event_type IN ('workstream_participant_added', 'workstream_message_created')
                 AND directory.archived_at IS NULL
                 AND ${threadListed}
                 AND ${breakouts
                   ? `(COALESCE(json_extract(event.metadata_json, '$.substreamId'), '0') = '0'
                       OR EXISTS (SELECT 1 FROM breakouts breakout ${BREAKOUT_VIEWER}
                                   WHERE breakout.workstream_id = event.subject_id
                                     AND breakout.substream_id = json_extract(event.metadata_json, '$.substreamId')
                                     AND breakout.archived_at IS NULL
                                     AND ${breakoutListed}))`
                   : `COALESCE(json_extract(event.metadata_json, '$.substreamId'), '0') = '0'`}`),
      // A start is read from the thread's and the breakout's own directory
      // rows, as a finish is: the conversation's opening-message event does
      // not reliably reach this object (a breakout's is never forwarded), and
      // the directory row is what every other list here is drawn from. The
      // starter's name is the client's to resolve.
      ...(mentionsOnly ? [] : arm(`SELECT 'started:' || directory.workstream_id AS id,
                     'thread_started' AS kind,
                     directory.source_created_at AS occurred_at,
                     directory.created_by_user_id AS actor_user_id, '' AS actor_label,
                     directory.workstream_id AS thread_id, '0' AS substream_id
                FROM channels directory
                ${CHANNEL_VIEWER}
               WHERE ${threadListed}
                 AND directory.created_by_user_id IS NOT NULL
                 AND directory.created_by_user_id <> ?1
                 AND directory.source_created_at IS NOT NULL
                 AND directory.archived_at IS NULL
                 AND directory.system_kind IS NULL`)),
      ...(breakouts && !mentionsOnly ? arm(`SELECT 'started:' || breakout.substream_id AS id,
                     'breakout_started' AS kind,
                     breakout.source_created_at AS occurred_at,
                     breakout.created_by_user_id AS actor_user_id, '' AS actor_label,
                     breakout.workstream_id AS thread_id, breakout.substream_id AS substream_id
                FROM breakouts breakout
                JOIN channels directory ON directory.workstream_id = breakout.workstream_id
                ${CHANNEL_VIEWER}
                ${BREAKOUT_VIEWER}
               WHERE ${threadListed} AND ${breakoutListed}
                 AND directory.archived_at IS NULL
                 AND breakout.created_by_user_id IS NOT NULL
                 AND breakout.created_by_user_id <> ?1
                 AND breakout.source_created_at IS NOT NULL
                 AND breakout.archived_at IS NULL`) : []),
      ...(mentionsOnly ? [] : arm(`SELECT 'finished:' || directory.workstream_id || ':' || directory.completed_at AS id,
                     'run_finished' AS kind,
                     directory.completed_at AS occurred_at,
                     NULL AS actor_user_id, 'Rally' AS actor_label,
                     directory.workstream_id AS thread_id, '0' AS substream_id
                FROM channel_viewers viewer
                JOIN channels directory
                  ON directory.workstream_id = viewer.workstream_id
                 AND directory.authority_generation = viewer.authority_generation
               WHERE viewer.user_id = ?1 AND viewer.is_participant = 1
                 AND directory.exact_state = 'completed'
                 AND directory.completed_at IS NOT NULL
                 AND directory.system_kind IS NULL`)),
      ...(breakouts && !mentionsOnly ? arm(`SELECT 'finished:' || breakout.substream_id || ':' || breakout.completed_at AS id,
                     'run_finished' AS kind,
                     breakout.completed_at AS occurred_at,
                     NULL AS actor_user_id, 'Rally' AS actor_label,
                     breakout.workstream_id AS thread_id, breakout.substream_id AS substream_id
                FROM breakout_viewers breakout_viewer
                JOIN breakouts breakout
                  ON breakout.workstream_id = breakout_viewer.workstream_id
                 AND breakout.substream_id = breakout_viewer.substream_id
                 AND breakout.authority_generation = breakout_viewer.authority_generation
               WHERE breakout_viewer.user_id = ?1 AND breakout_viewer.is_participant = 1
                 AND breakout.exact_state = 'completed'
                 AND breakout.completed_at IS NOT NULL`) : []),
    ].sort(newestFirst);
    // Each arm took one page past its own cursor, so the merged head is the
    // global first page, and anything left over means there is another.
    const pageKeys = keys.slice(0, SPACE_CHANNEL_PAGE_SIZE);
    const last = pageKeys.at(-1);
    const nextCursor = keys.length > SPACE_CHANNEL_PAGE_SIZE && last
      ? encodeCursor({ occurredAt: last.occurred_at, id: last.id })
      : null;
    return { items: this.hydrate(viewer, pageKeys), nextCursor };
  }

  /**
   * The page's keys as rows, with today's titles. The arms already applied
   * the listing rules; the title reads keep to them as well, so a key that
   * somehow passed an arm still never yields a row.
   */
  private hydrate(viewer: Viewer, keys: readonly ActivityKey[]): ActivityItem[] {
    const threadIds = [...new Set(keys.map((key) => key.thread_id))];
    const listsBreakouts = this.spaces.breakoutsReady();
    const threads = new Map<string, string>();
    for (const chunk of boundParameterChunks(threadIds)) {
      for (const row of this.storage.sql.exec<{ workstream_id: string; title: string } & Record<string, SqlStorageValue>>(
        `SELECT directory.workstream_id, directory.title
           FROM channels directory
           LEFT JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?1
            AND viewer.authority_generation = directory.authority_generation
          WHERE directory.archived_at IS NULL
            AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: listsBreakouts, userId: "?1" })}
            AND directory.workstream_id IN (${chunk.map((_, index) => `?${index + 2}`).join(", ")})`,
        viewer.userId,
        ...chunk,
      ).toArray()) threads.set(row.workstream_id, row.title);
    }
    const breakoutIds = [...new Set(keys.flatMap((key) => (
      key.substream_id && key.substream_id !== "0" ? [key.substream_id] : []
    )))];
    const breakouts = new Map<string, { workstreamId: string; title: string }>();
    if (breakoutIds.length > 0 && this.spaces.breakoutsReady()) {
      for (const chunk of boundParameterChunks(breakoutIds)) {
        for (const row of this.storage.sql.exec<{
          workstream_id: string;
          substream_id: string;
          title: string;
        } & Record<string, SqlStorageValue>>(
          `SELECT breakout.workstream_id, breakout.substream_id, breakout.title
             FROM breakouts breakout
             JOIN channels directory ON directory.workstream_id = breakout.workstream_id
             LEFT JOIN channel_viewers viewer
               ON viewer.workstream_id = directory.workstream_id
              AND viewer.user_id = ?1
              AND viewer.authority_generation = directory.authority_generation
             LEFT JOIN breakout_viewers breakout_viewer
               ON breakout_viewer.workstream_id = breakout.workstream_id
              AND breakout_viewer.substream_id = breakout.substream_id
              AND breakout_viewer.user_id = ?1
              AND breakout_viewer.authority_generation = breakout.authority_generation
            WHERE breakout.archived_at IS NULL AND directory.archived_at IS NULL
              AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: true, userId: "?1" })}
              AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}
              AND breakout.substream_id IN (${chunk.map((_, index) => `?${index + 2}`).join(", ")})`,
          viewer.userId,
          ...chunk,
        ).toArray()) breakouts.set(row.substream_id, { workstreamId: row.workstream_id, title: row.title });
      }
    }
    const channelIds = this.spaces.spaceIdsByChannel(viewer, threadIds);
    const seenThrough = this.seenThrough(viewer.userId);
    return keys.flatMap((key): ActivityItem[] => {
      const threadTitle = threads.get(key.thread_id);
      const onBreakout = key.substream_id !== null && key.substream_id !== "0";
      const breakout = onBreakout ? breakouts.get(key.substream_id as string) : undefined;
      // A breakout row needs the breakout listed; a thread row needs the thread
      // listed. Either one missing means this viewer may not be told.
      if (onBreakout ? breakout?.workstreamId !== key.thread_id : threadTitle === undefined) return [];
      return [{
        id: key.id,
        kind: key.kind,
        occurredAt: new Date(key.occurred_at).toISOString(),
        actorUserId: key.actor_user_id,
        actorLabel: key.actor_label,
        threadId: key.thread_id as ActivityItem["threadId"],
        threadTitle: threadTitle ?? "",
        breakout: breakout ? { substreamId: key.substream_id as string, title: breakout.title } : null,
        channelIds: channelIds.get(key.thread_id) ?? [],
        unread: key.occurred_at > seenThrough,
      }];
    });
  }

  private seenThrough(userId: string): number {
    return this.storage.sql.exec<{ seen_through: number }>(
      `SELECT seen_through FROM workspace_activity_seen WHERE user_id = ?`,
      userId,
    ).toArray()[0]?.seen_through ?? 0;
  }

  /** Move this person's read mark forward; never back. */
  markSeen(userId: string, seenThrough: number, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO workspace_activity_seen (user_id, seen_through, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE
         SET seen_through = MAX(seen_through, excluded.seen_through), updated_at = excluded.updated_at`,
      userId,
      seenThrough,
      now,
    );
  }
}

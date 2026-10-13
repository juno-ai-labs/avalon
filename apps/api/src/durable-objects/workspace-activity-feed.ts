import type { SqlStorageValue } from "@cloudflare/workers-types";
import type { ActivityEvent, ActivityFilter, ActivityItem, ActivityItemKind, ActivitySubject } from "@rally/contracts";

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
 * An item is done two ways. **Mark all read** moves one time per person
 * (`workspace_activity_seen`), and everything older is done. And **events**:
 * the app reports what the person did — "read thread X through message 29",
 * "opened breakout Y", "read Channel Z through placement 4" — as a subject and
 * an ordinal ({@link WorkspaceActivityFeed.record}). Each subject keeps one
 * waterline per person (`workspace_activity_reads`, migration 101), and an
 * item is done once any of its targets ({@link activityTargets}) is at or
 * below its subject's waterline. Neither is a row per item, so an event
 * settles every item it covers, including ones not yet on a page.
 */

/** A subject's waterline key; one shape per kind, so two kinds never collide. */
export function activitySubjectKey(subject: ActivitySubject): string {
  switch (subject.kind) {
    case "thread": return `thread:${subject.threadId}`;
    case "breakout": return `breakout:${subject.threadId}:${subject.substreamId}`;
    case "channel": return `channel:${subject.channelId}`;
  }
}

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

interface ActivityKey extends Record<string, SqlStorageValue> {
  id: string;
  kind: ActivityItemKind;
  occurred_at: number;
  actor_user_id: string | null;
  actor_label: string;
  thread_id: string;
  substream_id: string | null;
  /** The message's attention ordinal, on a message event that recorded one. */
  attention_ordinal: number | null;
}

/** A subject and the ordinal an item needs read on it. */
interface ActivityTarget {
  key: string;
  ordinal: number;
}

/**
 * Where an item is settled: its conversation (the breakout when it names one,
 * else the thread) at an ordinal, and for a thread's start, also each Channel
 * it is placed in at its placement. Ordinal 0 is "opened it".
 *
 * - **mentioned**: the message's own ordinal. An event from before messages
 *   carried one is settled by an open.
 * - **added**, **thread_started**, **breakout_started**: an open. Being added
 *   leaves the newest message unread, so opening is reading to where you were
 *   put; a start is the conversation itself.
 * - **run_finished**: the conversation's newest message. The directory keeps
 *   no ordinal for the finish, so a message after it moves the target too.
 */
function activityTargets(
  key: ActivityKey,
  latestAttentionOrdinal: number,
  placements: ReadonlyArray<{ channelId: string; ordinal: number }>,
): ActivityTarget[] {
  const threadId = key.thread_id as ActivityItem["threadId"];
  const conversation = activitySubjectKey(key.substream_id !== null && key.substream_id !== "0"
    ? { kind: "breakout", threadId, substreamId: key.substream_id }
    : { kind: "thread", threadId });
  switch (key.kind) {
    case "mentioned":
      return [{ key: conversation, ordinal: Number(key.attention_ordinal ?? 0) }];
    case "added":
    case "breakout_started":
      return [{ key: conversation, ordinal: 0 }];
    case "thread_started":
      return [
        { key: conversation, ordinal: 0 },
        ...placements.map((placement) => ({
          key: activitySubjectKey({ kind: "channel", channelId: placement.channelId }),
          ordinal: placement.ordinal,
        })),
      ];
    case "run_finished":
      return [{ key: conversation, ordinal: latestAttentionOrdinal }];
  }
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
                     json_extract(event.metadata_json, '$.substreamId') AS substream_id,
                     json_extract(event.metadata_json, '$.attentionOrdinal') AS attention_ordinal
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
                     directory.workstream_id AS thread_id, '0' AS substream_id,
                     NULL AS attention_ordinal
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
                     breakout.workstream_id AS thread_id, breakout.substream_id AS substream_id,
                     NULL AS attention_ordinal
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
                     directory.workstream_id AS thread_id, '0' AS substream_id,
                     NULL AS attention_ordinal
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
                     breakout.workstream_id AS thread_id, breakout.substream_id AS substream_id,
                     NULL AS attention_ordinal
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
    const threads = new Map<string, { title: string; latest: number }>();
    for (const chunk of boundParameterChunks(threadIds)) {
      for (const row of this.storage.sql.exec<{
        workstream_id: string;
        title: string;
        latest_attention_ordinal: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT directory.workstream_id, directory.title, directory.latest_attention_ordinal
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
      ).toArray()) threads.set(row.workstream_id, { title: row.title, latest: Number(row.latest_attention_ordinal) });
    }
    const breakoutIds = [...new Set(keys.flatMap((key) => (
      key.substream_id && key.substream_id !== "0" ? [key.substream_id] : []
    )))];
    const breakouts = new Map<string, { workstreamId: string; title: string; latest: number }>();
    if (breakoutIds.length > 0 && this.spaces.breakoutsReady()) {
      for (const chunk of boundParameterChunks(breakoutIds)) {
        for (const row of this.storage.sql.exec<{
          workstream_id: string;
          substream_id: string;
          title: string;
          latest_attention_ordinal: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT breakout.workstream_id, breakout.substream_id, breakout.title,
                  breakout.latest_attention_ordinal
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
        ).toArray()) breakouts.set(row.substream_id, {
          workstreamId: row.workstream_id,
          title: row.title,
          latest: Number(row.latest_attention_ordinal),
        });
      }
    }
    const channelIds = this.spaces.spaceIdsByChannel(viewer, threadIds);
    const seenThrough = this.seenThrough(viewer.userId);
    const startedThreadIds = keys.flatMap((key) => key.kind === "thread_started" ? [key.thread_id] : []);
    const placements = startedThreadIds.length > 0
      ? this.spaces.placementOrdinals(viewer, startedThreadIds)
      : new Map<string, Array<{ channelId: string; ordinal: number }>>();
    const targets = new Map(keys.map((key) => {
      const onBreakout = key.substream_id !== null && key.substream_id !== "0";
      const latest = (onBreakout ? breakouts.get(key.substream_id as string) : threads.get(key.thread_id))?.latest ?? 0;
      return [key.id, activityTargets(key, latest, placements.get(key.thread_id) ?? [])];
    }));
    const reads = this.readsReady()
      ? this.reads(viewer.userId, [...new Set([...targets.values()].flatMap((list) => list.map((target) => target.key)))])
      : new Map<string, number>();
    const done = (key: ActivityKey): boolean => (targets.get(key.id) ?? [])
      .some((target) => (reads.get(target.key) ?? -1) >= target.ordinal);
    return keys.flatMap((key): ActivityItem[] => {
      const thread = threads.get(key.thread_id);
      const threadTitle = thread?.title;
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
        unread: key.occurred_at > seenThrough && !done(key),
      }];
    });
  }

  /** Whether this object has reached migration 101. */
  readsReady(): boolean {
    return this.storage.sql.exec(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_activity_reads'`,
    ).toArray().length === 1;
  }

  /** This person's waterline on each of these subjects that has one. */
  private reads(userId: string, subjectKeys: readonly string[]): Map<string, number> {
    const reads = new Map<string, number>();
    for (const chunk of boundParameterChunks(subjectKeys)) {
      for (const row of this.storage.sql.exec<{ subject_key: string; read_through: number }>(
        `SELECT subject_key, read_through FROM workspace_activity_reads
          WHERE user_id = ?1 AND subject_key IN (${chunk.map((_, index) => `?${index + 2}`).join(", ")})`,
        userId,
        ...chunk,
      ).toArray()) reads.set(row.subject_key, Number(row.read_through));
    }
    return reads;
  }

  /**
   * Apply what the person did. Each `read` moves that subject's waterline to
   * the higher of where it was and `through`; never back, so events arriving
   * out of order settle the same way. Nothing checks the subject is one the
   * person may list: the row is theirs alone, and the feed lists only what
   * they may see.
   */
  record(userId: string, events: readonly ActivityEvent[], now: number): void {
    for (const event of events) {
      this.storage.sql.exec(
        `INSERT INTO workspace_activity_reads (user_id, subject_key, read_through, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, subject_key) DO UPDATE
           SET read_through = MAX(read_through, excluded.read_through), updated_at = excluded.updated_at`,
        userId,
        activitySubjectKey(event.subject),
        event.through,
        now,
      );
    }
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

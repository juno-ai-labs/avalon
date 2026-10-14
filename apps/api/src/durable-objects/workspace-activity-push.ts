import type { SqlStorageValue } from "@cloudflare/workers-types";
import type { ActivityItem, ActivityItemKind } from "@rally/contracts";

import type { WorkspaceActivityFeed } from "./workspace-activity-feed";
import type { Viewer } from "./listing-rules";

/**
 * Every Activity row is a push notification too.
 *
 * Mentions and adds already reach a device through their notification intent
 * (`docs/push-notifications.md`), which also owns their Slack and email
 * fallback. The rows the feed reads from the directory rather than from an
 * event (a thread or breakout somebody else started, a run that finished) had
 * no producer, so this file is theirs.
 *
 * It does not decide what a row is or who sees one: that stays the feed's.
 * A directory batch that starts a conversation or finishes a run names it as
 * a {@link ActivityPushSubject}; after the commit, each person who could be
 * told about it and has a live device reads their own first Activity page,
 * and every unread row on it about that subject, of a kind {@link PUSHED_KINDS}
 * names, that has not been pushed before, is pushed. The consumer reads the
 * row back through the feed again when it sends, so a row the person read or
 * lost in between sends nothing.
 */

/** The kinds this path pushes; `added` and `mentioned` have their own. */
export const PUSHED_KINDS: ReadonlySet<ActivityItemKind> = new Set([
  "thread_started",
  "breakout_started",
  "run_finished",
]);

/** A conversation a directory batch started or finished a run in. */
export interface ActivityPushSubject {
  threadId: string;
  /** Null for the thread itself. */
  substreamId: string | null;
}

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

export class WorkspaceActivityPushes {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly feed: WorkspaceActivityFeed,
  ) {}

  /** Whether this object has reached migration 105. */
  ready(): boolean {
    return this.storage.sql.exec(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_activity_push_origin'`,
    ).toArray().length === 1;
  }

  /**
   * Who could be told about these subjects: everyone, when one of them is
   * Organization-wide (the feed then decides, per person, what they may list),
   * else the people its viewer rows name. Read after the batch commits, so a
   * viewer row that landed with it counts.
   */
  audience(subjects: readonly ActivityPushSubject[]): { everyone: boolean; userIds: string[] } {
    const userIds = new Set<string>();
    for (const subject of subjects) {
      const row = subject.substreamId === null
        ? this.storage.sql.exec<{ scope: string } & Record<string, SqlStorageValue>>(
          `SELECT scope FROM channels WHERE workstream_id = ?`, subject.threadId,
        ).toArray()[0]
        : this.storage.sql.exec<{ scope: string } & Record<string, SqlStorageValue>>(
          `SELECT scope FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
          subject.threadId, subject.substreamId,
        ).toArray()[0];
      if (!row) continue;
      if (row.scope === "workspace") return { everyone: true, userIds: [] };
      const viewers = subject.substreamId === null
        ? this.storage.sql.exec<{ user_id: string }>(
          `SELECT viewer.user_id FROM channel_viewers viewer
             JOIN channels directory ON directory.workstream_id = viewer.workstream_id
              AND directory.authority_generation = viewer.authority_generation
            WHERE viewer.workstream_id = ? AND (viewer.is_participant = 1 OR viewer.listable = 1)`,
          subject.threadId,
        ).toArray()
        : this.storage.sql.exec<{ user_id: string }>(
          `SELECT viewer.user_id FROM breakout_viewers viewer
             JOIN breakouts breakout ON breakout.workstream_id = viewer.workstream_id
              AND breakout.substream_id = viewer.substream_id
              AND breakout.authority_generation = viewer.authority_generation
            WHERE viewer.workstream_id = ? AND viewer.substream_id = ?
              AND (viewer.is_participant = 1 OR viewer.listable = 1)`,
          subject.threadId, subject.substreamId,
        ).toArray();
      for (const viewer of viewers) userIds.add(viewer.user_id);
    }
    return { everyone: false, userIds: [...userIds] };
  }

  /**
   * The rows to push to one person about these subjects: unread, of a pushed
   * kind, from after the origin, and not pushed before. A start is left out
   * when the same page tells them they were added to that conversation, which
   * already pushed, and so is anything about a thread they have on screen.
   * Nothing is recorded here; {@link record} does that once a push is queued.
   */
  pending(
    viewer: Viewer,
    subjects: readonly ActivityPushSubject[],
    onScreen: ReadonlySet<string>,
  ): ActivityItem[] {
    const page = this.feed.page(viewer, null);
    if (page === "invalid_cursor") return [];
    const origin = this.storage.sql.exec<{ started_at: number }>(
      `SELECT started_at FROM workspace_activity_push_origin WHERE id = 1`,
    ).one().started_at;
    const conversation = (item: { threadId: string; breakout: { substreamId: string } | null }) =>
      `${item.threadId}:${item.breakout?.substreamId ?? "0"}`;
    const wanted = new Set(subjects.map((subject) => `${subject.threadId}:${subject.substreamId ?? "0"}`));
    const added = new Set(page.items.filter((item) => item.kind === "added").map(conversation));
    const candidates = page.items.filter((item) => (
      item.unread
      && PUSHED_KINDS.has(item.kind)
      && wanted.has(conversation(item))
      && Date.parse(item.occurredAt) >= origin
      && !onScreen.has(item.threadId)
      && !(item.kind !== "run_finished" && added.has(conversation(item)))
    ));
    if (candidates.length === 0) return [];
    const pushed = new Set(this.storage.sql.exec<{ item_id: string }>(
      `SELECT item_id FROM workspace_activity_pushes
        WHERE user_id = ? AND item_id IN (SELECT value FROM json_each(?))`,
      viewer.userId,
      JSON.stringify(candidates.map((item) => item.id)),
    ).toArray().map((row) => row.item_id));
    return candidates.filter((item) => !pushed.has(item.id));
  }

  /** Note that this row has gone to this person, so no later batch sends it again. */
  record(userId: string, itemId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO workspace_activity_pushes (user_id, item_id, pushed_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, item_id) DO NOTHING`,
      userId, itemId, now,
    );
  }

  /**
   * One person's Activity row, as a push would show it: unread and still
   * listed, or null. Read from the first page, which is where a row pushed
   * moments ago sits.
   */
  item(viewer: Viewer, itemId: string): ActivityItem | null {
    const page = this.feed.page(viewer, null);
    if (page === "invalid_cursor") return null;
    const item = page.items.find((candidate) => candidate.id === itemId);
    return item?.unread && PUSHED_KINDS.has(item.kind) ? item : null;
  }
}

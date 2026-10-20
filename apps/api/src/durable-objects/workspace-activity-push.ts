import type { SqlStorageValue } from "@cloudflare/workers-types";
import type { ActivityItem, ActivityItemKind } from "@rally/contracts";

import type { WorkspaceActivityFeed } from "./workspace-activity-feed";
import type { Viewer } from "./listing-rules";

/**
 * Every Activity row is a push notification too: the rows the feed reads from
 * the directory (starts and finished runs), decided from the feed itself.
 * `docs/push-notifications.md#activity-rows` owns the design.
 */

/** The kinds this path pushes, in the push payload's words; `added` and `mentioned` have their own. */
export const ACTIVITY_PUSH_KINDS = ["new_message", "thread_started", "breakout_started", "run_finished", "merged", "artifact_updated"] as const satisfies readonly ActivityItemKind[];

const PUSHED_KINDS: ReadonlySet<ActivityItemKind> = new Set(ACTIVITY_PUSH_KINDS);

const STARTS: ReadonlySet<ActivityItemKind> = new Set(["thread_started", "breakout_started"]);

/**
 * A conversation a directory batch moved in a way Activity shows. `start` and
 * `finish` are the conversation's own; `joined` is one person newly able to
 * see it, which can make its start a row for them after the start itself was
 * decided (a viewer row lands in its own message, and may land after).
 * `merge` is one merge into or out of the thread, named by its row id: a
 * breakout's merge into it, or its own merge into a Channel. `artifact` is
 * one new version of an artifact `userId` pinned in that thread, named by its
 * row id.
 */
export interface ActivityPushSubject {
  threadId: string;
  /** Null for the thread itself; always null on `merge` and `artifact`. */
  substreamId: string | null;
  kind: "start" | "finish" | "joined" | "merge" | "artifact" | "message";
  /** The person, on `joined` and `artifact` only. */
  userId?: string | undefined;
  /** The Activity row, on `merge` and `artifact` only. */
  itemId?: string | undefined;
  /**
   * On a thread's merge into a Channel: the Channel. Its readers are told,
   * whether or not they can open the thread, as its feed shows them the merge.
   */
  channelId?: string | undefined;
}

/** The kinds of row a subject can push. A join pushes the start alone. */
function subjectKinds(subject: ActivityPushSubject): ReadonlySet<ActivityItemKind> {
  if (subject.kind === "message") return new Set(["new_message"]);
  if (subject.kind === "merge") return new Set(["merged"]);
  if (subject.kind === "artifact") return new Set(["artifact_updated"]);
  return subject.kind === "finish" ? new Set(["run_finished"]) : STARTS;
}

function conversationKey(threadId: string, substreamId: string | null | undefined): string {
  return `${threadId}:${substreamId ?? "0"}`;
}

function itemConversation(item: ActivityItem): string {
  return conversationKey(item.threadId, item.breakout?.substreamId);
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
   * Who could be told about these subjects. A start, and a merge (asked of
   * the thread), reaches everyone when its
   * conversation is Organization-wide (the feed then decides, per person, what
   * they may list), else the people its viewer rows name; a finish reaches
   * only its participants, the only people the feed shows one to; a join
   * reaches the person who joined. Read after the batch commits, so a viewer
   * row that landed with it counts.
   */
  audience(subjects: readonly ActivityPushSubject[]): { everyone: boolean; userIds: string[] } {
    const userIds = new Set<string>();
    for (const subject of subjects) {
      // A join reaches the person who joined; a pinned artifact, its pinner.
      if (subject.kind === "joined" || subject.kind === "artifact") {
        if (subject.userId) userIds.add(subject.userId);
        continue;
      }
      if (subject.kind === "merge" && subject.channelId) {
        const space = this.storage.sql.exec<{ scope: string } & Record<string, SqlStorageValue>>(
          `SELECT scope FROM spaces WHERE space_id = ?`, subject.channelId,
        ).toArray()[0];
        if (space?.scope === "workspace") return { everyone: true, userIds: [] };
        // A private Channel's participants; anyone else who reads it, through
        // the thread, is among the thread's viewers below.
        for (const row of this.storage.sql.exec<{ user_id: string }>(
          `SELECT user_id FROM space_viewers WHERE space_id = ? AND is_participant = 1`, subject.channelId,
        ).toArray()) userIds.add(row.user_id);
      }
      if (subject.kind === "start" || subject.kind === "merge") {
        const row = subject.substreamId === null
          ? this.storage.sql.exec<{ scope: string } & Record<string, SqlStorageValue>>(
            `SELECT scope FROM channels WHERE workstream_id = ?`, subject.threadId,
          ).toArray()[0]
          : this.storage.sql.exec<{ scope: string } & Record<string, SqlStorageValue>>(
            `SELECT scope FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
            subject.threadId, subject.substreamId,
          ).toArray()[0];
        if (row?.scope === "workspace") return { everyone: true, userIds: [] };
      }
      const reach = subject.kind === "finish" || subject.kind === "message" ? "viewer.is_participant = 1"
        : "(viewer.is_participant = 1 OR viewer.listable = 1)";
      const viewers = subject.substreamId === null
        ? this.storage.sql.exec<{ user_id: string }>(
          `SELECT viewer.user_id FROM channel_viewers viewer
             JOIN channels directory ON directory.workstream_id = viewer.workstream_id
              AND directory.authority_generation = viewer.authority_generation
            WHERE viewer.workstream_id = ? AND ${reach}`,
          subject.threadId,
        ).toArray()
        : this.storage.sql.exec<{ user_id: string }>(
          `SELECT viewer.user_id FROM breakout_viewers viewer
             JOIN breakouts breakout ON breakout.workstream_id = viewer.workstream_id
              AND breakout.substream_id = viewer.substream_id
              AND breakout.authority_generation = viewer.authority_generation
            WHERE viewer.workstream_id = ? AND viewer.substream_id = ? AND ${reach}`,
          subject.threadId, subject.substreamId,
        ).toArray();
      for (const viewer of viewers) userIds.add(viewer.user_id);
    }
    return { everyone: false, userIds: [...userIds] };
  }

  /**
   * The rows to push to one person about these subjects: unread, of a kind
   * its subject pushes, from after the origin, and not pushed before. A start
   * is left out when the same page tells them they were added to that
   * conversation, since the add pushes itself, and so is anything about a
   * thread they have on screen. Nothing is recorded here; {@link record} does
   * that once a row has been handed to delivery.
   */
  pending(
    viewer: Viewer,
    subjects: readonly ActivityPushSubject[],
    onScreen: ReadonlySet<string>,
  ): ActivityItem[] {
    const wanted = new Map<string, Set<ActivityItemKind>>();
    // A merge is matched by its own row, not by its conversation: a breakout's
    // merge row names the breakout, though it is about the thread.
    const merges = new Set(subjects.flatMap((subject) => (subject.kind === "merge" && subject.itemId ? [subject.itemId] : [])));
    // An artifact's row too, and only for the person who pinned it.
    const artifacts = new Set(subjects.flatMap((subject) => (
      subject.kind === "artifact" && subject.itemId && subject.userId === viewer.userId ? [subject.itemId] : []
    )));
    for (const subject of subjects) {
      if (subject.kind === "merge" || subject.kind === "artifact") continue;
      if (subject.kind === "joined" && subject.userId !== viewer.userId) continue;
      const key = conversationKey(subject.threadId, subject.substreamId);
      const kinds = wanted.get(key) ?? new Set<ActivityItemKind>();
      for (const kind of subjectKinds(subject)) kinds.add(kind);
      wanted.set(key, kinds);
    }
    if (wanted.size === 0 && merges.size === 0 && artifacts.size === 0) return [];
    const page = this.feed.page(viewer, null);
    if (page === "invalid_cursor") return [];
    const origin = this.storage.sql.exec<{ started_at: number }>(
      `SELECT started_at FROM workspace_activity_push_origin WHERE id = 1`,
    ).one().started_at;
    const added = addedConversations(page.items);
    const candidates = page.items.filter((item) => (
      item.unread
      && (item.kind === "merged" ? merges.has(item.id)
        : item.kind === "artifact_updated" ? artifacts.has(item.id)
          : wanted.get(itemConversation(item))?.has(item.kind) === true)
      && Date.parse(item.occurredAt) >= origin
      // A reply remains eligible while this thread is open but scrolled away.
      // The consumer rechecks the visible-message waterline after batching.
      && (item.kind === "new_message" || !onScreen.has(item.threadId))
      && !(item.kind === "new_message" && page.items.some((other) => other.kind === "mentioned"
        && `message:${other.id}` === item.id))
      && !((item.kind === "new_message" || item.kind === "run_finished") && this.recentlyPushed(viewer.userId, item))
      && !(STARTS.has(item.kind) && added.has(itemConversation(item)))
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

  /** Product policy: at most one ordinary reply/finish alert per conversation every two minutes. */
  private recentlyPushed(userId: string, item: ActivityItem): boolean {
    const substreamId = item.breakout?.substreamId ?? "0";
    const finishedPrefix = `finished:${substreamId === "0" ? item.threadId : substreamId}:`;
    return this.storage.sql.exec<{ found: number }>(
      `SELECT 1 AS found FROM workspace_activity_pushes pushed
         LEFT JOIN workspace_activity_events event
           ON event.event_id = substr(pushed.item_id, 9) AND substr(pushed.item_id, 1, 8) = 'message:'
        WHERE pushed.user_id = ? AND pushed.pushed_at > ?
          AND ((event.subject_id = ? AND COALESCE(json_extract(event.metadata_json, '$.substreamId'), '0') = ?)
            OR substr(pushed.item_id, 1, length(?)) = ?) LIMIT 1`,
      userId, Date.now() - 120_000, item.threadId, substreamId, finishedPrefix, finishedPrefix,
    ).toArray().length > 0;
  }

  /** Note that this row has been handed to delivery for this person, so no later batch sends it again. */
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
   * moments ago sits. A finish is matched by its conversation, not its id:
   * the id carries `completed_at`, which a parent restamps with later
   * activity while the thread stays completed. A start is dropped once the
   * person has an add for the same conversation, which pushes itself.
   */
  item(viewer: Viewer, itemId: string): ActivityItem | null {
    const page = this.feed.page(viewer, null);
    if (page === "invalid_cursor") return null;
    if (itemId.startsWith("message:")) {
      const source = this.storage.sql.exec<{ subject_id: string; substream_id: string }>(
        `SELECT subject_id, COALESCE(json_extract(metadata_json, '$.substreamId'), '0') AS substream_id
           FROM workspace_activity_events WHERE event_id = ?`, itemId.slice("message:".length),
      ).toArray()[0];
      if (!source) return null;
      // The first event schedules the batch; its delivery shows the latest
      // human reply, while its original id remains the receipt/idempotency key.
      const latest = page.items.find((candidate) => candidate.kind === "new_message" && candidate.unread
        && candidate.threadId === source.subject_id
        && (candidate.breakout?.substreamId ?? "0") === source.substream_id) ?? null;
      if (latest && page.items.some((candidate) => candidate.kind === "mentioned"
        && `message:${candidate.id}` === latest.id)) return null;
      return latest;
    }
    const finish = itemId.startsWith("finished:") ? itemId.slice(0, itemId.lastIndexOf(":") + 1) : null;
    const item = page.items.find((candidate) => (
      finish === null ? candidate.id === itemId : candidate.kind === "run_finished" && candidate.id.startsWith(finish)
    ));
    if (!item?.unread || !PUSHED_KINDS.has(item.kind)) return null;
    if (STARTS.has(item.kind) && addedConversations(page.items).has(itemConversation(item))) return null;
    return item;
  }
}

/** The conversations a page says the person was added to. */
function addedConversations(items: readonly ActivityItem[]): Set<string> {
  return new Set(items.filter((item) => item.kind === "added").map(itemConversation));
}

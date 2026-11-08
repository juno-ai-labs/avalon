import type { ActivityItem, ActivityKind, ActivityParentKind } from "@rally/contracts";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import { PUSH_BODY_PREVIEW_CHARACTERS } from "@rally/contracts/push-notifications";

/**
 * WorkspaceDO migration 148: each person's Activity, one row per event per
 * recipient, and the one row per person that Mark all seen moves.
 *
 * A row is written by the code that records the event's notification intent,
 * in that intent's transaction (`recordPersonNotificationIntent`,
 * `recordSidekickRunNotices`), and carries the intent's id as its own, so a
 * replayed effect or a retried alarm converges on one row. The intents'
 * reaper never touches it.
 *
 * Seen is derived, never written per row: a row is seen once the recipient's
 * read cursor on its parent (`sidekick_viewer_reads`, the same projection the
 * Canvas and Sidekick rows read unread from) has passed `attention_ordinal`,
 * or once `workspace_activity_seen.seen_through` is at or after `created_at`.
 * Titles are read from `canvas_directory` and `automation_directory` at list
 * time, not copied here. Times are integer milliseconds, as the Canvas tables
 * keep them. `docs/activity.md` owns all of it.
 *
 * The sidebar-list waterline gains `activity`; the CHECK cannot widen in
 * place and nothing references the table, so it is copied, as migration 139
 * copied it.
 */
export const WORKSPACE_ACTIVITY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE workspace_activity_items (
    item_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('mention', 'participant_added', 'needs_input', 'run_finished')),
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('canvas', 'automation')),
    parent_id TEXT NOT NULL,
    substream_id TEXT,
    message_id TEXT,
    run_id TEXT,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'rally', 'sidekick')),
    actor_id TEXT,
    preview TEXT,
    attention_ordinal INTEGER CHECK (attention_ordinal IS NULL OR attention_ordinal >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  `CREATE INDEX workspace_activity_items_recipient_idx
    ON workspace_activity_items(recipient_user_id, created_at DESC)`,
  `CREATE TABLE workspace_activity_seen (
    user_id TEXT PRIMARY KEY,
    seen_through INTEGER NOT NULL CHECK (seen_through >= 0)
  ) STRICT`,
  `CREATE TABLE workspace_sidebar_list_state_v148 (
    list TEXT PRIMARY KEY CHECK (list IN ('automations', 'notes', 'canvases', 'activity')),
    waterline INTEGER NOT NULL CHECK (waterline >= 0)
  ) STRICT`,
  `INSERT INTO workspace_sidebar_list_state_v148 (list, waterline) SELECT list, waterline FROM workspace_sidebar_list_state`,
  `DROP TABLE workspace_sidebar_list_state`,
  `ALTER TABLE workspace_sidebar_list_state_v148 RENAME TO workspace_sidebar_list_state`,
  `INSERT INTO workspace_sidebar_list_state (list, waterline) VALUES ('activity', 0)`,
];

/** One event for one recipient, as its recorder knows it. */
export interface ActivityItemInput {
  itemId: string;
  workspaceId: string;
  recipientUserId: string;
  kind: ActivityKind;
  parentKind: ActivityParentKind;
  parentId: string;
  substreamId: string | null;
  messageId: string | null;
  runId: string | null;
  actorKind: "person" | "rally" | "sidekick";
  actorId: string | null;
  /** The push body's source text; reduced here exactly as the push reduces it. */
  text: string | null;
  /**
   * The ordinal the recipient's read cursor must reach: the mentioning
   * message's own for a mention. `undefined` reads the parent's latest at
   * write time, for the kinds whose event names no message of its own.
   */
  attentionOrdinal?: number | null;
}

/** Called once per row actually written, inside the recorder's transaction. */
export type NoteActivity = (recipientUserId: string) => void;

/** The push body's own text: plain, and the push's preview length with an ellipsis when shortened. */
function previewText(text: string | null): string | null {
  if (text === null) return null;
  const characters = Array.from(rewriteMessageAsPlainText(text, { sources: "none" }));
  if (characters.length === 0) return null;
  return characters.length > PUSH_BODY_PREVIEW_CHARACTERS
    ? `${characters.slice(0, PUSH_BODY_PREVIEW_CHARACTERS).join("")}…`
    : characters.join("");
}

/**
 * Write one Activity row unless it is already there. The caller holds the
 * transaction its intent is written in. The insert's returned id is the
 * witness that this call wrote it, and only then is the recipient noted.
 *
 * Where the event names no message of its own, the ordinal is the parent's
 * shared conversation's latest attention ordinal at this moment
 * (`latestAttentionOrdinal` of its `"0"` projection): neither the add's
 * effect nor the run's notice carries a better one. Such a row clears only
 * on a read report accepted after it was written (see `ACTIVITY_SEEN_SQL`),
 * so a reader who had already read that far does not see it arrive seen.
 */
export function recordActivityItem(sql: SqlStorage, item: ActivityItemInput, now: number, noteActivity: NoteActivity): void {
  const written = sql.exec<{ item_id: string }>(
    `INSERT INTO workspace_activity_items
       (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id, run_id,
        actor_kind, actor_id, preview, attention_ordinal, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
       CASE WHEN ?13 = 1 THEN ?14 ELSE COALESCE((
         SELECT json_extract(chat.effect_json, '$.latestAttentionOrdinal') FROM sidekick_child_projections chat
          WHERE chat.sidekick_id = ?6 AND chat.substream_id = '0'), 0) END,
       ?15)
     ON CONFLICT(item_id) DO NOTHING
     RETURNING item_id`,
    item.itemId, item.workspaceId, item.recipientUserId, item.kind, item.parentKind, item.parentId, item.substreamId,
    item.messageId, item.runId, item.actorKind, item.actorId, previewText(item.text),
    item.attentionOrdinal === undefined ? 0 : 1, item.attentionOrdinal ?? null, now,
  ).toArray();
  if (written.length === 1) noteActivity(item.recipientUserId);
}

/**
 * Whether row `item` is seen by its recipient, given `reads` (their
 * `sidekick_viewer_reads` row for its parent) and `marked` (their
 * `workspace_activity_seen` row). A mention clears when the cursor reaches
 * its message; any other kind when the cursor is at or past the ordinal it
 * was written at and that read was reported after it was written. Either
 * clears when Mark all seen came after it. One expression for the page and
 * the count, so the two cannot disagree.
 */
const ACTIVITY_SEEN_SQL = `(
  (marked.seen_through IS NOT NULL AND marked.seen_through >= item.created_at)
  OR (item.attention_ordinal IS NOT NULL AND reads.user_id IS NOT NULL
      AND reads.seen_attention_ordinal >= item.attention_ordinal
      AND (item.kind = 'mention' OR reads.updated_at >= item.created_at))
)`;

const ACTIVITY_JOINS = `
  LEFT JOIN sidekick_viewer_reads reads ON reads.sidekick_id = item.parent_id AND reads.user_id = item.recipient_user_id
  LEFT JOIN workspace_activity_seen marked ON marked.user_id = item.recipient_user_id`;

interface ActivityRow extends Record<string, SqlStorageValue> {
  item_id: string; kind: ActivityKind; parent_kind: ActivityParentKind; parent_id: string;
  substream_id: string | null; message_id: string | null; run_id: string | null;
  actor_kind: "person" | "rally" | "sidekick"; actor_id: string | null; preview: string | null;
  created_at: number; seen: number; parent_title: string | null;
}

/**
 * One person's newest `limit` items and how many of all of theirs are
 * unseen. `mayOpen` decides whether a parent's current title is named: a
 * Canvas or Sidekick they can no longer open is listed without one.
 */
export function activityPage(
  sql: SqlStorage,
  recipientUserId: string,
  limit: number,
  mayOpen: (parentKind: ActivityParentKind, parentId: string) => boolean,
): { unseenCount: number; items: ActivityItem[] } {
  const rows = sql.exec<ActivityRow>(
    `SELECT item.item_id, item.kind, item.parent_kind, item.parent_id, item.substream_id, item.message_id, item.run_id,
            item.actor_kind, item.actor_id, item.preview, item.created_at, ${ACTIVITY_SEEN_SQL} AS seen,
            CASE item.parent_kind WHEN 'canvas' THEN canvas.title ELSE sidekick.title END AS parent_title
       FROM workspace_activity_items item
       ${ACTIVITY_JOINS}
       LEFT JOIN canvas_directory canvas ON item.parent_kind = 'canvas' AND canvas.canvas_id = item.parent_id
       LEFT JOIN automation_directory sidekick ON item.parent_kind = 'automation' AND sidekick.automation_id = item.parent_id
                                              AND sidekick.lifecycle <> 'deleted'
      WHERE item.recipient_user_id = ?
      ORDER BY item.created_at DESC, item.item_id DESC
      LIMIT ?`,
    recipientUserId, limit,
  ).toArray();
  const unseenCount = sql.exec<{ unseen: number }>(
    `SELECT COUNT(*) AS unseen FROM workspace_activity_items item ${ACTIVITY_JOINS}
      WHERE item.recipient_user_id = ? AND NOT ${ACTIVITY_SEEN_SQL}`,
    recipientUserId,
  ).one().unseen;
  const opens = new Map<string, boolean>();
  const named = (row: ActivityRow): string | null => {
    if (row.parent_title === null) return null;
    const key = `${row.parent_kind}:${row.parent_id}`;
    if (!opens.has(key)) opens.set(key, mayOpen(row.parent_kind, row.parent_id));
    return opens.get(key) ? row.parent_title : null;
  };
  return {
    unseenCount,
    items: rows.map((row) => ({
      id: row.item_id,
      kind: row.kind,
      parentKind: row.parent_kind,
      parentId: row.parent_id,
      parentTitle: named(row),
      substreamId: row.substream_id,
      messageId: row.message_id,
      runId: row.run_id,
      actor: { kind: row.actor_kind, id: row.actor_id },
      preview: row.preview,
      createdAt: new Date(row.created_at).toISOString(),
      seen: row.seen === 1,
    } as ActivityItem)),
  };
}

/** Whether this person has any Activity, so a read that moved can skip republishing a feed with nothing to clear. */
export function hasActivity(sql: SqlStorage, recipientUserId: string): boolean {
  return sql.exec(`SELECT 1 FROM workspace_activity_items WHERE recipient_user_id = ? LIMIT 1`, recipientUserId)
    .toArray().length > 0;
}

/** Mark all seen: everything recorded until `now` is seen. Never moves back. */
export function markAllActivitySeen(sql: SqlStorage, userId: string, now: number): void {
  sql.exec(
    `INSERT INTO workspace_activity_seen (user_id, seen_through) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET seen_through = MAX(seen_through, excluded.seen_through)`,
    userId, now,
  );
}

import type { SqlStorageValue } from "@cloudflare/workers-types";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import type { ActivityEvent, ActivityFilter, ActivityItem, ActivityItemKind, ActivitySubject } from "@rally/contracts";

import {
  ACTIVITY_CLEAR_RULES,
  cleared,
  consultedSubjects,
  readsRole,
  type ActivityRowFacts,
  type ActivityWaterline,
} from "./activity-clear-rules";
import { threadStartAudienceSql } from "./activity-audience";
import { boundParameterChunks } from "./bound-parameters";
import { listedResourceVisibilitySql } from "../services/resource-listing";
import { breakoutListedSql, channelListedSql, mainOpenableSql, type Viewer } from "./listing-rules";
import { artifactUpdateSql } from "./workspace-pin-storage";
import { resourceVersionLedgerReady } from "./workspace-resource-versions";
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
 *   may list, started by somebody else, read from its directory row; in an
 *   Organization-wide Channel only its participants and the thread's are told
 *   of a thread, and only the thread's participants of a breakout
 *   (`activity-audience.ts`);
 * - **run_finished** is a thread or breakout the viewer takes part in whose
 *   run is `completed`, at its `completed_at`, so each conversation shows its
 *   latest finish once rather than one row per run.
 * - **artifact_updated** is a version of an artifact the viewer pinned, read
 *   from `resource_versions` against their pin (`artifactUpdateSql`).
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
 * item is done once its kind's rule holds over those waterlines: the rule
 * language and the table of rules are `activity-clear-rules.ts`, and this
 * file only binds each row's subjects ({@link activityRowFacts}). Neither is a
 * row per item, so an event settles every item it covers, including ones not
 * yet on a page.
 */

/** A subject's waterline key; one shape per kind, so two kinds never collide. */
export function activitySubjectKey(subject: ActivitySubject): string {
  switch (subject.kind) {
    case "thread": return `thread:${subject.threadId}`;
    case "breakout": return `breakout:${subject.threadId}:${subject.substreamId}`;
    case "channel": return `channel:${subject.channelId}`;
    // Spelled as `artifactSubjectKeySql` spells it, which reads this waterline in SQL.
    case "artifact": return `artifact:${subject.resourceId}`;
  }
}

/** An `artifact_updated` row's id: one row per version of one artifact. */
export function artifactActivityId(resourceId: string, version: number): string {
  return `artifact:${resourceId}:${version}`;
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
  preview?: string;
  unread_message_count?: number;
  read_floor?: number;
  /** On a breakout's `merged` row: the breakout, frozen at merge time. */
  merged_breakout_id?: string | null;
  merged_breakout_title?: string | null;
  /** On a thread's `merged` row: the Channel it merged into. */
  merged_channel_id?: string | null;
  merged_channel_name?: string | null;
  /** On a thread's `merged` row: 1 when this viewer may not open the thread. */
  merged_thread_private?: number | null;
  /** On an `artifact_updated` row: the artifact, its title now, and the version. */
  artifact_id?: string | null;
  artifact_title?: string | null;
  artifact_version?: number | null;
}

/**
 * One row's facts for its clear rule. `conversation` is the breakout when the
 * row names one, else the thread, and knows `opened`, and `message` when the
 * event recorded it. `placement` is each Channel the thread was placed in, at
 * that placement's ordinal. `occurred` is when the row happened.
 */
function activityRowFacts(
  key: ActivityKey,
  placements: ReadonlyArray<{ channelId: string; ordinal: number }>,
): ActivityRowFacts {
  const threadId = key.thread_id as ActivityItem["threadId"];
  // A thread's merge landed in a Channel, and took an ordinal on its waterline.
  const conversation = activitySubjectKey(key.merged_channel_id
    ? { kind: "channel", channelId: key.merged_channel_id }
    : key.substream_id !== null && key.substream_id !== "0"
      ? { kind: "breakout", threadId, substreamId: key.substream_id }
      : { kind: "thread", threadId });
  return {
    roles: {
      conversation: [{
        key: conversation,
        ordinals: { opened: 0, ...(key.attention_ordinal === null ? {} : { message: Number(key.attention_ordinal) }) },
      }],
      placement: placements.map((placement) => ({
        key: activitySubjectKey({ kind: "channel", channelId: placement.channelId }),
        ordinals: { opened: 0, placement: placement.ordinal },
      })),
      artifact: key.artifact_id ? [{
        key: activitySubjectKey({ kind: "artifact", resourceId: key.artifact_id }),
        ordinals: { version: Number(key.artifact_version) },
      }] : [],
    },
    times: { occurred: Number(key.occurred_at) },
  };
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
    replySubjects?: readonly { threadId: string; substreamId: string | null }[],
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
    const threadStartTold = this.spaces.ready()
      ? threadStartAudienceSql("directory", "viewer", "directory.source_created_at")
      : "1";
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
      ...(mentionsOnly ? [] : this.replyKeys(viewer, after, limit, replySubjects)),
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
                 AND ${threadStartTold}
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
                 AND (viewer.is_participant = 1 OR breakout_viewer.is_participant = 1)
                 AND directory.archived_at IS NULL
                 AND breakout.created_by_user_id IS NOT NULL
                 AND breakout.created_by_user_id <> ?1
                 AND breakout.source_created_at IS NOT NULL
                 AND breakout.archived_at IS NULL`) : []),
      // A breakout's merge into its thread, read from the merge message's
      // activity event through migration 109's partial index; the thread's
      // participants are told, though anyone who may read it sees the message.
      ...(mentionsOnly ? [] : arm(`SELECT 'merged:' || event.event_id AS id, 'merged' AS kind,
                     event.occurred_at, event.actor_user_id, event.actor_label,
                     event.subject_id AS thread_id, '0' AS substream_id,
                     json_extract(event.metadata_json, '$.attentionOrdinal') AS attention_ordinal,
                     json_extract(event.metadata_json, '$.mergedFrom.breakoutId') AS merged_breakout_id,
                     json_extract(event.metadata_json, '$.mergedFrom.title') AS merged_breakout_title
                FROM workspace_activity_events event
                JOIN channels directory ON directory.workstream_id = event.subject_id
                ${CHANNEL_VIEWER}
               WHERE json_extract(event.metadata_json, '$.mergedFrom.breakoutId') IS NOT NULL
                 AND event.event_type = 'workstream_message_created'
                 AND event.subject_type = 'workstream'
                 AND (event.actor_user_id IS NULL OR event.actor_user_id <> ?1)
                 AND directory.archived_at IS NULL
                 AND ${threadListed}
                 AND viewer.is_participant = 1`)),
      ...(mentionsOnly ? [] : this.spaces.mergeActivityKeys(viewer, after, limit)),
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
      // A new version of an artifact the viewer pinned, made by somebody
      // else after they pinned it, while it is still generated in a Main they
      // may list. Read from the version history itself; nothing is logged.
      ...(mentionsOnly || !this.artifactUpdatesReady() ? [] : arm(`SELECT 'artifact:' || version.resource_id || ':' || version.version AS id,
                     'artifact_updated' AS kind,
                     CAST(unixepoch(version.captured_at, 'subsec') * 1000 AS INTEGER) AS occurred_at,
                     version.author_user_id AS actor_user_id,
                     CASE version.author_kind WHEN 'agent' THEN 'Rally' ELSE '' END AS actor_label,
                     pin.parent_id AS thread_id, '0' AS substream_id,
                     NULL AS attention_ordinal,
                     r.id AS artifact_id, r.title AS artifact_title, version.version AS artifact_version
                FROM workspace_pins pin
                JOIN resource_versions version ON version.resource_id = pin.item_id
                JOIN resources r ON r.id = pin.item_id
                JOIN workspace_workstream_resource_links link
                  ON link.workstream_id = pin.parent_id
                 AND link.resource_id = pin.item_id
                 AND link.relationship_type = 'generated'
                JOIN channels directory ON directory.workstream_id = pin.parent_id
                ${CHANNEL_VIEWER}
               WHERE pin.user_id = ?1 AND pin.item_kind = 'artifact'
                 AND ${artifactUpdateSql("version", "pin")}
                 AND ${listedResourceVisibilitySql("r")}
                 AND directory.archived_at IS NULL
                 AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}`)),
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
   * Seek from participating conversations into the partial message index. Push
   * batches restrict the conversations before touching any message history.
   * Read waterlines are joined once per conversation, including the initial
   * participant cursor that predates the client's first Activity read.
   */
  private replyKeys(
    person: Viewer, after: ActivityCursor | null, limit: number,
    subjects?: readonly { threadId: string; substreamId: string | null }[],
  ): ActivityKey[] {
    if (subjects?.length === 0) return [];
    const breakouts = this.spaces.breakoutsReady();
    const threadListed = channelListedSql("directory", "viewer", person.accessClass, { breakouts, userId: "?1" });
    const breakoutListed = breakoutListedSql("breakout", "breakout_viewer", person.accessClass);
    const restrict = subjects === undefined ? "" : `AND EXISTS (SELECT 1 FROM json_each(?5) requested
      WHERE json_extract(requested.value, '$.threadId') = conversation.thread_id
        AND COALESCE(json_extract(requested.value, '$.substreamId'), '0') = conversation.substream_id)`;
    // Strip the directory column's TEXT affinity at the expression-index join;
    // otherwise SQLite scans the whole thread and sorts instead of seeking a breakout.
    const query = `WITH conversations AS (
      SELECT directory.workstream_id AS thread_id, '0' AS substream_id,
             viewer.seen_attention_ordinal AS seen_ordinal,
             'thread:' || directory.workstream_id AS subject_key
        FROM channel_viewers viewer JOIN channels directory
          ON directory.workstream_id = viewer.workstream_id
         AND directory.authority_generation = viewer.authority_generation
       WHERE viewer.user_id = ?1 AND viewer.is_participant = 1
         AND directory.archived_at IS NULL AND ${threadListed}
      ${breakouts ? `UNION ALL
      SELECT breakout.workstream_id AS thread_id, breakout.substream_id,
             breakout_viewer.seen_attention_ordinal AS seen_ordinal,
             'breakout:' || breakout.workstream_id || ':' || breakout.substream_id AS subject_key
        FROM breakout_viewers breakout_viewer JOIN breakouts breakout
          ON breakout.workstream_id = breakout_viewer.workstream_id
         AND breakout.substream_id = breakout_viewer.substream_id
         AND breakout.authority_generation = breakout_viewer.authority_generation
        JOIN channels directory ON directory.workstream_id = breakout.workstream_id
        ${CHANNEL_VIEWER}
       WHERE breakout_viewer.user_id = ?1 AND breakout_viewer.is_participant = 1
         AND directory.archived_at IS NULL AND breakout.archived_at IS NULL
         AND ${threadListed} AND ${breakoutListed}` : ""}
    ), latest_replies AS (
      SELECT 'message:' || event.event_id AS id, 'new_message' AS kind,
             event.occurred_at, event.actor_user_id, event.actor_label,
             conversation.thread_id, conversation.substream_id,
             json_extract(event.metadata_json, '$.attentionOrdinal') AS attention_ordinal,
             event.body AS preview,
             MAX(conversation.seen_ordinal, COALESCE(waterline.read_through, 0)) AS read_floor,
             (SELECT COUNT(*) FROM workspace_activity_events unread INDEXED BY workspace_activity_replies_conversation_idx
               WHERE unread.subject_id = conversation.thread_id
                 AND COALESCE(json_extract(unread.metadata_json, '$.substreamId'), '0') = +conversation.substream_id
                 AND unread.event_type = 'workstream_message_created' AND unread.subject_type = 'workstream'
                 AND unread.actor_type = 'user' AND json_extract(unread.metadata_json, '$.mergedFrom.breakoutId') IS NULL
                 AND unread.actor_user_id <> ?1
                 AND COALESCE(json_extract(unread.metadata_json, '$.attentionOrdinal'), 0) > MAX(conversation.seen_ordinal, COALESCE(waterline.read_through, 0))
                 AND unread.occurred_at > COALESCE(seen.seen_through, 0)) AS unread_message_count
        FROM conversations conversation
        LEFT JOIN workspace_activity_reads waterline ON waterline.user_id = ?1 AND waterline.subject_key = conversation.subject_key
        LEFT JOIN workspace_activity_seen seen ON seen.user_id = ?1
        CROSS JOIN workspace_activity_events event
       WHERE event.event_id = (
         SELECT latest.event_id FROM workspace_activity_events latest INDEXED BY workspace_activity_replies_conversation_idx
          WHERE latest.subject_id = conversation.thread_id
            AND COALESCE(json_extract(latest.metadata_json, '$.substreamId'), '0') = +conversation.substream_id
            AND latest.event_type = 'workstream_message_created' AND latest.subject_type = 'workstream'
            AND latest.actor_type = 'user' AND json_extract(latest.metadata_json, '$.mergedFrom.breakoutId') IS NULL
            AND latest.actor_user_id <> ?1
          ORDER BY COALESCE(json_extract(latest.metadata_json, '$.attentionOrdinal'), 0) DESC,
                   latest.occurred_at DESC, latest.event_id DESC LIMIT 1
       ) ${restrict}
    ) SELECT * FROM latest_replies WHERE ${AFTER} ORDER BY occurred_at DESC, id DESC LIMIT ?4`;
    return this.storage.sql.exec<ActivityKey>(query, person.userId, after?.occurredAt ?? null, after?.id ?? "", limit,
      ...(subjects === undefined ? [] : [JSON.stringify(subjects)])).toArray();
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
    // Placements are a read of their own, made only for rows whose rule reads them.
    const placedThreadIds = [...new Set(keys.flatMap((key) => (
      readsRole(ACTIVITY_CLEAR_RULES[key.kind], "placement") ? [key.thread_id] : []
    )))];
    const placements = placedThreadIds.length > 0
      ? this.spaces.placementOrdinals(viewer, placedThreadIds)
      : new Map<string, Array<{ channelId: string; ordinal: number }>>();
    const facts = new Map(keys.map((key) => [key.id, activityRowFacts(key, placements.get(key.thread_id) ?? [])]));
    const waterlines = this.activityReadsReady()
      ? this.reads(viewer.userId, [...new Set(keys.flatMap((key) => (
        consultedSubjects(ACTIVITY_CLEAR_RULES[key.kind], facts.get(key.id)?.roles ?? {})
      )))])
      : new Map<string, ActivityWaterline>();
    const done = (key: ActivityKey): boolean => {
      if (key.kind === "new_message" && Number(key.attention_ordinal ?? 0) <= Number(key.read_floor ?? 0)) return true;
      const row = facts.get(key.id);
      return row !== undefined && cleared(ACTIVITY_CLEAR_RULES[key.kind], row, waterlines);
    };
    return keys.flatMap((key): ActivityItem[] => {
      // A merge from a thread this viewer may not open reaches them through
      // the Channel it landed in, as the Channel's feed shows it: the row is
      // the Channel's, and names no thread.
      const privateMerge = key.merged_channel_id != null && Number(key.merged_thread_private) === 1;
      const threadTitle = privateMerge ? "" : threads.get(key.thread_id);
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
        ...(key.kind === "new_message" ? { preview: rewriteMessageAsPlainText(key.preview ?? ""), unreadMessageCount: Number(key.unread_message_count ?? 0) } : {}),
        threadId: key.thread_id as ActivityItem["threadId"],
        threadTitle: threadTitle ?? "",
        breakout: breakout ? { substreamId: key.substream_id as string, title: breakout.title }
          : key.merged_breakout_id ? { substreamId: key.merged_breakout_id, title: key.merged_breakout_title ?? "" }
            : null,
        ...(key.merged_channel_id ? { mergedInto: {
          channelId: key.merged_channel_id, name: key.merged_channel_name ?? "", ...(privateMerge ? { threadPrivate: true as const } : {}),
        } } : {}),
        ...(key.artifact_id ? {
          artifact: { resourceId: key.artifact_id, title: key.artifact_title ?? "", version: Number(key.artifact_version) },
        } : {}),
        channelIds: privateMerge ? [key.merged_channel_id as string] : channelIds.get(key.thread_id) ?? [],
        unread: key.occurred_at > seenThrough && !done(key),
      }];
    });
  }

  /**
   * Whether this object has reached migration 111, whose index the artifact
   * arm reads through. Its ledger table is how that shows, under the name
   * migration 114 gave it.
   */
  private artifactUpdatesReady(): boolean {
    return resourceVersionLedgerReady(this.storage.sql);
  }

  /** Whether this object has reached migration 101. */
  activityReadsReady(): boolean {
    return this.storage.sql.exec(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_activity_reads'`,
    ).toArray().length === 1;
  }

  /** This person's waterline on each of these subjects that has one, and when they last read it. */
  private reads(userId: string, subjectKeys: readonly string[]): Map<string, ActivityWaterline> {
    const reads = new Map<string, ActivityWaterline>();
    for (const chunk of boundParameterChunks(subjectKeys)) {
      for (const row of this.storage.sql.exec<{ subject_key: string; read_through: number; updated_at: number }>(
        `SELECT subject_key, read_through, updated_at FROM workspace_activity_reads
          WHERE user_id = ?1 AND subject_key IN (${chunk.map((_, index) => `?${index + 2}`).join(", ")})`,
        userId,
        ...chunk,
      ).toArray()) reads.set(row.subject_key, { through: Number(row.read_through), at: Number(row.updated_at) });
    }
    return reads;
  }

  /**
   * Apply what the person did. Each `read` moves that subject's waterline to
   * the higher of where it was and `through`, and its read time to now; never
   * back, so events arriving out of order settle the same way. The read time
   * is what a rule's `since` compares, whatever ordinal the read carried.
   * Nothing checks the subject is one the person may list: the row is theirs
   * alone, and the feed lists only what they may see.
   *
   * Answers whether any waterline was new or rose, which is when the person's
   * other surfaces are worth telling; a read that only refreshed the time is
   * left to the window that sent it.
   */
  record(userId: string, events: readonly ActivityEvent[], now: number): boolean {
    let advanced = false;
    for (const event of events) {
      const key = activitySubjectKey(event.subject);
      const before = this.storage.sql.exec<{ read_through: number }>(
        `SELECT read_through FROM workspace_activity_reads WHERE user_id = ? AND subject_key = ?`,
        userId,
        key,
      ).toArray()[0];
      if (before === undefined || event.through > Number(before.read_through)) advanced = true;
      this.storage.sql.exec(
        `INSERT INTO workspace_activity_reads (user_id, subject_key, read_through, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, subject_key) DO UPDATE
           SET read_through = MAX(read_through, excluded.read_through),
               updated_at = MAX(updated_at, excluded.updated_at)`,
        userId,
        key,
        event.through,
        now,
      );
    }
    return advanced;
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

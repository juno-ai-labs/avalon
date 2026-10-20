import { z } from "zod";
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { RegionSchema } from "@rally/contracts/regions";
import { ConversationViewContentSchema, ConversationViewHeaderSchema } from "@rally/contracts/conversation-view";
import { scheduledAlarmRetryDelay } from "./scheduled-alarms";

export const ConversationViewJobSchema = z.strictObject({
  type: z.literal("conversation_view_v1"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  // Empty names the header. Transcript turn IDs are nonempty.
  turnId: z.string(),
  dispatchRevision: z.number().int().positive().optional(),
});
export const ConversationViewProjectionSchema = ConversationViewJobSchema.extend({
  generation: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  header: ConversationViewHeaderSchema,
  content: ConversationViewContentSchema.nullable(),
});
export const ConversationViewDeliverySchema = ConversationViewJobSchema.extend({
  dispatchRevision: z.number().int().positive(),
  projectedRevision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
});

function markViewTurn(select: string): string {
  return `UPDATE conversation_view_clock SET revision = revision + 1 WHERE id = 1 AND EXISTS (${select});
    INSERT INTO conversation_view_changes(turn_id, revision, pending, not_before)
      SELECT turn_id, (SELECT revision FROM conversation_view_clock WHERE id = 1), 1, 0
      FROM (${select}) WHERE true
      ON CONFLICT(turn_id) DO UPDATE SET revision = excluded.revision, pending = 1, not_before = 0;`;
}

/** Walk upward from timing to its assistant turn, before a deletion removes the link. */
function activityTurn(activityId: string): string {
  return `WITH RECURSIVE ancestors(activity_id, parent_activity_id, scope, subject_id) AS (
    SELECT activity_id, parent_activity_id, scope, subject_id FROM transcript_activities WHERE activity_id = ${activityId}
    UNION ALL
    SELECT a.activity_id, a.parent_activity_id, a.scope, a.subject_id
      FROM transcript_activities a JOIN ancestors p ON a.activity_id = p.parent_activity_id
  ) SELECT subject_id AS turn_id FROM ancestors WHERE scope = 'assistant_turn'`;
}

export const CONVERSATION_VIEW_SOURCE_MIGRATION: readonly string[] = [
  `CREATE TABLE conversation_view_clock (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision > 0)) STRICT`,
  `INSERT INTO conversation_view_clock VALUES (1, 1)`,
  `CREATE TABLE conversation_view_changes (
    turn_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), pending INTEGER NOT NULL CHECK(pending IN (0, 1)),
    not_before INTEGER NOT NULL CHECK(not_before >= 0),
    in_flight_revision INTEGER, in_flight_until INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE INDEX conversation_view_pending_idx ON conversation_view_changes(pending, not_before, turn_id)`,
  `CREATE INDEX conversation_view_in_flight_idx ON conversation_view_changes(in_flight_revision) WHERE in_flight_revision IS NOT NULL`,
  ...(["INSERT", "UPDATE", "DELETE"] as const).flatMap((operation) => {
    const row = operation === "DELETE" ? "OLD" : "NEW";
    return [
      ...(["participant_transcript_turns", "participant_transcript_blocks", "participant_transcript_attachments", "participant_transcript_mentions"] as const).map((table) =>
        `CREATE TRIGGER conversation_view_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
         ${table === "participant_transcript_blocks" ? `WHEN ${row}.block_kind = 'text'${operation === "UPDATE" ? " OR OLD.block_kind = 'text'" : ""}` : ""}
         BEGIN ${markViewTurn(`SELECT ${row}.turn_id AS turn_id`)} END`),
      ...(["transcript_activities", "transcript_activity_intervals"] as const).map((table) =>
        `CREATE TRIGGER conversation_view_${table}_${operation.toLowerCase()}
         ${operation === "DELETE" ? "BEFORE" : "AFTER"} ${operation} ON ${table}
         BEGIN ${markViewTurn(activityTurn(`${row}.activity_id`))} END`),
      `CREATE TRIGGER conversation_view_resource_${operation.toLowerCase()}
       ${operation === "DELETE" ? "BEFORE" : "AFTER"} ${operation} ON workstream_resource_links
       BEGIN ${markViewTurn(`SELECT turn_id FROM participant_transcript_attachments WHERE resource_id = ${row}.resource_id`)} END`,
      `CREATE TRIGGER conversation_view_header_${operation.toLowerCase()} AFTER ${operation === "UPDATE"
        ? "UPDATE OF title, title_status, scope, exact_state, created_at, updated_at, authority_generation" : operation} ON workstream
       BEGIN ${markViewTurn("SELECT '' AS turn_id")} END`,
    ];
  }),
  `CREATE TRIGGER conversation_view_generation AFTER UPDATE OF authority_generation ON workstream
   WHEN NEW.authority_generation != OLD.authority_generation
   BEGIN UPDATE conversation_view_changes SET in_flight_revision = NULL, in_flight_until = NULL, attempts = 0;
     ${markViewTurn("SELECT turn_id FROM participant_transcript_turns")} END`,
  `INSERT INTO conversation_view_changes(turn_id, revision, pending, not_before) SELECT turn_id, 1, 1, 0 FROM participant_transcript_turns`,
  `INSERT INTO conversation_view_changes(turn_id, revision, pending, not_before) SELECT '', 1, 1, 0 WHERE EXISTS (SELECT 1 FROM workstream WHERE id = 1)`,
];

export function nextConversationViewAt(sql: SqlStorage): number | null {
  return sql.exec<{ due: number | null }>(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM workstream WHERE id = 1) THEN COALESCE(
       (SELECT MAX(in_flight_until) FROM conversation_view_changes WHERE in_flight_revision IS NOT NULL AND in_flight_until > ?),
       (SELECT MIN(not_before) FROM conversation_view_changes WHERE pending = 1))
     END AS due`, Date.now(),
  ).one().due;
}

/** Only references enter the queue. The consumer reloads the newest compact value. */
export async function publishConversationViews(
  sql: SqlStorage, queue: Queue, identity: Omit<z.infer<typeof ConversationViewJobSchema>, "turnId">,
): Promise<void> {
  const now = Date.now();
  const next = nextConversationViewAt(sql);
  if (next === null || next > now) return;
  // The same durable retry gate as thread_backfill: Queue exhaustion or a lost
  // acknowledgement cannot leave a claim stuck forever. Retries are idempotent.
  sql.exec(`UPDATE conversation_view_changes SET in_flight_revision = NULL, in_flight_until = NULL
    WHERE in_flight_until <= ?`, now);
  // The existing Queue batch maximum; payloads here contain identities only.
  const rows = sql.exec<{ turn_id: string; revision: number; attempts: number }>(
    `SELECT changes.turn_id, changes.revision, changes.attempts FROM conversation_view_changes changes
      LEFT JOIN participant_transcript_turns turns ON turns.turn_id = changes.turn_id
      WHERE changes.pending = 1 AND changes.not_before <= ?
      ORDER BY changes.revision DESC, turns.transcript_sequence DESC, changes.turn_id LIMIT 100`, now,
  ).toArray();
  if (!rows.length) return;
  for (const row of rows) sql.exec(
    `UPDATE conversation_view_changes SET in_flight_revision = ?, in_flight_until = ?, attempts = attempts + 1
     WHERE turn_id = ?`, row.revision, now + scheduledAlarmRetryDelay(row.attempts + 1), row.turn_id,
  );
  try {
    await queue.sendBatch(rows.map((row) => ({ body: { ...identity, turnId: row.turn_id, dispatchRevision: row.revision } })));
  } catch (error) {
    // Same dispatch retry as the other projection outboxes.
    for (const row of rows) sql.exec(
      "UPDATE conversation_view_changes SET in_flight_revision = NULL, in_flight_until = NULL, not_before = ? WHERE turn_id = ? AND in_flight_revision = ?",
      Date.now() + 5_000, row.turn_id, row.revision,
    );
    throw error;
  }
}

/** Delivery, rather than Queue acceptance, releases the next page. */
export function completeConversationViewDelivery(sql: SqlStorage, delivery: z.infer<typeof ConversationViewDeliverySchema>): void {
  sql.exec(
    `UPDATE conversation_view_changes SET in_flight_revision = NULL, in_flight_until = NULL, attempts = 0,
       pending = CASE WHEN revision <= ? THEN 0 ELSE 1 END
     WHERE turn_id = ? AND in_flight_revision = ?
       AND EXISTS (SELECT 1 FROM workstream WHERE id = 1 AND authority_generation = ?)`,
    delivery.projectedRevision, delivery.turnId, delivery.dispatchRevision, delivery.generation,
  );
}

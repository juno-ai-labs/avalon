import { canvasAdmits, sidekickAdmits } from "../services/authorization-policy";

/**
 * Who may open a Canvas or a Sidekick, and who manages a Sidekick, decided
 * from `WorkspaceDO`'s own rows.
 *
 * The rules read each other, so they live in one module:
 *  * a Canvas a Sidekick run made admits whoever that Sidekick admits
 *    (`canvas_directory.writer_sidekick_id`);
 *  * a Sidekick is managed by everyone a Canvas it is attached to admits,
 *    the Canvas whose Chat made it among them, except a Canvas its own runs
 *    made. It is not opened by them: who reads
 *    a Sidekick never depends on a Canvas, so the chain ends after one step.
 * Both are read live, so nothing copies one list into the other.
 *
 * `docs/canvases.md#who-can-open-a-canvas` and
 * `docs/automation-lifecycle.md#a-sidekick-made-in-a-canvas` own the rules.
 */

/** Who is asking: their id and, for a member, their Organization role; a guest has none. */
export interface AdmissionActor {
  userId: string;
  actorRole: "owner" | "admin" | "member" | null;
}

/** The columns of a Canvas row its read rule decides from. */
export interface CanvasAdmissionRow {
  canvas_id: string;
  created_by_user_id: string;
  writer_sidekick_id: string | null;
  visibility: string;
  archived_at: number | null;
}

/** The columns of a Sidekick row its read and manage rules decide from. */
export interface SidekickAdmissionRow {
  automation_id: string;
  scope: string;
  author_user_id: string;
  run_as_user_id: string | null;
  lifecycle: string;
}

/** Whether this person is on a Canvas's participant list. */
export function canvasParticipant(sql: SqlStorage, canvasId: string, userId: string): boolean {
  return sql.exec(`SELECT 1 FROM canvas_participants WHERE canvas_id = ? AND user_id = ? LIMIT 1`, canvasId, userId)
    .toArray().length > 0;
}

/** Whether this person is on a Sidekick's `people` list. */
export function sidekickSharedWith(sql: SqlStorage, sidekickId: string, userId: string): boolean {
  return sql.exec(`SELECT 1 FROM sidekick_audience WHERE sidekick_id = ? AND user_id = ? LIMIT 1`, sidekickId, userId)
    .toArray().length > 0;
}

function sidekickRow(sql: SqlStorage, sidekickId: string): SidekickAdmissionRow | null {
  return sql.exec<SidekickAdmissionRow & Record<string, SqlStorageValue>>(
    `SELECT automation_id, scope, author_user_id, run_as_user_id, lifecycle FROM automation_directory WHERE automation_id = ?`,
    sidekickId,
  ).toArray()[0] ?? null;
}

/** A Canvas's writer Sidekick, as the rules read it; `null` for an id that names none. */
export function writerSidekick(sql: SqlStorage, sidekickId: string): SidekickAdmissionRow | null {
  return sidekickRow(sql, sidekickId);
}

/**
 * The read rule over a Canvas's row: `canvasAdmits` over its visibility, its
 * creator, its participant list, its writer Sidekick's audience as it stands
 * now, and the actor's role (an owner or administrator manages, so opens,
 * every Canvas). A guest has no `actorRole`, so Organization visibility never
 * admits one. An archived Canvas admits nobody.
 */
export function canvasReaderAllows(row: CanvasAdmissionRow, actor: AdmissionActor, sql: SqlStorage): boolean {
  if (row.archived_at !== null) return false;
  return canvasAdmits({
    visibility: row.visibility,
    creator: row.created_by_user_id === actor.userId,
    participant: canvasParticipant(sql, row.canvas_id, actor.userId),
    writerAudience: row.writer_sidekick_id !== null && writerSidekickAdmits(sql, row.writer_sidekick_id, actor),
  }, actor.actorRole !== null, actor.actorRole === "owner" || actor.actorRole === "admin");
}

/** Whether a Canvas's writer Sidekick admits this person (`sidekickReaderAllows`). */
export function writerSidekickAdmits(sql: SqlStorage, sidekickId: string, actor: AdmissionActor): boolean {
  const sidekick = sidekickRow(sql, sidekickId);
  return sidekick !== null && sidekickReaderAllows(sidekick, actor, sql);
}

/**
 * Whether a Canvas the Sidekick is attached to admits this person: the Canvas
 * whose Chat made it, or any Canvas it was attached to later. A Canvas this
 * Sidekick's own runs made is left out: it admits whoever reads the Sidekick
 * (`writerSidekickAdmits`), so counting it would make every reader a manager.
 * An archived Canvas admits nobody (`canvasReaderAllows`).
 */
export function sidekickCanvasAdmits(sql: SqlStorage, sidekickId: string, actor: AdmissionActor): boolean {
  const canvases = sql.exec<CanvasAdmissionRow & Record<string, SqlStorageValue>>(
    `SELECT canvas.canvas_id, canvas.created_by_user_id, canvas.writer_sidekick_id, canvas.visibility, canvas.archived_at
       FROM sidekick_conversation_attachments attachment
       JOIN canvas_directory canvas ON canvas.canvas_id = attachment.parent_id
      WHERE attachment.automation_id = ? AND attachment.parent_kind = 'canvas' AND attachment.substream_id = '0'
        AND canvas.writer_sidekick_id IS NOT attachment.automation_id`,
    sidekickId,
  ).toArray();
  return canvases.some((canvas) => canvasReaderAllows(canvas, actor, sql));
}

/**
 * The library's and the management API's read rule, over a directory row
 * alone: `sidekickAdmits` over its scope, its author and executor, and its
 * `people` list. A guest has no `actorRole`, so Organization scope never
 * admits one.
 */
export function sidekickReaderAllows(row: SidekickAdmissionRow, actor: AdmissionActor, sql: SqlStorage): boolean {
  if (row.lifecycle === "deleted") return false;
  return sidekickAdmits({
    scope: row.scope,
    author: row.author_user_id === actor.userId,
    executor: row.run_as_user_id === actor.userId,
    shared: sidekickSharedWith(sql, row.automation_id, actor.userId),
  }, actor.actorRole != null);
}

/**
 * Who manages a Sidekick, from its row alone: its author, the person it runs
 * as, and for an Organization one its owners and administrators.
 * `sidekickManages` adds the Canvases it is attached to.
 */
export function sidekickManagerAllows(
  row: { scope: string; author_user_id: string; run_as_user_id: string | null },
  actor: { userId: string; actorRole?: AdmissionActor["actorRole"] | undefined },
): boolean {
  return row.author_user_id === actor.userId || row.run_as_user_id === actor.userId
    || (row.scope === "workspace" && (actor.actorRole === "owner" || actor.actorRole === "admin"));
}

/**
 * Who manages a Sidekick: `sidekickManagerAllows`, and everyone a Canvas it is
 * attached to admits (`sidekickCanvasAdmits`). Managing is not opening: such a person reads its
 * conversation and runs only once it is shared with them.
 */
export function sidekickManages(
  row: { automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null },
  actor: { userId: string; actorRole?: AdmissionActor["actorRole"] | undefined },
  sql: SqlStorage,
): boolean {
  return sidekickManagerAllows(row, actor)
    || sidekickCanvasAdmits(sql, row.automation_id, { userId: actor.userId, actorRole: actor.actorRole ?? null });
}

/**
 * Whether a Sidekick is attached to a Canvas: the one row that lets its runs
 * read and post in the Canvas's Chat, publish into the Canvas and write its
 * artifacts' data. `docs/automation-lifecycle.md#attached-conversations`.
 */
export function sidekickAttachedToCanvas(sql: SqlStorage, sidekickId: string, canvasId: string): boolean {
  return sql.exec(
    `SELECT 1 FROM sidekick_conversation_attachments
      WHERE automation_id = ? AND parent_kind = 'canvas' AND parent_id = ? AND substream_id = '0' LIMIT 1`,
    sidekickId, canvasId,
  ).toArray().length > 0;
}

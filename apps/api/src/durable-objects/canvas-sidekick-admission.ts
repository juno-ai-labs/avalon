import { canvasAdmits, sidekickAdmits } from "../services/authorization-policy";

/**
 * Who may open a Canvas or a Sidekick, and who manages a Sidekick, decided
 * from `WorkspaceDO`'s own rows.
 *
 * The two rules read each other, so they live in one module:
 *  * a Canvas a Sidekick run made admits whoever that Sidekick admits
 *    (`canvas_directory.writer_sidekick_id`);
 *  * a Sidekick made in a Canvas's Chat admits, and is managed by, whoever
 *    that Canvas admits (`automation_directory.home_canvas_id`).
 * Both are read live, so nothing copies one list into the other.
 *
 * The chain ends: a writer is set only when a Canvas is created and a home
 * only when a Sidekick is, so each link names a row that existed before the
 * row holding it. `visited` still stops a loop that hand-written SQL could
 * make, by refusing a row already asked about on this path.
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
export function canvasReaderAllows(row: CanvasAdmissionRow, actor: AdmissionActor, sql: SqlStorage, visited?: Set<string>): boolean {
  if (row.archived_at !== null) return false;
  const path = visited ?? new Set<string>();
  if (path.has(row.canvas_id)) return false;
  path.add(row.canvas_id);
  return canvasAdmits({
    visibility: row.visibility,
    creator: row.created_by_user_id === actor.userId,
    participant: canvasParticipant(sql, row.canvas_id, actor.userId),
    writerAudience: row.writer_sidekick_id !== null && writerSidekickAdmits(sql, row.writer_sidekick_id, actor, path),
  }, actor.actorRole !== null, actor.actorRole === "owner" || actor.actorRole === "admin");
}

/** Whether a Canvas's writer Sidekick admits this person (`sidekickReaderAllows`). */
export function writerSidekickAdmits(sql: SqlStorage, sidekickId: string, actor: AdmissionActor, visited?: Set<string>): boolean {
  const sidekick = sidekickRow(sql, sidekickId);
  return sidekick !== null && sidekickReaderAllows(sidekick, actor, sql, visited);
}

/**
 * Whether the Canvas a Sidekick was made in admits this person. A Sidekick
 * made anywhere else has no home and answers `false`; so does one whose home
 * was archived, which archives the Sidekick with it.
 */
export function sidekickHomeAdmits(sql: SqlStorage, sidekickId: string, actor: AdmissionActor, visited?: Set<string>): boolean {
  const home = sql.exec<CanvasAdmissionRow & Record<string, SqlStorageValue>>(
    `SELECT canvas.canvas_id, canvas.created_by_user_id, canvas.writer_sidekick_id, canvas.visibility, canvas.archived_at
       FROM automation_directory directory
       JOIN canvas_directory canvas ON canvas.canvas_id = directory.home_canvas_id
      WHERE directory.automation_id = ?`,
    sidekickId,
  ).toArray()[0];
  return home !== undefined && canvasReaderAllows(home, actor, sql, visited);
}

/**
 * The library's and the management API's read rule, over a directory row:
 * `sidekickAdmits` over its scope, its author and executor, its `people`
 * list, and the Canvas it was made in. A guest has no `actorRole`, so
 * Organization scope never admits one.
 */
export function sidekickReaderAllows(row: SidekickAdmissionRow, actor: AdmissionActor, sql: SqlStorage, visited?: Set<string>): boolean {
  if (row.lifecycle === "deleted") return false;
  const path = visited ?? new Set<string>();
  if (path.has(row.automation_id)) return false;
  path.add(row.automation_id);
  const own = row.author_user_id === actor.userId || row.run_as_user_id === actor.userId;
  return sidekickAdmits({
    scope: row.scope,
    author: row.author_user_id === actor.userId,
    executor: row.run_as_user_id === actor.userId,
    // The home read is two probes; a person the row already names skips it.
    shared: !own && (sidekickSharedWith(sql, row.automation_id, actor.userId)
      || sidekickHomeAdmits(sql, row.automation_id, actor, path)),
  }, actor.actorRole != null);
}

/**
 * Who manages a Sidekick, from its row alone: its author, the person it runs
 * as, and for an Organization one its owners and administrators.
 * `sidekickManages` adds the Canvas it was made in.
 */
export function sidekickManagerAllows(
  row: { scope: string; author_user_id: string; run_as_user_id: string | null },
  actor: { userId: string; actorRole?: AdmissionActor["actorRole"] | undefined },
): boolean {
  return row.author_user_id === actor.userId || row.run_as_user_id === actor.userId
    || (row.scope === "workspace" && (actor.actorRole === "owner" || actor.actorRole === "admin"));
}

/**
 * Who manages a Sidekick: `sidekickManagerAllows`, and everyone the Canvas it
 * was made in admits. Also who manages the audience of a Canvas the Sidekick
 * writes.
 */
export function sidekickManages(
  row: { automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null },
  actor: { userId: string; actorRole?: AdmissionActor["actorRole"] | undefined },
  sql: SqlStorage,
): boolean {
  return sidekickManagerAllows(row, actor)
    || sidekickHomeAdmits(sql, row.automation_id, { userId: actor.userId, actorRole: actor.actorRole ?? null });
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

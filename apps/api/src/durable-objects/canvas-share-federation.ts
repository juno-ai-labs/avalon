import type { GuestSharedCanvas } from "@rally/contracts/canvas-share-federation";

import { SIDEBAR_LIST_LIMIT } from "../services/sidebar-reads";
import { canvasReaderAllows, type CanvasAdmissionRow } from "./canvas-sidekick-admission";
import type { InvalidCanvasAppearanceReport } from "./hosted-canvas";
import { parsedAppearance } from "./sidekick-directory-sql";

/*
 * The origin half of Canvas share federation (`docs/canvas-share-federation.md`).
 * Only a guest of this Organization, explicitly added to a Canvas here, has it
 * shown in their other Organizations. This object stores nothing for that: its
 * triggers queue one outbox entry per person whose view may have changed (keyed
 * by their user id), the alarm turns each into a refresh of their other
 * Organizations' lists, and `guestSharedCanvases` answers when a list is built.
 */

export const CANVAS_SHARE_FEDERATION_ALARM = "canvas_share_federation";

const clock = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const upsert = `ON CONFLICT(kind,alarm_key) DO UPDATE SET due_at=MAX(_internal_durable_alarms.due_at+1,excluded.due_at),
    retry_at=0,attempt=0,updated_at=excluded.updated_at`;
/** Whether a person is known here as a member: they never federate, so they queue nothing. */
const knownMember = (user: string) => `EXISTS (SELECT 1 FROM workspace_member_status s
    WHERE s.user_id = ${user} AND json_extract(s.relationship_json, '$.accessClass') = 'member')`;
const enqueue = (user: string) => `INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,repeat_every_ms,retry_at,attempt,payload_json,created_at,updated_at)
    VALUES('${CANVAS_SHARE_FEDERATION_ALARM}', ${user}, ${clock}, NULL, 0, 0, NULL, ${clock}, ${clock})
    ${upsert};`;
/** Everyone but a known member on a Canvas's list, its creator aside. */
const enqueueListed = (canvas: string) => `INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,repeat_every_ms,retry_at,attempt,payload_json,created_at,updated_at)
    SELECT DISTINCT '${CANVAS_SHARE_FEDERATION_ALARM}', p.user_id, ${clock}, NULL, 0, 0, NULL, ${clock}, ${clock}
      FROM canvas_participants p JOIN canvas_directory d ON d.canvas_id = p.canvas_id
     WHERE p.canvas_id = ${canvas} AND p.user_id <> d.created_by_user_id AND NOT ${knownMember("p.user_id")}
    ${upsert};`;

export const CANVAS_SHARE_FEDERATION_STATEMENTS: readonly string[] = [
  // Added to or taken off a Canvas's list.
  ...["INSERT", "DELETE"].map((event) => {
    const row = event === "DELETE" ? "OLD" : "NEW";
    return `CREATE TRIGGER canvas_share_federation_participant_${event.toLowerCase()} AFTER ${event} ON canvas_participants
      WHEN NOT ${knownMember(`${row}.user_id`)} BEGIN ${enqueue(`${row}.user_id`)} END`;
  }),
  // What a row shows, or whether the Canvas is open at all, changed. Its date
  // alone queues nothing: a Chat message never fans out.
  `CREATE TRIGGER canvas_share_federation_directory AFTER UPDATE OF title, appearance_json, archived_at ON canvas_directory
    WHEN OLD.title IS NOT NEW.title OR OLD.appearance_json IS NOT NEW.appearance_json OR OLD.archived_at IS NOT NEW.archived_at
    BEGIN ${enqueueListed("NEW.canvas_id")} END`,
  `CREATE TRIGGER canvas_share_federation_directory_delete BEFORE DELETE ON canvas_directory
    BEGIN ${enqueueListed("OLD.canvas_id")} END`,
  // A guest promoted to member, removed or suspended: what they see elsewhere
  // changes. Only someone on some Canvas's list can have anything to change.
  ...["INSERT", "UPDATE", "DELETE"].map((event) => {
    const row = event === "DELETE" ? "OLD" : "NEW";
    const changed = event === "UPDATE" ? "(OLD.relationship_json IS NOT NEW.relationship_json OR OLD.active IS NOT NEW.active) AND " : "";
    return `CREATE TRIGGER canvas_share_federation_relationship_${event.toLowerCase()} AFTER ${event} ON workspace_member_status
      WHEN ${changed}EXISTS (SELECT 1 FROM canvas_participants p WHERE p.user_id = ${row}.user_id) BEGIN ${enqueue(`${row}.user_id`)} END`;
  }),
];

/**
 * The Canvases here shared with this person, for their lists elsewhere: those
 * they are on the list of and did not make, newest first, each one the
 * Canvas's own read rule still admits them to (`canvasReaderAllows`), so an
 * archived Canvas never shows. At most the sidebar list's own bound: the
 * merged list keeps no more. The caller answers for whether they are a guest.
 */
export function guestSharedCanvases(sql: SqlStorage, userId: string, report: InvalidCanvasAppearanceReport): GuestSharedCanvas[] {
  return sql.exec<CanvasAdmissionRow & { title: string; appearance_json: string | null; updated_at: number } & Record<string, SqlStorageValue>>(
    `SELECT d.canvas_id, d.created_by_user_id, d.writer_sidekick_id, d.visibility, d.archived_at,
            d.title, d.appearance_json, d.updated_at
       FROM canvas_participants p JOIN canvas_directory d ON d.canvas_id = p.canvas_id
      WHERE p.user_id = ?1 AND d.created_by_user_id <> ?1 AND d.archived_at IS NULL
      ORDER BY d.updated_at DESC, d.canvas_id
      LIMIT ?2`,
    userId, SIDEBAR_LIST_LIMIT,
  ).toArray().filter((row) => canvasReaderAllows(row, { userId, actorRole: null }, sql)).map((row) => ({
    id: row.canvas_id,
    title: row.title,
    // A stored appearance that no longer parses is reported by field and reads as unchosen, as in the list.
    appearance: parsedAppearance(row.appearance_json, "canvas_appearance", (code) => report(row.canvas_id, code)) ?? null,
    updatedAt: row.updated_at,
  }));
}

import {
  CanvasShareStateSchema,
  type CanvasShareState,
} from "@rally/contracts/canvas-share-federation";

import type { InvalidCanvasAppearanceReport } from "./hosted-canvas";
import { parsedAppearance } from "./sidekick-directory-sql";

/*
 * The origin half of Canvas share federation (`docs/canvas-share-federation.md`):
 * the Canvas's own Organization publishes who it is shared with, and never
 * reads another Organization. Everything WorkspaceDO holds for it is here: a
 * revision on each Canvas, and triggers that queue one outbox entry per
 * (Canvas, person) whenever that person's view of the Canvas may have changed.
 * The alarm sends an address-only activity-queue message; the consumer reads
 * the state back with `canvasShareState`.
 */

export const CANVAS_SHARE_FEDERATION_ALARM = "canvas_share_federation";

const clock = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const upsert = `ON CONFLICT(kind,alarm_key) DO UPDATE SET due_at=MAX(_internal_durable_alarms.due_at+1,excluded.due_at),
    retry_at=0,attempt=0,updated_at=excluded.updated_at`;
/** One outbox entry for each person on a Canvas's list but its creator: who it is shared with. */
const enqueueParticipants = (canvas: string) => `INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,repeat_every_ms,retry_at,attempt,payload_json,created_at,updated_at)
    SELECT '${CANVAS_SHARE_FEDERATION_ALARM}', p.canvas_id || ':' || p.user_id, ${clock}, NULL, 0, 0, NULL, ${clock}, ${clock}
      FROM canvas_participants p JOIN canvas_directory d ON d.canvas_id = p.canvas_id
     WHERE p.canvas_id = ${canvas} AND p.user_id <> d.created_by_user_id
    ${upsert};`;

export const CANVAS_SHARE_FEDERATION_STATEMENTS: readonly string[] = [
  `ALTER TABLE canvas_directory ADD COLUMN share_revision INTEGER NOT NULL DEFAULT 0 CHECK (share_revision >= 0)`,
  // Added to or taken off the list: that one person's view changed.
  ...["INSERT", "DELETE"].map((event) => {
    const row = event === "DELETE" ? "OLD" : "NEW";
    return `CREATE TRIGGER canvas_share_federation_participant_${event.toLowerCase()} AFTER ${event} ON canvas_participants BEGIN
      UPDATE canvas_directory SET share_revision = share_revision + 1 WHERE canvas_id = ${row}.canvas_id;
      INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,repeat_every_ms,retry_at,attempt,payload_json,created_at,updated_at)
        VALUES('${CANVAS_SHARE_FEDERATION_ALARM}', ${row}.canvas_id || ':' || ${row}.user_id, ${clock}, NULL, 0, 0, NULL, ${clock}, ${clock})
        ${upsert};
    END`;
  }),
  // What a shared row shows, or whether the Canvas is open at all, changed:
  // everyone it is shared with. Its date alone does not publish.
  `CREATE TRIGGER canvas_share_federation_directory AFTER UPDATE OF title, appearance_json, archived_at ON canvas_directory
    WHEN OLD.title IS NOT NEW.title OR OLD.appearance_json IS NOT NEW.appearance_json OR OLD.archived_at IS NOT NEW.archived_at BEGIN
      UPDATE canvas_directory SET share_revision = share_revision + 1 WHERE canvas_id = NEW.canvas_id;
      ${enqueueParticipants("NEW.canvas_id")}
    END`,
  // A Canvas deleted outright: everyone still on its list.
  `CREATE TRIGGER canvas_share_federation_directory_delete BEFORE DELETE ON canvas_directory BEGIN
      ${enqueueParticipants("OLD.canvas_id")}
    END`,
  // Every share made before federation, published once as the object upgrades.
  `INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,repeat_every_ms,retry_at,attempt,payload_json,created_at,updated_at)
    SELECT '${CANVAS_SHARE_FEDERATION_ALARM}', p.canvas_id || ':' || p.user_id, ${clock}, NULL, 0, 0, NULL, ${clock}, ${clock}
      FROM canvas_participants p JOIN canvas_directory d ON d.canvas_id = p.canvas_id
     WHERE p.user_id <> d.created_by_user_id AND d.archived_at IS NULL
    ${upsert}`,
];

/** The outbox key's two halves. */
export function canvasShareFederationKey(key: string): { canvasId: string; userId: string } {
  const [canvasId, userId, ...rest] = key.split(":");
  if (!canvasId || !userId || rest.length > 0) throw new Error("canvas_share_federation_key_invalid");
  return { canvasId, userId };
}

/**
 * One person's state of one Canvas: shared when they are on its list, did not
 * make it, and it is not archived, the rule the list's `sharedWithMe` follows.
 */
export function canvasShareState(sql: SqlStorage, canvasId: string, userId: string,
  report: InvalidCanvasAppearanceReport): CanvasShareState {
  const row = sql.exec<{
    title: string; appearance_json: string | null; share_revision: number; updated_at: number;
    archived_at: number | null; created_by_user_id: string; listed: number;
  }>(
    `SELECT d.title, d.appearance_json, d.share_revision, d.updated_at, d.archived_at, d.created_by_user_id,
            EXISTS (SELECT 1 FROM canvas_participants p WHERE p.canvas_id = d.canvas_id AND p.user_id = ?2) AS listed
       FROM canvas_directory d WHERE d.canvas_id = ?1`,
    canvasId, userId,
  ).toArray()[0];
  if (!row) return { state: "gone" };
  if (row.listed !== 1 || row.created_by_user_id === userId || row.archived_at !== null) {
    return { state: "unshared", revision: row.share_revision };
  }
  // A stored appearance that no longer parses is reported by field and reads as unchosen, as in the list.
  const appearance = parsedAppearance(row.appearance_json, "canvas_appearance", (code) => report(canvasId, code)) ?? null;
  return CanvasShareStateSchema.parse({
    state: "shared", revision: row.share_revision, title: row.title, appearance, updatedAt: row.updated_at,
  });
}

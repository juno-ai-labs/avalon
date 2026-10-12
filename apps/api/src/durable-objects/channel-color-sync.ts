import { IdSchema, SpaceColorKeySchema, WorkspaceIdSchema } from "@rally/contracts";
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";

/**
 * A thread and its Breakouts store their Channel's colour.
 *
 * For now a conversation does not choose a colour: every thread, and every
 * Breakout under it, carries the colour of the Channel (storage `space`) it
 * sits in, written into its own `appearance_json` by the server. The client's
 * appearance command drops `color` (`applyAppearance`), so the server is the
 * only writer. When a thread sits in several Channels the colour is that of
 * `canonicalChannelSpaceId`, the same viewer-independent placement links use.
 *
 * The colour lives in each conversation's own object while what decides it —
 * the Channel's colour and the thread's placements — lives here in WorkspaceDO,
 * so keeping them in step is a cross-object write. It is done the way the
 * authorization projection is: SQLite triggers on every table whose change can
 * move a thread's colour record the thread in `channel_color_sync`, in the same
 * transaction as the change, so no write path (today's or a future one) can
 * forget to. The alarm sends each due row to the Queue, and the consumer reads
 * the colour back through `channelColorWork`, writes it into Main and every
 * open Breakout with the identity port's `recolor`, and deletes the row only if
 * nothing has marked the thread again since (`revision`). A repeat delivery is
 * harmless: `recolor` writes nothing when the colour already matches.
 *
 * See `docs/workstream-appearance.md`.
 */

const MARK = (workstreamId: string) => `INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before)
       VALUES (${workstreamId}, 1, 0, 0)
       ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, attempts = 0, not_before = 0;`;

/** WorkspaceDO migration 99; the backfill is its last statement. */
export const CHANNEL_COLOR_SYNC_MIGRATION: readonly string[] = [
  `CREATE TABLE channel_color_sync (
    workstream_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX channel_color_sync_due_idx ON channel_color_sync(not_before, workstream_id)`,
  // A placement made, ended, archived with its Channel or restored. `UPDATE OF
  // state` only: the row's ordinal and timestamps move on every feed write.
  `CREATE TRIGGER channel_color_membership_insert AFTER INSERT ON space_channel_memberships BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_membership_state AFTER UPDATE OF state ON space_channel_memberships
   WHEN OLD.state IS NOT NEW.state BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_membership_delete AFTER DELETE ON space_channel_memberships BEGIN
     ${MARK("OLD.workstream_id")}
   END`,
  // A Channel recoloured, archived, restored, or made private, which moves it
  // in `canonicalChannelSpaceId`'s order. Every thread placed in it is marked;
  // the consumer works out whether this Channel is the one that decides.
  `CREATE TRIGGER channel_color_space_change AFTER UPDATE OF appearance_json, archived_at, scope ON spaces
   WHEN json_extract(OLD.appearance_json, '$.color') IS NOT json_extract(NEW.appearance_json, '$.color')
     OR OLD.archived_at IS NOT NEW.archived_at OR OLD.scope IS NOT NEW.scope BEGIN
     INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before)
       SELECT workstream_id, 1, 0, 0 FROM space_channel_memberships
        WHERE space_id = NEW.space_id AND state = 'active'
       ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, attempts = 0, not_before = 0;
   END`,
  // A thread's or a Breakout's first projection: the conversation exists now,
  // and starts without a colour. A thread restored from the archive is marked
  // too, since its Channels may have changed colour while it was away.
  `CREATE TRIGGER channel_color_thread_insert AFTER INSERT ON channels BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_thread_restore AFTER UPDATE OF archived_at ON channels
   WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_breakout_insert AFTER INSERT ON breakouts BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  `CREATE TRIGGER channel_color_breakout_restore AFTER UPDATE OF archived_at ON breakouts
   WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL BEGIN
     ${MARK("NEW.workstream_id")}
   END`,
  // Every thread that exists today, so each one and its Breakouts take their
  // Channel's colour once this ships.
  `INSERT INTO channel_color_sync(workstream_id, revision, attempts, not_before)
     SELECT workstream_id, 1, 0, 0 FROM channels WHERE archived_at IS NULL`,
];

/** One thread whose conversations should carry its Channel's colour. */
export const ChannelColorSyncMessageSchema = z.strictObject({
  type: z.literal("channel_color_sync"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: IdSchema,
  revision: z.number().int().positive(),
});
export type ChannelColorSyncMessage = z.infer<typeof ChannelColorSyncMessageSchema>;

/**
 * What the consumer writes for one thread: the colour, and the conversations to
 * write it into. `null` when there is nothing to do — the row was marked again
 * or is gone, or the thread is archived or has no Channel — and the row is
 * settled by `channelColorWork` itself.
 */
export const ChannelColorWorkSchema = z.strictObject({
  color: SpaceColorKeySchema,
  substreamIds: z.array(z.string().min(1)).min(1),
}).nullable();
export type ChannelColorWork = z.infer<typeof ChannelColorWorkSchema>;

/** `null` too for an Organization held below migration 99, which has no table yet. */
export function nextChannelColorSyncAt(sql: SqlStorage): number | null {
  const present = sql.exec(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'channel_color_sync'",
  ).toArray().length > 0;
  if (!present) return null;
  return sql.exec<{ due: number | null }>("SELECT MIN(not_before) AS due FROM channel_color_sync").one().due;
}

/**
 * Send one batch of due threads, advancing each row's retry gate before the
 * await so a failed or lost delivery comes round again on its own. The row is
 * deleted by the consumer, not here.
 */
export async function publishChannelColorSync(input: {
  sql: SqlStorage;
  queue: { sendBatch(messages: Array<{ body: ChannelColorSyncMessage }>): Promise<unknown> };
  workspaceId: string;
  region: ChannelColorSyncMessage["region"];
  now: number;
  retryAt: (attempt: number) => number;
}): Promise<number> {
  // Cloudflare Queue sendBatch accepts at most 100 messages.
  const rows = input.sql.exec<{ workstream_id: string; revision: number; attempts: number }>(
    `SELECT workstream_id, revision, attempts FROM channel_color_sync
      WHERE not_before <= ? ORDER BY not_before, workstream_id LIMIT 100`,
    input.now,
  ).toArray();
  if (rows.length === 0) return 0;
  for (const row of rows) {
    input.sql.exec(
      "UPDATE channel_color_sync SET attempts = ?, not_before = ? WHERE workstream_id = ? AND revision = ?",
      row.attempts + 1, input.retryAt(row.attempts + 1), row.workstream_id, row.revision,
    );
  }
  await input.queue.sendBatch(rows.map((row) => ({
    body: ChannelColorSyncMessageSchema.parse({
      type: "channel_color_sync",
      region: input.region,
      workspaceId: input.workspaceId,
      workstreamId: row.workstream_id,
      revision: row.revision,
    }),
  })));
  return rows.length;
}

/** Settle a row the consumer finished, unless the thread was marked again since. */
export function completeChannelColorSync(sql: SqlStorage, workstreamId: string, revision: number): boolean {
  return sql.exec<{ workstream_id: string }>(
    "DELETE FROM channel_color_sync WHERE workstream_id = ? AND revision = ? RETURNING workstream_id",
    workstreamId, revision,
  ).toArray().length === 1;
}

/**
 * The colour and conversations for one marked thread, or `null` after settling
 * a row that has nothing to write. `color` is the thread's deciding Channel's,
 * already coerced the way a Space summary coerces it.
 */
export function channelColorWork(
  sql: SqlStorage,
  input: { workstreamId: string; revision: number; color: z.infer<typeof SpaceColorKeySchema> | null },
): ChannelColorWork {
  const marked = sql.exec<{ revision: number }>(
    "SELECT revision FROM channel_color_sync WHERE workstream_id = ?", input.workstreamId,
  ).toArray()[0];
  // Marked again since this message was sent: the newer message carries it.
  if (marked?.revision !== input.revision) return null;
  const thread = sql.exec<{ archived_at: number | null }>(
    "SELECT archived_at FROM channels WHERE workstream_id = ?", input.workstreamId,
  ).toArray()[0];
  // No projection yet (its insert marks it again), archived (its restore
  // does), or in no Channel (its next placement does).
  if (!thread || thread.archived_at !== null || input.color === null) {
    completeChannelColorSync(sql, input.workstreamId, input.revision);
    return null;
  }
  const breakouts = sql.exec<{ substream_id: string }>(
    `SELECT substream_id FROM breakouts
      WHERE workstream_id = ? AND archived_at IS NULL ORDER BY substream_id`,
    input.workstreamId,
  ).toArray().map((row) => row.substream_id);
  return { color: input.color, substreamIds: ["0", ...breakouts] };
}

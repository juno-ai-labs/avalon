import { WorkspaceIdSchema } from "@rally/contracts";
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";

import { MemoryConversationSchema, memorySourceOf, type MemoryConversation } from "./workspace-memory-facts-protocol";

/**
 * Every conversation that holds a memory digest copy hears when that copy may
 * now show a fact it should not.
 *
 * A conversation keeps one digest copy per principal that acted in it (agent
 * memory step 2), refreshed from `memoryDigest` here. What decides a copy's
 * contents — the facts, and who may open each fact's sources and subject —
 * lives in this object, while the copy lives in the conversation's own object,
 * so keeping them in step is a cross-object write. It is done the way channel
 * colour sync does it (`channel-color-sync.ts`), one for one: `memoryDigest`
 * records each conversation it answers in `memory_digest_holders`; SQLite
 * triggers on every change that can withdraw a fact from a reader, the
 * retraction in `forgetMemoryFact`, and a sweep that retracts or supersedes a
 * fact (`applyMemorySweep`) mark the holders in `memory_digest_sync` in
 * the same transaction as the change; the alarm sends each due row to the
 * Queue; the consumer reads the conversation back through
 * `memoryDigestSyncWork`, refreshes its copies, and settles the row only if
 * nothing has marked it again since (`revision`).
 *
 * **Every holder, not the affected ones.** Which copies a scope change or a
 * retraction touches depends on which facts each copy holds and on the
 * sources those facts carry, which only the conversation knows. Marking every
 * holder is one statement and cannot miss one; the batch limit below keeps the
 * fan-out to one batch in flight per Organization.
 *
 * **Only what withdraws.** A scope change in either direction (a narrowing
 * withdraws, and a widening is cheap to answer the same way), and a person
 * stopping being a participant. There is no DELETE trigger on the viewer
 * tables: projection rebuilds delete and reinsert their rows in bulk, which
 * would mark every holder on every rebuild while withdrawing nothing the
 * `is_participant` update does not already cover. A fact being added is not
 * marked either: copies widen on their own refreshes (a run's settle, a sweep).
 *
 * **One batch in flight per Organization**, for colour sync's reason: each
 * message costs this object a call and the conversation a refresh that calls
 * back here. See `docs/agent-memory.md`.
 */

/**
 * Every mark takes the next value of one counter, so a conversation's revision
 * never repeats, not even after its row is settled and deleted, and a late
 * completion of an older mark cannot settle a newer one.
 */
const NEXT_REVISION = "UPDATE memory_digest_sync_state SET revision = revision + 1 WHERE id = 1;";
const CURRENT_REVISION = "(SELECT revision FROM memory_digest_sync_state WHERE id = 1)";
const REMARK = "ON CONFLICT(conversation) DO UPDATE SET revision = excluded.revision, attempts = 0, not_before = 0, in_flight = 0;";

/** Mark every holder; `WHERE true` keeps SQLite from reading `ON CONFLICT` as a join constraint. */
const MARK = `${NEXT_REVISION}
     INSERT INTO memory_digest_sync(conversation, revision, attempts, not_before)
       SELECT conversation, ${CURRENT_REVISION}, 0, 0 FROM memory_digest_holders WHERE true
       ${REMARK}`;

/**
 * The triggers by table. Exported because a rebuild of any of these tables
 * drops its trigger and has to put the same text back (as migration 102 did for
 * channel colour sync's `spaces` trigger).
 */
export const MEMORY_DIGEST_SYNC_TRIGGERS = {
  channels: `CREATE TRIGGER memory_digest_thread_scope AFTER UPDATE OF scope ON channels
   WHEN OLD.scope IS NOT NEW.scope BEGIN
     ${MARK}
   END`,
  breakouts: `CREATE TRIGGER memory_digest_breakout_scope AFTER UPDATE OF scope ON breakouts
   WHEN OLD.scope IS NOT NEW.scope BEGIN
     ${MARK}
   END`,
  spaces: `CREATE TRIGGER memory_digest_space_scope AFTER UPDATE OF scope ON spaces
   WHEN OLD.scope IS NOT NEW.scope BEGIN
     ${MARK}
   END`,
  channel_viewers: `CREATE TRIGGER memory_digest_thread_participant AFTER UPDATE OF is_participant ON channel_viewers
   WHEN OLD.is_participant = 1 AND NEW.is_participant = 0 BEGIN
     ${MARK}
   END`,
  breakout_viewers: `CREATE TRIGGER memory_digest_breakout_participant AFTER UPDATE OF is_participant ON breakout_viewers
   WHEN OLD.is_participant = 1 AND NEW.is_participant = 0 BEGIN
     ${MARK}
   END`,
  space_viewers: `CREATE TRIGGER memory_digest_space_participant AFTER UPDATE OF is_participant ON space_viewers
   WHEN OLD.is_participant = 1 AND NEW.is_participant = 0 BEGIN
     ${MARK}
   END`,
} as const;

/** WorkspaceDO migration 117. */
export const MEMORY_DIGEST_SYNC_MIGRATION: readonly string[] = [
  `CREATE TABLE memory_digest_holders (
    conversation TEXT PRIMARY KEY,
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space')),
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    refreshed_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE memory_digest_sync (
    conversation TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0, 1))
  ) STRICT`,
  `CREATE INDEX memory_digest_sync_due_idx ON memory_digest_sync(not_before, conversation)`,
  `CREATE TABLE memory_digest_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  ) STRICT`,
  // Nothing holds a copy yet, so there is no backfill; the first mark is 1.
  "INSERT INTO memory_digest_sync_state(id, revision) VALUES (1, 0)",
  ...Object.values(MEMORY_DIGEST_SYNC_TRIGGERS),
];

/** Mark every conversation holding a copy, inside the caller's transaction. */
export function markMemoryDigestHolders(sql: SqlStorage): void {
  sql.exec(MARK);
}

/** Record that `conversation` holds a copy now, so the lane can reach it. */
export function recordMemoryDigestHolder(sql: SqlStorage, conversation: MemoryConversation, now: number): void {
  sql.exec(
    `INSERT INTO memory_digest_holders(conversation, parent_kind, parent_id, substream_id, refreshed_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation) DO UPDATE SET refreshed_at = excluded.refreshed_at`,
    memorySourceOf(conversation), conversation.parentKind, conversation.parentId, conversation.substreamId, now,
  );
}

/** One conversation whose digest copies should be refreshed. */
export const MemoryDigestSyncMessageSchema = z.strictObject({
  type: z.literal("memory_digest_sync"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  /** `memorySourceOf` the conversation: the holder's key. */
  conversation: z.string().min(1),
  revision: z.number().int().positive(),
});
export type MemoryDigestSyncMessage = z.infer<typeof MemoryDigestSyncMessageSchema>;

/** The conversation to refresh, or `null` when there is nothing to do and the row is settled. */
export const MemoryDigestSyncWorkSchema = MemoryConversationSchema.nullable();
export type MemoryDigestSyncWork = z.infer<typeof MemoryDigestSyncWorkSchema>;

/** `null` too for an Organization held below migration 117, which has no table yet. */
export function nextMemoryDigestSyncAt(sql: SqlStorage): number | null {
  const present = sql.exec(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_digest_sync'",
  ).toArray().length > 0;
  if (!present) return null;
  return sql.exec<{ due: number | null }>(
    // While a batch is in flight the next wake is its earliest gate, not the
    // pending rows' (which are due now and would wake the alarm for nothing).
    `SELECT COALESCE(
       (SELECT MIN(not_before) FROM memory_digest_sync WHERE in_flight = 1 AND not_before > ?),
       (SELECT MIN(not_before) FROM memory_digest_sync)) AS due`,
    Date.now(),
  ).one().due;
}

/** Whether a batch sent earlier is still waiting on its consumer, as of `now`. */
function batchInFlight(sql: SqlStorage, now: number): boolean {
  return sql.exec(
    "SELECT 1 FROM memory_digest_sync WHERE in_flight = 1 AND not_before > ? LIMIT 1", now,
  ).toArray().length > 0;
}

/**
 * Send one batch of due conversations, advancing each row's retry gate before
 * the await so a failed or lost delivery comes round again on its own. The row
 * is deleted by the consumer, not here.
 */
export async function publishMemoryDigestSync(input: {
  sql: SqlStorage;
  queue: { sendBatch(messages: Array<{ body: MemoryDigestSyncMessage }>): Promise<unknown> };
  workspaceId: string;
  region: MemoryDigestSyncMessage["region"];
  now: number;
  retryAt: (attempt: number) => number;
}): Promise<number> {
  if (batchInFlight(input.sql, input.now)) return 0;
  // Cloudflare Queue sendBatch accepts at most 100 messages (Cloudflare Queues
  // limits, read 2026-10-12, as colour sync); one batch is also the most in
  // flight at once.
  const rows = input.sql.exec<{ conversation: string; revision: number; attempts: number }>(
    `SELECT conversation, revision, attempts FROM memory_digest_sync
      WHERE not_before <= ? ORDER BY not_before, conversation LIMIT 100`,
    input.now,
  ).toArray();
  if (rows.length === 0) return 0;
  for (const row of rows) {
    input.sql.exec(
      `UPDATE memory_digest_sync SET attempts = ?, not_before = ?, in_flight = 1
        WHERE conversation = ? AND revision = ?`,
      row.attempts + 1, input.retryAt(row.attempts + 1), row.conversation, row.revision,
    );
  }
  await input.queue.sendBatch(rows.map((row) => ({
    body: MemoryDigestSyncMessageSchema.parse({
      type: "memory_digest_sync",
      region: input.region,
      workspaceId: input.workspaceId,
      conversation: row.conversation,
      revision: row.revision,
    }),
  })));
  return rows.length;
}

/** Settle a row the consumer finished, unless the conversation was marked again since. */
export function completeMemoryDigestSync(sql: SqlStorage, conversation: string, revision: number): boolean {
  return sql.exec<{ conversation: string }>(
    "DELETE FROM memory_digest_sync WHERE conversation = ? AND revision = ? RETURNING conversation",
    conversation, revision,
  ).toArray().length === 1;
}

/**
 * Let a conversation the consumer could not finish stop holding the next
 * batch back. Its gate, set when it was claimed, still decides when it is sent
 * again.
 */
export function releaseMemoryDigestSync(sql: SqlStorage, conversation: string, revision: number): boolean {
  return sql.exec<{ conversation: string }>(
    `UPDATE memory_digest_sync SET in_flight = 0
      WHERE conversation = ? AND revision = ? RETURNING conversation`,
    conversation, revision,
  ).toArray().length === 1;
}

/**
 * Whether the conversation is still live in this object's directory
 * projection: a thread (and, for a Breakout, the Breakout too) not archived, a
 * Channel not archived, a Sidekick not deleted.
 */
function conversationLive(sql: SqlStorage, conversation: MemoryConversation): boolean {
  const exists = (query: string, ...bindings: string[]) => sql.exec(query, ...bindings).toArray().length > 0;
  switch (conversation.parentKind) {
    case "workstream": {
      const thread = exists("SELECT 1 FROM channels WHERE workstream_id = ? AND archived_at IS NULL", conversation.parentId);
      if (!thread || conversation.substreamId === "0") return thread;
      return exists(
        "SELECT 1 FROM breakouts WHERE workstream_id = ? AND substream_id = ? AND archived_at IS NULL",
        conversation.parentId, conversation.substreamId,
      );
    }
    case "automation":
      return exists("SELECT 1 FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'", conversation.parentId);
    case "space":
      return exists("SELECT 1 FROM spaces WHERE space_id = ? AND archived_at IS NULL", conversation.parentId);
  }
}

/**
 * The conversation one marked row names, or `null`: marked again since this
 * message was sent (the newer message carries it), no longer a holder, or
 * archived or gone from the directory (both settled here). A dead
 * conversation's holder row is deleted too, so it stops being marked; if it is
 * restored, its next digest read records it again.
 */
export function memoryDigestSyncWork(
  sql: SqlStorage,
  input: { conversation: string; revision: number },
): MemoryDigestSyncWork {
  const marked = sql.exec<{ revision: number }>(
    "SELECT revision FROM memory_digest_sync WHERE conversation = ?", input.conversation,
  ).toArray()[0];
  if (marked?.revision !== input.revision) return null;
  const holder = sql.exec<{ parent_kind: MemoryConversation["parentKind"]; parent_id: string; substream_id: string }>(
    "SELECT parent_kind, parent_id, substream_id FROM memory_digest_holders WHERE conversation = ?", input.conversation,
  ).toArray()[0];
  if (!holder) {
    completeMemoryDigestSync(sql, input.conversation, input.revision);
    return null;
  }
  const conversation: MemoryConversation = {
    parentKind: holder.parent_kind, parentId: holder.parent_id, substreamId: holder.substream_id,
  };
  if (!conversationLive(sql, conversation)) {
    sql.exec("DELETE FROM memory_digest_holders WHERE conversation = ?", input.conversation);
    completeMemoryDigestSync(sql, input.conversation, input.revision);
    return null;
  }
  return conversation;
}

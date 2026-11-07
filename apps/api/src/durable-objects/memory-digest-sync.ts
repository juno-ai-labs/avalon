import { WorkspaceIdSchema } from "@rally/contracts";
import { codeShaped } from "@rally/contracts/zod-diagnostics";
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";
import { ApiError } from "../lib/api-error";

import {
  MemoryConversationSchema,
  memoryConversationKeyOf,
  type MemoryConversation,
} from "./workspace-memory-facts-protocol";

/**
 * The copy-sync lane: `WorkspaceDO` marks every conversation holding a memory
 * digest copy that may now show a fact its reader should not see, and the
 * alarm hands each to the Queue for a refresh, channel colour sync's shape
 * (`channel-color-sync.ts`). What marks, and why, is in
 * `docs/agent-memory.md#the-digest`.
 */

/**
 * Every mark takes the next value of one counter, so a conversation's revision
 * never repeats, not even after its row is settled and deleted, and a late
 * completion of an older mark cannot settle a newer one.
 */
const NEXT_REVISION = "UPDATE memory_digest_sync_state SET revision = revision + 1 WHERE id = 1;";
const CURRENT_REVISION = "(SELECT revision FROM memory_digest_sync_state WHERE id = 1)";
/**
 * A mark is a change in what some copy may show, so it also advances the
 * token every digest read is stamped with: the refresh it asks for reads above
 * every read taken before the change, and a copy keeps the newer read.
 */
const NEXT_MEMORY_REVISION = "UPDATE memory_revision SET revision = revision + 1 WHERE id = 1;";
const REMARK = "ON CONFLICT(conversation) DO UPDATE SET revision = excluded.revision, attempts = 0, not_before = 0, in_flight = 0";

/** Mark the holders `holders` selects (a predicate over `memory_digest_holders`). */
function markWhere(holders: string): string {
  return `${NEXT_REVISION}
     ${NEXT_MEMORY_REVISION}
     INSERT INTO memory_digest_sync(conversation, revision, attempts, not_before)
       SELECT conversation, ${CURRENT_REVISION}, 0, 0 FROM memory_digest_holders WHERE ${holders}
       ${REMARK};`;
}

const MARK_ALL = markWhere("true");
/** Every conversation of one thread: its Main and its Breakouts. */
const THREAD_HOLDERS = "parent_kind = 'workstream' AND parent_id = NEW.workstream_id";
const SPACE_HOLDERS = "parent_kind = 'space' AND parent_id = NEW.space_id";

/** The holders whose copy was read with a fact one of whose sources matches `source` (over `source.value`). */
function holdersOfFactsFrom(source: string): string {
  return `conversation IN (
         SELECT held.conversation FROM memory_digest_holder_facts held
           JOIN memory_facts fact ON fact.fact_id = held.fact_id
          WHERE EXISTS (SELECT 1 FROM json_each(fact.source_conversations_json) source WHERE ${source}))`;
}

/**
 * A participant joining or leaving changes that conversation's audience, so
 * its holders are marked. Leaving also takes the conversation away from the
 * person, which withdraws what was learned there from their copies everywhere
 * and from every copy whose audience includes them: the holders of a fact
 * sourced here are marked too. Joining widens an audience and hides nothing.
 */
function participantTriggers(table: string, name: string, holders: string, source: string): readonly string[] {
  return [
    `CREATE TRIGGER memory_digest_${name}_participant_insert AFTER INSERT ON ${table}
   WHEN NEW.is_participant = 1 BEGIN
     ${markWhere(holders)}
   END`,
    `CREATE TRIGGER memory_digest_${name}_participant_update AFTER UPDATE OF is_participant ON ${table}
   WHEN OLD.is_participant IS NOT NEW.is_participant BEGIN
     ${markWhere(`(${holders}) OR (OLD.is_participant = 1 AND ${holdersOfFactsFrom(source)})`)}
   END`,
  ];
}

function visibilityTrigger(table: string, name: string): string {
  return `CREATE TRIGGER memory_digest_${name}_visibility AFTER UPDATE OF scope, archived_at ON ${table}
   WHEN OLD.scope IS NOT NEW.scope OR OLD.archived_at IS NOT NEW.archived_at BEGIN
     ${MARK_ALL}
   END`;
}

/**
 * The triggers by table: one per column the visibility rule
 * (`openableByPerson`, `conversationAudience`) reads. Exported because a
 * rebuild of any of these tables drops its triggers and has to put the same
 * text back (as migration 102 did for channel colour sync's `spaces` trigger).
 *
 * No `DELETE` triggers: projection rebuilds delete and reinsert viewer rows in
 * bulk. A rebuild's reinserts mark that one thread's (or Channel's) holders,
 * which is bounded; a participant a rebuild removed reaches copies at their
 * next refresh.
 */
export const MEMORY_DIGEST_SYNC_TRIGGERS = {
  channels: [visibilityTrigger("channels", "thread")],
  breakouts: [visibilityTrigger("breakouts", "breakout")],
  spaces: [visibilityTrigger("spaces", "space")],
  // A thread's sources are its Main and its Breakouts, which it lists.
  channel_viewers: participantTriggers("channel_viewers", "thread", THREAD_HOLDERS,
    "source.value = NEW.workstream_id OR substr(source.value, 1, length(NEW.workstream_id) + 1) = NEW.workstream_id || '/'"),
  breakout_viewers: participantTriggers("breakout_viewers", "breakout", THREAD_HOLDERS,
    "source.value = NEW.workstream_id || '/' || NEW.substream_id"),
  space_viewers: participantTriggers("space_viewers", "space", SPACE_HOLDERS, "source.value = 'space:' || NEW.space_id"),
  // Member or guest, administrator, and active are what a person reader is
  // resolved to; a revision that changed none of them withdraws nothing.
  workspace_member_status: [`CREATE TRIGGER memory_digest_member_relationship AFTER UPDATE OF relationship_json, active ON workspace_member_status
   WHEN OLD.active IS NOT NEW.active
     OR json_extract(OLD.relationship_json, '$.accessClass') IS NOT json_extract(NEW.relationship_json, '$.accessClass')
     OR json_extract(OLD.relationship_json, '$.role') IS NOT json_extract(NEW.relationship_json, '$.role')
     OR json_extract(OLD.relationship_json, '$.status') IS NOT json_extract(NEW.relationship_json, '$.status') BEGIN
     ${MARK_ALL}
   END`],
  automation_directory: [`CREATE TRIGGER memory_digest_sidekick_scope AFTER UPDATE OF scope ON automation_directory
   WHEN OLD.scope IS NOT NEW.scope BEGIN
     ${MARK_ALL}
   END`],
} as const satisfies Record<string, readonly string[]>;

/** WorkspaceDO migration 117. */
export const MEMORY_DIGEST_SYNC_MIGRATION: readonly string[] = [
  `CREATE TABLE memory_digest_holders (
    conversation TEXT PRIMARY KEY,
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space')),
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    refreshed_at INTEGER NOT NULL
  ) STRICT`,
  // Which facts each principal's copy in a conversation was last read with, so
  // a retraction marks only the holders that hold the fact.
  `CREATE TABLE memory_digest_holder_facts (
    conversation TEXT NOT NULL,
    principal TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (conversation, principal, fact_id)
  ) STRICT`,
  `CREATE INDEX memory_digest_holder_facts_fact_idx ON memory_digest_holder_facts(fact_id)`,
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
  // The ordering token of every digest read (`WorkspaceMemoryDigestResultSchema`).
  `CREATE TABLE memory_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  ) STRICT`,
  "INSERT INTO memory_revision(id, revision) VALUES (1, 0)",
  ...Object.values(MEMORY_DIGEST_SYNC_TRIGGERS).flat(),
];

const MEMORY_DIGEST_TRIGGER_STATEMENTS = Object.values(MEMORY_DIGEST_SYNC_TRIGGERS).flat();

/**
 * WorkspaceDO migration 143: a holder may be a Canvas's Chat. The CHECK on
 * `parent_kind` cannot widen in place, so the table is copied. Every trigger
 * above reads the table by name in its body, and SQLite refuses to rename a
 * table into place while a trigger names one that does not exist, so the
 * triggers are dropped first and put back with the same text afterwards.
 */
export const MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION: readonly string[] = [
  ...MEMORY_DIGEST_TRIGGER_STATEMENTS.map((statement) =>
    `DROP TRIGGER IF EXISTS ${/^CREATE TRIGGER (\S+)/u.exec(statement)![1]}`),
  `CREATE TABLE memory_digest_holders_v143 (
    conversation TEXT PRIMARY KEY,
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space', 'canvas')),
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    refreshed_at INTEGER NOT NULL
  ) STRICT`,
  "INSERT INTO memory_digest_holders_v143 SELECT * FROM memory_digest_holders",
  "DROP TABLE memory_digest_holders",
  "ALTER TABLE memory_digest_holders_v143 RENAME TO memory_digest_holders",
  ...MEMORY_DIGEST_TRIGGER_STATEMENTS,
];

/**
 * WorkspaceDO migration 144: the copy-sync triggers for the parents that
 * remain, which `MEMORY_DIGEST_SYNC_TRIGGERS` (written for Threads and
 * Channels, and hashed into migrations 117 and 143) never covered. A Canvas
 * changing who may open it (`canvasReaderAllows` reads its visibility, its
 * creator and the Sidekick that writes it) or being deleted marks every
 * holder; a participant joining marks that Canvas's holders, and one leaving
 * also marks every copy holding a fact learned there. A Sidekick's people
 * list is what `sidekickAdmits` reads, so a change marks every holder.
 */
const CANVAS_HOLDERS = (row: "NEW" | "OLD") => `parent_kind = 'canvas' AND parent_id = ${row}.canvas_id`;
export const MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION: readonly string[] = [
  `CREATE TRIGGER memory_digest_canvas_visibility AFTER UPDATE OF visibility, created_by_user_id, writer_sidekick_id ON canvas_directory
   WHEN OLD.visibility IS NOT NEW.visibility OR OLD.created_by_user_id IS NOT NEW.created_by_user_id
     OR OLD.writer_sidekick_id IS NOT NEW.writer_sidekick_id BEGIN
     ${MARK_ALL}
   END`,
  `CREATE TRIGGER memory_digest_canvas_delete AFTER DELETE ON canvas_directory BEGIN
     ${MARK_ALL}
   END`,
  `CREATE TRIGGER memory_digest_canvas_participant_insert AFTER INSERT ON canvas_participants BEGIN
     ${markWhere(CANVAS_HOLDERS("NEW"))}
   END`,
  `CREATE TRIGGER memory_digest_canvas_participant_delete AFTER DELETE ON canvas_participants BEGIN
     ${markWhere(`(${CANVAS_HOLDERS("OLD")}) OR ${holdersOfFactsFrom("source.value = 'canvas:' || OLD.canvas_id")}`)}
   END`,
  `CREATE TRIGGER memory_digest_sidekick_audience_insert AFTER INSERT ON sidekick_audience BEGIN
     ${MARK_ALL}
   END`,
  `CREATE TRIGGER memory_digest_sidekick_audience_delete AFTER DELETE ON sidekick_audience BEGIN
     ${MARK_ALL}
   END`,
];

/** Advance `memory_revision` inside the caller's transaction and answer the new value. */
export function nextMemoryRevision(sql: SqlStorage): number {
  return sql.exec<{ revision: number }>(
    "UPDATE memory_revision SET revision = revision + 1 WHERE id = 1 RETURNING revision",
  ).one().revision;
}

export function currentMemoryRevision(sql: SqlStorage): number {
  return sql.exec<{ revision: number }>("SELECT revision FROM memory_revision WHERE id = 1").one().revision;
}

/** Mark every conversation holding a copy, inside the caller's transaction. */
export function markMemoryDigestHolders(sql: SqlStorage): void {
  sql.exec(MARK_ALL);
}

/**
 * Mark only the holders whose copy was read with one of `factIds`, inside the
 * caller's transaction; `true` when any was marked.
 */
export function markMemoryDigestHoldersFor(sql: SqlStorage, factIds: readonly string[]): boolean {
  if (factIds.length === 0) return false;
  sql.exec(NEXT_REVISION);
  sql.exec(NEXT_MEMORY_REVISION);
  return sql.exec<{ conversation: string }>(
    `INSERT INTO memory_digest_sync(conversation, revision, attempts, not_before)
       SELECT DISTINCT conversation, ${CURRENT_REVISION}, 0, 0 FROM memory_digest_holder_facts
        WHERE fact_id IN (SELECT value FROM json_each(?))
       ${REMARK}
     RETURNING conversation`,
    JSON.stringify(factIds),
  ).toArray().length > 0;
}

/**
 * Record that one principal's copy in `conversation` now holds `factIds`, so
 * the lane can reach it: the conversation as a holder, and its facts replaced.
 */
export function recordMemoryDigestHolder(
  sql: SqlStorage,
  input: { conversation: MemoryConversation; principal: string; factIds: readonly string[]; now: number },
): void {
  const key = memoryConversationKeyOf(input.conversation);
  try {
    sql.exec(
      `INSERT INTO memory_digest_holders(conversation, parent_kind, parent_id, substream_id, refreshed_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation) DO UPDATE SET refreshed_at = excluded.refreshed_at`,
      key, input.conversation.parentKind, input.conversation.parentId, input.conversation.substreamId, input.now,
    );
  } catch (error) {
    // The table's CHECK names the conversation kinds that may hold a copy. A
    // kind it does not admit (a Canvas, before migration 143) failed every
    // refresh under one generic reason; say which kind it was.
    if (!(error instanceof Error) || !/CHECK constraint failed/u.test(error.message)) throw error;
    throw new ApiError(500, "memory_digest_holder_kind_unadmitted", "This conversation kind cannot hold a memory digest copy",
      undefined, codeShaped(`memory_digest_holder_kind_unadmitted:${input.conversation.parentKind}`));
  }
  sql.exec("DELETE FROM memory_digest_holder_facts WHERE conversation = ? AND principal = ?", key, input.principal);
  sql.exec(
    `INSERT INTO memory_digest_holder_facts(conversation, principal, fact_id)
       SELECT ?, ?, value FROM json_each(?)`,
    key, input.principal, JSON.stringify(input.factIds),
  );
}

/** One conversation whose digest copies should be refreshed. */
export const MemoryDigestSyncMessageSchema = z.strictObject({
  type: z.literal("memory_digest_sync"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  /** `memoryConversationKeyOf` the conversation: the holder's key. */
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
    case "canvas":
      return exists("SELECT 1 FROM canvas_directory WHERE canvas_id = ?", conversation.parentId);
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
    sql.exec("DELETE FROM memory_digest_holder_facts WHERE conversation = ?", input.conversation);
    completeMemoryDigestSync(sql, input.conversation, input.revision);
    return null;
  }
  return conversation;
}

import { RegionSchema } from "@rally/contracts/regions";
import { IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { searchAudienceGroup } from "../services/search-audience";
import type { SearchDocument, SearchDocumentBatch } from "../services/search-document";
import type { SearchDocumentJob } from "../services/search-indexing-jobs";
import { searchIndexingConfigured } from "../services/search-embedding";
import { searchDocumentId } from "../services/text-search";
import type { ResourceSearchPace } from "./resource-search-projection";
import { RESOURCE_SEARCH_BACKLOG_INTERVAL_MS } from "./resource-search-projection";

/**
 * A Channel's own messages (`space_messages`: Rally's posts and the results
 * threads merge into it) in the shared search index, so a Channel message is
 * found the way a thread's message is: one index, one audience filter. See
 * docs/text-search.md.
 *
 * The resource projection's shape, for the same reason: the rows live in
 * WorkspaceDO, so a version table records each message's revision and a
 * pending flag, triggers on every writer keep it, the alarm publishes
 * references in batches, and the Queue consumer calls back here for the one
 * document. Each reference goes out as a document-phase job
 * (`search_embedding_batch_v1`), not a message type of its own: a consumer on
 * an older build recognizes that envelope, fails to parse the reference it
 * does not know, and retries it until a newer consumer takes it, where an
 * unknown type would be acknowledged and lost (docs/text-search.md, "Version
 * skew between producers and the consumer"). The revision outlives a deleted message, so a late job for it
 * writes a deletion watermark rather than restoring it.
 *
 * A row's audience is the Channel's `space:<id>` group: every reader of the
 * Channel sees every message in its feed, a private thread's merge included,
 * and `readSearchAudience` already gives that group to each person who may
 * list the Channel, unarchived. Its title is the Channel's name as it was
 * indexed, never the merged thread's, which a reader of the Channel may not be
 * allowed to see.
 */

export const CHANNEL_MESSAGE_SEARCH_SOURCE = "channel_messages";

export const ChannelMessageSearchProjectionSchema = z.strictObject({
  type: z.literal("channel_message_search_projection_v1"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  messageId: IdSchema,
});
export type ChannelMessageSearchProjection = z.infer<typeof ChannelMessageSearchProjectionSchema>;
export const ChannelMessageSearchRevisionRequestSchema = ChannelMessageSearchProjectionSchema
  .pick({ workspaceId: true, messageId: true });

/**
 * WorkspaceDO migration 120. `space_id` is kept beside the revision because a
 * deleted message's document id is derived from it. A Channel's rename does
 * not rewrite its rows: the row's title is the name when it was indexed, and
 * nothing reads it (`conversation_search` names a match from its scope). A
 * reader of row titles would add a rename trigger in a migration of its own.
 * Immutable once shipped: each statement is hashed into the migration receipt.
 */
export const CHANNEL_MESSAGE_SEARCH_MIGRATION: readonly string[] = [
  `CREATE TABLE channel_message_search_versions (
    message_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
    not_before INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX channel_message_search_versions_pending_idx
     ON channel_message_search_versions(pending, not_before, message_id)`,
  ...(["INSERT", "DELETE"] as const).map((operation) => {
    const row = operation === "DELETE" ? "OLD" : "NEW";
    return `CREATE TRIGGER space_messages_search_${operation.toLowerCase()} AFTER ${operation} ON space_messages
      BEGIN
        INSERT INTO channel_message_search_versions(message_id, space_id, revision, pending, not_before)
        VALUES (${row}.message_id, ${row}.space_id, 1, 1, 0)
        ON CONFLICT(message_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
      END`;
  }),
  // A merge made again rewrites its row in place with new words and a new time.
  `CREATE TRIGGER space_messages_search_update AFTER UPDATE ON space_messages
    WHEN OLD.body IS NOT NEW.body OR OLD.posted_at IS NOT NEW.posted_at OR OLD.space_id IS NOT NEW.space_id
    BEGIN
      INSERT INTO channel_message_search_versions(message_id, space_id, revision, pending, not_before)
      VALUES (NEW.message_id, NEW.space_id, 1, 1, 0)
      ON CONFLICT(message_id) DO UPDATE SET space_id = NEW.space_id, revision = revision + 1, pending = 1, not_before = 0;
    END`,
  `INSERT INTO channel_message_search_versions(message_id, space_id, revision, pending, not_before)
   SELECT message_id, space_id, 1, 1, 0 FROM space_messages`,
];

export function channelMessageSearchRevision(sql: SqlStorage, messageId: string): number | null {
  return sql.exec<{ revision: number }>(
    "SELECT revision FROM channel_message_search_versions WHERE message_id = ?", messageId,
  ).toArray()[0]?.revision ?? null;
}

/** The activity Queue accepts at most 100 messages in one batch. */
const CHANNEL_MESSAGE_SEARCH_BATCH = 100;

/**
 * When the next batch is due, or null for an Organization held below
 * migration 120 (the meeting-notes retirement holds some at 57), which has no
 * table. The pace is this lane's own, at the resource lane's interval: each job
 * calls this object back once, the load that interval was set against, and a
 * shared pace would let a resource backlog hold every Channel message back
 * until it drained.
 */
export function nextChannelMessageSearchDueAt(sql: SqlStorage, env?: Env, pace?: ResourceSearchPace): number | null {
  if (env && !searchIndexingConfigured(env)) return null;
  const present = sql.exec(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'channel_message_search_versions'",
  ).toArray().length > 0;
  if (!present) return null;
  const due = sql.exec<{ due_at: number | null }>(
    "SELECT MIN(not_before) AS due_at FROM channel_message_search_versions WHERE pending = 1",
  ).one().due_at;
  return due === null || !pace ? due : Math.max(due, pace.nextBatchAt);
}

export async function publishChannelMessageSearch(sql: SqlStorage, env: Env, workspaceId: string,
  pace?: ResourceSearchPace): Promise<void> {
  if (!searchIndexingConfigured(env)) return;
  if (pace && Date.now() < pace.nextBatchAt) return;
  const rows = sql.exec<{ message_id: string; space_id: string; revision: number }>(
    `SELECT message_id, space_id, revision FROM channel_message_search_versions
      WHERE pending = 1 AND not_before <= ? ORDER BY not_before, message_id LIMIT ?`,
    Date.now(), CHANNEL_MESSAGE_SEARCH_BATCH,
  ).toArray();
  if (!rows.length) return;
  try {
    const jobs = await Promise.all(rows.map(async (row): Promise<SearchDocumentJob> => ({
      type: "search_embedding_batch_v1",
      phase: "document",
      reference: ChannelMessageSearchProjectionSchema.parse({
        type: "channel_message_search_projection_v1", region: env.AVALON_REGION, workspaceId, messageId: row.message_id,
      }),
      documentId: await searchDocumentId(CHANNEL_MESSAGE_SEARCH_SOURCE, row.space_id, row.message_id),
    })));
    await env.ACTIVITY_QUEUE.sendBatch(jobs.map((body) => ({ body })));
    for (const row of rows) {
      sql.exec("UPDATE channel_message_search_versions SET pending = 0 WHERE message_id = ? AND revision = ?",
        row.message_id, row.revision);
    }
    if (pace && rows.length === CHANNEL_MESSAGE_SEARCH_BATCH && sql.exec(
      "SELECT 1 FROM channel_message_search_versions WHERE pending = 1 AND not_before <= ? LIMIT 1", Date.now(),
    ).toArray().length) pace.nextBatchAt = Date.now() + RESOURCE_SEARCH_BACKLOG_INTERVAL_MS;
  } catch (error) {
    // The resource projection's dispatch retry interval.
    for (const row of rows) {
      sql.exec("UPDATE channel_message_search_versions SET not_before = ? WHERE message_id = ? AND revision = ?",
        Date.now() + 5_000, row.message_id, row.revision);
    }
    throw error;
  }
}

/** One message's document, or its deletion watermark. Extraction only: the Queue Worker indexes. */
export async function prepareChannelMessageSearch(sql: SqlStorage, messageId: string): Promise<SearchDocumentBatch> {
  const version = sql.exec<{ space_id: string; revision: number }>(
    "SELECT space_id, revision FROM channel_message_search_versions WHERE message_id = ?", messageId,
  ).toArray()[0];
  if (!version) return { documents: [], retry: false };
  const id = await searchDocumentId(CHANNEL_MESSAGE_SEARCH_SOURCE, version.space_id, messageId);
  // Read after the await, with none between the read and the revision check below.
  const row = sql.exec<{ body: string; posted_at: number; title: string | null }>(
    `SELECT message.body, message.posted_at, space.title
       FROM space_messages message
       LEFT JOIN spaces space ON space.space_id = message.space_id
      WHERE message.message_id = ?`,
    messageId,
  ).toArray()[0];
  if (channelMessageSearchRevision(sql, messageId) !== version.revision) throw new Error("search_source_changed");
  const document: SearchDocument = {
    id, source: CHANNEL_MESSAGE_SEARCH_SOURCE, sourceId: messageId, scopeId: version.space_id, revision: version.revision,
    text: row ? row.body : null,
    ...(row ? {
      audience: [searchAudienceGroup.space(version.space_id)],
      // An archived Channel leaves every reader's groups, so its rows match nobody.
      display: { title: row.title ?? "", sourceLabel: row.title ?? "", occurredAt: row.posted_at,
        transcriptSequence: null, url: null, mimeType: null, archived: false },
    } : {}),
  };
  return { documents: [document], retry: false };
}

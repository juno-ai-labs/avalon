/**
 * WorkspaceDO migration 119 (a Channel's own messages are projected into the
 * search index), upgraded the way a deployed Organization is: populated at 118
 * and committed in its own event, then woken with every migration. Every
 * existing message is queued once with its words intact, its document can be
 * prepared, and its reference goes out as a document-phase job, the envelope
 * an older consumer retries rather than drops. An Organization held below 119
 * arms no lane for a table it does not have.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  nextChannelMessageSearchDueAt,
  prepareChannelMessageSearch,
  publishChannelMessageSearch,
} from "../src/durable-objects/channel-message-search-projection";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { SearchDocumentJobSchema } from "../src/services/search-indexing-jobs";
import { createCloudflareTestBinding, createTestEnv } from "../test/helpers/cloudflare-test";

const WORKSPACE = "00000000-0000-7000-8000-0000000119a0";
const SPACE = "00000000-0000-7000-8000-0000000119a1";
const THREAD = "00000000-0000-7000-8000-0000000119a2";
const MERGE = "00000000-0000-7000-8000-0000000119b1";
const WELCOME = "00000000-0000-7000-8000-0000000119b2";

/** Search indexing switched on, and a Queue that records what it is sent. */
function indexingEnv(sent: unknown[]) {
  return createTestEnv({
    APP_ENV: "development",
    AVALON_REGION: "global",
    TURBO_PUFFER_DEV_API_KEY: "test-key",
    OPENROUTER_API_KEY: "test-key",
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({
      sendBatch: async (batch: Iterable<MessageSendRequest>) => { for (const message of batch) sent.push(message.body); },
    }),
  });
}

describe("migration 119", () => {
  it("queues a populated Organization's existing Channel messages once, and publishes each as a document job", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("channel-message-search-v118");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 118);
      expect(before.at(-1)?.version).toBe(118);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-search", now: 1,
      });
      state.storage.sql.exec(
        `INSERT INTO space_messages (message_id, space_id, message_key, author_kind, author_user_id, body, posted_at,
           source_workstream_id)
         VALUES (?, ?, ?, 'member', 'user-1', 'Resolution: our ICP is growth teams.', 5, ?),
                (?, ?, 'start:0', 'rally', NULL, 'Welcome', 4, NULL)`,
        MERGE, SPACE, `merge:${THREAD}`, THREAD, WELCOME, SPACE,
      );
    });

    const sent: unknown[] = [];
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-search", now: 2,
      });
      const sql = state.storage.sql;
      expect(sql.exec("SELECT message_id, space_id, revision, pending FROM channel_message_search_versions ORDER BY message_id")
        .toArray()).toEqual([
        { message_id: MERGE, space_id: SPACE, revision: 1, pending: 1 },
        { message_id: WELCOME, space_id: SPACE, revision: 1, pending: 1 },
      ]);
      expect(await prepareChannelMessageSearch(sql, MERGE)).toMatchObject({ documents: [{
        source: "channel_messages", sourceId: MERGE, scopeId: SPACE, revision: 1,
        text: "Resolution: our ICP is growth teams.", audience: [`space:${SPACE}`],
      }] });

      await publishChannelMessageSearch(sql, indexingEnv(sent), WORKSPACE);
      expect(sql.exec("SELECT SUM(pending) AS pending FROM channel_message_search_versions").one().pending).toBe(0);
    });
    // Each is the envelope the consumer's document path takes, naming the message.
    expect(sent.map((body) => SearchDocumentJobSchema.parse(body).reference)).toEqual(expect.arrayContaining([
      { type: "channel_message_search_projection_v1", region: "global", workspaceId: WORKSPACE, messageId: MERGE },
      { type: "channel_message_search_projection_v1", region: "global", workspaceId: WORKSPACE, messageId: WELCOME },
    ]));
    expect(sent).toHaveLength(2);
  });

  it("arms nothing for an Organization held below it, which has no table", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("channel-message-search-held-57");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 57),
        component: "workspace_do", workerVersionId: "held", now: 1,
      });
      expect(nextChannelMessageSearchDueAt(state.storage.sql, indexingEnv([]))).toBeNull();
    });
  });
});

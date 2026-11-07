/**
 * WorkspaceDO migration 109 (`space_messages` gains a source thread, an
 * attention ordinal, embeds and an operation id), upgraded the way a deployed
 * Organization is: populated at 108 and committed in its own event, then woken
 * with every migration. A message posted before it stays as it was and is not
 * news, so nobody's Channel turns unread on deploy.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const SPACE = "00000000-0000-7000-8000-0000000108a1";
const MESSAGE = "00000000-0000-7000-8000-0000000108a2";

describe("migration 109", () => {
  it("upgrades a populated Organization at 108, keeping each Channel message and taking none of them as news", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("space-message-merges-v108");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 108);
      expect(before.at(-1)?.version).toBe(108);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-merges", now: 1,
      });
      state.storage.sql.exec(
        `INSERT INTO space_messages (message_id, space_id, message_key, author_kind, author_user_id, body, posted_at)
         VALUES (?, ?, 'start:0', 'rally', NULL, 'Welcome', 5)`,
        MESSAGE, SPACE,
      );
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 146) /* 147 drops what this reads */, component: "workspace_do",
        workerVersionId: "with-merges", now: 2,
      });
      expect(state.storage.sql.exec(
        `SELECT body, posted_at, source_workstream_id, attention_ordinal, embeds_json, merge_operation_id
           FROM space_messages WHERE message_id = ?`, MESSAGE,
      ).one()).toEqual({
        body: "Welcome", posted_at: 5, source_workstream_id: null, attention_ordinal: null, embeds_json: null,
        merge_operation_id: null,
      });
    });
  });
});

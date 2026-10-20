/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { backfillRemovedThreadMerges } from "../src/durable-objects/workspace-space-storage";
import { stableUuidSync } from "../src/lib/stable-uuid";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

it("resolves existing merged Threads and Breakouts while retaining independent archive state", async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName("conversation-resolution-v122");
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 122),
      component: "workspace_do", workerVersionId: "before-resolution", now: 1 });
    for (const [id, archivedAt] of [["0", null], ["merged", null], ["archived", 10], ["unfinished", null]] as const) {
      state.storage.sql.exec(`INSERT INTO parent_children
        (parent_id, substream_id, kind, created_at, updated_at, archived_at)
        VALUES ('thread', ?, ?, 1, 1, ?)`, id, id === "0" ? "main" : "child", archivedAt);
    }
    state.storage.sql.exec(`INSERT INTO space_messages
      (message_id, space_id, author_kind, author_user_id, body, posted_at, source_workstream_id)
      VALUES ('merge', 'channel', 'member', 'user', 'Shipped', 5, 'thread')`);
    state.storage.sql.exec(`INSERT INTO parent_children
      (parent_id, substream_id, kind, created_at, updated_at)
      VALUES ('removed-thread', '0', 'main', 1, 1)`);
    const removedMergeId = stableUuidSync(["space_message", "channel", "merge:removed-thread"]);
    state.storage.sql.exec(`INSERT INTO space_messages
      (message_id, space_id, author_kind, author_user_id, body, posted_at, source_workstream_id)
      VALUES (?, 'channel', 'member', 'user', 'Removed result', 5, 'removed-thread')`, removedMergeId);
    state.storage.sql.exec("INSERT INTO space_message_operations (message_id, operation_id, created_at) VALUES (?, 'removed-merge', 5)", removedMergeId);
    state.storage.sql.exec("DELETE FROM space_messages WHERE message_id = ?", removedMergeId);
    for (const id of ["merged", "archived"]) {
      state.storage.sql.exec(`INSERT INTO workspace_activity_events
        (event_id, event_type, subject_type, subject_id, actor_type, actor_label, title, body,
         audience_kind, digestible, occurred_at, created_at, source_kind, dedupe_key, metadata_json)
        VALUES (?, 'workstream_message_created', 'workstream', 'thread', 'user', 'Ada', 'Merged', 'Done',
          'workspace', 0, 5, 5, 'workstream_message', ?, ?)`,
      id, id, JSON.stringify({ mergedFrom: { breakoutId: id } }));
    }
  });
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "with-resolution", now: 2, afterMigrations: backfillRemovedThreadMerges });
    expect(state.storage.sql.exec(`SELECT substream_id, resolved, archived_at FROM parent_children WHERE parent_id = 'thread' ORDER BY substream_id`).toArray())
      .toEqual([
        { substream_id: "0", resolved: 1, archived_at: null },
        { substream_id: "archived", resolved: 1, archived_at: 10 },
        { substream_id: "merged", resolved: 1, archived_at: null },
        { substream_id: "unfinished", resolved: 0, archived_at: null },
      ]);
    expect(state.storage.sql.exec("SELECT resolved FROM parent_children WHERE parent_id = 'removed-thread' AND substream_id = '0'").one())
      .toEqual({ resolved: 1 });
  });
});

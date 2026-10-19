/**
 * WorkspaceDO migration 118 (every earlier Channel merge's embeds are linked to
 * its Channel), upgraded the way a deployed Organization is: populated at 117
 * and committed in its own event, then woken with every migration. A merge's
 * embed that still exists is linked to the Channel it was posted in, once; one
 * whose resource is gone, and a message that is no merge, link nothing.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const WORKSPACE = "00000000-0000-7000-8000-0000000116a0";
const SPACE = "00000000-0000-7000-8000-0000000116a1";
const THREAD = "00000000-0000-7000-8000-0000000116a2";
const ARTIFACT = "00000000-0000-7000-8000-0000000116a3";
const GONE = "00000000-0000-7000-8000-0000000116a4";

describe("migration 118", () => {
  it("links a populated Organization's earlier Channel merges' embeds to their Channel", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("space-merge-embed-links-v117");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 117);
      expect(before.at(-1)?.version).toBe(117);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-links", now: 1,
      });
      state.storage.sql.exec(
        `INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
         VALUES (1, ?, 'global', 'wnam', 1, 1)`, WORKSPACE,
      );
      state.storage.sql.exec(
        `INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'generated_file', 'avalon_generated', 'Price model', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        ARTIFACT, WORKSPACE,
      );
      const embeds = JSON.stringify([
        { id: ARTIFACT, title: "Price model", kind: "generated_file" },
        { id: GONE, title: "Deleted", kind: "generated_file" },
      ]);
      state.storage.sql.exec(
        `INSERT INTO space_messages (message_id, space_id, message_key, author_kind, author_user_id, body, posted_at,
           source_workstream_id, embeds_json)
         VALUES ('00000000-0000-7000-8000-0000000116b1', ?, ?, 'member', 'user-1', 'Shipped', 5, ?, ?),
                ('00000000-0000-7000-8000-0000000116b2', ?, 'start:0', 'rally', NULL, 'Welcome', 4, NULL, ?)`,
        SPACE, `merge:${THREAD}`, THREAD, embeds, SPACE, embeds,
      );
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-links", now: 2,
      });
      expect(state.storage.sql.exec(
        "SELECT parent_id, substream_id, parent_kind, resource_id FROM authorization_locations",
      ).toArray()).toEqual([{ parent_id: SPACE, substream_id: "0", parent_kind: "space", resource_id: ARTIFACT }]);
    });
  });
});

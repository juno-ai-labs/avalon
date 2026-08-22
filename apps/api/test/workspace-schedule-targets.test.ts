/**
 * The workspace alarm's due-time queries, against the object's own schema.
 *
 * A maintenance entry is due at the earliest row its pass will act on, and the
 * hot loop of 2026-08-22 was a query that counted a row its pass did not
 * remove. These cases pin the two arms that could do that again — the draft
 * reap keeps a linked draft on purpose, and `strftime` drops the milliseconds
 * the pass's own cutoff keeps — on the ledger production applies, because the
 * links table exists nowhere else. `docs/durable-object-alarms.md` is the
 * module document.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTarget,
} from "../src/services/workspace-schedule-execution";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** The object's ledger, every version, as the constructor applies it. */
function workspaceObjectDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    for (const statement of migration.statements) database.exec(statement);
  }
  // Every write to the object asserts its identity first; the ledger's
  // triggers refuse a row for any other workspace.
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
  return database;
}

function scheduleContext(database: DatabaseSync): WorkspaceScheduleContext {
  const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
  return {
    env,
    workspaceEnv: env,
    workspaceId: WORKSPACE_ID,
    directory: {
      workstreamScheduleTargets: async () => ({ items: [] }),
      plannedWorkstream: async () => null,
    },
  };
}

function seedDraft(database: DatabaseSync, id: string, createdAt: string): void {
  database.prepare(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, created_at, updated_at,
        uploaded_by_user_id, attachment_status)
     VALUES (?, ?, 'file', 'avalon_upload', 'draft.pdf', ?, ?, 'user-1', 'draft')`,
  ).run(id, WORKSPACE_ID, createdAt, createdAt);
}

function linkToWorkstream(database: DatabaseSync, resourceId: string): void {
  database.prepare(
    `INSERT OR IGNORE INTO workspace_workstream_directory
       (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title,
        description, preview, scope, exact_state, last_activity_at, origin_type, title_status,
        latest_attention_ordinal, unread_tracking_start_ordinal, source_created_at,
        source_updated_at, projected_at)
     VALUES (?, 1, 1, 'event-1', 'hash', 'Linked', '', '', 'workspace', 'running', 0, 'ad_hoc',
             'settled', 0, 0, 0, 0, 0)`,
  ).run(WORKSTREAM_ID);
  database.prepare(
    `INSERT INTO workspace_workstream_resource_links
       (workstream_id, resource_id, watch_enabled, relationship_type, authority_generation,
        waterline, source_event_id, projected_at)
     VALUES (?, ?, 0, 'attachment', 1, 1, ?, 0)`,
  ).run(WORKSTREAM_ID, resourceId, `link-${resourceId}`);
}

function expiredDrafts(targets: WorkspaceScheduleTarget[]): WorkspaceScheduleTarget[] {
  return targets.filter((target) => target.kind === "maintenance" && target.id === "expired_drafts");
}

describe("the expired-drafts due time", () => {
  it("counts only the drafts the reap will remove, so a linked draft cannot pin the pass", async () => {
    const database = workspaceObjectDatabase();
    seedDraft(database, "00000000-0000-7000-8000-0000000000d1", "2026-01-01T00:00:00.000Z");
    linkToWorkstream(database, "00000000-0000-7000-8000-0000000000d1");

    // The linked draft is the only draft: nothing is due.
    expect(expiredDrafts(await workspaceScheduleTargets(scheduleContext(database)))).toEqual([]);

    // An unlinked draft, newer than the linked one, is what the pass is due for.
    seedDraft(database, "00000000-0000-7000-8000-0000000000d2", "2026-02-01T00:00:00.000Z");

    expect(expiredDrafts(await workspaceScheduleTargets(scheduleContext(database))))
      .toEqual([{ kind: "maintenance", id: "expired_drafts", dueAt: "2026-02-02T00:00:01Z" }]);
  });

  it("rounds a due time up to the next whole second rather than down to the last", async () => {
    // The pass compares the millisecond column against its own cutoff. A due
    // time rounded down fires up to 999 ms before the row is reapable, finds
    // nothing, and comes back at the identical instant — which the stall gate
    // now holds and reports.
    const database = workspaceObjectDatabase();
    seedDraft(database, "00000000-0000-7000-8000-0000000000d3", "2026-03-01T10:20:30.700Z");

    expect(expiredDrafts(await workspaceScheduleTargets(scheduleContext(database))))
      .toEqual([{ kind: "maintenance", id: "expired_drafts", dueAt: "2026-03-02T10:20:31Z" }]);
  });
});

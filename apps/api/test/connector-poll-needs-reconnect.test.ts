import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runWorkspaceScheduleTarget,
  type WorkspaceScheduleContext,
} from "../src/services/workspace-schedule-execution";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CONNECTION_ID = "00000000-0000-7000-8000-000000000010";
const SCHEDULE_ID = "00000000-0000-7000-8000-000000000020";
const DUE = "2026-01-02T16:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(status: string) {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database.prepare(
    `INSERT INTO connector_connections (id, workspace_id, connector_type, display_name, model_plugin_id, scope, granted_scopes_json, status, config_json, created_at, updated_at)
     VALUES (?, ?, 'google', 'Google', 'plugin_google', 'workspace', '[]', ?, '{}', '2026-01-01', '2026-01-01')`,
  ).run(CONNECTION_ID, WORKSPACE_ID, status);
  database.prepare(
    `INSERT INTO schedules (id, workspace_id, connector_connection_id, schedule_type, interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, 'interval', 300, 'UTC', ?, 1, 1, '2026-01-01', '2026-01-01')`,
  ).run(SCHEDULE_ID, WORKSPACE_ID, CONNECTION_ID, DUE);
  const create = vi.fn(async () => ({}));
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    CONNECTOR_POLL_WORKFLOW: { create },
  });
  const ctx: WorkspaceScheduleContext = {
    env,
    workspaceEnv: env,
    workspaceId: WORKSPACE_ID,
    directory: { workstreamScheduleTargets: async () => ({ items: [] }) },
    dueTerminalSubstreams: async () => [],
    notificationIntents: {
      notificationIntentMaintenanceTarget: async () => ({ dueAt: null }),
      reapSettledWorkstreamNotificationIntents: async () => ({ reapedIntentIds: [] }),
    },
  };
  const run = () => runWorkspaceScheduleTarget(ctx, { kind: "schedule", id: SCHEDULE_ID, dueAt: DUE }, new Date(DUE));
  return { database, create, run };
}

describe("a connector poll for a connection the provider no longer authorizes", () => {
  it("starts no poll workflow, and still advances the schedule", async () => {
    const { database, create, run } = fixture("needs_reconnect");
    await run();
    expect(create).not.toHaveBeenCalled();
    const row = database.prepare("SELECT next_run_at FROM schedules WHERE id = ?").get(SCHEDULE_ID) as { next_run_at: string };
    expect(row.next_run_at).toBe("2026-01-02T16:05:00.000Z");
  });

  it("starts the poll for a healthy connection", async () => {
    const { create, run } = fixture("healthy");
    await run();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

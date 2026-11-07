import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
} from "../src/services/workspace-schedule-execution";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { applyWorkspaceResourceSchema, createWorkspaceObjectTable } from "./helpers/workspace-object-tables";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000002");
const PINNED_SUBSCRIPTION_ID = "00000000-0000-7000-8000-000000000007";
const UNPINNED_SUBSCRIPTION_ID = "00000000-0000-7000-8000-000000000008";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * The workspace's schedule execution, wired to the fixture's databases.
 *
 * WorkspaceDO owns the alarm; this drives the half that decides what a
 * scheduled automation creates. `test-workers/scheduled-alarms.test.ts` covers
 * the arming and the drain on real workerd.
 */
function scheduleRunnerFor(fixture: Fixture) {
  const { database, objectStore } = fixture;
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: { refreshSchedule: async () => ({ alarmAt: null }) },
    }),
  });
  const ctx: WorkspaceScheduleContext = {
    env,
    workspaceEnv: env,
    workspaceId: WORKSPACE_ID,
    directory: {
      workstreamScheduleTargets: async () => ({ items: [] }),
    },
    dueTerminalSubstreams: async () => [],
    notificationIntents: {
      notificationIntentMaintenanceTarget: async () => ({ dueAt: null }),
      reapSettledWorkstreamNotificationIntents: async () => ({ reapedIntentIds: [] }),
    },
  };
  return {
    runDue: async (now = new Date()) => {
      for (const target of await workspaceScheduleTargets(ctx)) {
        if (Date.parse(target.dueAt) > now.getTime()) continue;
        await runWorkspaceScheduleTarget(ctx, target, now);
      }
    },
  };
}

describe("automation model override", () => {
  // AutomationAgent owns automation timers. WorkspaceDO's scheduler must not
  // accept a restored legacy automation target after the cutover.
  it("refuses a legacy automation target in the workspace scheduler", async () => {
    const fixture = seededDatabase();
    fixture.database.exec(`
      UPDATE automation_subscriptions
         SET scope = 'workspace', owner_user_id = NULL,
             execution_principal_json = '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}'
       WHERE id = '${PINNED_SUBSCRIPTION_ID}';
      INSERT INTO schedules
        (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone,
         next_run_at, enabled, version, created_at, updated_at)
      VALUES
        ('00000000-0000-7000-8000-000000000009', '${WORKSPACE_ID}', '${PINNED_SUBSCRIPTION_ID}', 'calendar', 'FREQ=DAILY', 'America/Los_Angeles',
         '2026-01-02T16:00:00.000Z', 1, 1, '2026-01-01', '2026-01-01');
    `);
    await expect(scheduleRunnerFor(fixture).runDue()).rejects.toThrow("unsupported_schedule_target");
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM automation_runs",
    ).get()).toEqual({ count: 0 });
  });
});

interface Fixture {
  database: DatabaseSync;
  /** The WorkstreamDO store the runtime SQL port writes product rows into. */
  objectStore: DatabaseSync;
}

function seededDatabase(): Fixture {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Every automation run path now launches through the Durable-Object
  // authority; open it before any product rows exist, as a fresh stack does.
  openWorkstreamAuthorityForTest(database);
  // The alarm's draft arm reads the object's Canvas artifacts, which no
  // regional snapshot has ever carried, and excludes drafts still reserved by
  // an input preparation in the same WorkspaceDO authority.
  createWorkspaceObjectTable(database, "canvas_artifacts");
  applyWorkspaceResourceSchema(database, WORKSPACE_ID);

  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Avalon Studio', 'avalon-studio', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner', 'active', '2026-01-01');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES
      ('00000000-0000-7000-8000-000000000003', '${WORKSPACE_ID}', '${USER_ID}', 'Daily product brief', 'Brief', 'private', 1, '2026-01-01', '2026-01-01'),
      ('00000000-0000-7000-8000-000000000004', '${WORKSPACE_ID}', '${USER_ID}', 'Weekly competitor scan', 'Scan', 'private', 1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
    VALUES
      ('00000000-0000-7000-8000-000000000005', '00000000-0000-7000-8000-000000000003', 1, 'Write the brief', '[]', '${USER_ID}', '2026-01-01'),
      ('00000000-0000-7000-8000-000000000006', '00000000-0000-7000-8000-000000000004', 1, 'Scan competitors', '[]', '${USER_ID}', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, status, email_address,
       model_override, created_at, updated_at)
    VALUES
      ('${PINNED_SUBSCRIPTION_ID}', '${WORKSPACE_ID}', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000005', 'personal', '${USER_ID}',
       '{"type":"user","userId":"${USER_ID}"}', 'active', 'calm-bright-gentle-otter@automation.with-avalon.com',
       'openai/gpt-5.6-terra', '2026-01-01', '2026-01-01'),
      ('${UNPINNED_SUBSCRIPTION_ID}', '${WORKSPACE_ID}', '00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000006', 'personal', '${USER_ID}',
       '{"type":"user","userId":"${USER_ID}"}', 'active', 'quiet-amber-steady-heron@automation.with-avalon.com',
       NULL, '2026-01-01', '2026-01-01');
  `);
  return { database, objectStore };
}

import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import {
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
} from "../src/services/workspace-schedule-execution";
import { AutomationService } from "../src/services/automation-service";
import { __testing } from "../src/queues/activity-consumer";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createWorkspaceObjectTable } from "./helpers/workspace-object-tables";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectParticipantRows,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async reserve() {
      return { emailAddress: "calm-bright-gentle-otter@with-avalon.com" };
    }
    async activateWorkstreamRoute() {
      return undefined;
    }
    async ensureWorkstreamAddress() {
      return undefined;
    }
  },
}));

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000002");
const PINNED_SUBSCRIPTION_ID = "00000000-0000-7000-8000-000000000007";
const UNPINNED_SUBSCRIPTION_ID = "00000000-0000-7000-8000-000000000008";
const ACTIVITY_ID = "00000000-0000-7000-8000-00000000000a";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function serviceFor(fixture: Fixture, logLevel: Env["LOG_LEVEL"] = "error"): AutomationService {
  const { database, objectStore } = fixture;
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: logLevel,
    // No FLAGS binding, so an unpinned run resolves to the Worker variables —
    // which is exactly the value a pinned run has to differ from.
    OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: { refreshSchedule: async () => ({ alarmAt: null }) },
    }),
  });
  return new AutomationService(env, auth);
}

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
      plannedAutomationWorkstream: async () => null,
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

interface RunWorkstreamRow {
  id: string;
  model_override: string | null;
  scope: string;
  created_by_user_id: string | null;
  participant_user_id: string | null;
}

function runWorkstream(objectStore: DatabaseSync, subscriptionId: string): RunWorkstreamRow {
  // One object holds one work stream, so the retired view's
  // `WHERE automation_subscription_id = ? ORDER BY created_at DESC LIMIT 1`
  // is an assertion about which store this is rather than a row to pick.
  const root = workstreamObjectRootRow<{
    workstream_key: string;
    automation_subscription_id: string | null;
    model_override: string | null;
    scope: string;
    created_by_user_id: string | null;
  }>(
    objectStore,
    "workstream_key, automation_subscription_id, model_override, scope, created_by_user_id",
  );
  expect(root.automation_subscription_id).toBe(subscriptionId);
  const seated = workstreamObjectParticipantRows<{ user_id: string }>(objectStore, "user_id");
  return {
    id: root.workstream_key,
    model_override: root.model_override,
    scope: root.scope,
    created_by_user_id: root.created_by_user_id,
    participant_user_id: seated[0]?.user_id ?? null,
  };
}

describe("automation model override", () => {
  it("copies the automation's pinned model onto every run it creates", async () => {
    const fixture = seededDatabase();

    const run = await serviceFor(fixture).runNow(PINNED_SUBSCRIPTION_ID, "idempotency-key-1");

    expect(workstreamObjectRootRow(fixture.objectStore, "model_override"))
      .toEqual({ model_override: "openai/gpt-5.6-terra" });
    // The run's expected model is recorded at schedule time, so the pin has to
    // reach `harness_runs` in the same batch that writes the work stream.
    expect(workstreamObjectGet(fixture.objectStore, "SELECT model FROM harness_runs WHERE workstream_id = ?", run.workstreamId))
      .toEqual({ model: "openai/gpt-5.6-terra" });
  });

  it("leaves an unpinned automation's runs to the flag and its Worker-variable default", async () => {
    const fixture = seededDatabase();

    const run = await serviceFor(fixture).runNow(UNPINNED_SUBSCRIPTION_ID, "idempotency-key-2");

    expect(workstreamObjectRootRow(fixture.objectStore, "model_override"))
      .toEqual({ model_override: null });
    expect(workstreamObjectGet(fixture.objectStore, "SELECT model FROM harness_runs WHERE workstream_id = ?", run.workstreamId))
      .toEqual({ model: "x-ai/grok-4.3" });
  });

  // Retiring a model from `AGENT_MODEL_OVERRIDES` drops the pins naming it. The
  // work-stream read path says so; these paths write the column, so without
  // their own log a retirement would move every pinned automation in silence.
  it("says so when a run drops a pin naming a model that has left the list", async () => {
    const fixture = seededDatabase();
    fixture.database.exec(`
      UPDATE automation_subscriptions SET model_override = 'anthropic/claude-opus-4.6'
       WHERE id = '${PINNED_SUBSCRIPTION_ID}';
    `);
    // Workers Logs indexes object properties, so the diagnostic is logged as a
    // structured entry rather than a string — assert on the fields.
    const warnings: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((entry: unknown) => {
      warnings.push(entry as Record<string, unknown>);
    });

    const run = await serviceFor(fixture, "warn").runNow(PINNED_SUBSCRIPTION_ID, "idempotency-key-3");

    expect(workstreamObjectRootRow(fixture.objectStore, "model_override"))
      .toEqual({ model_override: null });
    expect(workstreamObjectGet(fixture.objectStore, "SELECT model FROM harness_runs WHERE workstream_id = ?", run.workstreamId))
      .toEqual({ model: "x-ai/grok-4.3" });
    expect(warnings).toContainEqual(expect.objectContaining({
      event: "workstream_model_override_unknown",
      automation_subscription_id: PINNED_SUBSCRIPTION_ID,
      stored_model: "anthropic/claude-opus-4.6",
    }));
    warn.mockRestore();
  });

  // A scheduled run is the common automation shape, and it never passes through
  // `createRun` — the scheduler Durable Object writes the work stream itself.
  it("carries the pin into a run the scheduler alarm creates", async () => {
    const fixture = seededDatabase();
    fixture.database.exec(`
      INSERT INTO schedules
        (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone,
         next_run_at, enabled, version, created_at, updated_at)
      VALUES
        ('00000000-0000-7000-8000-000000000009', '${WORKSPACE_ID}', '${PINNED_SUBSCRIPTION_ID}', 'calendar', 'FREQ=DAILY', 'America/Los_Angeles',
         '2026-01-02T16:00:00.000Z', 1, 1, '2026-01-01', '2026-01-01');
    `);
    await scheduleRunnerFor(fixture).runDue();

    const workstream = runWorkstream(fixture.objectStore, PINNED_SUBSCRIPTION_ID);
    expect(workstream.model_override).toBe("openai/gpt-5.6-terra");
    expect(workstream).toMatchObject({
      scope: "personal",
      created_by_user_id: USER_ID,
      participant_user_id: USER_ID,
    });
    // The scheduler creates the harness run after the work stream exists, so
    // it resolves the model from the row rather than being handed the value.
    expect(workstreamObjectGet(fixture.objectStore, "SELECT model FROM harness_runs WHERE workstream_id = ?", workstream.id))
      .toEqual({ model: "openai/gpt-5.6-terra" });
  });

  // Connector-activity runs are the third path that writes a work stream
  // directly, in the queue consumer rather than in either of the above.
  it("carries the pin into a run a matching connector activity creates", async () => {
    const fixture = seededDatabase();
    const { database, objectStore } = fixture;
    database.exec(`
      UPDATE automation_template_versions
         SET trigger_definitions_json = '[{"type":"connector_activity","connectorType":"github","eventTypes":["github.pull_request.merged"],"deterministicFilters":{}}]'
       WHERE id = '00000000-0000-7000-8000-000000000005';
      -- Workspace-scoped and bound to the connection the activity arrives on:
      -- both are what the consumer requires before a trigger is even consulted.
      UPDATE automation_subscriptions
         SET scope = 'workspace', owner_user_id = NULL,
             execution_principal_json = '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}',
             connector_bindings_json = '{"plugin_github_acme":"connection-github-acme"}'
       WHERE id = '${PINNED_SUBSCRIPTION_ID}';
      -- The run row references the activity, which references its connection,
      -- so both have to be real rows rather than a hand-built activity object.
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id, status, created_at, updated_at)
      VALUES
        ('connection-github-acme', '${WORKSPACE_ID}', 'github', 'workspace', NULL, 'GitHub', 'plugin_github_acme', 'healthy', '2026-01-01', '2026-01-01');
      INSERT INTO activities
        (id, workspace_id, connection_id, connection_scope, provider, provider_event_id, event_type,
         resource_type, provider_resource_id, occurred_at, received_at, title, dedupe_key)
      VALUES
        ('${ACTIVITY_ID}', '${WORKSPACE_ID}', 'connection-github-acme', 'workspace', 'github', 'event-42',
         'github.pull_request.merged', 'github_pull_request', 'juno-ai-labs/avalon#42',
         '2026-01-02', '2026-01-02', 'Merged #42', 'dedupe-42');
    `);
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      LOG_LEVEL: "error",
      OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    });

    await __testing.runMatchingAutomations(env, {
      id: ACTIVITY_ID,
      workspace_id: WORKSPACE_ID,
      workspace_region: "global",
      connection_id: "connection-github-acme",
      connection_scope: "workspace",
      connector_type: "github",
      provider: "github",
      event_type: "github.pull_request.merged",
      resource_type: "github_pull_request",
      provider_resource_id: "juno-ai-labs/avalon#42",
      title: "Merged #42",
      summary: "",
      text_snippet: "",
      metadata_json: "{}",
      visibility_json: "{}",
    } as never);

    const workstream = runWorkstream(objectStore, PINNED_SUBSCRIPTION_ID);
    expect(workstream.model_override).toBe("openai/gpt-5.6-terra");
    expect(workstream).toMatchObject({
      scope: "personal",
      created_by_user_id: USER_ID,
      participant_user_id: USER_ID,
    });
    expect(workstreamObjectGet(objectStore, "SELECT model FROM harness_runs WHERE workstream_id = ?", workstream.id))
      .toEqual({ model: "openai/gpt-5.6-terra" });
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
  // The alarm's draft arm reads the object's links table, which no regional
  // snapshot has ever carried.
  createWorkspaceObjectTable(database, "workspace_workstream_resource_links");
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

import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { WorkspaceScheduler } from "../src/durable-objects/workspace-scheduler";
import { AutomationService } from "../src/services/automation-service";
import { __testing } from "../src/queues/activity-consumer";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

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

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000002";
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

function serviceFor(database: DatabaseSync, logLevel = "error"): AutomationService {
  const env = {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: logLevel,
    // No FLAGS binding, so an unpinned run resolves to the Worker variables —
    // which is exactly the value a pinned run has to differ from.
    OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
    WORKSTREAM_LOOP_WORKFLOW: { create: async () => ({ id: "instance" }) },
    WORKSPACE_SCHEDULERS: {
      idFromName: () => "scheduler",
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      jurisdiction: () => ({
        idFromName: () => "scheduler",
        get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      }),
    },
  } as unknown as Env;
  return new AutomationService(env, auth);
}

function schedulerFor(database: DatabaseSync): WorkspaceScheduler {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  } as unknown as DurableObjectStorage;
  return new WorkspaceScheduler(
    { storage } as unknown as DurableObjectState,
    {
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      LOG_LEVEL: "error",
      OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
      WORKSTREAM_LOOP_WORKFLOW: { create: async () => ({ id: "instance" }) },
    } as unknown as Env,
  );
}

function runWorkstream(database: DatabaseSync, subscriptionId: string): { id: string; model_override: string | null } {
  return database.prepare(
    "SELECT id, model_override FROM workstreams WHERE automation_subscription_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(subscriptionId) as { id: string; model_override: string | null };
}

describe("automation model override", () => {
  it("copies the automation's pinned model onto every run it creates", async () => {
    const database = seededDatabase();

    const run = await serviceFor(database).runNow(PINNED_SUBSCRIPTION_ID, "idempotency-key-1");

    expect(database.prepare("SELECT model_override FROM workstreams WHERE id = ?").get(run.workstreamId))
      .toEqual({ model_override: "openai/gpt-5.6-terra" });
    // The run's expected model is recorded at schedule time, so the pin has to
    // reach `harness_runs` in the same batch that writes the work stream.
    expect(database.prepare("SELECT model FROM harness_runs WHERE workstream_id = ?").get(run.workstreamId))
      .toEqual({ model: "openai/gpt-5.6-terra" });
  });

  it("leaves an unpinned automation's runs to the flag and its Worker-variable default", async () => {
    const database = seededDatabase();

    const run = await serviceFor(database).runNow(UNPINNED_SUBSCRIPTION_ID, "idempotency-key-2");

    expect(database.prepare("SELECT model_override FROM workstreams WHERE id = ?").get(run.workstreamId))
      .toEqual({ model_override: null });
    expect(database.prepare("SELECT model FROM harness_runs WHERE workstream_id = ?").get(run.workstreamId))
      .toEqual({ model: "x-ai/grok-4.3" });
  });

  // Retiring a model from `AGENT_MODEL_OVERRIDES` drops the pins naming it. The
  // work-stream read path says so; these paths write the column, so without
  // their own log a retirement would move every pinned automation in silence.
  it("says so when a run drops a pin naming a model that has left the list", async () => {
    const database = seededDatabase();
    database.exec(`
      UPDATE automation_subscriptions SET model_override = 'anthropic/claude-opus-4.6'
       WHERE id = '${PINNED_SUBSCRIPTION_ID}';
    `);
    // Workers Logs indexes object properties, so the diagnostic is logged as a
    // structured entry rather than a string — assert on the fields.
    const warnings: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((entry: unknown) => {
      warnings.push(entry as Record<string, unknown>);
    });

    const run = await serviceFor(database, "warn").runNow(PINNED_SUBSCRIPTION_ID, "idempotency-key-3");

    expect(database.prepare("SELECT model_override FROM workstreams WHERE id = ?").get(run.workstreamId))
      .toEqual({ model_override: null });
    expect(database.prepare("SELECT model FROM harness_runs WHERE workstream_id = ?").get(run.workstreamId))
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
    const database = seededDatabase();
    database.exec(`
      INSERT INTO schedules
        (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone,
         next_run_at, enabled, version, created_at, updated_at)
      VALUES
        ('00000000-0000-7000-8000-000000000009', '${WORKSPACE_ID}', '${PINNED_SUBSCRIPTION_ID}', 'calendar', 'FREQ=DAILY', 'America/Los_Angeles',
         '2026-01-02T16:00:00.000Z', 1, 1, '2026-01-01', '2026-01-01');
    `);
    const scheduler = schedulerFor(database);

    await scheduler.refresh(WORKSPACE_ID);
    await scheduler.alarm();

    const workstream = runWorkstream(database, PINNED_SUBSCRIPTION_ID);
    expect(workstream.model_override).toBe("openai/gpt-5.6-terra");
    // The scheduler creates the harness run after the work stream exists, so
    // it resolves the model from the row rather than being handed the value.
    expect(database.prepare("SELECT model FROM harness_runs WHERE workstream_id = ?").get(workstream.id))
      .toEqual({ model: "openai/gpt-5.6-terra" });
  });

  // Connector-activity runs are the third path that writes a work stream
  // directly, in the queue consumer rather than in either of the above.
  it("carries the pin into a run a matching connector activity creates", async () => {
    const database = seededDatabase();
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
    const env = {
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      LOG_LEVEL: "error",
      OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
      WORKSTREAM_LOOP_WORKFLOW: { create: async () => ({ id: "instance" }) },
    } as unknown as Env;

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

    const workstream = runWorkstream(database, PINNED_SUBSCRIPTION_ID);
    expect(workstream.model_override).toBe("openai/gpt-5.6-terra");
    expect(database.prepare("SELECT model FROM harness_runs WHERE workstream_id = ?").get(workstream.id))
      .toEqual({ model: "openai/gpt-5.6-terra" });
  });
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
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
       execution_principal_json, status, email_address, email_route_status,
       model_override, created_at, updated_at)
    VALUES
      ('${PINNED_SUBSCRIPTION_ID}', '${WORKSPACE_ID}', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000005', 'personal', '${USER_ID}',
       '{"type":"user","userId":"${USER_ID}"}', 'active', 'calm-bright-gentle-otter@automation.with-avalon.com',
       'active', 'openai/gpt-5.6-terra', '2026-01-01', '2026-01-01'),
      ('${UNPINNED_SUBSCRIPTION_ID}', '${WORKSPACE_ID}', '00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000006', 'personal', '${USER_ID}',
       '{"type":"user","userId":"${USER_ID}"}', 'active', 'quiet-amber-steady-heron@automation.with-avalon.com',
       'active', NULL, '2026-01-01', '2026-01-01');
  `);
  return database;
}

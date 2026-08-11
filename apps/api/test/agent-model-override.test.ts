import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
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

function serviceFor(database: DatabaseSync): AutomationService {
  const env = {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
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

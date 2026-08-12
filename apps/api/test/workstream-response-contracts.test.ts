import { MessageSchema, WorkstreamContextSchema } from "@avalon/contracts";
import { z } from "zod";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workstreamRoutes } from "../src/routes/workstreams";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The response and row contracts driven through the real queries.
 *
 * The other tests around these schemas assert a schema against a hand-written
 * row, which is the schema restated — it cannot catch the mismatch the schemas
 * exist for, because the fixture is written from the schema rather than from the
 * query. These cases seed a migrated database, run the real SQL, and let the
 * route's own `parse` be the assertion, so a column this code stops selecting or
 * an enum a migration widens fails here rather than in production.
 *
 * `GET /:id/context` matters most: `loadBackgroundTasks` is reached from nowhere
 * else, and its rows only exist once a work stream has run the agent — so an
 * empty-result test exercises none of the mapping.
 */
const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const USER = "00000000-0000-7000-8000-000000000002";
const WORKSTREAM = "00000000-0000-7000-8000-000000000003";
const RUN = "00000000-0000-7000-8000-000000000004";
const TOOL_CALL = "00000000-0000-7000-8000-000000000006";
const ACTIVITY = "00000000-0000-7000-8000-000000000007";
const SUGGESTION = "00000000-0000-7000-8000-000000000008";
const CONNECTION = "00000000-0000-7000-8000-000000000009";
const AT = "2026-08-10T16:10:55.531Z";

const MessagePageSchema = z.object({
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
  newerCursor: z.string().nullable(),
});

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${USER}', 'g-a', 'a@example.com', 'Adam', 'America/Los_Angeles', '${AT}', '${AT}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${USER}', '${AT}', '${AT}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${USER}', 'owner', 'active', '${AT}');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at,
       email_address, email_route_status)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Avalon UX', '', 'ad_hoc', '${USER}', 'completed',
            2, '${AT}', '${AT}', '${AT}',
            -- Already active, so the read does not divert into the Global
            -- address registry; the address lifecycle is not what is under test.
            'granular-misty@automation.with-avalon.com', 'active');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${WORKSTREAM}', '${USER}', '${USER}', 'creator', '${AT}');
  `);
  return database;
}

/** The rows that only exist once a work stream has actually run the agent. */
function seedAgentRun(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status,
       started_at, completed_at, model, usage_json, created_at)
    VALUES ('${RUN}', '${WORKSPACE}', '${WORKSTREAM}', 'human_message', '{}', 'completed',
            '${AT}', '${AT}', 'x-ai/grok-4.3', '{"prompt_tokens":42,"completion_tokens":8}', '${AT}');
    INSERT INTO tool_invocations
      (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
       input_hash, input_json, status, started_at, completed_at)
    VALUES ('${TOOL_CALL}', '${WORKSPACE}', '${WORKSTREAM}', '${RUN}', 'call-1', 'github_read',
            'hash', '{}', 'completed', '${AT}', '${AT}');
  `);
}

function envFor(database: DatabaseSync): Env {
  return {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
  } as unknown as Env;
}

function appFor(database: DatabaseSync) {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (context, next) => {
    context.set("auth", {
      sessionId: "test-session", workspaceId: WORKSPACE, userId: USER, region: "global", role: "owner",
    });
    await next();
  });
  app.route("/workstreams", workstreamRoutes);
  // The real app's handler, so a contract failure becomes the 500 and the
  // structured log production would see rather than an uncaught throw.
  app.onError(errorHandler);
  return { app, env: envFor(database) };
}

describe("work-stream response contracts, driven through the real queries", () => {
  it("serves a context of background tasks from a run that happened", async () => {
    const database = seededDatabase();
    seedAgentRun(database);
    const { app, env } = appFor(database);

    const response = await app.request(`/workstreams/${WORKSTREAM}/context`, undefined, env);

    // `HarnessTaskRowSchema` and `ToolTaskRowSchema` are only reachable from
    // here, and only once these rows exist. A 200 means both matched the
    // columns their queries actually select.
    expect(response.status).toBe(200);
    const payload = await response.json();
    // Asserted on the raw body rather than through the schema, which would
    // supply the default itself. A desktop build in the wild requires this
    // field and fails the whole response without it, so what matters is that
    // it is actually serialized — see `WorkstreamContextSchema`.
    expect(payload).toMatchObject({ artifacts: [] });
    const body = WorkstreamContextSchema.parse(payload);
    expect(body.backgroundTasks).toEqual([
      expect.objectContaining({ id: RUN, taskType: "agent", status: "completed", tokenCount: 50 }),
      expect.objectContaining({ id: TOOL_CALL, taskType: "tool", status: "completed" }),
    ]);
  });

  it("serves a transcript page", async () => {
    const database = seededDatabase();
    database.exec(`
      INSERT INTO messages
        (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
         message_type, text_content, sequence_number, created_at)
      VALUES ('00000000-0000-7000-8000-00000000000a', 'client-1', '${WORKSPACE}', '${WORKSTREAM}',
              'human', '${USER}', 'text', 'Hello', 1, '${AT}');
    `);
    const { app, env } = appFor(database);

    const response = await app.request(`/workstreams/${WORKSTREAM}/messages`, undefined, env);

    expect(response.status).toBe(200);
    const body = MessagePageSchema.parse(await response.json());
    expect(body.items).toEqual([
      expect.objectContaining({ textContent: "Hello", sequenceNumber: 1, messageType: "text" }),
    ]);
  });

  it("truncates an activity title the column does not bound rather than failing the work stream", async () => {
    // The production incident, end to end: a GitHub push title is the whole
    // commit body, `activities.title` has no length constraint, and
    // `ActivitySuggestionSchema` caps it at 300. Before the read bounded it,
    // one such row made this work stream unopenable for the whole workspace.
    const database = seededDatabase();
    const title = `juno-ai-labs/avalon: push — ${"x".repeat(500)}`;
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
         granted_scopes_json, config_json, cursor_json, created_at, updated_at, model_plugin_id)
      VALUES ('${CONNECTION}', '${WORKSPACE}', 'github', 'workspace', NULL, 'GitHub', 'healthy',
              '[]', '{}', '{}', '${AT}', '${AT}', 'plugin_github');
      INSERT INTO activities
        (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
         event_type, occurred_at, received_at, title, summary, actor_json, subject_json,
         visibility_json, entity_keys_json, dedupe_key, metadata_json)
      VALUES ('${ACTIVITY}', '${WORKSPACE}', '${CONNECTION}', 'workspace', 'github', 'push-1',
              'repo.push', '${AT}', '${AT}', '${title}', 'A commit landed.', '{}', '{}',
              '{"scope":"workspace"}', '[]', 'dedupe-1', '{}');
      INSERT INTO activity_suggestions
        (id, workspace_id, activity_id, workstream_id, confidence, reason, status, created_at)
      VALUES ('${SUGGESTION}', '${WORKSPACE}', '${ACTIVITY}', '${WORKSTREAM}', 0.9,
              'The work stream tracks this repository.', 'pending', '${AT}');
    `);
    const { app, env } = appFor(database);

    const response = await app.request(`/workstreams/${WORKSTREAM}`, undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { suggestions: Array<{ id: string; title: string }> };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]?.title).toHaveLength(300);
  });

  it("fails the read, naming the column, when a row leaves the state its table allows", async () => {
    // The other half of the same boundary. Hand-coercion turned this into a
    // plausible value that the response schema rejected several layers later as
    // an anonymous 500; the row schema names `harness_status` instead.
    const database = seededDatabase();
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.exec(`UPDATE workstreams SET harness_status = 'paused' WHERE id = '${WORKSTREAM}'`);
    const { app, env } = appFor(database);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(`/workstreams/${WORKSTREAM}`, undefined, env);

    expect(response.status).toBe(500);
    expect(logged.mock.calls[0]?.[0]).toMatchObject({
      error_name: "ZodError",
      route: "/workstreams/:id",
      validation_issues: [{ path: "harness_status" }],
    });
    logged.mockRestore();
  });
});

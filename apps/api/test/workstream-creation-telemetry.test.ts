import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  recordWorkstreamCreatedTelemetry,
  workstreamCreationEventId,
} from "../src/telemetry/workstream-creation";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const userId = asUserId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1");
const workspaceId = asWorkspaceId("018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2");
const workstreamId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3";

function fixture() {
  const database = preRetirementProductSqliteDatabase();
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, product_analytics_enabled, created_at, updated_at)
    VALUES
      ('${userId}', 'subject', 'member@example.com', 'Member', 1,
       '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z');
    INSERT INTO workspaces
      (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
    VALUES
      ('${workspaceId}', 'Workspace', 'workspace', 'global', 'UTC', '${userId}',
       '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '2026-08-13T17:00:00.000Z');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, scope,
       model_override, created_at, updated_at, last_activity_at)
    VALUES
      ('${workstreamId}', '${workspaceId}', 'Task', 'Task', 'ad_hoc', '${userId}',
       'personal', 'openai/gpt-5', '2026-08-13T17:00:00.000Z',
       '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES
      ('${workstreamId}', '${userId}', '${userId}', 'creator', '2026-08-13T17:00:00.000Z');
  `);
  const objectStores = new Map<string, DatabaseSync>();
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "production",
    APP_VERSION: "1.97.0",
    BUILD_SHA: "build-creation",
    // The emitter routes its work-stream read through the runtime database,
    // which reaches the object through the SUBSTREAM_AGENTS port.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
  });
  return { database, env, objectStores };
}

describe("server-authoritative work-stream creation telemetry", () => {
  it("projects legacy UUID work-stream ids into a stable UUIDv7 insert id", () => {
    expect(workstreamCreationEventId("00000000-0000-4000-8000-000000000101"))
      .toBe("00000000-0000-7000-8000-000000000101");
  });

  it("records one idempotent event with closed connector attribution and stored work-stream state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T17:00:01.000Z"));
    const { database, env, objectStores } = fixture();
    // The stored state this telemetry reads (scope, model override, the
    // participant roll) lives in the work stream's object since migration
    // 0090; the emitter reaches it through the port.
    const objectStore = testWorkstreamObjectStore();
    seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO workstreams
         (id, workspace_id, title, objective, origin_type, created_by_user_id, scope,
          model_override, created_at, updated_at, last_activity_at)
       VALUES (?, ?, 'Task', 'Task', 'ad_hoc', ?, 'personal', 'openai/gpt-5',
               '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z')`,
      workstreamId,
      workspaceId,
      userId,
    );
    workstreamObjectRun(
      objectStore,
      `INSERT INTO workstream_participants
         (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
       VALUES (?, ?, ?, 'creator', '2026-08-13T17:00:00.000Z')`,
      workstreamId,
      userId,
      userId,
    );
    objectStores.set(workstreamId, objectStore);

    const input = {
      workspaceId,
      workstreamId,
      creationSource: "slack_agent" as const,
      connectorTypes: ["slack", "slack"] as const,
      principal: { type: "user" as const, userId },
    };
    await recordWorkstreamCreatedTelemetry(env, input);
    await recordWorkstreamCreatedTelemetry(env, input);

    const rows = database.prepare(
      "SELECT event_id, envelope_json FROM telemetry_accepted_events WHERE event_id = ?",
    ).all(workstreamId) as Array<{ event_id: string; envelope_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.envelope_json)).toMatchObject({
      name: "workstream_created",
      source: "api",
      identityScope: "workspace-user",
      context: { operationId: workstreamId },
      properties: {
        workstreamId,
        visibility: "private",
        creationSource: "slack_agent",
        origin: "ad_hoc",
        connectorType: "slack",
        connectorTypes: ["slack"],
        connectorTypeCount: 1,
        participantCount: 1,
        attachmentCount: 0,
        modelOverride: true,
      },
    });
    objectStore.close();
    database.close();
    vi.useRealTimers();
  });

});

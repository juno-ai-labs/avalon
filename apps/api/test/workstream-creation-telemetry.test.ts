import { describe, expect, it, vi } from "vitest";

import {
  connectorTypesForOpportunity,
  recordWorkstreamCreatedTelemetry,
  workstreamCreationEventId,
} from "../src/telemetry/workstream-creation";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const userId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1";
const workspaceId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2";
const workstreamId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3";
const opportunityId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4";

function fixture() {
  const database = migratedSqliteDatabase();
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
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "production",
    APP_VERSION: "1.97.0",
    BUILD_SHA: "build-creation",
  });
  return { database, env };
}

describe("server-authoritative work-stream creation telemetry", () => {
  it("projects legacy UUID work-stream ids into a stable UUIDv7 insert id", () => {
    expect(workstreamCreationEventId("00000000-0000-4000-8000-000000000101"))
      .toBe("00000000-0000-7000-8000-000000000101");
  });

  it("records one idempotent event with closed connector attribution and stored work-stream state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T17:00:01.000Z"));
    const { database, env } = fixture();

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
    database.close();
    vi.useRealTimers();
  });

  it("resolves all distinct connector types from an opportunity's stored activity roots", async () => {
    const { database, env } = fixture();
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, status, created_at, updated_at, model_plugin_id)
      VALUES
        ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901', '${workspaceId}', 'linear', 'workspace', NULL,
         'Linear', '[]', 'healthy', '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z',
         'plugin_linear'),
        ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902', '${workspaceId}', 'slack', 'workspace', NULL,
         'Slack', '[]', 'healthy', '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z',
         'plugin_slack');
      INSERT INTO activities
        (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
         event_type, actor_json, subject_json, occurred_at, received_at, title, summary,
         text_snippet, visibility_json, entity_keys_json, dedupe_key, processing_status,
         metadata_json)
      VALUES
        ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7911', '${workspaceId}',
         '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901', 'workspace', 'linear', 'linear-1',
         'issue.updated', '{}', '{}', '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z',
         'Issue', '', '', '{}', '[]', 'linear-1', 'processed', '{}'),
        ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7912', '${workspaceId}',
         '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902', 'workspace', 'slack', 'slack-1',
         'message.created', '{}', '{}', '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z',
         'Thread', '', '', '{}', '[]', 'slack-1', 'processed', '{}');
      INSERT INTO work_opportunities
        (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
         admission_reasoning, source_fingerprint, display_prompt_hash, execution_prompt_hash,
         expires_at, created_at, updated_at)
      VALUES
        ('${opportunityId}', '${workspaceId}', 'workspace', NULL, 'Do the work', 'Do the work',
         'Useful', 'fingerprint', 'display-hash', 'execution-hash', '2026-08-14T17:00:00.000Z',
         '2026-08-13T17:00:00.000Z', '2026-08-13T17:00:00.000Z');
      INSERT INTO opportunity_provenance_nodes
        (id, workspace_id, node_kind, source_id, provider, label, visibility_scope, locator_json, created_at)
      VALUES
        ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7921', '${workspaceId}', 'activity',
         '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7911', 'linear', 'Issue', 'workspace', '{}',
         '2026-08-13T17:00:00.000Z'),
        ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7922', '${workspaceId}', 'activity',
         '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7912', 'slack', 'Thread', 'workspace', '{}',
         '2026-08-13T17:00:00.000Z');
      INSERT INTO work_opportunity_provenance_roots (opportunity_id, node_id, position)
      VALUES
        ('${opportunityId}', '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7921', 0),
        ('${opportunityId}', '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7922', 1);
    `);

    await expect(connectorTypesForOpportunity(env, workspaceId, opportunityId))
      .resolves.toEqual(["linear", "slack"]);
    database.close();
  });
});

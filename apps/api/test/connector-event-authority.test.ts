import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { reapProcessedActivityPayloads } from "../src/services/normalized-activity-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000401";
const USER_ID = "00000000-0000-7000-8000-000000000402";
const CONNECTION_ID = "00000000-0000-7000-8000-000000000403";
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000404";
const FREE_EVENT_ID = "00000000-0000-7000-8000-000000000405";
const BATCH_EVENT_ID = "00000000-0000-7000-8000-000000000406";
const SUGGESTED_EVENT_ID = "00000000-0000-7000-8000-000000000407";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'connector-authority-user', 'connector@example.com', 'Connector', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Connector workspace', 'connector-workspace', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name,
       granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${CONNECTION_ID}', '${WORKSPACE_ID}', 'github', 'workspace', NULL, 'GitHub',
            '[]', 'plugin_github', 'healthy', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'A stream', 'Test redaction', 'ad_hoc', '${USER_ID}',
            'idle', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  for (const [index, eventId] of [FREE_EVENT_ID, BATCH_EVENT_ID, SUGGESTED_EVENT_ID].entries()) {
    database.prepare(`
      INSERT INTO activities
        (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
         provider, provider_event_id, event_type, resource_type, provider_resource_id,
         actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet,
         payload_ref, visibility_json, target_user_ids_json, entity_keys_json, dedupe_key,
         raw_content_hash, external_people_json, processing_status, metadata_json)
      VALUES (?, ?, ?, 'workspace', NULL, 'github', ?, 'github.issue.edited', 'issue', ?,
              '{"displayName":"Ada"}', '{"number":42}', '2026-01-01', '2026-01-01',
              'A durable title', 'A durable summary', 'A durable snippet', 'global/raw.json',
              '{"scope":"workspace"}', ?, '["github:issue:42"]', ?, 'raw-hash', '[]',
              'processed', ?)
    `).run(
      eventId,
      WORKSPACE_ID,
      CONNECTION_ID,
      `provider-${index}`,
      `issue-${index}`,
      JSON.stringify([USER_ID]),
      `dedupe-${index}`,
      JSON.stringify({
        _workspace_do_event_id: eventId,
        _connector_event_workflow_id: `connector-event:${eventId}:0`,
        _connector_event_attempt: 0,
        durableProductBody: "must be removed",
      }),
    );
  }
  database.exec(`
    INSERT INTO opportunity_batch_windows
      (id, workspace_id, partition_key, audience_scope, audience_user_id,
       first_event_at, last_event_at, process_after, status, created_at, updated_at)
    VALUES ('00000000-0000-7000-8000-000000000408', '${WORKSPACE_ID}', 'workspace',
            'workspace', NULL, '2026-01-01', '2026-01-01', '2026-01-01', 'queued', '2026-01-01', '2026-01-01');
    INSERT INTO opportunity_batch_events
      (id, workspace_id, window_id, partition_key, source_kind, source_id,
       occurred_at, input_characters, status, created_at, updated_at)
    VALUES ('00000000-0000-7000-8000-000000000409', '${WORKSPACE_ID}',
            '00000000-0000-7000-8000-000000000408', 'workspace', 'activity',
            '${BATCH_EVENT_ID}', '2026-01-01', 100, 'pending', '2026-01-01', '2026-01-01');
    INSERT INTO activity_suggestions
      (id, workspace_id, activity_id, workstream_id, confidence, reason, status, created_at, source)
    VALUES ('00000000-0000-7000-8000-000000000410', '${WORKSPACE_ID}', '${SUGGESTED_EVENT_ID}',
            '${WORKSTREAM_ID}', 0.9, 'Still needs its display snapshot', 'pending', '2026-01-01', 'contextual_routing');
  `);
  return database;
}

describe("WorkspaceDO connector-event authority", () => {
  it("redacts only settled D1 handoffs whose pending snapshot readers have cleared", async () => {
    const database = seededDatabase();
    const env = createTestEnv({ DB: sqliteD1(database) });

    await expect(reapProcessedActivityPayloads(env, 10)).resolves.toBe(1);
    expect(database.prepare(
      `SELECT title, summary, actor_json, subject_json, payload_ref,
              json_extract(metadata_json, '$._workspace_do_event_id') AS durable_event_id,
              json_extract(metadata_json, '$.durableProductBody') AS removed_body
         FROM activities WHERE id = ?`,
    ).get(FREE_EVENT_ID)).toEqual({
      title: "",
      summary: "",
      actor_json: "{}",
      subject_json: "{}",
      payload_ref: null,
      durable_event_id: FREE_EVENT_ID,
      removed_body: null,
    });
    expect(database.prepare("SELECT title FROM activities WHERE id = ?").get(BATCH_EVENT_ID))
      .toEqual({ title: "A durable title" });
    expect(database.prepare("SELECT title FROM activities WHERE id = ?").get(SUGGESTED_EVENT_ID))
      .toEqual({ title: "A durable title" });
  });
});

import { asUserId, asWorkspaceId } from "@avalon/contracts";
import { describe, expect, it } from 'vitest';
import {
  emitAgentToolStartedTelemetry,
  emitAgentToolTerminalTelemetry,
} from '../src/telemetry/tool-usage';
import { withWorkstreamRuntimeDatabase } from '../src/services/workstream-runtime-database';
import { createTestEnv } from './helpers/cloudflare-test';
import { preRetirementProductSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import {
  executeWorkstreamObjectSql,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
  seedToolReceipt,
} from './helpers/durable-authority';

const userId = asUserId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1');
const workspaceId = asWorkspaceId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2');
const workstreamId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3';
const harnessRunId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4';
const userInvocationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d5';
const workspaceInvocationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d6';

function fixture() {
  const database = preRetirementProductSqliteDatabase();
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'subject', 'member@example.com', 'Member',
            '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
    INSERT INTO workspaces
      (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', 'UTC', '${userId}',
            '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
  `);
  return {
    database,
    env: createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: 'global',
      APP_ENV: 'production',
      APP_VERSION: '1.96.0',
      BUILD_SHA: 'build-1',
    }),
  };
}

describe('agent tool usage telemetry', () => {
  it('attributes a user-owned invocation to the person and workspace without content', async () => {
    const { database, env } = fixture();
    await emitAgentToolStartedTelemetry(env, {
      workspaceId,
      workstreamId,
      harnessRunId,
      invocationId: userInvocationId,
      executionPrincipal: { type: 'user', userId },
      toolName: 'search_messages',
      pluginId: 'avalon.workstream',
      capability: 'workstream.search',
      mode: 'read',
      runKind: 'workstream',
    });

    const row = database.prepare(
      `SELECT envelope_json, subject_user_id, workspace_analytics_id
         FROM telemetry_accepted_events WHERE event_id = ?`,
    ).get(userInvocationId) as {
      envelope_json: string;
      subject_user_id: string | null;
      workspace_analytics_id: string | null;
    };
    expect(row.subject_user_id).toBe(userId);
    expect(row.workspace_analytics_id).toBeTruthy();
    expect(JSON.parse(row.envelope_json)).toMatchObject({
      name: 'agent_tool_started',
      identityScope: 'workspace-user',
      properties: {
        workstreamId,
        harnessRunId,
        toolName: 'search_messages',
        pluginId: 'avalon.workstream',
        capability: 'workstream.search',
        mode: 'read',
        runKind: 'workstream',
        executionScope: 'user',
      },
    });
    expect(row.envelope_json).not.toContain('arguments');
    expect(row.envelope_json).not.toContain('output');
    database.close();
  });

  it('uses a personless workspace identity for an automation invocation', async () => {
    const { database, env } = fixture();
    await emitAgentToolStartedTelemetry(env, {
      workspaceId,
      workstreamId,
      harnessRunId,
      invocationId: workspaceInvocationId,
      automationId: userInvocationId,
      executionPrincipal: { type: 'workspace', workspaceId },
      toolName: 'create_issue',
      pluginId: 'connection:018f3f4e-7b5a-7cc1-9a6f-2aa0324b7900',
      capability: 'linear.issue.create',
      mode: 'write',
      runKind: 'automation',
    });

    const row = database.prepare(
      `SELECT envelope_json, analytics_subject_id, subject_user_id, workspace_analytics_id
         FROM telemetry_accepted_events WHERE event_id = ?`,
    ).get(workspaceInvocationId) as {
      envelope_json: string;
      analytics_subject_id: string;
      subject_user_id: string | null;
      workspace_analytics_id: string;
    };
    expect(row.subject_user_id).toBeNull();
    expect(row.analytics_subject_id).toBe(row.workspace_analytics_id);
    expect(JSON.parse(row.envelope_json)).toMatchObject({
      identityScope: 'workspace',
      properties: { runKind: 'automation', executionScope: 'workspace' },
    });
    database.close();
  });

  it('emits a content-free authoritative terminal receipt with bounded failure metadata', async () => {
    const { database, env } = fixture();
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         created_at, updated_at, last_activity_at)
      VALUES ('${workstreamId}', '${workspaceId}', 'Run', '', 'ad_hoc', '${userId}',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z',
              '2026-08-12T20:00:00.000Z');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901', '${workspaceId}', '${userId}',
              'Automation', '', 'private', 1, '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         created_by_user_id, created_at)
      VALUES ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902',
              '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901', 1, 'Run', '[]', '${userId}',
              '2026-08-12T20:00:00.000Z');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, status, created_at, updated_at)
      VALUES ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903', '${workspaceId}',
              '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901',
              '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902', 'personal', '${userId}',
              '{"type":"user","userId":"${userId}"}', 'active',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
      UPDATE workstreams
         SET origin_type = 'automation',
             automation_subscription_id = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903',
             automation_run_id = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7904'
       WHERE id = '${workstreamId}';
      INSERT INTO automation_runs
        (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
         started_at, completed_at, status, created_at)
      VALUES ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7904', '${workspaceId}',
              '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903', '${workstreamId}', 'scheduled',
              '2026-08-12T19:00:00.000Z', '2026-08-12T19:10:00.000Z', 'completed',
              '2026-08-12T19:00:00.000Z');
    `);
    // The run, its invocation receipts, and the product work-stream row live
    // in the work stream's object since migration 0090; the emitter is handed
    // a routed environment the way the harness hands it one.
    const objectStore = testWorkstreamObjectStore();
    seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO workstreams
         (id, workspace_id, title, objective, origin_type, created_by_user_id,
          automation_subscription_id, automation_run_id, created_at, updated_at, last_activity_at)
       VALUES (?, ?, 'Run', '', 'automation', ?, '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903',
               '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7904', '2026-08-12T20:00:00.000Z',
               '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z')`,
      workstreamId,
      workspaceId,
      userId,
    );
    workstreamObjectRun(
      objectStore,
      `INSERT INTO harness_runs
         (id, workspace_id, workstream_id, origin, execution_principal_json,
          status, started_at, created_at)
       VALUES (?, ?, ?, 'human_message', ?, 'running',
               '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z')`,
      harnessRunId,
      workspaceId,
      workstreamId,
      JSON.stringify({ type: 'user', userId }),
    );
    seedToolReceipt(objectStore, {
      id: userInvocationId,
      runId: harnessRunId,
      toolCallId: 'call-1',
      toolName: 'create_issue',
      mode: 'write',
      status: 'failed',
      inputJson: '{"title":"secret"}',
      startedAt: Date.parse('2026-08-12T20:00:01.000Z'),
      settledAt: Date.parse('2026-08-12T20:00:07.000Z'),
      executionPlanJson: '{"pluginId":"linear","canonicalToolName":"create_issue","capability":"linear.issue.create","mode":"write"}',
    });
    objectStore.prepare(
      `UPDATE tool_effects SET error_json = ? WHERE effect_intent_id = ?`,
    ).run('{"code":"provider_timeout","message":"secret provider response"}', userInvocationId);
    const routedEnv = withWorkstreamRuntimeDatabase(
      // The work stream's automation run was a third table in the receipt's
      // join; it is the identity authority's read now, answered by the real
      // storage class over the same object store this test seeds.
      createTestEnv({ ...env, SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore) }),
      workspaceId,
      workstreamId,
      '0',
      async (statements) => executeWorkstreamObjectSql(objectStore, statements),
    );

    await emitAgentToolTerminalTelemetry(routedEnv, {
      workspaceId,
      workstreamId,
      harnessRunId,
      invocationId: userInvocationId,
    });
    await emitAgentToolTerminalTelemetry(routedEnv, {
      workspaceId,
      workstreamId,
      harnessRunId,
      invocationId: userInvocationId,
    });

    const row = database.prepare(
      `SELECT envelope_json, subject_user_id FROM telemetry_accepted_events
        WHERE json_extract(envelope_json, '$.name') = 'agent_tool_terminal'`,
    ).get() as { envelope_json: string; subject_user_id: string };
    expect(row.subject_user_id).toBe(userId);
    expect(JSON.parse(row.envelope_json)).toMatchObject({
      name: 'agent_tool_terminal',
      identityScope: 'workspace-user',
      properties: {
        workstreamId,
        harnessRunId,
        toolName: 'create_issue',
        pluginId: 'linear',
        capability: 'linear.issue.create',
        mode: 'write',
        runKind: 'workstream',
        executionScope: 'user',
        result: 'provider_error',
        duration: '5s_30s',
        replayed: false,
      },
    });
    expect(JSON.parse(row.envelope_json).properties).not.toHaveProperty('automationId');
    expect(row.envelope_json).not.toContain('secret');
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM telemetry_accepted_events
        WHERE json_extract(envelope_json, '$.name') = 'agent_tool_terminal'`,
    ).get()).toEqual({ count: 1 });
    database.close();
  });
});

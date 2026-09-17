import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from 'vitest';
import {
  emitAgentToolStartedTelemetry,
  emitAgentToolTerminalTelemetry,
} from '../src/telemetry/tool-usage';
import { createTestEnv } from './helpers/cloudflare-test';
import { preRetirementProductSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import {
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
const automationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903';
const automationRunId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7904';

function workDeferral() {
  const pending: Promise<unknown>[] = [];
  return {
    defer(promise: Promise<unknown>) {
      pending.push(promise);
    },
    async settle() {
      for (let index = 0; index < pending.length; index += 1) {
        await pending[index];
      }
    },
  };
}

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
    const lifecycle = workDeferral();
    emitAgentToolStartedTelemetry(env, {
      workspaceId,
      workstreamId,
      harnessRunId,
      invocationId: userInvocationId,
      executionPrincipal: { type: 'user', userId },
      toolName: 'search_messages',
      pluginId: 'rally.workstream',
      capability: 'workstream.search',
      mode: 'read',
      runKind: 'workstream',
    }, lifecycle.defer);
    expect(database.prepare(
      'SELECT event_id FROM telemetry_accepted_events WHERE event_id = ?',
    ).get(userInvocationId)).toBeUndefined();
    await lifecycle.settle();

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
        pluginId: 'rally.workstream',
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
    const lifecycle = workDeferral();
    emitAgentToolStartedTelemetry(env, {
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
    }, lifecycle.defer);
    await lifecycle.settle();

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
    `);
    // The run, its invocation receipts, and the product work-stream row live
    // in the work stream's object since migration 0090; the emitter is handed
    // a routed environment the way the harness hands it one.
    const objectStore = testWorkstreamObjectStore();
    seedWorkstreamObjectRoot(objectStore, {
      workstreamId,
      workspaceId,
      title: "Run",
      description: "",
      createdByUserId: userId,
    }, Date.parse("2026-08-12T20:00:00.000Z"));
    workstreamObjectRun(
      objectStore,
      `INSERT INTO runs
         (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
          next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
          tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
          origin, execution_principal_json, chain_depth, created_at, updated_at)
       VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, ?,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               'human_message', ?, 0, ?, ?)`,
      harnessRunId,
      Date.parse('2026-08-12T20:00:00.000Z'),
      JSON.stringify({ type: 'user', userId }),
      Date.parse('2026-08-12T20:00:00.000Z'),
      Date.parse('2026-08-12T20:00:00.000Z'),
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
    const routedEnv =
      // The receipt itself lives in the work stream's object, read by the real
      // storage class over the same object store this test seeds.
      createTestEnv({ ...env, SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore) });
    // Which automation this run belongs to is the loop input's to say: the
    // stored receipt carries no automation columns, so the caller passes the
    // same provenance the started event carried.
    const terminal = {
      workspaceId,
      workstreamId,
      harnessRunId,
      invocationId: userInvocationId,
      automationId,
      automationRunId,
    };
    const lifecycle = workDeferral();

    emitAgentToolTerminalTelemetry(routedEnv, terminal, lifecycle.defer);
    emitAgentToolTerminalTelemetry(routedEnv, terminal, lifecycle.defer);
    await lifecycle.settle();

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
        runKind: 'automation',
        executionScope: 'user',
        result: 'provider_error',
        duration: '5s_30s',
        replayed: false,
      },
    });
    expect(JSON.parse(row.envelope_json).properties.automationId).toBe(automationId);
    expect(row.envelope_json).not.toContain('secret');
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM telemetry_accepted_events
        WHERE json_extract(envelope_json, '$.name') = 'agent_tool_terminal'`,
    ).get()).toEqual({ count: 1 });
    database.close();
  });
});

import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { describe, expect, it, vi } from 'vitest';
import type { IdentityAuthContext } from '../src/env';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from '../src/telemetry/api-emitter';
import { emitCorrelatedRunOutcome } from '../src/telemetry/run-outcome';
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
const workstreamId = asWorkstreamId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3');
const runId = asHarnessRunId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4');
const operationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d5';

describe('authoritative run outcome telemetry', () => {
  it('writes one idempotent outcome keyed by the run while retaining the operation as correlation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:08.000Z'));
    const database = preRetirementProductSqliteDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${userId}', 'subject', 'member@example.com', 'Member',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
      INSERT INTO workspaces
        (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', 'UTC', '${userId}',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '2026-08-12T20:00:00.000Z');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id, created_at, updated_at, last_activity_at)
      VALUES ('${workstreamId}', '${workspaceId}', 'Run', 'Run', 'ad_hoc', '${userId}',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
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
    // The run and its inference receipts live in the work stream's object
    // since migration 0090; the emitter is handed a routed environment the way
    // both production callers hand it one.
    const objectStore = testWorkstreamObjectStore();
    seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO workstreams
         (id, workspace_id, title, objective, origin_type, created_by_user_id,
          automation_subscription_id, automation_run_id, created_at, updated_at, last_activity_at)
       VALUES (?, ?, 'Run', 'Run', 'automation', ?, '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903',
               '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7904', '2026-08-12T20:00:00.000Z',
               '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z')`,
      workstreamId,
      workspaceId,
      userId,
    );
    workstreamObjectRun(
      objectStore,
      `INSERT INTO harness_runs
         (id, workspace_id, workstream_id, origin, execution_principal_json, status,
          started_at, completed_at, created_at, model, usage_json)
       VALUES (?, ?, ?, 'human_message', ?, 'completed',
               '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:08.000Z',
               '2026-08-12T20:00:00.000Z', 'openai/gpt-5', '{"run_stats":{"turns":2}}')`,
      runId,
      workspaceId,
      workstreamId,
      JSON.stringify({ type: 'user', userId }),
    );
    workstreamObjectRun(
      objectStore,
      // routing_decision_json is NOT NULL in the object's ledger; the compat
      // trigger's INSERT OR IGNORE silently drops a row that omits it.
      `INSERT INTO inference_attempts
         (id, harness_run_id, workspace_id, workstream_id, attempt_id, turn_id,
          endpoint_attempt, fallback_attempt, provider, model, workspace_identity_hash,
          routing_decision_json, outcome, latency_ms, ttft_ms, started_at, completed_at, created_at)
       VALUES ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d8', ?, ?, ?, 'attempt', 'turn-1',
               1, 1, 'openai', 'openai/gpt-5', 'workspace-hash', '{}', 'success', 4000, 1200,
               '2026-08-12T20:00:01.000Z', '2026-08-12T20:00:05.000Z',
               '2026-08-12T20:00:05.000Z')`,
      runId,
      workspaceId,
      workstreamId,
    );
    // Two receipts, one of them a write. Nothing else in this suite covered the
    // outcome event's tool counts, so retargeting their subqueries at
    // `tool_effects` would otherwise have been an unasserted change.
    seedToolReceipt(objectStore, {
      id: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901', runId, toolCallId: 'call-1',
      toolName: 'read_resource', status: 'completed', requestHash: 'hash-1',
      executionPlanJson: '{"mode":"read"}',
    });
    seedToolReceipt(objectStore, {
      id: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902', runId, toolCallId: 'call-2',
      toolName: 'publish_branch', mode: 'write', status: 'completed',
      requestHash: 'hash-2', position: 1,
      executionPlanJson: '{"mode":"write"}',
    });
    const env = createTestEnv({
      DB: sqliteD1(database),
      // The work stream's automation run was a `JOIN workstreams` inside the
      // statement below; it is the identity authority's read now, answered by
      // the real storage class over the same object store this fixture seeds.
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
      AVALON_REGION: 'global',
      APP_ENV: 'production',
      APP_VERSION: '1.96.0',
      BUILD_SHA: 'build-1',
    });
    const auth: IdentityAuthContext = {
      sessionId: 'telemetry-create',
      userId,
      workspaceId,
      region: 'global',
      role: 'owner',
    };
    await emitAuthenticatedApiTelemetry(env, auth, apiTelemetryEnvelope(
      env,
      'workstream_create_completed',
      { result: 'success' },
      operationId,
      'workspace-user',
      'global',
      operationId,
    ));

    const routedEnv = withWorkstreamRuntimeDatabase(
      env,
      workspaceId,
      workstreamId,
      '0',
      async (statements) => executeWorkstreamObjectSql(objectStore, statements),
    );
    const input = {
      workspaceId,
      workstreamId,
      harnessRunId: runId,
      telemetryOperationId: operationId,
      telemetrySubjectUserId: userId,
    };
    await emitCorrelatedRunOutcome(routedEnv, input);
    await emitCorrelatedRunOutcome(routedEnv, input);

    const rows = database.prepare(
      `SELECT event_id, envelope_json FROM telemetry_accepted_events WHERE event_id = ?`,
    ).all(runId) as Array<{ event_id: string; envelope_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_id).toBe(runId);
    expect(JSON.parse(rows[0]!.envelope_json)).toMatchObject({
      name: 'run_completed',
      context: { operationId },
      properties: { result: 'success', duration: '5s_30s' },
    });
    const terminal = database.prepare(
      `SELECT envelope_json FROM telemetry_accepted_events
        WHERE json_extract(envelope_json, '$.name') = 'run_terminal'`,
    ).get() as { envelope_json: string };
    expect(JSON.parse(terminal.envelope_json)).toMatchObject({
      name: 'run_terminal',
      identityScope: 'workspace-user',
      context: { operationId },
      properties: {
        workstreamId,
        harnessRunId: runId,
        runKind: 'workstream',
        triggerType: 'composer',
        terminalState: 'completed',
        duration: '5s_30s',
        timeToFirstOutput: '1s_5s',
        turnCount: 'two_to_five',
        // Two receipts, one of them a write. These previously read `zero`
        // against a run with no receipts at all, which meant breaking the
        // subqueries outright left the assertion green.
        toolCallCount: 'two_to_five',
        writeToolCallCount: 'one',
        modelRoute: 'openai/gpt-5',
        fallbackUsed: true,
      },
    });
    expect(JSON.parse(terminal.envelope_json).properties).not.toHaveProperty('automationId');
    expect(database.prepare(`
      SELECT event_id, json_extract(envelope_json, '$.name') AS name
      FROM telemetry_accepted_events
      WHERE event_id IN (?, ?)
      ORDER BY name
    `).all(operationId, runId)).toEqual([
      { event_id: runId, name: 'run_completed' },
      { event_id: operationId, name: 'workstream_create_completed' },
    ]);
    objectStore.close();
    database.close();
    vi.useRealTimers();
  });
});

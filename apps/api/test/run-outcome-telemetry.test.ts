import { asAutomationId, asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it, vi } from 'vitest';
import type { IdentityAuthContext } from '../src/env';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from '../src/telemetry/api-emitter';
import { emitCorrelatedRunOutcome } from '../src/telemetry/run-outcome';
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
const workstreamId = asWorkstreamId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3');
const runId = asHarnessRunId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4');
const operationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d5';
const automationId = asAutomationId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b7903');
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
    `);
    // The run and its inference receipts live in the work stream's object
    // since migration 0090; the emitter is handed a routed environment the way
    // both production callers hand it one.
    const objectStore = testWorkstreamObjectStore();
    seedWorkstreamObjectRoot(objectStore, {
      workstreamId,
      workspaceId,
      title: "Run",
      description: "Run",
      createdByUserId: userId,
    }, Date.parse("2026-08-12T20:00:00.000Z"));

    workstreamObjectRun(
      objectStore,
      `INSERT INTO runs
         (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
          next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
          tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
          terminal_reason, origin, execution_principal_json, chain_depth, model, usage_json,
          completed_at, terminalized_at, created_at, updated_at)
       VALUES (?, '0', 'completed', '{}', 0, 0, '', 0, 0, ?,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               'completed', 'automation_activation', ?, 0, 'openai/gpt-5',
               '{"run_stats":{"turns":2}}', ?, ?, ?, ?)`,
      runId,
      Date.parse('2026-08-12T20:00:00.000Z'),
      JSON.stringify({ type: 'user', userId }),
      Date.parse('2026-08-12T20:00:08.000Z'),
      Date.parse('2026-08-12T20:00:08.000Z'),
      Date.parse('2026-08-12T20:00:00.000Z'),
      Date.parse('2026-08-12T20:00:08.000Z'),
    );
    workstreamObjectRun(
      objectStore,
      `INSERT INTO inference_attempts
         (inference_attempt_id, run_id, attempt_id, turn_id,
          endpoint_attempt, fallback_attempt, provider, model, workspace_identity_hash,
          routing_decision_json, outcome, latency_ms, ttft_ms, started_at, completed_at, created_at)
       VALUES ('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d8', ?, 'attempt', 'turn-1',
               1, 1, 'openai', 'openai/gpt-5', 'workspace-hash', '{}', 'success', 4000, 1200,
               ?, ?, ?)`,
      runId,
      Date.parse('2026-08-12T20:00:01.000Z'),
      Date.parse('2026-08-12T20:00:05.000Z'),
      Date.parse('2026-08-12T20:00:05.000Z'),
    );
    // Two receipts, one of them a write. Nothing else in this suite covered the
    // outcome event's tool counts, so retargeting their subqueries at
    // `tool_effects` would otherwise have been an unasserted change.
    seedToolReceipt(objectStore, {
      id: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7901', runId, toolCallId: 'call-1',
      toolName: 'read_resource', status: 'completed', requestHash: 'hash-1',
      mode: 'read', executionPlanJson: null,
    });
    seedToolReceipt(objectStore, {
      id: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902', runId, toolCallId: 'call-2',
      toolName: 'publish_branch', mode: 'write', status: 'completed',
      requestHash: 'hash-2', position: 1,
      executionPlanJson: null,
    });
    const env = createTestEnv({
      DB: sqliteD1(database),
      // The run row lives in the work stream's object, read by the real
      // storage class over the same object store this fixture seeds.
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

    const routedEnv = env;
    // Which automation this run belongs to, and what started it, ride on the
    // loop input: the stored run row carries no automation columns, so nothing
    // is asked a second question after the terminal gate.
    const input = {
      workspaceId,
      parentKind: "workstream",
      parentId: workstreamId,
      harnessRunId: runId,
      automationRun: {
        schemaVersion: 1,
        automationId,
        runId: automationRunId,
        definitionRevision: 1,
        trigger: {
          kind: "schedule",
          scheduleId: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b7905',
          scheduleKind: "calendar",
          plannedFor: Date.parse('2026-08-12T19:00:00.000Z'),
        },
      },
      telemetryOperationId: operationId,
      telemetrySubjectUserId: userId,
    } as const;
    const lifecycle = workDeferral();
    emitCorrelatedRunOutcome(routedEnv, input, lifecycle.defer);
    emitCorrelatedRunOutcome(routedEnv, input, lifecycle.defer);
    await lifecycle.settle();

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
        runKind: 'automation',
        // The reference says `schedule`; this event has always said
        // `scheduled`, and the run's own origin is the activation.
        triggerType: 'scheduled',
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
    expect(JSON.parse(terminal.envelope_json).properties)
      .toHaveProperty('automationId', automationId);
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

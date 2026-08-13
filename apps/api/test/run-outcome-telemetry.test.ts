import { describe, expect, it, vi } from 'vitest';
import { emitCorrelatedRunOutcome } from '../src/telemetry/run-outcome';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const userId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1';
const workspaceId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2';
const workstreamId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3';
const runId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4';
const operationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d5';

describe('authoritative run outcome telemetry', () => {
  it('writes one idempotent content-free outcome with the originating operation ID', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:08.000Z'));
    const database = migratedSqliteDatabase();
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
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status,
         started_at, completed_at, created_at)
      VALUES ('${runId}', '${workspaceId}', '${workstreamId}', 'human_message',
              '{"type":"user","userId":"${userId}"}', 'completed',
              '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:08.000Z',
              '2026-08-12T20:00:00.000Z');
    `);
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: 'global',
      APP_ENV: 'production',
      APP_VERSION: '1.96.0',
      BUILD_SHA: 'build-1',
    });

    const input = {
      workspaceId,
      workstreamId,
      harnessRunId: runId,
      telemetryOperationId: operationId,
      telemetrySubjectUserId: userId,
    };
    await emitCorrelatedRunOutcome(env, input);
    await emitCorrelatedRunOutcome(env, input);

    const rows = database.prepare(
      `SELECT event_id, envelope_json FROM telemetry_accepted_events WHERE event_id = ?`,
    ).all(operationId) as Array<{ event_id: string; envelope_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.envelope_json)).toMatchObject({
      name: 'run_completed',
      context: { operationId },
      properties: { result: 'success', duration: '5s_30s' },
    });
    database.close();
    vi.useRealTimers();
  });
});

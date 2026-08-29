import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../src/env';
import { ConnectionService } from '../src/services/connection-service';
import { createTestEnv } from './helpers/cloudflare-test';
import { preRetirementProductSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from './helpers/workspace-object-rpcs';

const userId = asUserId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79e1');
const workspaceId = asWorkspaceId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79e2');
const operationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79e3';
const attemptId = 'a'.repeat(43);

describe('connector setup outcome telemetry', () => {
  it('emits a single authoritative terminal result from the durable OAuth attempt', async () => {
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
    `);
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: database });
    workspace.objectDatabase.exec(`
      INSERT INTO connector_oauth_attempts
        (id, region, provider, user_id, workspace_id, status, expires_at,
         created_at, updated_at, telemetry_operation_id)
      VALUES ('${attemptId}', 'global', 'linear', '${userId}', '${workspaceId}', 'pending',
              '2026-08-12T20:10:00.000Z', '2026-08-12T20:00:00.000Z',
              '2026-08-12T20:00:00.000Z', '${operationId}');
    `);
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', APP_ENV: 'production', APP_VERSION: '1.96.0',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, [
        'finishConnectorOAuthAttempt', 'connectorOAuthAttempt',
      ]),
    });
    const auth: AuthContext = {
      sessionId: 'session', userId, workspaceId, region: 'global', role: 'owner',
    };
    const service = new ConnectionService(env, auth) as unknown as {
      finishOAuthAttempt(
        workspaceId: string,
        id: string,
        status: 'denied',
        result: { errorCode: string },
      ): Promise<void>;
    };

    await service.finishOAuthAttempt(workspaceId, attemptId, 'denied', { errorCode: 'oauth_denied' });
    await service.finishOAuthAttempt(workspaceId, attemptId, 'denied', { errorCode: 'oauth_denied' });

    const rows = database.prepare(
      'SELECT envelope_json FROM telemetry_accepted_events WHERE event_id = ?',
    ).all(operationId) as Array<{ envelope_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.envelope_json)).toMatchObject({
      name: 'connector_setup_completed',
      context: { operationId },
      properties: { connector: 'linear', result: 'denied' },
    });
    database.close();
    vi.useRealTimers();
  });

  it('emits only the correlated rich outcome for a version-two OAuth attempt', async () => {
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
    `);
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: database });
    workspace.objectDatabase.exec(`
      INSERT INTO connector_oauth_attempts
        (id, region, provider, user_id, workspace_id, status, expires_at,
         created_at, updated_at, telemetry_operation_id, telemetry_event_version,
         telemetry_scope, telemetry_capability_count, telemetry_reconnect)
      VALUES ('${attemptId}', 'global', 'linear', '${userId}', '${workspaceId}', 'pending',
              '2026-08-12T20:10:00.000Z', '2026-08-12T20:00:00.000Z',
              '2026-08-12T20:00:00.000Z', '${operationId}', 2, 'personal', 3, 1);
    `);
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', APP_ENV: 'production', APP_VERSION: '1.96.0',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, [
        'finishConnectorOAuthAttempt', 'connectorOAuthAttempt',
      ]),
    });
    const auth: AuthContext = {
      sessionId: 'session', userId, workspaceId, region: 'global', role: 'owner',
    };
    const service = new ConnectionService(env, auth) as unknown as {
      finishOAuthAttempt(
        workspaceId: string,
        id: string,
        status: 'denied',
        result: { errorCode: string },
      ): Promise<void>;
    };

    await service.finishOAuthAttempt(workspaceId, attemptId, 'denied', { errorCode: 'oauth_denied' });
    await service.finishOAuthAttempt(workspaceId, attemptId, 'denied', { errorCode: 'oauth_denied' });

    const rows = database.prepare(
      'SELECT envelope_json FROM telemetry_accepted_events WHERE event_id = ?',
    ).all(operationId) as Array<{ envelope_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.envelope_json)).toMatchObject({
      name: 'connector_setup_completed_v2',
      context: { operationId },
      properties: {
        connector: 'linear', scope: 'personal', method: 'oauth', result: 'denied',
        duration: '5s_30s', capabilityCount: 'two_to_five', reconnect: true,
      },
    });
    database.close();
    vi.useRealTimers();
  });
});

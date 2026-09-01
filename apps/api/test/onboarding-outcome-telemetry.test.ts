import { asUserId } from "@rally/contracts";
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { HonoAppEnv, IdentityAuthContext } from '../src/env';
import { ApiError } from '../src/lib/api-error';
import { onboardingRoutes } from '../src/routes/onboarding';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const userId = asUserId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1');
const operationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2';
const existingWorkspaceId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3';
const auth: IdentityAuthContext = {
  sessionId: 'identity-session',
  userId,
  workspaceId: null,
  region: 'global',
  role: null,
};

describe('authoritative onboarding outcome telemetry', () => {
  it('emits a bounded failure outcome when a valid workspace creation operation conflicts', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES (?, 'subject', 'member@example.com', 'Member', ?, ?)
    `).run(userId, '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
    database.prepare(`
      INSERT INTO workspaces
        (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
      VALUES (?, 'Existing', 'existing', 'global', 'UTC', ?, ?, ?)
    `).run(existingWorkspaceId, userId, '2026-08-12T20:00:00.000Z', '2026-08-12T20:00:00.000Z');
    database.prepare(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES (?, ?, 'owner', 'active', ?)
    `).run(existingWorkspaceId, userId, '2026-08-12T20:00:00.000Z');
    database.prepare(`
      INSERT INTO platform_workspace_operations
        (operation_id, platform_user_id, action, request_fingerprint, region,
         workspace_id, placement_affinity, invitation_id, status, created_at, updated_at)
      VALUES (?, ?, 'create', 'another-request', 'global', ?, 'wnam', NULL, 'pending', ?, ?)
    `).run(
      operationId,
      userId,
      existingWorkspaceId,
      '2026-08-12T20:00:00.000Z',
      '2026-08-12T20:00:00.000Z',
    );
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
    app.route('/', onboardingRoutes);
    app.onError((error, c) => c.json({
      error: error instanceof ApiError ? error.code : error.message,
    }, error instanceof ApiError ? error.status : 500));
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: 'global',
      APP_ENV: 'production',
      APP_VERSION: '1.96.0',
      BUILD_SHA: 'build-1',
      EU_IDENTITY_BRIDGE: {
        discover: async () => ({
          ok: true,
          value: { region: 'eu', workspaces: [], invitations: [] },
        }),
      },
    });

    const response = await app.request('/workspace', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rally-operation-id': operationId,
      },
      body: JSON.stringify({ name: 'Research', region: 'global' }),
    }, env);

    expect(response.status, await response.clone().text()).toBe(409);
    await vi.waitFor(() => {
      const row = database.prepare(
        'SELECT envelope_json FROM telemetry_accepted_events WHERE event_id = ?',
      ).get(operationId) as { envelope_json: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.envelope_json)).toMatchObject({
        name: 'workspace_create_completed',
        identityScope: 'platform-user',
        context: { operationId, region: 'global' },
        properties: { selectedRegion: 'global', result: 'conflict' },
      });
    });
    database.close();
  });
});

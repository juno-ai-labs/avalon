import { describe, expect, it } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { TelemetryEnvelope } from '@rally/contracts/telemetry';
import { acceptAuthenticatedTelemetry } from '../src/telemetry/authenticated';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedObservabilityFixture, sqliteD1 } from './helpers/sqlite-d1';

const userId = '00000000-0000-7000-8000-0000000000e1';
const workspaceId = '00000000-0000-7000-8000-0000000000e2';

function fixture(surrogates: { person: string | null; workspace: string | null }) {
  const database = migratedObservabilityFixture();
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, analytics_person_id, created_at, updated_at)
     VALUES (?, 'google-e1', 'user@example.com', 'User', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  ).run(userId, surrogates.person);
  database.prepare(
    `INSERT INTO workspaces
       (id, name, slug, region, created_by_user_id, analytics_workspace_id, created_at, updated_at)
     VALUES (?, 'Workspace', 'workspace', 'global', ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  ).run(workspaceId, userId, surrogates.workspace);
  const env = createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database) });
  return { database, env };
}

function event(eventId: string): TelemetryEnvelope {
  return {
    schema: 'ai.rallywith.telemetry.event', schemaVersion: 1, eventId,
    name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
    identityScope: 'workspace-user', originalTimestamp: '2026-08-12T20:00:00.000Z',
    sentAt: '2026-08-12T20:00:00.000Z',
    context: { environment: 'production', release: '1.0.0', buildId: 'build', region: 'global' },
    properties: { screen: 'workspace_home' },
  } as TelemetryEnvelope;
}

function stored(database: ReturnType<typeof migratedObservabilityFixture>, eventId: string) {
  return database.prepare(
    'SELECT analytics_subject_id, workspace_analytics_id FROM telemetry_accepted_events WHERE event_id = ?',
  ).get(eventId);
}

describe('authenticated telemetry analytics surrogates', () => {
  it('accepts a batch on the surrogates the session already read, without writing users or workspaces', async () => {
    const { database, env } = fixture({ person: 'person-surrogate', workspace: 'workspace-surrogate' });
    // A D1 primary that cannot write these rows, as a transient D1 internal
    // error did in production: a batch whose surrogates are known must not
    // depend on a write it does not need.
    database.exec(`
      CREATE TRIGGER users_unwritable BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'internal error'); END;
      CREATE TRIGGER workspaces_unwritable BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'internal error'); END;
    `);
    const eventId = '018f22f2-4c22-7abc-8def-0123456789c1';

    const results = await acceptAuthenticatedTelemetry(env, {
      sessionId: 'session', userId: asUserId(userId), workspaceId: asWorkspaceId(workspaceId),
      region: 'global', role: 'owner',
      analyticsPersonId: 'person-surrogate', analyticsWorkspaceId: 'workspace-surrogate',
    }, { events: [event(eventId)] });

    expect(results).toEqual([{ result: 'accepted', eventId }]);
    expect(stored(database, eventId)).toEqual({
      analytics_subject_id: 'person-surrogate', workspace_analytics_id: 'workspace-surrogate',
    });
  });

  it('mints the surrogates when the session carried none', async () => {
    const { database, env } = fixture({ person: null, workspace: null });
    const eventId = '018f22f2-4c22-7abc-8def-0123456789c2';

    const results = await acceptAuthenticatedTelemetry(env, {
      sessionId: 'session', userId: asUserId(userId), workspaceId: asWorkspaceId(workspaceId),
      region: 'global', role: 'owner', analyticsPersonId: null, analyticsWorkspaceId: null,
    }, { events: [event(eventId)] });

    expect(results).toEqual([{ result: 'accepted', eventId }]);
    const minted = database.prepare(
      `SELECT u.analytics_person_id AS person, w.analytics_workspace_id AS workspace
       FROM users u, workspaces w WHERE u.id = ? AND w.id = ?`,
    ).get(userId, workspaceId) as { person: string | null; workspace: string | null };
    expect(minted.person).toMatch(/^[0-9a-f-]{36}$/u);
    expect(minted.workspace).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stored(database, eventId)).toEqual({
      analytics_subject_id: minted.person, workspace_analytics_id: minted.workspace,
    });
  });
});

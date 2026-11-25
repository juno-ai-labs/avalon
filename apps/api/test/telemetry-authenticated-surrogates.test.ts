import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { TelemetryEnvelope } from '@rally/contracts/telemetry';
import { acceptAuthenticatedTelemetry } from '../src/telemetry/authenticated';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedObservabilityFixture, sqliteD1 } from './helpers/sqlite-d1';

const userId = '00000000-0000-7000-8000-0000000000e1';
const workspaceId = '00000000-0000-7000-8000-0000000000e2';
const opened: DatabaseSync[] = [];

afterEach(() => { opened.splice(0).forEach((database) => database.close()); });

function fixture(surrogates: { person: string | null; workspace: string | null }) {
  const database = migratedObservabilityFixture();
  opened.push(database);
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

// A D1 primary that cannot write the row, as a transient D1 internal error did
// in production. The trigger fires even on a no-op `COALESCE` update.
function makeUnwritable(database: DatabaseSync, table: 'users' | 'workspaces') {
  database.exec(
    `CREATE TRIGGER ${table}_unwritable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'internal error'); END;`,
  );
}

function auth(surrogates: { person: string | null; workspace: string | null }) {
  return {
    sessionId: 'session', userId: asUserId(userId), workspaceId: asWorkspaceId(workspaceId),
    region: 'global' as const, role: 'owner' as const,
    analyticsPersonId: surrogates.person, analyticsWorkspaceId: surrogates.workspace,
  };
}

function event(eventId: string): TelemetryEnvelope {
  return {
    schema: 'ai.rallywith.telemetry.event', schemaVersion: 1, eventId,
    name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
    identityScope: 'workspace-user', originalTimestamp: '2026-08-12T20:00:00.000Z',
    sentAt: '2026-08-12T20:00:00.000Z',
    context: { environment: 'production', release: '1.0.0', buildId: 'build', region: 'global' },
    properties: { screen: 'workspace_home' },
  };
}

function stored(database: DatabaseSync, eventId: string) {
  return database.prepare(
    'SELECT analytics_subject_id, workspace_analytics_id FROM telemetry_accepted_events WHERE event_id = ?',
  ).get(eventId);
}

function personProfileDestination(database: DatabaseSync) {
  return (database.prepare(
    "SELECT destination_analytics_id FROM telemetry_profile_jobs WHERE job_kind = 'person_profile'",
  ).get() as { destination_analytics_id: string } | undefined)?.destination_analytics_id;
}

function minted(database: DatabaseSync) {
  return database.prepare(
    `SELECT u.analytics_person_id AS person, w.analytics_workspace_id AS workspace
     FROM users u, workspaces w WHERE u.id = ? AND w.id = ?`,
  ).get(userId, workspaceId) as { person: string | null; workspace: string | null };
}

describe('authenticated telemetry analytics surrogates', () => {
  it('accepts a batch on the surrogates the session read, without reading or writing them again', async () => {
    // The database and the session hold different values only so the assertion
    // can tell which one ingest used; in production they are the same value.
    const { database, env } = fixture({ person: 'person-in-db', workspace: 'workspace-in-db' });
    makeUnwritable(database, 'users');
    makeUnwritable(database, 'workspaces');
    const eventId = '018f22f2-4c22-7abc-8def-0123456789c1';

    const results = await acceptAuthenticatedTelemetry(
      env, auth({ person: 'person-from-session', workspace: 'workspace-from-session' }), { events: [event(eventId)] },
    );

    expect(results).toEqual([{ result: 'accepted', eventId }]);
    expect(stored(database, eventId)).toEqual({
      analytics_subject_id: 'person-from-session', workspace_analytics_id: 'workspace-from-session',
    });
    expect(personProfileDestination(database)).toBe('person-from-session');
  });

  it('mints only the surrogate the session did not carry', async () => {
    const { database, env } = fixture({ person: 'person-in-db', workspace: null });
    makeUnwritable(database, 'users');
    const eventId = '018f22f2-4c22-7abc-8def-0123456789c3';

    const results = await acceptAuthenticatedTelemetry(
      env, auth({ person: 'person-in-db', workspace: null }), { events: [event(eventId)] },
    );

    expect(results).toEqual([{ result: 'accepted', eventId }]);
    const { workspace } = minted(database);
    expect(workspace).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stored(database, eventId)).toEqual({
      analytics_subject_id: 'person-in-db', workspace_analytics_id: workspace,
    });
  });

  it('mints both surrogates when the session carried none', async () => {
    const { database, env } = fixture({ person: null, workspace: null });
    const eventId = '018f22f2-4c22-7abc-8def-0123456789c2';

    const results = await acceptAuthenticatedTelemetry(
      env, auth({ person: null, workspace: null }), { events: [event(eventId)] },
    );

    expect(results).toEqual([{ result: 'accepted', eventId }]);
    const { person, workspace } = minted(database);
    expect(person).toMatch(/^[0-9a-f-]{36}$/u);
    expect(workspace).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stored(database, eventId)).toEqual({ analytics_subject_id: person, workspace_analytics_id: workspace });
    expect(personProfileDestination(database)).toBe(person);
  });
});

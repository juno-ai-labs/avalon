import { asUserId } from "@rally/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBootstrapService } from '../src/telemetry/bootstrap';
import { linkAnonymousTelemetry } from '../src/telemetry/identity-link';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const anonymousEpochId = '018f22f2-4c22-7abc-8def-0123456789ab';

function seedUser(database: ReturnType<typeof migratedSqliteDatabase>): void {
  database.prepare(`INSERT INTO users
    (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled)
    VALUES ('00000000-0000-4000-8000-000000000001', 'google-1', 'user@example.com', 'Ada User', ?, ?, 1)`)
    .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
}

describe('anonymous telemetry identity linking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('links a Global epoch exactly once and preserves the transition job with contact properties', async () => {
    const database = migratedSqliteDatabase();
    seedUser(database);
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', SESSION_SIGNING_KEY: 'shared-test-key',
    });
    const bootstrapService = new TelemetryBootstrapService(env);
    const capability = (await bootstrapService.bootstrap(anonymousEpochId, 'US')).capability;
    const auth = { userId: asUserId('00000000-0000-4000-8000-000000000001'), workspaceId: null, region: 'global' as const };
    await expect(linkAnonymousTelemetry(env, auth, capability)).resolves.toMatchObject({ result: 'linked' });
    await expect(linkAnonymousTelemetry(env, auth, capability)).resolves.toMatchObject({ result: 'duplicate' });
    await expect(bootstrapService.bootstrap(anonymousEpochId, 'US')).rejects.toThrow('telemetry_journey_closed');

    expect(database.prepare('SELECT anonymous_epoch_id, route FROM telemetry_identity_links').all()).toEqual([
      { anonymous_epoch_id: anonymousEpochId, route: 'global' },
    ]);
    const jobs = database.prepare(`SELECT job_kind, anonymous_epoch_id, properties_json, state
      FROM telemetry_profile_jobs`).all() as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job_kind: 'epoch_transition', anonymous_epoch_id: anonymousEpochId, state: 'pending' });
    expect(JSON.parse(String(jobs[0]?.properties_json))).toEqual({ email: 'user@example.com', name: 'Ada User' });
    database.close();
  });

  it('links an EU epoch through the narrow Global control RPC without sharing its signing key', async () => {
    const globalDatabase = migratedSqliteDatabase();
    const globalEnv = createTestEnv({
      DB: sqliteD1(globalDatabase), AVALON_REGION: 'global', SESSION_SIGNING_KEY: 'global-session-key',
      TELEMETRY_CAPABILITY_SIGNING_KEY: 'shared-telemetry-key',
    });
    const capability = (await new TelemetryBootstrapService(globalEnv).bootstrap(anonymousEpochId, 'DE')).capability;

    const euDatabase = migratedSqliteDatabase();
    seedUser(euDatabase);
    const euEnv = createTestEnv({
      DB: sqliteD1(euDatabase), AVALON_REGION: 'eu', SESSION_SIGNING_KEY: 'eu-session-key',
      GLOBAL_TELEMETRY_CONTROL: {
        authorizeJourneyLink: (input: { capability: string; expectedRoute: 'eu' }) =>
          new TelemetryBootstrapService(globalEnv).authorizeLink(input.capability, input.expectedRoute),
        closeJourney: (input: { capability: string; expectedRoute: 'eu' }) =>
          new TelemetryBootstrapService(globalEnv).closeJourney(input.capability, input.expectedRoute),
      },
    });
    await expect(linkAnonymousTelemetry(euEnv, {
      userId: asUserId('00000000-0000-4000-8000-000000000001'), workspaceId: null, region: 'eu',
    }, capability)).resolves.toMatchObject({ result: 'linked' });
    expect(euDatabase.prepare('SELECT route FROM telemetry_identity_links').get()).toEqual({ route: 'eu' });
    expect(euDatabase.prepare('SELECT COUNT(*) AS count FROM telemetry_profile_jobs').get()).toEqual({ count: 0 });
    expect(globalDatabase.prepare(
      'SELECT closed_at IS NOT NULL AS closed FROM telemetry_onboarding_journeys',
    ).get()).toEqual({ closed: 1 });
    globalDatabase.close();
    euDatabase.close();
  });
});

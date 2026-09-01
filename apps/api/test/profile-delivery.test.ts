import { asUserId } from "@rally/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBootstrapService } from '../src/telemetry/bootstrap';
import { linkAnonymousTelemetry } from '../src/telemetry/identity-link';
import { processProfileOutbox } from '../src/telemetry/profile-delivery';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

describe('PostHog profile job delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('has no destination path in EU', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_profile_jobs
      (id, subject_user_id, job_kind, destination_analytics_id, anonymous_epoch_id,
       properties_json, version, state, created_at, delete_at)
      VALUES ('job-eu-guard', NULL, 'person_profile', 'person-1', NULL,
              '{"name":"Ada"}', 1, 'pending', ?, ?)`)
      .run('2026-08-12T19:00:00.000Z', '2026-11-10T20:00:00.000Z');
    const deliverProfileBatch = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'eu',
      POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      TELEMETRY_DELIVERY: { deliverProfileBatch },
    });

    await expect(processProfileOutbox(env)).resolves.toEqual({
      selected: 0, delivered: 0, retried: 0, terminal: 0, suppressed: 0,
    });
    expect(deliverProfileBatch).not.toHaveBeenCalled();
    expect(database.prepare('SELECT state FROM telemetry_profile_jobs').get())
      .toEqual({ state: 'pending' });
    database.close();
  });

  it('delivers the non-supersedable epoch transition exactly once before later person work', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled)
      VALUES ('00000000-0000-4000-8000-000000000001', 'google-1', 'ada@example.com', 'Ada', ?, ?, 1)`)
      .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    const deliverProfileBatch = vi.fn(async () => ({
      postHog: {
        result: 'delivered' as const,
        requestId: 'posthog-profile-request-1',
        retryAfterMs: null,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', SESSION_SIGNING_KEY: 'test-key',
      POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      TELEMETRY_DELIVERY: { deliverProfileBatch },
    });
    const capability = (await new TelemetryBootstrapService(env).bootstrap(
      '018f22f2-4c22-7abc-8def-0123456789ab', 'US',
    )).capability;
    await linkAnonymousTelemetry(env, { userId: asUserId('00000000-0000-4000-8000-000000000001'), workspaceId: null, region: 'global' }, capability);
    await expect(processProfileOutbox(env)).resolves.toEqual({ selected: 1, delivered: 1, retried: 0, terminal: 0, suppressed: 0 });
    expect(deliverProfileBatch).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        kind: 'epoch_transition',
        anonymousEpochId: '018f22f2-4c22-7abc-8def-0123456789ab',
        properties: { email: 'ada@example.com', name: 'Ada' },
      })],
    }));
    expect(database.prepare('SELECT state FROM telemetry_profile_jobs').get()).toEqual({ state: 'acknowledged' });
    await processProfileOutbox(env);
    expect(deliverProfileBatch).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('suppresses pending identifiable profile work after opt-out', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled, analytics_person_id)
      VALUES ('00000000-0000-4000-8000-000000000001', 'google-1', 'ada@example.com', 'Ada', ?, ?, 0, 'person-1')`)
      .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    database.prepare(`INSERT INTO telemetry_profile_jobs
      (id, subject_user_id, job_kind, destination_analytics_id, anonymous_epoch_id,
       properties_json, version, state, created_at, delete_at)
      VALUES ('job-1', '00000000-0000-4000-8000-000000000001', 'person_profile', 'person-1', NULL, '{}', 1, 'pending', ?, ?)`)
      .run('2026-08-12T20:00:00.000Z', '2026-11-10T20:00:00.000Z');
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      TELEMETRY_DELIVERY: { deliverProfileBatch: vi.fn() },
    });
    await expect(processProfileOutbox(env)).resolves.toMatchObject({ suppressed: 1 });
    expect(database.prepare('SELECT state FROM telemetry_profile_jobs').get()).toEqual({ state: 'suppressed' });
    database.close();
  });

  it('translates profile RPC transport rejection into durable retry', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_profile_jobs
      (id, subject_user_id, job_kind, destination_analytics_id, anonymous_epoch_id,
       properties_json, version, state, created_at, delete_at)
      VALUES ('job-rpc-retry', NULL, 'person_profile', 'person-1', NULL,
              '{"name":"Ada"}', 1, 'pending', ?, ?)`)
      .run('2026-08-12T19:00:00.000Z', '2026-11-10T20:00:00.000Z');
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      TELEMETRY_DELIVERY: {
        deliverProfileBatch: vi.fn(async () => { throw new Error('posthog_rpc_unavailable'); }),
      },
    });

    await expect(processProfileOutbox(env)).resolves.toMatchObject({ retried: 1 });
    expect(database.prepare(`
      SELECT state, attempt_count, next_attempt_at FROM telemetry_profile_jobs
    `).get()).toEqual({
      state: 'pending',
      attempt_count: 1,
      next_attempt_at: '2026-08-12T20:01:00.000Z',
    });
    database.close();
  });

  it('marks malformed or empty profile jobs terminal without blocking later valid work', async () => {
    const database = migratedSqliteDatabase();
    const insert = database.prepare(`INSERT INTO telemetry_profile_jobs
      (id, subject_user_id, job_kind, destination_analytics_id, anonymous_epoch_id,
       properties_json, version, state, created_at, delete_at)
      VALUES (?, NULL, 'person_profile', ?, NULL, ?, 1, 'pending', ?, ?)`);
    const deleteAt = '2026-11-10T20:00:00.000Z';
    insert.run('job-malformed', 'person-malformed', '{', '2026-08-12T19:00:00.000Z', deleteAt);
    insert.run('job-empty', 'person-empty', '{}', '2026-08-12T19:01:00.000Z', deleteAt);
    insert.run(
      'job-valid',
      'person-valid',
      JSON.stringify({ name: 'Valid user' }),
      '2026-08-12T19:02:00.000Z',
      deleteAt,
    );
    const deliverProfileBatch = vi.fn(async () => ({
      postHog: {
        result: 'delivered' as const,
        requestId: 'posthog-profile-request-2',
        retryAfterMs: null,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      TELEMETRY_DELIVERY: { deliverProfileBatch },
    });

    await expect(processProfileOutbox(env)).resolves.toEqual({
      selected: 3, delivered: 1, retried: 0, terminal: 2, suppressed: 0,
    });
    expect(database.prepare('SELECT id, state, attempt_count FROM telemetry_profile_jobs ORDER BY id').all())
      .toEqual([
        { id: 'job-empty', state: 'terminal', attempt_count: 1 },
        { id: 'job-malformed', state: 'terminal', attempt_count: 1 },
        { id: 'job-valid', state: 'acknowledged', attempt_count: 1 },
      ]);
    expect(deliverProfileBatch).toHaveBeenCalledTimes(1);
    expect(deliverProfileBatch).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        kind: 'person_profile',
        destinationAnalyticsId: 'person-valid',
        properties: { name: 'Valid user' },
      })],
    }));
    database.close();
  });
});

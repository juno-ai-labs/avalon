import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  queryEuCrashFreeLaunches,
  queryEuCrashIssues,
  readRawCrashForSupport,
} from '../src/telemetry/crash-operations';
import { createCloudflareTestBinding, createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

describe('regional crash operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('groups only surviving EU fingerprint contributions at query time', async () => {
    const database = migratedSqliteDatabase();
    database.exec(`
      INSERT INTO telemetry_eu_crash_contributions
        (occurrence_id, fingerprint, occurred_at, release, build_id, platform, architecture,
         process_role, channel, launch_id, delete_at)
      VALUES
        ('one', '${'a'.repeat(64)}', '2026-08-10T00:00:00Z', '1.0.0', 'build-1',
         'darwin', 'arm64', 'renderer', 'stable', 'launch-one', '2027-09-10T00:00:00Z'),
        ('two', '${'a'.repeat(64)}', '2026-08-11T00:00:00Z', '1.1.0', 'build-2',
         'darwin', 'arm64', 'renderer', 'stable', 'launch-two', '2027-09-11T00:00:00Z'),
        ('expired', '${'b'.repeat(64)}', '2025-01-01T00:00:00Z', '0.1.0', 'build-old',
         'darwin', 'arm64', 'renderer', 'stable', 'launch-old', '2026-08-01T00:00:00Z');
    `);
    await expect(queryEuCrashIssues(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'eu',
    }), { limit: 10 })).resolves.toEqual([{
      fingerprint: 'a'.repeat(64),
      firstSeen: '2026-08-10T00:00:00Z',
      lastSeen: '2026-08-11T00:00:00Z',
      count: 2,
      releases: ['1.0.0', '1.1.0'],
    }]);
    database.close();
  });

  it('computes an honest EU crash-free denominator from continuously eligible launches', async () => {
    const database = migratedSqliteDatabase();
    const launches = [
      ['launch-crashed', true],
      ['launch-free', true],
      ['launch-ineligible', false],
    ] as const;
    for (const [launchId, eligible] of launches) {
      database.prepare(`INSERT INTO telemetry_eu_events
        (event_id, event_name, schema_version, identity_scope, analytics_subject_id,
         normalized_timestamp, environment, release, build_id, platform, architecture,
         channel, launch_id, properties_json, delete_at)
        VALUES (?, 'application_lifecycle', 1, 'installation', ?, ?, 'production',
                '1.0.0', 'build-1', 'darwin', 'arm64', 'stable', ?, ?, ?)`)
        .run(
          `event-${launchId}`,
          `installation-${launchId}`,
          '2026-08-12T19:00:00.000Z',
          launchId,
          JSON.stringify({ state: 'launch_started', crashReportingEligible: eligible }),
          '2026-11-10T19:00:00.000Z',
        );
    }
    const insertCrash = database.prepare(`INSERT INTO telemetry_eu_crash_contributions
      (occurrence_id, fingerprint, occurred_at, release, build_id, platform, architecture,
       process_role, channel, launch_id, delete_at)
      VALUES (?, ?, ?, '1.0.0', 'build-1', 'darwin', 'arm64', 'renderer', 'stable', ?, ?)`);
    insertCrash.run(
      'crash-matched', 'a'.repeat(64), '2026-08-12T19:30:00.000Z',
      'launch-crashed', '2027-09-12T19:30:00.000Z',
    );
    insertCrash.run(
      'crash-uncorrelated', 'b'.repeat(64), '2026-08-12T19:40:00.000Z',
      'launch-unknown', '2027-09-12T19:40:00.000Z',
    );

    await expect(queryEuCrashFreeLaunches(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'eu',
    }), {
      from: '2026-08-12T00:00:00.000Z',
      to: '2026-08-13T00:00:00.000Z',
    })).resolves.toEqual([{
      release: '1.0.0',
      platform: 'darwin',
      architecture: 'arm64',
      channel: 'stable',
      eligibleLaunches: 2,
      crashedLaunches: 1,
      crashFreeLaunches: 1,
      uncorrelatedCrashes: 1,
    }]);
    database.close();
  });

  it('audits an authorized raw lookup without exposing an object key', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_crash_reports
      (crash_id, upload_id, installation_analytics_id, route, object_key, byte_size,
       content_sha256, release, build_id, platform, architecture, process_role,
       launch_id, channel, received_at, delete_at)
      VALUES (?, ?, ?, 'global', ?, 4, ?, '1.0.0', 'build', 'darwin', 'arm64', 'main', ?, 'stable', ?, ?)`).run(
      '018f22f2-4c22-7abc-8def-0123456789ab',
      '018f22f2-4c22-7abc-8def-0123456789ac',
      '018f22f2-4c22-7abc-8def-0123456789ad',
      'telemetry/crashes/global/opaque.dmp', 'hash',
      '018f22f2-4c22-7abc-8def-0123456789af',
      '2026-08-12T19:00:00Z', '2026-11-10T19:00:00Z',
    );
    const get = vi.fn(async () => ({ arrayBuffer: async () => new TextEncoder().encode('MDMP').buffer }));
    const result = await readRawCrashForSupport(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
    }), {
      crashId: '018f22f2-4c22-7abc-8def-0123456789ab',
      reason: 'customer_support',
    }, {
      operatorId: '018f22f2-4c22-7abc-8def-0123456789ae',
      role: 'support',
    });
    expect(await result?.arrayBuffer()).toEqual(new TextEncoder().encode('MDMP').buffer);
    expect(database.prepare(`SELECT operator_id, reason_code, result_code, delete_at
      FROM telemetry_crash_access_audit`).get()).toEqual({
      operator_id: '018f22f2-4c22-7abc-8def-0123456789ae',
      reason_code: 'customer_support', result_code: 'found',
      delete_at: '2026-11-10T20:00:00.000Z',
    });
    expect(JSON.stringify(database.prepare('SELECT * FROM telemetry_crash_access_audit').get()))
      .not.toContain('telemetry/crashes');
    database.close();
  });

  it('rejects raw lookup for roles outside support and security before touching storage', async () => {
    const get = vi.fn();
    await expect(readRawCrashForSupport(createTestEnv({
      AVALON_REGION: 'global',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
    }), {
      crashId: '018f22f2-4c22-7abc-8def-0123456789ab',
      reason: 'customer_support',
    }, {
      operatorId: '018f22f2-4c22-7abc-8def-0123456789ae',
      // @ts-expect-error Exercise the runtime boundary against an untrusted role.
      role: 'analyst',
    })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});

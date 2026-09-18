import "../../../tests/isolated-region";
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
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

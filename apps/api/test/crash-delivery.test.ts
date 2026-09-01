import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashIngestService } from '../src/telemetry/crash-ingest';
import { processPendingCrashReports } from '../src/telemetry/crash-processing';
import {
  processCrashOutbox,
  reapExpiredCrashReports,
  reapExpiredOrphanedCrashObjects,
} from '../src/telemetry/crash-delivery';
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from './helpers/cloudflare-test';
import type { CrashSymbolicatorContainer } from '../src/crash-symbolicator-container';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

describe('Global native crash delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends the complete sanitized report to PostHog and marks it delivered', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled)
      VALUES ('user-1', 'google-1', 'user@example.com', 'User', ?, ?, 1)`)
      .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    const objects = new Map<string, Uint8Array>();
    objects.set('telemetry/symbols/1.96.0/build-123/darwin/arm64.tar', new Uint8Array([1]));
    const bucket = createCloudflareTestBinding<R2Bucket>({
      put: vi.fn(async (key: string, value: Uint8Array) => { objects.set(key, value); }),
      get: vi.fn(async (key: string) => {
        const value = objects.get(key);
        return value ? { arrayBuffer: async () => value.buffer.slice(0) } : null;
      }),
      delete: vi.fn(async (key: string) => { objects.delete(key); }),
    });
    const report = { status: 'ok', crash_info: { type: 'EXC_BAD_ACCESS' }, threads: [{ frames: [{ function: 'main' }] }] };
    const sendCrashBatch = vi.fn(async () => ({
      result: 'delivered' as const,
      requestId: 'posthog-crash-request-1',
      retryAfterMs: null,
    }));
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', TELEMETRY_PAYLOADS: bucket,
      POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      POSTHOG_DELIVERY: { sendCrashBatch },
      CRASH_SYMBOLICATOR: createCloudflareTestBinding<DurableObjectNamespace<CrashSymbolicatorContainer>>({
        idFromName: () => createTestDurableObjectId('crash-symbolicator'),
        get: () => ({
          symbolicate: vi.fn(async () => ({
            parserState: 'symbolicated' as const,
            reportJson: JSON.stringify(report),
          })),
        }),
      }),
    });
    const dump = new Uint8Array(32);
    dump.set(new TextEncoder().encode('MDMP'));
    await new CrashIngestService(env).accept({
      uploadId: '018f22f2-4c22-7abc-8def-0123456789ab',
      installationId: '018f22f2-4c22-7abc-8def-0123456789ac',
      route: 'global', release: '1.96.0', buildId: 'build-123', platform: 'darwin',
      architecture: 'arm64', processRole: 'renderer',
      launchId: '018f22f2-4c22-7abc-8def-0123456789ad', channel: 'stable',
      dump, subjectUserId: 'user-1', rateLimitSubject: 'user-1',
    });
    await processPendingCrashReports(env);

    await expect(processCrashOutbox(env)).resolves.toEqual({ selected: 1, delivered: 1, retried: 0, terminal: 0, suppressed: 0 });
    expect(sendCrashBatch).toHaveBeenCalledWith(expect.objectContaining({
      host: 'https://us.i.posthog.com',
      projectToken: 'phc_test',
      rows: [expect.objectContaining({
        processPersonProfile: true,
        launchId: '018f22f2-4c22-7abc-8def-0123456789ad',
        channel: 'stable',
        report: expect.objectContaining({
          status: 'symbolicated',
          crash_type: 'EXC_BAD_ACCESS',
          mechanism: 'minidump',
          handled: false,
          process_role: 'renderer',
        }),
      })],
    }));
    expect(database.prepare('SELECT destination_state FROM telemetry_crash_reports').get())
      .toEqual({ destination_state: 'delivered' });
    database.close();
  });

  it('has no destination path in EU', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_crash_reports
      (crash_id, upload_id, installation_analytics_id, route, object_key, byte_size,
       content_sha256, release, build_id, platform, architecture, process_role,
       launch_id, channel, parser_state, structured_report_json, issue_fingerprint,
       destination_state, received_at, delete_at)
      VALUES ('crash-eu-guard', 'upload-eu-guard', 'installation-1', 'global',
              'telemetry/crashes/global/eu-guard.dmp', 4, 'hash', '1.235.0',
              'build-test', 'darwin', 'arm64', 'renderer', 'launch-1', 'stable',
              'symbolicated', '{"status":"symbolicated"}', 'fingerprint-1',
              'pending', ?, ?)`)
      .run('2026-08-12T19:00:00.000Z', '2026-11-10T20:00:00.000Z');
    const sendCrashBatch = vi.fn();
    await expect(processCrashOutbox(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'eu',
      POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      POSTHOG_DELIVERY: { sendCrashBatch },
    }))).resolves.toEqual({ selected: 0, delivered: 0, retried: 0, terminal: 0, suppressed: 0 });
    expect(sendCrashBatch).not.toHaveBeenCalled();
    expect(database.prepare('SELECT destination_state FROM telemetry_crash_reports').get())
      .toEqual({ destination_state: 'pending' });
    database.close();
  });

  it('translates crash RPC transport rejection into durable retry', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_crash_reports
      (crash_id, upload_id, installation_analytics_id, route, object_key, byte_size,
       content_sha256, release, build_id, platform, architecture, process_role,
       launch_id, channel, parser_state, structured_report_json, issue_fingerprint,
       destination_state, received_at, delete_at)
      VALUES ('crash-rpc-retry', 'upload-rpc-retry', 'installation-1', 'global',
              'telemetry/crashes/global/rpc-retry.dmp', 4, 'hash', '1.235.0',
              'build-test', 'darwin', 'arm64', 'renderer', 'launch-1', 'stable',
              'symbolicated', '{"status":"symbolicated"}', 'fingerprint-1',
              'pending', ?, ?)`)
      .run('2026-08-12T19:00:00.000Z', '2026-11-10T20:00:00.000Z');
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_PROJECT_TOKEN: 'phc_test',
      POSTHOG_DELIVERY: {
        sendCrashBatch: vi.fn(async () => { throw new Error('posthog_rpc_unavailable'); }),
      },
    });

    await expect(processCrashOutbox(env)).resolves.toMatchObject({ retried: 1 });
    expect(database.prepare(`SELECT destination_state, destination_attempt_count,
      destination_next_attempt_at FROM telemetry_crash_reports`).get()).toEqual({
      destination_state: 'retrying',
      destination_attempt_count: 1,
      destination_next_attempt_at: '2026-08-12T20:01:00.000Z',
    });
    database.close();
  });

  it('reaps raw crash objects by their immutable deadline even without a D1 index row', async () => {
    const database = migratedSqliteDatabase();
    const deleteObject = vi.fn(async () => undefined);
    const list = vi.fn()
      .mockResolvedValueOnce({
        objects: [
          {
            key: 'telemetry/crashes/global/orphan-expired.dmp',
            customMetadata: { deleteAfter: '2026-08-12T19:59:59.000Z' },
          },
          {
            key: 'telemetry/crashes/global/orphan-live.dmp',
            customMetadata: { deleteAfter: '2026-11-10T20:00:00.000Z' },
          },
        ],
        truncated: true,
        cursor: 'second-page',
      })
      .mockResolvedValueOnce({
        objects: [{
          key: 'telemetry/crashes/global/orphan-without-deadline.dmp',
          customMetadata: {},
        }],
        truncated: false,
      });
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: 'global',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        list,
        delete: deleteObject,
      }),
    });

    await expect(reapExpiredOrphanedCrashObjects(env)).resolves.toBe(2);
    expect(list.mock.calls).toEqual([[{
      prefix: 'telemetry/crashes/global/',
      limit: 100,
      include: ['customMetadata'],
    }], [{
      prefix: 'telemetry/crashes/global/',
      limit: 100,
      include: ['customMetadata'],
      cursor: 'second-page',
    }]]);
    expect(deleteObject.mock.calls).toEqual([
      ['telemetry/crashes/global/orphan-expired.dmp'],
      ['telemetry/crashes/global/orphan-without-deadline.dmp'],
    ]);
    expect(database.prepare(
      `SELECT task, cursor FROM telemetry_maintenance_state`,
    ).get()).toEqual({ task: 'crash_object_retention', cursor: null });
    database.close();
  });

  it('drains more than one D1 batch of expired crash indexes in one bounded pass', async () => {
    const database = migratedSqliteDatabase();
    const insert = database.prepare(`INSERT INTO telemetry_crash_reports
      (crash_id, upload_id, installation_analytics_id, route, object_key, byte_size,
       content_sha256, release, build_id, platform, architecture, process_role,
       launch_id, channel, received_at, delete_at)
      VALUES (?, ?, ?, 'global', ?, 4, ?, '1.0.0', 'build', 'darwin', 'arm64',
              'renderer', ?, 'stable', ?, ?)`);
    for (let index = 0; index < 101; index += 1) {
      const id = index.toString().padStart(3, '0');
      insert.run(
        `crash-${id}`, `upload-${id}`, `installation-${id}`,
        `telemetry/crashes/global/${id}.dmp`, `hash-${id}`, `launch-${id}`,
        '2026-01-01T00:00:00.000Z', '2026-08-12T19:00:00.000Z',
      );
    }
    const deleteObject = vi.fn(async () => undefined);
    const env = createTestEnv({
      DB: sqliteD1(database),
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({ delete: deleteObject }),
    });

    await expect(reapExpiredCrashReports(env)).resolves.toBe(101);
    expect(deleteObject).toHaveBeenCalledTimes(101);
    expect(database.prepare('SELECT COUNT(*) AS count FROM telemetry_crash_reports').get())
      .toEqual({ count: 0 });
    database.close();
  });
});

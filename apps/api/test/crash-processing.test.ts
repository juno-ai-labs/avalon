import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashIngestService } from '../src/telemetry/crash-ingest';
import { processPendingCrashReports } from '../src/telemetry/crash-processing';
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from './helpers/cloudflare-test';
import type { CrashSymbolicatorContainer } from '../src/crash-symbolicator-container';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const metadata = {
  uploadId: '018f22f2-4c22-7abc-8def-0123456789ab',
  installationId: '018f22f2-4c22-7abc-8def-0123456789ac',
  route: 'global' as const,
  release: '1.96.0', buildId: 'build-123', platform: 'darwin' as const,
  architecture: 'arm64' as const, processRole: 'renderer' as const,
  launchId: '018f22f2-4c22-7abc-8def-0123456789ad', channel: 'stable' as const,
  rateLimitSubject: 'test-subject',
};

function dump(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode('MDMP'));
  return bytes;
}

function bucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    binding: createCloudflareTestBinding<R2Bucket>({
      put: vi.fn(async (key: string, value: Uint8Array) => { objects.set(key, value); }),
      get: vi.fn(async (key: string) => {
        const value = objects.get(key);
        return value ? { arrayBuffer: async () => value.buffer.slice(0) } : null;
      }),
      delete: vi.fn(async (key: string) => { objects.delete(key); }),
    }),
  };
}

describe('regional native crash processing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('symbolicates with private regional artifacts and stores one bounded full structured report', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled)
      VALUES ('user-1', 'google-1', 'user@example.com', 'User', ?, ?, 1)`)
      .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    const storage = bucket();
    storage.objects.set('telemetry/symbols/1.96.0/build-123/darwin/arm64.tar', new Uint8Array([1, 2, 3]));
    const symbolicate = vi.fn(async () => ({
      parserState: 'symbolicated' as const,
      reportJson: JSON.stringify({
        status: 'ok', crash_info: { type: 'EXC_BAD_ACCESS' }, threads: [{ frames: [{ function: 'main' }] }],
      }),
    }));
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', TELEMETRY_PAYLOADS: storage.binding,
      CRASH_SYMBOLICATOR: createCloudflareTestBinding<DurableObjectNamespace<CrashSymbolicatorContainer>>({
        idFromName: () => createTestDurableObjectId('crash-symbolicator'),
        get: () => ({ symbolicate }),
      }),
    });
    await new CrashIngestService(env).accept({
      ...metadata, dump: dump(), subjectUserId: 'user-1',
      breadcrumbs: {
        version: 1, launchId: metadata.uploadId, updatedAt: '2026-08-12T19:59:30.000Z',
        entries: [{ sequence: 1, at: '2026-08-12T19:59:30.000Z', kind: 'lifecycle', phase: 'ready' }],
      },
    });

    await expect(processPendingCrashReports(env)).resolves.toEqual({ selected: 1, processed: 1, failed: 0 });
    expect(symbolicate).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.any(ArrayBuffer));
    const row = database.prepare(`SELECT parser_state, structured_report_json, issue_fingerprint, destination_state
      FROM telemetry_crash_reports`).get() as Record<string, unknown>;
    expect(row.parser_state).toBe('symbolicated');
    expect(JSON.parse(String(row.structured_report_json))).toMatchObject({
      status: 'symbolicated', crash_type: 'EXC_BAD_ACCESS', mechanism: 'minidump',
      handled: false, process_role: 'renderer', breadcrumb_status: 'available',
      breadcrumbs: { entries: [{ kind: 'lifecycle', phase: 'ready' }] },
    });
    expect(row.issue_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.destination_state).toBe('pending');
    database.close();
  });

  it('queues enterprise crash delivery with the same policy as Global', async () => {
    const database = migratedSqliteDatabase();
    const storage = bucket();
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'enterprise', TELEMETRY_PAYLOADS: storage.binding,
      CRASH_SYMBOLICATOR: createCloudflareTestBinding<DurableObjectNamespace<CrashSymbolicatorContainer>>({
        idFromName: vi.fn(() => createTestDurableObjectId('crash-symbolicator')),
        get: vi.fn(),
      }),
    });
    await new CrashIngestService(env).accept({
      ...metadata, route: 'enterprise', dump: dump(), subjectUserId: null,
    });
    await processPendingCrashReports(env);
    expect(database.prepare('SELECT parser_state, destination_state FROM telemetry_crash_reports').get()).toEqual({
      parser_state: 'unsymbolicated', destination_state: 'pending',
    });
    database.close();
  });

  it('retries a transient regional processor failure with deadline-bounded backoff', async () => {
    const database = migratedSqliteDatabase();
    const storage = bucket();
    storage.objects.set('telemetry/symbols/1.96.0/build-123/darwin/arm64.tar', new Uint8Array([1, 2, 3]));
    const symbolicate = vi.fn()
      .mockRejectedValueOnce(new Error('container unavailable'))
      .mockResolvedValueOnce({
        parserState: 'symbolicated' as const,
        reportJson: JSON.stringify({ status: 'ok', threads: [] }),
      });
    const env = createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', TELEMETRY_PAYLOADS: storage.binding,
      CRASH_SYMBOLICATOR: createCloudflareTestBinding<DurableObjectNamespace<CrashSymbolicatorContainer>>({
        idFromName: () => createTestDurableObjectId('crash-symbolicator'),
        get: () => ({ symbolicate }),
      }),
    });
    await new CrashIngestService(env).accept({ ...metadata, dump: dump(), subjectUserId: null });

    await expect(processPendingCrashReports(env)).resolves.toEqual({ selected: 1, processed: 0, failed: 1 });
    expect(database.prepare(`SELECT parser_state, processing_attempt_count, processing_next_attempt_at,
      delete_at FROM telemetry_crash_reports`).get()).toEqual({
      parser_state: 'failed',
      processing_attempt_count: 1,
      processing_next_attempt_at: '2026-08-12T20:01:00.000Z',
      delete_at: '2026-11-10T20:00:00.000Z',
    });
    await expect(processPendingCrashReports(env)).resolves.toMatchObject({ selected: 0 });

    vi.setSystemTime(new Date('2026-08-12T20:01:00.001Z'));
    await expect(processPendingCrashReports(env)).resolves.toEqual({ selected: 1, processed: 1, failed: 0 });
    expect(database.prepare('SELECT parser_state, processing_attempt_count FROM telemetry_crash_reports').get())
      .toEqual({ parser_state: 'symbolicated', processing_attempt_count: 1 });
    database.close();
  });
});

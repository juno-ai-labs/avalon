import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashIngestService } from '../src/telemetry/crash-ingest';
import { createCloudflareTestBinding, createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const uploadId = '018f22f2-4c22-7abc-8def-0123456789ab';
const installationId = '018f22f2-4c22-7abc-8def-0123456789ac';
const metadata = {
  uploadId,
  installationId,
  release: '1.96.0',
  buildId: 'build-123',
  platform: 'darwin' as const,
  architecture: 'arm64' as const,
  processRole: 'renderer' as const,
  launchId: '018f22f2-4c22-7abc-8def-0123456789ad',
  channel: 'stable' as const,
  route: 'global' as const,
  rateLimitSubject: 'user-1',
};

function seedUser(database: ReturnType<typeof migratedSqliteDatabase>, enabled: boolean): void {
  database.prepare(`INSERT INTO users
    (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled)
    VALUES ('user-1', 'google-1', 'user@example.com', 'User', ?, ?, ?)`)
    .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', enabled ? 1 : 0);
}

function minidump(extra = 16): Uint8Array {
  const bytes = new Uint8Array(4 + extra);
  bytes.set(new TextEncoder().encode('MDMP'));
  return bytes;
}

describe('regional native crash ingest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('durably stores a bounded minidump under an opaque regional key with a fixed 90-day deadline', async () => {
    const database = migratedSqliteDatabase();
    seedUser(database, true);
    const put = vi.fn(async () => undefined);
    const service = new CrashIngestService(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put, delete: vi.fn(async () => undefined) }),
    }));

    const result = await service.accept({
      ...metadata, dump: minidump(), subjectUserId: 'user-1',
      breadcrumbs: {
        version: 1, launchId: uploadId, updatedAt: '2026-08-12T19:59:30.000Z',
        entries: [{ sequence: 1, at: '2026-08-12T19:59:30.000Z', kind: 'screen_changed', screen: 'workstream' }],
      },
    });
    expect(result.result).toBe('accepted');
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^telemetry\/crashes\/global\/[0-9a-f-]+\.dmp$/u),
      expect.any(Uint8Array),
      expect.objectContaining({ httpMetadata: { contentType: 'application/octet-stream' } }),
    );
    expect(database.prepare(`SELECT route, byte_size, release, launch_id, channel,
                                    breadcrumb_status, parser_state, received_at, delete_at
      FROM telemetry_crash_reports WHERE upload_id = ?`).get(uploadId)).toEqual({
      route: 'global', byte_size: 20, release: '1.96.0',
      launch_id: metadata.launchId, channel: 'stable',
      breadcrumb_status: 'available', parser_state: 'pending',
      received_at: '2026-08-12T20:00:00.000Z', delete_at: '2026-11-10T20:00:00.000Z',
    });
    database.close();
  });

  it('rejects malformed, oversized, forged-route, and opted-out reports before R2', async () => {
    const database = migratedSqliteDatabase();
    seedUser(database, false);
    const put = vi.fn(async () => undefined);
    const service = new CrashIngestService(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global',
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put, delete: vi.fn(async () => undefined) }),
    }));
    await expect(service.accept({ ...metadata, dump: new TextEncoder().encode('not-a-dump'), subjectUserId: 'user-1' }))
      .rejects.toThrow('crash_dump_malformed');
    await expect(service.accept({ ...metadata, dump: minidump(20 * 1024 * 1024), subjectUserId: 'user-1' }))
      .rejects.toThrow('crash_dump_too_large');
    await expect(service.accept({ ...metadata, route: 'enterprise' as never, dump: minidump(), subjectUserId: 'user-1' }))
      .rejects.toThrow('crash_route_mismatch');
    await expect(service.accept({ ...metadata, dump: minidump(), subjectUserId: 'user-1' }))
      .resolves.toEqual({ result: 'suppressed', uploadId });
    expect(put).not.toHaveBeenCalled();
    database.close();
  });

  it('deduplicates byte-identical retries and rejects an upload ID reused for different bytes', async () => {
    const database = migratedSqliteDatabase();
    seedUser(database, true);
    const bucket = createCloudflareTestBinding<R2Bucket>({
      put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
    });
    const service = new CrashIngestService(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', TELEMETRY_PAYLOADS: bucket,
    }));
    await service.accept({ ...metadata, dump: minidump(), subjectUserId: 'user-1' });
    await expect(service.accept({ ...metadata, dump: minidump(), subjectUserId: 'user-1' }))
      .resolves.toEqual({ result: 'duplicate', uploadId });
    await expect(service.accept({ ...metadata, dump: minidump(17), subjectUserId: 'user-1' }))
      .rejects.toThrow('crash_upload_conflict');
    database.close();
  });

  it('rate limits new crash uploads by an opaque subject bucket without blocking duplicate acknowledgement', async () => {
    const database = migratedSqliteDatabase();
    seedUser(database, true);
    const bucket = createCloudflareTestBinding<R2Bucket>({
      put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
    });
    const service = new CrashIngestService(createTestEnv({
      DB: sqliteD1(database), AVALON_REGION: 'global', TELEMETRY_PAYLOADS: bucket,
    }));
    const acceptedIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const currentUploadId = `018f22f2-4c22-7abc-8def-0123456789${index.toString(16).padStart(2, '0')}`;
      acceptedIds.push(currentUploadId);
      await expect(service.accept({
        ...metadata, uploadId: currentUploadId, dump: minidump(index), subjectUserId: 'user-1',
      })).resolves.toMatchObject({ result: 'accepted', uploadId: currentUploadId });
    }
    await expect(service.accept({
      ...metadata,
      uploadId: '018f22f2-4c22-7abc-8def-0123456789ff',
      dump: minidump(32),
      subjectUserId: 'user-1',
    })).rejects.toThrow('crash_rate_limited');
    await expect(service.accept({
      ...metadata, uploadId: acceptedIds[0]!, dump: minidump(0), subjectUserId: 'user-1',
    })).resolves.toMatchObject({ result: 'duplicate', uploadId: acceptedIds[0] });
    expect(database.prepare(
      'SELECT surface, count FROM telemetry_ingest_rate_buckets',
    ).get()).toEqual({ surface: 'crash_upload', count: 11 });
    database.close();
  });
});

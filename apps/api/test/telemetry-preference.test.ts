import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProductAnalyticsPreferenceService,
  applyCanonicalPreferenceMutation,
  applyRegionalPreferenceProjection,
} from '../src/telemetry/preference';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const handle = '018f22f2-4c22-7abc-8def-0123456789ab';
const operationId = '018f22f2-4c22-7abc-8def-0123456789ac';

function seed(database: ReturnType<typeof migratedSqliteDatabase>, region: string): void {
  database.prepare(`INSERT INTO users
    (id, google_subject, email, name, created_at, updated_at, platform_user_id,
     preference_subject_handle, product_analytics_enabled, product_analytics_preference_version)
    VALUES (?, ?, ?, 'User', ?, ?, 'platform-user', ?, 1, 1)`).run(
    `${region}-user`, `${region}-subject`, `${region}@example.com`,
    '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', handle,
  );
}

describe('canonical regional Product analytics preference', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('writes an enterprise disable locally before sending the opaque canonical mutation', async () => {
    const globalDatabase = migratedSqliteDatabase();
    const enterpriseDatabase = migratedSqliteDatabase();
    seed(globalDatabase, 'global');
    seed(enterpriseDatabase, 'enterprise');
    const canonicalEnv = createTestEnv({ DB: sqliteD1(globalDatabase), AVALON_REGION: 'global' });
    const mutate = vi.fn(async (input: unknown) => {
      expect(enterpriseDatabase.prepare(`SELECT product_analytics_enabled FROM users WHERE id = 'enterprise-user'`).get())
        .toEqual({ product_analytics_enabled: 0 });
      return applyCanonicalPreferenceMutation(canonicalEnv, input);
    });
    const enterpriseEnv = createTestEnv({
      DB: sqliteD1(enterpriseDatabase), AVALON_REGION: 'enterprise',
      GLOBAL_TELEMETRY_CONTROL: { mutatePreference: mutate },
    });

    await expect(new ProductAnalyticsPreferenceService(enterpriseEnv, 'enterprise-user').update({
      enabled: false, expectedVersion: 1, operationId,
    })).resolves.toEqual({ enabled: false, version: 2 });
    expect(mutate).toHaveBeenCalledWith({
      preferenceSubjectHandle: handle, enabled: false, expectedVersion: 1, operationId,
    });
    expect(JSON.stringify(mutate.mock.calls)).not.toContain('enterprise-user');
    expect(globalDatabase.prepare(`SELECT product_analytics_enabled, product_analytics_preference_version
      FROM users WHERE id = 'global-user'`).get()).toEqual({
      product_analytics_enabled: 0, product_analytics_preference_version: 2,
    });
    globalDatabase.close();
    enterpriseDatabase.close();
  });

  it('keeps enterprise disabled until canonical enablement acknowledges and applies activation projections monotonically', async () => {
    const globalDatabase = migratedSqliteDatabase();
    const enterpriseDatabase = migratedSqliteDatabase();
    seed(globalDatabase, 'global');
    seed(enterpriseDatabase, 'enterprise');
    globalDatabase.prepare(`UPDATE users SET product_analytics_enabled = 0,
      product_analytics_preference_version = 2 WHERE id = 'global-user'`).run();
    enterpriseDatabase.prepare(`UPDATE users SET product_analytics_enabled = 0,
      product_analytics_preference_version = 2 WHERE id = 'enterprise-user'`).run();
    const canonicalEnv = createTestEnv({ DB: sqliteD1(globalDatabase), AVALON_REGION: 'global' });
    const mutate = vi.fn(async (input: unknown) => {
      expect(enterpriseDatabase.prepare(`SELECT product_analytics_enabled FROM users WHERE id = 'enterprise-user'`).get())
        .toEqual({ product_analytics_enabled: 0 });
      return applyCanonicalPreferenceMutation(canonicalEnv, input);
    });
    const enterpriseEnv = createTestEnv({
      DB: sqliteD1(enterpriseDatabase), AVALON_REGION: 'enterprise', GLOBAL_TELEMETRY_CONTROL: { mutatePreference: mutate },
    });
    await expect(new ProductAnalyticsPreferenceService(enterpriseEnv, 'enterprise-user').update({
      enabled: true, expectedVersion: 2, operationId,
    })).resolves.toEqual({ enabled: true, version: 3 });

    await applyRegionalPreferenceProjection(enterpriseEnv, 'enterprise-user', {
      preferenceSubjectHandle: handle, enabled: false, version: 2,
    });
    expect(enterpriseDatabase.prepare(`SELECT product_analytics_enabled, product_analytics_preference_version
      FROM users WHERE id = 'enterprise-user'`).get()).toEqual({
      product_analytics_enabled: 1, product_analytics_preference_version: 3,
    });
    globalDatabase.close();
    enterpriseDatabase.close();
  });

  it('projects the canonical winner back to enterprise when a stale mutation conflicts', async () => {
    const globalDatabase = migratedSqliteDatabase();
    const enterpriseDatabase = migratedSqliteDatabase();
    seed(globalDatabase, 'global');
    seed(enterpriseDatabase, 'enterprise');
    globalDatabase.prepare(`UPDATE users SET product_analytics_enabled = 0,
      product_analytics_preference_version = 2 WHERE id = 'global-user'`).run();
    const canonicalEnv = createTestEnv({ DB: sqliteD1(globalDatabase), AVALON_REGION: 'global' });
    const enterpriseEnv = createTestEnv({
      DB: sqliteD1(enterpriseDatabase),
      AVALON_REGION: 'enterprise',
      GLOBAL_TELEMETRY_CONTROL: {
        mutatePreference: (input: unknown) => applyCanonicalPreferenceMutation(canonicalEnv, input),
      },
    });

    await expect(new ProductAnalyticsPreferenceService(enterpriseEnv, 'enterprise-user').update({
      enabled: true, expectedVersion: 1, operationId,
    })).rejects.toMatchObject({ status: 409, code: 'telemetry_preference_conflict' });
    expect(enterpriseDatabase.prepare(`SELECT product_analytics_enabled, product_analytics_preference_version
      FROM users WHERE id = 'enterprise-user'`).get()).toEqual({
      product_analytics_enabled: 0,
      product_analytics_preference_version: 2,
    });
    globalDatabase.close();
    enterpriseDatabase.close();
  });
});

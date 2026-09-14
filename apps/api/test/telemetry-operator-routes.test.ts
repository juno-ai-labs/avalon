import "../../../tests/isolated-region";
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { telemetryOperatorRoutes } from '../src/routes/telemetry-operations';
import { createCloudflareTestBinding, createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const securityToken = 'security-token-with-at-least-32-bytes';
const supportToken = 'support-token-with-at-least-32-bytes-';
const securityId = '018f22f2-4c22-7abc-8def-0123456789ab';
const supportId = '018f22f2-4c22-7abc-8def-0123456789ac';
const eventId = '018f22f2-4c22-7abc-8def-0123456789ad';
const crashId = '018f22f2-4c22-7abc-8def-0123456789ae';

function app(): Hono<HonoAppEnv> {
  const instance = new Hono<HonoAppEnv>();
  instance.route('/internal/telemetry', telemetryOperatorRoutes);
  instance.onError(errorHandler);
  return instance;
}

const demosToken = 'demos-operator-token-0123456789abcdef0123456789abcdef';

function operatorConfig(): string {
  return JSON.stringify({
    [securityToken]: { operatorId: securityId, role: 'security' },
    [supportToken]: { operatorId: supportId, role: 'support' },
    [demosToken]: { operatorId: '0198a229-ef99-7000-8000-00000000000d', role: 'demos' },
  });
}

function authorization(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe('regional telemetry operator routes', () => {
  it("refuses the demos role at the router, so Ace's credential reaches no telemetry route", async () => {
    // `demos` is a role of the same credential map; the isolation the role
    // exists for holds only if this router names the roles it admits.
    const environment = createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error', TELEMETRY_OPERATORS_JSON: operatorConfig() });
    for (const [method, path] of [['GET', '/internal/telemetry/status'], ['GET', '/internal/telemetry/enterprise/crash-issues'], ['POST', '/internal/telemetry/replay']] as const) {
      const response = await app().request(path, { method, headers: authorization(demosToken) }, environment);
      expect(response.status, `${method} ${path}`).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'operator_role_forbidden' } });
    }
  });

  it('fails closed for missing and invalid server-configured operator credentials', async () => {
    const environment = createTestEnv({
      AVALON_REGION: 'global',
      LOG_LEVEL: 'error',
      TELEMETRY_OPERATORS_JSON: operatorConfig(),
    });
    const missing = await app().request('/internal/telemetry/status', undefined, environment);
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'operator_authentication_required' },
    });

    const invalid = await app().request('/internal/telemetry/status', {
      headers: authorization('invalid-token-with-at-least-32-bytes'),
    }, environment);
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'operator_authentication_invalid' },
    });
  });

  it('derives the security principal from configuration and replays only a regional terminal row', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_accepted_events
      (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id,
       accepted_at, normalized_timestamp, delete_at, delivery_state)
      VALUES (?, 'hash', ?, 'global', 'explicit_binding', 'person', ?, ?, ?, 'terminal')`).run(
      eventId,
      JSON.stringify({
        schema: 'ai.rallywith.telemetry.event', schemaVersion: 1, eventId,
        name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
        identityScope: 'platform-user', originalTimestamp: '2026-08-12T20:00:00.000Z',
        sentAt: '2026-08-12T20:00:00.000Z',
        context: { environment: 'production', release: '1.0.0', buildId: 'build' },
        properties: { screen: 'workspace_home' },
      }),
      '2026-08-12T20:00:00.000Z',
      '2026-08-12T20:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    );
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_OPERATORS_JSON: operatorConfig(),
    });

    const forbidden = await app().request('/internal/telemetry/replay', {
      method: 'POST', headers: { ...authorization(supportToken), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, reason: 'destination_recovery' }),
    }, environment);
    expect(forbidden.status).toBe(403);

    const replayed = await app().request('/internal/telemetry/replay', {
      method: 'POST', headers: { ...authorization(securityToken), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, reason: 'destination_recovery' }),
    }, environment);
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual({ result: 'requeued', eventId });
    expect(database.prepare('SELECT operator_id, result_code FROM telemetry_replay_audit').get())
      .toEqual({ operator_id: securityId, result_code: 'requeued' });
    database.close();
  });

  it('streams an authorized raw dump while auditing only its opaque crash ID', async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_crash_reports
      (crash_id, upload_id, installation_analytics_id, route, object_key, byte_size,
       content_sha256, release, build_id, platform, architecture, process_role,
       launch_id, channel, received_at, delete_at)
      VALUES (?, ?, ?, 'global', 'telemetry/crashes/global/private.dmp', 4, 'hash',
              '1.0.0', 'build', 'darwin', 'arm64', 'main', ?, 'stable', ?, ?)`).run(
      crashId,
      '018f22f2-4c22-7abc-8def-0123456789af',
      '018f22f2-4c22-7abc-8def-0123456789b0',
      '018f22f2-4c22-7abc-8def-0123456789b1',
      '2026-08-12T20:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    );
    const bytes = new TextEncoder().encode('MDMP');
    const get = vi.fn(async () => ({
      size: bytes.byteLength,
      httpEtag: 'etag',
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    }));
    const environment = createTestEnv({
      AVALON_REGION: 'global', LOG_LEVEL: 'error', DB: sqliteD1(database),
      TELEMETRY_OPERATORS_JSON: operatorConfig(),
      TELEMETRY_PAYLOADS: createCloudflareTestBinding<R2Bucket>({ get }),
    });

    const response = await app().request(
      `/internal/telemetry/crashes/${crashId}/raw?reason=customer_support`,
      { headers: authorization(supportToken) },
      environment,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(`${crashId}.dmp`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(database.prepare('SELECT crash_id, operator_id, result_code FROM telemetry_crash_access_audit').get())
      .toEqual({ crash_id: crashId, operator_id: supportId, result_code: 'found' });
    expect(JSON.stringify(database.prepare('SELECT * FROM telemetry_crash_access_audit').get()))
      .not.toContain('telemetry/crashes');
    database.close();
  });
});

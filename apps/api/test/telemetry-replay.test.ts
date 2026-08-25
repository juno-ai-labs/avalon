import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryCollector } from '../src/telemetry/collector';
import { replayTelemetryEvent } from '../src/telemetry/replay';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const eventId = '018f22f2-4c22-7abc-8def-0123456789ab';
const operatorId = '018f22f2-4c22-7abc-8def-0123456789ac';
const securityPrincipal = { operatorId, role: 'security' as const };

function envelope() {
  return {
    schema: 'ai.rallywith.telemetry.event' as const,
    schemaVersion: 1 as const,
    eventId,
    name: 'onboarding_region_selected' as const,
    source: 'desktop-renderer' as const,
    category: 'product' as const,
    identityScope: 'anonymous-epoch' as const,
    originalTimestamp: '2026-08-12T20:00:00.000Z',
    sentAt: '2026-08-12T20:00:00.000Z',
    context: { environment: 'production' as const, release: '1.0.0', buildId: 'build' },
    properties: { selectedRegion: 'global' as const, entrypoint: 'first_run' as const },
  };
}

describe('regional telemetry replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('requeues a terminal Global row without changing its identity, payload, or deadline', async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global' });
    await new TelemetryCollector(env).accept(envelope(), {
      route: 'global', routingBasis: 'geolocation_fallback', analyticsSubjectId: 'anon-1',
      subjectUserId: null, workspaceAnalyticsId: null,
    });
    database.prepare(`UPDATE telemetry_accepted_events
      SET delivery_state = 'terminal', terminal_code = 'destination_rejected', attempt_count = 3
      WHERE event_id = ?`).run(eventId);
    const before = database.prepare(`SELECT payload_hash, envelope_json, analytics_subject_id, delete_at
      FROM telemetry_accepted_events WHERE event_id = ?`).get(eventId);

    await expect(replayTelemetryEvent(env, {
      eventId, reason: 'destination_recovery',
    }, securityPrincipal)).resolves.toEqual({ result: 'requeued', eventId });
    expect(database.prepare(`SELECT payload_hash, envelope_json, analytics_subject_id, delete_at,
      delivery_state, next_attempt_at, terminal_code FROM telemetry_accepted_events WHERE event_id = ?`)
      .get(eventId)).toEqual({
      ...before, delivery_state: 'pending', next_attempt_at: null, terminal_code: null,
    });
    expect(database.prepare(`SELECT operator_id, result_code, original_delete_at
      FROM telemetry_replay_audit`).get()).toEqual({
      operator_id: operatorId, result_code: 'requeued',
      original_delete_at: '2026-11-10T20:00:00.000Z',
    });
    database.close();
  });

  it('rejects unauthorized, expired, and cross-region replay without mutating the row', async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global' });
    await new TelemetryCollector(env).accept(envelope(), {
      route: 'global', routingBasis: 'geolocation_fallback', analyticsSubjectId: 'anon-1',
      subjectUserId: null, workspaceAnalyticsId: null,
    });
    database.prepare(`UPDATE telemetry_accepted_events SET delivery_state = 'terminal' WHERE event_id = ?`)
      .run(eventId);

    await expect(replayTelemetryEvent(env, {
      eventId, reason: 'destination_recovery',
    }, { operatorId, role: 'support' })).resolves.toEqual({ result: 'denied', eventId });
    vi.setSystemTime(new Date('2026-11-11T20:00:00.000Z'));
    await expect(replayTelemetryEvent(env, {
      eventId, reason: 'destination_recovery',
    }, securityPrincipal)).resolves.toEqual({ result: 'expired', eventId });
    expect(database.prepare('SELECT delivery_state FROM telemetry_accepted_events WHERE event_id = ?')
      .get(eventId)).toEqual({ delivery_state: 'terminal' });
    database.close();
  });
});

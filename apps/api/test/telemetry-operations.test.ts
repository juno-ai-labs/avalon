import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  destinationCircuitAllows,
  readTelemetryOperationalSnapshot,
  recordDestinationOutcome,
} from '../src/telemetry/operations';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedObservabilityFixture, sqliteD1 } from './helpers/sqlite-d1';

const now = new Date('2026-08-12T20:00:00.000Z');

describe('telemetry operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  it('opens a content-free destination circuit after repeated transient failures and recovers it', async () => {
    const database = migratedObservabilityFixture();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global' });

    await expect(destinationCircuitAllows(env, 'posthog_capture', now)).resolves.toBe(true);
    for (let index = 0; index < 5; index += 1) {
      await recordDestinationOutcome(env, 'posthog_capture', 'retryable', now);
    }
    await expect(destinationCircuitAllows(env, 'posthog_capture', now)).resolves.toBe(false);
    expect(database.prepare(
      'SELECT destination, consecutive_failures, circuit_open_until FROM telemetry_destination_state',
    ).get()).toEqual({
      destination: 'posthog_capture',
      consecutive_failures: 5,
      circuit_open_until: '2026-08-12T20:05:00.000Z',
    });

    const afterCooldown = new Date('2026-08-12T20:05:00.001Z');
    await expect(destinationCircuitAllows(env, 'posthog_capture', afterCooldown)).resolves.toBe(true);
    await recordDestinationOutcome(env, 'posthog_capture', 'healthy', afterCooldown);
    expect(database.prepare(
      'SELECT consecutive_failures, circuit_open_until FROM telemetry_destination_state',
    ).get()).toEqual({ consecutive_failures: 0, circuit_open_until: null });
    database.close();
  });

  it('reports only fixed counts and oldest ages for regional operations', async () => {
    const database = migratedObservabilityFixture();
    database.exec(`
      INSERT INTO telemetry_accepted_events
        (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id,
         accepted_at, normalized_timestamp, delete_at, delivery_state)
      VALUES
        ('event-a', 'hash-a', '{}', 'global', 'explicit_binding', 'person-a',
         '2026-08-12T19:50:00.000Z', '2026-08-12T19:50:00.000Z', '2026-11-10T19:50:00.000Z', 'pending'),
        ('event-b', 'hash-b', '{}', 'global', 'explicit_binding', 'person-b',
         '2026-08-12T19:55:00.000Z', '2026-08-12T19:55:00.000Z', '2026-11-10T19:55:00.000Z', 'terminal');
      INSERT INTO telemetry_rejection_buckets
        (bucket_start, violation_code, event_name, count, delete_at)
      VALUES ('2026-08-12T20:00:00.000Z', 'schema_invalid', 'unregistered', 3,
              '2026-11-10T20:00:00.000Z');
    `);
    const snapshot = await readTelemetryOperationalSnapshot(
      createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global' }),
      now,
    );

    expect(snapshot).toEqual({
      acceptedPending: 1,
      acceptedTerminal: 1,
      crashPending: 0,
      crashTerminal: 0,
      profilePending: 0,
      profileTerminal: 0,
      rejectionCount: 3,
      openCircuits: 0,
      oldestAcceptedAgeSeconds: 600,
      oldestCrashAgeSeconds: null,
      oldestProfileAgeSeconds: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/event-a|person-a|hash-a/u);
    database.close();
  });
});

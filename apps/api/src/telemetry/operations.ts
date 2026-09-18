import type { Env } from '../env';
import { sha256 } from '../lib/crypto';

export type TelemetryDestination =
  | 'posthog_capture'
  | 'posthog_javascript_exception'
  | 'posthog_profile'
  | 'posthog_crash';

export type TelemetryDestinationOutcome = 'healthy' | 'retryable';

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

export async function destinationCircuitAllows(
  env: Env,
  destination: TelemetryDestination,
  now = new Date(),
): Promise<boolean> {
  const state = await env.DB.prepare(
    'SELECT circuit_open_until FROM telemetry_destination_state WHERE destination = ?',
  ).bind(destination).first<{ circuit_open_until: string | null }>();
  return state?.circuit_open_until == null || Date.parse(state.circuit_open_until) <= now.getTime();
}

export async function recordDestinationOutcome(
  env: Env,
  destination: TelemetryDestination,
  outcome: TelemetryDestinationOutcome,
  now = new Date(),
): Promise<void> {
  if (outcome === 'healthy') {
    await env.DB.prepare(
      `INSERT INTO telemetry_destination_state
        (destination, consecutive_failures, circuit_open_until, updated_at)
       VALUES (?, 0, NULL, ?)
       ON CONFLICT(destination) DO UPDATE SET
         consecutive_failures = 0, circuit_open_until = NULL, updated_at = excluded.updated_at`,
    ).bind(destination, now.toISOString()).run();
    return;
  }
  const openUntil = new Date(now.getTime() + CIRCUIT_COOLDOWN_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO telemetry_destination_state
      (destination, consecutive_failures, circuit_open_until, updated_at)
     VALUES (?, 1, NULL, ?)
     ON CONFLICT(destination) DO UPDATE SET
       consecutive_failures = MIN(?, telemetry_destination_state.consecutive_failures + 1),
       circuit_open_until = CASE
         WHEN telemetry_destination_state.consecutive_failures + 1 >= ? THEN ?
         ELSE telemetry_destination_state.circuit_open_until
       END,
       updated_at = excluded.updated_at`,
  ).bind(
    destination,
    now.toISOString(),
    CIRCUIT_FAILURE_THRESHOLD,
    CIRCUIT_FAILURE_THRESHOLD,
    openUntil,
  ).run();
}

export async function consumeTelemetryRateLimit(
  env: Env,
  surface: 'crash_upload' | 'telemetry_bootstrap',
  subject: string,
  limit: number,
  now = new Date(),
): Promise<boolean> {
  const bucketStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const deleteAt = new Date(bucketStart.getTime() + 24 * 60 * 60 * 1_000);
  const subjectHash = await sha256(`${surface}:${subject}`);
  await env.DB.prepare(
    `INSERT INTO telemetry_ingest_rate_buckets
      (surface, subject_hash, bucket_start, count, delete_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(surface, subject_hash, bucket_start) DO UPDATE SET count = count + 1`,
  ).bind(surface, subjectHash, bucketStart.toISOString(), deleteAt.toISOString()).run();
  const row = await env.DB.prepare(
    `SELECT count FROM telemetry_ingest_rate_buckets
     WHERE surface = ? AND subject_hash = ? AND bucket_start = ?`,
  ).bind(surface, subjectHash, bucketStart.toISOString()).first<{ count: number }>();
  return (row?.count ?? limit + 1) <= limit;
}

export async function recordTelemetryRejection(
  env: Env,
  violationCode: 'crash_rate_limited',
  now = new Date(),
): Promise<void> {
  const bucketStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const deleteAt = new Date(bucketStart.getTime() + 90 * 24 * 60 * 60 * 1_000);
  await env.DB.prepare(
    `INSERT INTO telemetry_rejection_buckets
      (bucket_start, violation_code, event_name, count, delete_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(bucket_start, violation_code, event_name) DO UPDATE SET count = count + 1`,
  ).bind(bucketStart.toISOString(), violationCode, 'unregistered', deleteAt.toISOString()).run();
}

export interface TelemetryOperationalSnapshot {
  acceptedPending: number;
  acceptedTerminal: number;
  crashPending: number;
  crashTerminal: number;
  profilePending: number;
  profileTerminal: number;
  rejectionCount: number;
  openCircuits: number;
  oldestAcceptedAgeSeconds: number | null;
  oldestCrashAgeSeconds: number | null;
  oldestProfileAgeSeconds: number | null;
}

interface OperationalRow {
  pending: number;
  terminal: number;
  oldest: string | null;
}

function ageSeconds(value: string | null, now: Date): number | null {
  if (value === null) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 1_000));
}

export async function readTelemetryOperationalSnapshot(
  env: Env,
  now = new Date(),
): Promise<TelemetryOperationalSnapshot> {
  const [accepted, crashes, profiles, rejection, circuits] = await Promise.all([
    env.TELEMETRY_DB.prepare(
      `SELECT
         SUM(CASE WHEN delivery_state IN ('pending', 'retrying') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN delivery_state = 'terminal' THEN 1 ELSE 0 END) AS terminal,
         MIN(CASE WHEN delivery_state IN ('pending', 'retrying') THEN accepted_at END) AS oldest
       FROM telemetry_accepted_events`,
    ).first<OperationalRow>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN parser_state IN ('pending', 'processing', 'failed') OR destination_state IN ('pending', 'retrying') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN destination_state = 'terminal' OR parser_state = 'malformed' THEN 1 ELSE 0 END) AS terminal,
         MIN(CASE WHEN parser_state IN ('pending', 'processing', 'failed') OR destination_state IN ('pending', 'retrying') THEN received_at END) AS oldest
       FROM telemetry_crash_reports`,
    ).first<OperationalRow>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN state IN ('pending', 'delivering') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = 'terminal' THEN 1 ELSE 0 END) AS terminal,
         MIN(CASE WHEN state IN ('pending', 'delivering') THEN created_at END) AS oldest
       FROM telemetry_profile_jobs`,
    ).first<OperationalRow>(),
    env.DB.prepare(
      'SELECT COALESCE(SUM(count), 0) AS count FROM telemetry_rejection_buckets WHERE delete_at > ?',
    ).bind(now.toISOString()).first<{ count: number }>(),
    env.DB.prepare(
      'SELECT COUNT(*) AS count FROM telemetry_destination_state WHERE circuit_open_until > ?',
    ).bind(now.toISOString()).first<{ count: number }>(),
  ]);
  return {
    acceptedPending: accepted?.pending ?? 0,
    acceptedTerminal: accepted?.terminal ?? 0,
    crashPending: crashes?.pending ?? 0,
    crashTerminal: crashes?.terminal ?? 0,
    profilePending: profiles?.pending ?? 0,
    profileTerminal: profiles?.terminal ?? 0,
    rejectionCount: rejection?.count ?? 0,
    openCircuits: circuits?.count ?? 0,
    oldestAcceptedAgeSeconds: ageSeconds(accepted?.oldest ?? null, now),
    oldestCrashAgeSeconds: ageSeconds(crashes?.oldest ?? null, now),
    oldestProfileAgeSeconds: ageSeconds(profiles?.oldest ?? null, now),
  };
}

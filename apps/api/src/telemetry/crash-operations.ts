import { newId } from '@rally/db';
import { z } from 'zod';
import type { Env } from '../env';
import type { TelemetryOperatorPrincipal } from './operator-auth';

const QuerySchema = z.strictObject({ limit: z.number().int().min(1).max(100).default(50) });
const AccessSchema = z.strictObject({
  crashId: z.string().uuid().refine((value) => value[14] === '7'),
  reason: z.enum(['customer_support', 'incident_response']),
});

interface EuIssueRow {
  fingerprint: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  releases: string;
}

export interface EuCrashIssue {
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  releases: string[];
}

export async function queryEuCrashIssues(
  env: Env,
  input: { limit?: number } = {},
): Promise<EuCrashIssue[]> {
  if (env.AVALON_REGION !== 'eu') throw new Error('eu_crash_issues_wrong_region');
  const { limit } = QuerySchema.parse(input);
  const rows = await env.DB.prepare(
    `SELECT fingerprint, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen,
            COUNT(*) AS occurrence_count, GROUP_CONCAT(DISTINCT release) AS releases
     FROM telemetry_eu_crash_contributions
     WHERE delete_at > ?
     GROUP BY fingerprint
     ORDER BY last_seen DESC
     LIMIT ?`,
  ).bind(new Date().toISOString(), limit).all<EuIssueRow>();
  return rows.results.map((row) => ({
    fingerprint: row.fingerprint,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    count: Number(row.occurrence_count),
    releases: row.releases.split(',').sort(),
  }));
}

interface CrashLookupRow {
  object_key: string;
  delete_at: string;
}

export type RawCrashObject = NonNullable<Awaited<ReturnType<R2Bucket['get']>>>;

export async function readRawCrashForSupport(
  env: Env,
  input: z.input<typeof AccessSchema>,
  principal: TelemetryOperatorPrincipal,
): Promise<RawCrashObject | null> {
  const request = AccessSchema.parse(input);
  if ((request.reason === 'customer_support' && principal.role !== 'support')
    || (request.reason === 'incident_response' && principal.role !== 'security')) {
    throw new Error('telemetry_operator_reason_forbidden');
  }
  const now = new Date();
  const row = await env.DB.prepare(
    'SELECT object_key, delete_at FROM telemetry_crash_reports WHERE crash_id = ? AND route = ?',
  ).bind(request.crashId, env.AVALON_REGION).first<CrashLookupRow>();

  let resultCode: 'found' | 'not_found' | 'expired' | 'storage_error';
  let object: RawCrashObject | null = null;
  if (!row) {
    resultCode = 'not_found';
  } else if (Date.parse(row.delete_at) <= now.getTime()) {
    resultCode = 'expired';
  } else {
    try {
      object = await env.TELEMETRY_PAYLOADS.get(row.object_key);
      resultCode = object ? 'found' : 'not_found';
    } catch {
      resultCode = 'storage_error';
    }
  }

  await env.DB.prepare(
    `INSERT INTO telemetry_crash_access_audit
      (id, crash_id, operator_id, reason_code, result_code, accessed_at, delete_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId(now.getTime()), request.crashId, principal.operatorId, request.reason,
    resultCode, now.toISOString(), new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
  ).run();
  return object;
}
export interface EuCrashFreeLaunchSegment {
  release: string;
  platform: string;
  architecture: string;
  channel: string;
  eligibleLaunches: number;
  crashedLaunches: number;
  crashFreeLaunches: number;
  uncorrelatedCrashes: number;
}

export async function queryEuCrashFreeLaunches(
  env: Env,
  input: { from: string; to: string },
): Promise<EuCrashFreeLaunchSegment[]> {
  if (env.AVALON_REGION !== 'eu') throw new Error('eu_crash_query_wrong_region');
  const from = canonicalInstant(input.from);
  const to = canonicalInstant(input.to);
  if (Date.parse(from) >= Date.parse(to)) throw new Error('eu_crash_query_invalid_range');
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT e.release, e.platform, e.architecture, e.channel,
            COUNT(DISTINCT e.launch_id) AS eligible_launches,
            COUNT(DISTINCT c.launch_id) AS crashed_launches
     FROM telemetry_eu_events e
     LEFT JOIN telemetry_eu_crash_contributions c
       ON c.launch_id = e.launch_id AND c.delete_at > ?
     WHERE e.event_name = 'application_lifecycle'
       AND e.normalized_timestamp >= ? AND e.normalized_timestamp < ? AND e.delete_at > ?
       AND e.launch_id IS NOT NULL
       AND json_extract(e.properties_json, '$.state') = 'launch_started'
       AND json_extract(e.properties_json, '$.crashReportingEligible') = 1
     GROUP BY e.release, e.platform, e.architecture, e.channel
     ORDER BY e.release, e.platform, e.architecture, e.channel`,
  ).bind(now, from, to, now).all<{
    release: string;
    platform: string;
    architecture: string;
    channel: string;
    eligible_launches: number;
    crashed_launches: number;
  }>();
  const uncorrelated = await env.DB.prepare(
    `SELECT c.release, c.platform, c.architecture, c.channel, COUNT(*) AS count
     FROM telemetry_eu_crash_contributions c
     WHERE c.occurred_at >= ? AND c.occurred_at < ? AND c.delete_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_eu_events e
         WHERE e.event_name = 'application_lifecycle'
           AND e.launch_id = c.launch_id
           AND e.delete_at > ?
           AND json_extract(e.properties_json, '$.state') = 'launch_started'
           AND json_extract(e.properties_json, '$.crashReportingEligible') = 1
       )
     GROUP BY c.release, c.platform, c.architecture, c.channel`,
  ).bind(from, to, now, now).all<{
    release: string;
    platform: string;
    architecture: string;
    channel: string;
    count: number;
  }>();
  const uncorrelatedBySegment = new Map(uncorrelated.results.map((row) => [
    [row.release, row.platform, row.architecture, row.channel].join('\u0000'),
    row.count,
  ]));
  const segments = new Map(rows.results.map((row) => {
    const key = [row.release, row.platform, row.architecture, row.channel].join('\u0000');
    return [key, {
      release: row.release,
      platform: row.platform,
      architecture: row.architecture,
      channel: row.channel,
      eligibleLaunches: Number(row.eligible_launches),
      crashedLaunches: Number(row.crashed_launches),
      crashFreeLaunches: Number(row.eligible_launches) - Number(row.crashed_launches),
      uncorrelatedCrashes: uncorrelatedBySegment.get(key) ?? 0,
    }] as const;
  }));
  for (const row of uncorrelated.results) {
    const key = [row.release, row.platform, row.architecture, row.channel].join('\u0000');
    if (segments.has(key)) continue;
    segments.set(key, {
      release: row.release,
      platform: row.platform,
      architecture: row.architecture,
      channel: row.channel,
      eligibleLaunches: 0,
      crashedLaunches: 0,
      crashFreeLaunches: 0,
      uncorrelatedCrashes: Number(row.count),
    });
  }
  return [...segments.values()].sort((left, right) => (
    [left.release, left.platform, left.architecture, left.channel].join('\u0000')
      .localeCompare([right.release, right.platform, right.architecture, right.channel].join('\u0000'))
  ));
}

function canonicalInstant(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('eu_crash_query_invalid_time');
  }
  return value;
}

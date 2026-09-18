import { newId } from '@rally/db';
import { z } from 'zod';
import type { Env } from '../env';
import type { TelemetryOperatorPrincipal } from './operator-auth';

const AccessSchema = z.strictObject({
  crashId: z.string().uuid().refine((value) => value[14] === '7'),
  reason: z.enum(['customer_support', 'incident_response']),
});

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

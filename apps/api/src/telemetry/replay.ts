import { TelemetryEnvelopeSchema } from '@rally/contracts/telemetry';
import { newId } from '@rally/db';
import { z } from 'zod';
import type { Env } from '../env';
import type { TelemetryOperatorPrincipal } from './operator-auth';

const ReplayInputSchema = z.strictObject({
  eventId: z.string().uuid().refine((value) => value[14] === '7'),
  reason: z.enum(['destination_recovery', 'incident_response']),
});

type ReplayResultCode =
  | 'requeued'
  | 'denied'
  | 'not_found'
  | 'wrong_region'
  | 'expired'
  | 'suppressed'
  | 'invalid_state';

interface ReplayRow {
  route: 'global' | 'eu';
  envelope_json: string;
  subject_user_id: string | null;
  delivery_state: string;
  delete_at: string;
  product_analytics_enabled: number | null;
}

export async function replayTelemetryEvent(
  env: Env,
  input: z.input<typeof ReplayInputSchema>,
  principal: TelemetryOperatorPrincipal,
): Promise<{ result: ReplayResultCode; eventId: string }> {
  const request = ReplayInputSchema.parse(input);
  const now = new Date();
  const row = await env.DB.prepare(
    `SELECT e.route, e.envelope_json, e.subject_user_id, e.delivery_state, e.delete_at,
            u.product_analytics_enabled
     FROM telemetry_accepted_events e
     LEFT JOIN users u ON u.id = e.subject_user_id
     WHERE e.event_id = ?`,
  ).bind(request.eventId).first<ReplayRow>();

  let result: ReplayResultCode;
  if (principal.role !== 'security') result = 'denied';
  else if (!row) result = 'not_found';
  else if (row.route !== env.AVALON_REGION || env.AVALON_REGION !== 'global') result = 'wrong_region';
  else if (Date.parse(row.delete_at) <= now.getTime()) result = 'expired';
  else if (row.delivery_state === 'suppressed') result = 'suppressed';
  else {
    const envelope = TelemetryEnvelopeSchema.parse(JSON.parse(row.envelope_json) as unknown);
    if (row.subject_user_id && envelope.category !== 'essential' && row.product_analytics_enabled !== 1) {
      result = 'suppressed';
    } else if (row.delivery_state !== 'terminal') {
      result = 'invalid_state';
    } else {
      result = 'requeued';
    }
  }

  const audit = env.DB.prepare(
    `INSERT INTO telemetry_replay_audit
      (id, event_id, operator_id, reason_code, result_code, original_delete_at, created_at, delete_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId(now.getTime()), request.eventId, principal.operatorId, request.reason, result,
    row?.delete_at ?? null, now.toISOString(),
    new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
  );
  if (result === 'requeued') {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE telemetry_accepted_events
         SET delivery_state = 'pending', next_attempt_at = NULL, terminal_code = NULL
         WHERE event_id = ? AND route = ? AND delivery_state = 'terminal' AND delete_at > ?`,
      ).bind(request.eventId, env.AVALON_REGION, now.toISOString()),
      audit,
    ]);
  } else {
    await audit.run();
  }
  return { result, eventId: request.eventId };
}

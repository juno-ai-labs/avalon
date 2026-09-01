import type { Env } from '../env';
import {
  telemetryDeliveryRpcCall,
  type GlobalProfileDeliveryRow,
} from './telemetry-delivery-contract';
import { destinationCircuitAllows, recordDestinationOutcome } from './operations';

interface ProfileJobRow {
  id: string;
  subject_user_id: string | null;
  job_kind: 'epoch_transition' | 'person_profile' | 'group_profile';
  destination_analytics_id: string;
  anonymous_epoch_id: string | null;
  properties_json: string;
  created_at: string;
  delete_at: string;
  attempt_count: number;
  product_analytics_enabled: number | null;
}

export interface ProfileDeliverySummary {
  selected: number;
  delivered: number;
  retried: number;
  terminal: number;
  suppressed: number;
}

export async function processProfileOutbox(env: Env): Promise<ProfileDeliverySummary> {
  const summary: ProfileDeliverySummary = { selected: 0, delivered: 0, retried: 0, terminal: 0, suppressed: 0 };
  const telemetryDelivery = env.TELEMETRY_DELIVERY;
  const postHogHost = env.POSTHOG_HOST;
  const postHogProjectToken = env.POSTHOG_PROJECT_TOKEN;
  if (env.AVALON_REGION !== 'global'
    || !postHogHost
    || !postHogProjectToken
    || !telemetryDelivery) return summary;
  const now = new Date();
  if (!await destinationCircuitAllows(env, 'posthog_profile', now)) return summary;
  const pending = await env.DB.prepare(
    `SELECT j.id, j.subject_user_id, j.job_kind, j.destination_analytics_id,
            j.anonymous_epoch_id, j.properties_json, j.created_at, j.delete_at,
            j.attempt_count, u.product_analytics_enabled
     FROM telemetry_profile_jobs j
     LEFT JOIN users u ON u.id = j.subject_user_id
     WHERE j.state = 'pending' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
       AND j.delete_at > ?
       AND (j.job_kind <> 'person_profile' OR NOT EXISTS (
         SELECT 1 FROM telemetry_profile_jobs transition
         WHERE transition.subject_user_id = j.subject_user_id
           AND transition.job_kind = 'epoch_transition'
           AND transition.state IN ('pending', 'delivering')
       ))
     ORDER BY CASE j.job_kind WHEN 'epoch_transition' THEN 0 WHEN 'person_profile' THEN 1 ELSE 2 END,
              j.created_at
     LIMIT 20`,
  ).bind(now.toISOString(), now.toISOString()).all<ProfileJobRow>();
  summary.selected = pending.results.length;
  for (const row of pending.results) {
    if (row.subject_user_id && row.product_analytics_enabled !== 1) {
      await env.DB.prepare(
        "UPDATE telemetry_profile_jobs SET state = 'suppressed' WHERE id = ? AND state = 'pending'",
      ).bind(row.id).run();
      summary.suppressed += 1;
      continue;
    }
    let properties: Record<string, string>;
    try {
      properties = parseProfileProperties(row);
    } catch {
      const terminalized = await env.DB.prepare(
        `UPDATE telemetry_profile_jobs
         SET state = 'terminal', attempt_count = attempt_count + 1, next_attempt_at = NULL
         WHERE id = ? AND state = 'pending'`,
      ).bind(row.id).run();
      summary.terminal += Number(terminalized.meta.changes ?? 0);
      continue;
    }
    const delivery: GlobalProfileDeliveryRow = {
      jobId: row.id,
      kind: row.job_kind,
      destinationAnalyticsId: row.destination_analytics_id,
      anonymousEpochId: row.anonymous_epoch_id,
      properties,
      createdAt: row.created_at,
    };
    const { postHog: result } = await telemetryDeliveryRpcCall(() => telemetryDelivery.deliverProfileBatch({
      host: postHogHost,
      projectToken: postHogProjectToken,
      rows: [delivery],
    }));
    await recordDestinationOutcome(
      env,
      'posthog_profile',
      result.result === 'retry' ? 'retryable' : 'healthy',
      now,
    ).catch(() => undefined);
    if (result.result === 'delivered') {
      await env.DB.prepare(
        `UPDATE telemetry_profile_jobs
         SET state = 'acknowledged', attempt_count = attempt_count + 1,
             next_attempt_at = NULL, acknowledged_at = ?
         WHERE id = ? AND state = 'pending'`,
      ).bind(now.toISOString(), row.id).run();
      summary.delivered += 1;
    } else if (result.result === 'terminal') {
      await env.DB.prepare(
        `UPDATE telemetry_profile_jobs
         SET state = 'terminal', attempt_count = attempt_count + 1, next_attempt_at = NULL
         WHERE id = ? AND state = 'pending'`,
      ).bind(row.id).run();
      summary.terminal += 1;
    } else {
      const delay = result.retryAfterMs
        ?? Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.min(row.attempt_count, 6));
      const next = new Date(Math.min(Date.parse(row.delete_at), now.getTime() + delay));
      await env.DB.prepare(
        `UPDATE telemetry_profile_jobs
         SET state = 'pending', attempt_count = attempt_count + 1, next_attempt_at = ?
         WHERE id = ? AND state = 'pending'`,
      ).bind(next.toISOString(), row.id).run();
      summary.retried += 1;
    }
  }
  return summary;
}

function parseProfileProperties(row: ProfileJobRow): Record<string, string> {
  const value = JSON.parse(row.properties_json) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('telemetry_profile_properties_invalid');
  const candidate = value as Record<string, unknown>;
  const allowed = row.job_kind === 'group_profile' ? new Set(['name']) : new Set(['email', 'name']);
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new Error('telemetry_profile_properties_invalid');
  }
  const properties: Record<string, string> = {};
  for (const [key, child] of Object.entries(candidate)) {
    if (typeof child !== 'string' || child.length === 0 || child.length > 320) {
      throw new Error('telemetry_profile_properties_invalid');
    }
    properties[key] = child;
  }
  return properties;
}

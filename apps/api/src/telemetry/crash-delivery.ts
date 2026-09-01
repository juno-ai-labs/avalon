import type { Env } from '../env';
import {
  telemetryDeliveryRpcCall,
  type GlobalCrashDeliveryRow,
} from './telemetry-delivery-contract';
import { destinationCircuitAllows, recordDestinationOutcome } from './operations';

const MAINTENANCE_BATCH_SIZE = 100;
const MAINTENANCE_MAX_BATCHES = 5;
const CRASH_OBJECT_RETENTION_TASK = 'crash_object_retention';

interface CrashDeliveryDatabaseRow {
  crash_id: string;
  subject_user_id: string | null;
  installation_analytics_id: string;
  object_key: string;
  release: string;
  build_id: string;
  platform: 'darwin' | 'win32' | 'linux';
  architecture: 'arm64' | 'x64';
  process_role: 'main' | 'renderer' | 'utility' | 'gpu' | 'unknown';
  launch_id: string;
  channel: 'development' | 'alpha' | 'beta' | 'stable';
  parser_state: 'symbolicated' | 'unsymbolicated' | 'malformed';
  structured_report_json: string;
  issue_fingerprint: string;
  received_at: string;
  delete_at: string;
  destination_attempt_count: number;
  product_analytics_enabled: number | null;
  analytics_person_id: string | null;
  analytics_workspace_id: string | null;
}

export interface CrashDeliverySummary {
  selected: number;
  delivered: number;
  retried: number;
  terminal: number;
  suppressed: number;
}

export async function processCrashOutbox(env: Env): Promise<CrashDeliverySummary> {
  const summary: CrashDeliverySummary = { selected: 0, delivered: 0, retried: 0, terminal: 0, suppressed: 0 };
  const telemetryDelivery = env.TELEMETRY_DELIVERY;
  const postHogHost = env.POSTHOG_HOST;
  const postHogProjectToken = env.POSTHOG_PROJECT_TOKEN;
  if (env.AVALON_REGION !== 'global'
    || !postHogHost
    || !postHogProjectToken
    || !telemetryDelivery) return summary;
  const now = new Date();
  if (!await destinationCircuitAllows(env, 'posthog_crash', now)) return summary;
  const pending = await env.DB.prepare(
    `SELECT c.crash_id, c.subject_user_id, c.installation_analytics_id, c.object_key,
            c.release, c.build_id, c.platform, c.architecture, c.process_role,
            c.launch_id, c.channel,
            c.parser_state, c.structured_report_json, c.issue_fingerprint,
            c.received_at, c.delete_at, c.destination_attempt_count,
            u.product_analytics_enabled, u.analytics_person_id, w.analytics_workspace_id
     FROM telemetry_crash_reports c
     LEFT JOIN users u ON u.id = c.subject_user_id
     LEFT JOIN workspaces w ON w.id = c.subject_workspace_id
     WHERE c.route = 'global' AND c.destination_state IN ('pending', 'retrying')
       AND (c.destination_next_attempt_at IS NULL OR c.destination_next_attempt_at <= ?)
       AND c.delete_at > ?
     ORDER BY c.received_at LIMIT 5`,
  ).bind(now.toISOString(), now.toISOString()).all<CrashDeliveryDatabaseRow>();
  summary.selected = pending.results.length;
  for (const row of pending.results) {
    if (row.subject_user_id && row.product_analytics_enabled !== 1) {
      await env.TELEMETRY_PAYLOADS.delete(row.object_key).catch(() => undefined);
      await env.DB.prepare('DELETE FROM telemetry_crash_reports WHERE crash_id = ?')
        .bind(row.crash_id).run();
      summary.suppressed += 1;
      continue;
    }
    const delivery: GlobalCrashDeliveryRow = {
      crashId: row.crash_id,
      deviceId: row.installation_analytics_id,
      analyticsSubjectId: row.analytics_person_id ?? row.installation_analytics_id,
      workspaceAnalyticsId: row.analytics_workspace_id,
      processPersonProfile: row.subject_user_id !== null,
      receivedAt: row.received_at,
      release: row.release,
      buildId: row.build_id,
      platform: row.platform,
      architecture: row.architecture,
      processRole: row.process_role,
      launchId: row.launch_id,
      channel: row.channel,
      parserState: row.parser_state,
      fingerprint: row.issue_fingerprint,
      report: JSON.parse(row.structured_report_json) as unknown,
    };
    const { postHog: result } = await telemetryDeliveryRpcCall(() => telemetryDelivery.deliverCrashBatch({
      host: postHogHost,
      projectToken: postHogProjectToken,
      rows: [delivery],
    }));
    await recordDestinationOutcome(
      env,
      'posthog_crash',
      result.result === 'retry' ? 'retryable' : 'healthy',
      now,
    ).catch(() => undefined);
    if (result.result === 'delivered') {
      await env.DB.prepare(
        `UPDATE telemetry_crash_reports
         SET destination_state = 'delivered', destination_attempt_count = destination_attempt_count + 1,
             destination_delivered_at = ?, destination_next_attempt_at = NULL
         WHERE crash_id = ? AND destination_state IN ('pending', 'retrying')`,
      ).bind(now.toISOString(), row.crash_id).run();
      summary.delivered += 1;
    } else if (result.result === 'terminal') {
      await env.DB.prepare(
        `UPDATE telemetry_crash_reports
         SET destination_state = 'terminal', destination_attempt_count = destination_attempt_count + 1,
             destination_next_attempt_at = NULL
         WHERE crash_id = ? AND destination_state IN ('pending', 'retrying')`,
      ).bind(row.crash_id).run();
      summary.terminal += 1;
    } else {
      const delay = result.retryAfterMs
        ?? Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.min(row.destination_attempt_count, 6));
      const next = new Date(Math.min(Date.parse(row.delete_at), now.getTime() + delay));
      await env.DB.prepare(
        `UPDATE telemetry_crash_reports
         SET destination_state = 'retrying', destination_attempt_count = destination_attempt_count + 1,
             destination_next_attempt_at = ?
         WHERE crash_id = ? AND destination_state IN ('pending', 'retrying')`,
      ).bind(next.toISOString(), row.crash_id).run();
      summary.retried += 1;
    }
  }
  return summary;
}

export async function purgeIneligibleCrashReports(env: Env, subjectUserId?: string): Promise<number> {
  let purged = 0;
  let afterCrashId = '';
  for (let batch = 0; batch < MAINTENANCE_MAX_BATCHES; batch += 1) {
    const rows = await env.DB.prepare(
      `SELECT c.crash_id, c.object_key
       FROM telemetry_crash_reports c
       JOIN users u ON u.id = c.subject_user_id
       WHERE u.product_analytics_enabled = 0
         AND (? IS NULL OR c.subject_user_id = ?)
         AND c.crash_id > ?
       ORDER BY c.crash_id
       LIMIT ?`,
    ).bind(
      subjectUserId ?? null,
      subjectUserId ?? null,
      afterCrashId,
      MAINTENANCE_BATCH_SIZE,
    ).all<{ crash_id: string; object_key: string }>();
    if (rows.results.length === 0) break;
    for (const row of rows.results) {
      afterCrashId = row.crash_id;
      try {
        await env.TELEMETRY_PAYLOADS.delete(row.object_key);
        await env.DB.prepare('DELETE FROM telemetry_crash_reports WHERE crash_id = ?')
          .bind(row.crash_id).run();
        purged += 1;
      } catch {
        // Keep the index as the durable retry marker; deleting it first would
        // orphan a raw object past the user's opt-out. Advance this invocation
        // so one unavailable object cannot block every later report.
      }
    }
    if (rows.results.length < MAINTENANCE_BATCH_SIZE) break;
  }
  return purged;
}

export async function reapExpiredCrashReports(env: Env, now = new Date()): Promise<number> {
  let reaped = 0;
  let afterCrashId = '';
  for (let batch = 0; batch < MAINTENANCE_MAX_BATCHES; batch += 1) {
    const rows = await env.DB.prepare(
      `SELECT crash_id, object_key FROM telemetry_crash_reports
       WHERE delete_at <= ? AND crash_id > ?
       ORDER BY crash_id
       LIMIT ?`,
    ).bind(
      now.toISOString(),
      afterCrashId,
      MAINTENANCE_BATCH_SIZE,
    ).all<{ crash_id: string; object_key: string }>();
    if (rows.results.length === 0) break;
    for (const row of rows.results) {
      afterCrashId = row.crash_id;
      try {
        await env.TELEMETRY_PAYLOADS.delete(row.object_key);
        const deleted = await env.DB.prepare(
          'DELETE FROM telemetry_crash_reports WHERE crash_id = ? AND delete_at <= ?',
        ).bind(row.crash_id, now.toISOString()).run();
        reaped += Number(deleted.meta.changes ?? 0);
      } catch {
        // The D1 row remains the durable retry marker. Continue through this
        // bounded pass so one R2 failure cannot hide later expired objects.
      }
    }
    if (rows.results.length < MAINTENANCE_BATCH_SIZE) break;
  }
  return reaped;
}

/**
 * Raw crash objects carry their own absolute deletion deadline so a successful
 * R2 write followed by a failed D1 insert cannot escape the retention policy.
 * Missing or malformed deadlines fail closed: objects in this dedicated
 * prefix have no valid reason to live without one.
 */
export async function reapExpiredOrphanedCrashObjects(
  env: Env,
  now = new Date(),
): Promise<number> {
  const state = await env.DB.prepare(
    'SELECT cursor FROM telemetry_maintenance_state WHERE task = ?',
  ).bind(CRASH_OBJECT_RETENTION_TASK).first<{ cursor: string | null }>();
  let cursor = state?.cursor ?? undefined;
  let reaped = 0;
  for (let page = 0; page < MAINTENANCE_MAX_BATCHES; page += 1) {
    const listed = await env.TELEMETRY_PAYLOADS.list({
      prefix: `telemetry/crashes/${env.AVALON_REGION}/`,
      limit: MAINTENANCE_BATCH_SIZE,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listed.objects) {
      const deadline = object.customMetadata?.deleteAfter;
      const deadlineMs = deadline === undefined ? Number.NaN : Date.parse(deadline);
      if (Number.isFinite(deadlineMs) && deadlineMs > now.getTime()) continue;
      await env.TELEMETRY_PAYLOADS.delete(object.key);
      reaped += 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) throw new Error('telemetry_r2_cursor_missing');
    await env.DB.prepare(
      `INSERT INTO telemetry_maintenance_state (task, cursor, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(task) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).bind(CRASH_OBJECT_RETENTION_TASK, cursor ?? null, now.toISOString()).run();
    if (!listed.truncated) break;
  }
  return reaped;
}

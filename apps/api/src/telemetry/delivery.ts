import { TelemetryEnvelopeSchema, type TelemetryEnvelope } from "@rally/contracts/telemetry";
import type { Env } from "../env";
import {
  telemetryDeliveryRpcCall,
  type GlobalTelemetryDeliveryRow,
  type TelemetryDestinationResult,
} from "./telemetry-delivery-contract";
import { processProfileOutbox } from "./profile-delivery";
import { symbolicateJavascriptFrames } from "./javascript-symbolication";
import { destinationCircuitAllows, recordDestinationOutcome } from "./operations";

export interface TelemetryDeliverySummary {
  selected: number;
  delivered: number;
  retried: number;
  terminal: number;
  suppressed: number;
  expired: number;
}

interface DeliveryDatabaseRow {
  event_id: string;
  envelope_json: string;
  analytics_subject_id: string;
  workspace_analytics_id: string | null;
  normalized_timestamp: string;
  attempt_count: number;
  delete_at: string;
  subject_user_id: string | null;
  product_analytics_enabled: number | null;
}

async function reapExpiredTelemetry(env: Env, now: string): Promise<number> {
  const tables = [
    "telemetry_accepted_events",
    "telemetry_delivery_receipts",
    "telemetry_crash_access_audit",
    "telemetry_eu_crash_contributions",
    "telemetry_eu_events",
    "telemetry_identity_links",
    "telemetry_ingest_rate_buckets",
    "telemetry_onboarding_journeys",
    "telemetry_profile_jobs",
    "telemetry_rejection_buckets",
    "telemetry_replay_audit",
  ] as const;
  let expired = 0;
  for (const table of tables) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE delete_at <= ?`,
    ).bind(now).first<{ count: number }>();
    expired += row?.count ?? 0;
    await env.DB.prepare(`DELETE FROM ${table} WHERE delete_at <= ?`).bind(now).run();
  }
  return expired;
}

function deliveryRow(row: DeliveryDatabaseRow): GlobalTelemetryDeliveryRow {
  return {
    eventId: row.event_id,
    envelope: TelemetryEnvelopeSchema.parse(JSON.parse(row.envelope_json)) as TelemetryEnvelope,
    analyticsSubjectId: row.analytics_subject_id,
    workspaceAnalyticsId: row.workspace_analytics_id,
    normalizedTimestamp: row.normalized_timestamp,
  };
}

async function javascriptDeliveryRow(
  env: Env,
  row: DeliveryDatabaseRow,
): Promise<GlobalTelemetryDeliveryRow> {
  const delivery = deliveryRow(row);
  if (delivery.envelope.name !== "javascript_exception") return delivery;
  const properties = delivery.envelope.properties as {
    process: "main" | "preload" | "renderer";
    generatedFrames: string[];
  };
  return {
    ...delivery,
    symbolicatedFrames: await symbolicateJavascriptFrames(env.TELEMETRY_PAYLOADS, {
      release: delivery.envelope.context.release,
      buildId: delivery.envelope.context.buildId,
      process: properties.process,
      generatedFrames: properties.generatedFrames,
    }),
  };
}

function backoffMs(attemptCount: number): number {
  return Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.min(attemptCount, 6));
}

export async function processTelemetryOutbox(env: Env): Promise<TelemetryDeliverySummary> {
  const now = new Date();
  const summary: TelemetryDeliverySummary = {
    selected: 0,
    delivered: 0,
    retried: 0,
    terminal: 0,
    suppressed: 0,
    expired: await reapExpiredTelemetry(env, now.toISOString()),
  };
  const telemetryDelivery = env.TELEMETRY_DELIVERY;
  const postHogHost = env.POSTHOG_HOST;
  const postHogProjectToken = env.POSTHOG_PROJECT_TOKEN;
  if (env.AVALON_REGION !== "global"
    || !postHogHost
    || !postHogProjectToken
    || !telemetryDelivery) return summary;
  await processProfileOutbox(env);
  const [captureAllowed, exceptionAllowed] = await Promise.all([
    destinationCircuitAllows(env, "posthog_capture", now),
    destinationCircuitAllows(env, "posthog_javascript_exception", now),
  ]);
  if (!captureAllowed && !exceptionAllowed) return summary;

  const pending = await env.DB.prepare(
    `SELECT e.event_id, e.envelope_json, e.analytics_subject_id, e.workspace_analytics_id,
            e.normalized_timestamp, e.attempt_count, e.delete_at, e.subject_user_id,
            u.product_analytics_enabled
     FROM telemetry_accepted_events e
     LEFT JOIN users u ON u.id = e.subject_user_id
     WHERE e.route = 'global'
       AND e.delivery_state IN ('pending', 'retrying')
       AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?)
       AND e.delete_at > ?
       AND (e.subject_user_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM telemetry_profile_jobs transition
         WHERE transition.subject_user_id = e.subject_user_id
           AND transition.job_kind = 'epoch_transition'
           AND transition.state IN ('pending', 'delivering')
       ))
     ORDER BY e.accepted_at
     LIMIT 50`,
  ).bind(now.toISOString(), now.toISOString()).all<DeliveryDatabaseRow>();

  const eligible: DeliveryDatabaseRow[] = [];
  for (const row of pending.results) {
    const parsed = TelemetryEnvelopeSchema.parse(JSON.parse(row.envelope_json)) as TelemetryEnvelope;
    const attributableNonessential = row.subject_user_id !== null && parsed.category !== "essential";
    if (attributableNonessential && row.product_analytics_enabled !== 1) {
      await env.DB.prepare(
        "DELETE FROM telemetry_accepted_events WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')",
      ).bind(row.event_id).run();
      summary.suppressed += 1;
    } else {
      eligible.push(row);
    }
  }
  const exceptionCandidates = eligible.filter((row) => (
    TelemetryEnvelopeSchema.parse(JSON.parse(row.envelope_json)) as TelemetryEnvelope
  ).name === "javascript_exception");
  const ordinaryCandidates = eligible.filter((row) => !exceptionCandidates.includes(row));
  const ordinary = captureAllowed ? ordinaryCandidates : [];
  const exceptions = exceptionAllowed ? exceptionCandidates : [];
  summary.selected = ordinary.length + exceptions.length;
  if (summary.selected === 0) return summary;
  const exceptionDeliveries = await Promise.all(
    exceptions.map((row) => javascriptDeliveryRow(env, row)),
  );
  for (const [rows, result, destination] of await Promise.all([
    ordinary.length > 0
      ? telemetryDeliveryRpcCall(() => telemetryDelivery.deliverTelemetryBatch({
        host: postHogHost,
        projectToken: postHogProjectToken,
        webBaseUrl: env.PUBLIC_WEB_BASE_URL,
        rows: ordinary.map(deliveryRow),
      })).then(({ postHog }) => [ordinary, postHog, "posthog_capture"] as const)
      : Promise.resolve([ordinary, null, "posthog_capture"] as const),
    exceptions.length > 0
      ? telemetryDeliveryRpcCall(() => telemetryDelivery.deliverJavascriptExceptionBatch({
        host: postHogHost,
        projectToken: postHogProjectToken,
        rows: exceptionDeliveries,
      })).then(({ postHog }) => [exceptions, postHog, "posthog_javascript_exception"] as const)
      : Promise.resolve([exceptions, null, "posthog_javascript_exception"] as const),
  ])) {
    if (result) {
      await applyDestinationResult(env, rows, result, now, summary);
      await recordDestinationOutcome(
        env,
        destination,
        result.result === "retry" ? "retryable" : "healthy",
        now,
      ).catch(() => undefined);
    }
  }
  return summary;
}

async function applyDestinationResult(
  env: Env,
  rows: DeliveryDatabaseRow[],
  result: TelemetryDestinationResult,
  now: Date,
  summary: TelemetryDeliverySummary,
): Promise<void> {
  if (result.result === "delivered") {
    await env.DB.batch(rows.map((row) => env.DB.prepare(
      `UPDATE telemetry_accepted_events
       SET delivery_state = 'delivered', delivered_at = ?, attempt_count = attempt_count + 1,
           next_attempt_at = NULL, terminal_code = NULL
       WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
    ).bind(now.toISOString(), row.event_id)));
    summary.delivered += rows.length;
    return;
  }
  if (result.result === "terminal") {
    await env.DB.batch(rows.map((row) => env.DB.prepare(
      `UPDATE telemetry_accepted_events
       SET delivery_state = 'terminal', attempt_count = attempt_count + 1,
           next_attempt_at = NULL, terminal_code = 'destination_rejected'
       WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
    ).bind(row.event_id)));
    summary.terminal += rows.length;
    return;
  }

  await env.DB.batch(rows.map((row) => {
    const delay = result.retryAfterMs ?? backoffMs(row.attempt_count);
    const next = new Date(Math.min(Date.parse(row.delete_at), now.getTime() + delay));
    return env.DB.prepare(
      `UPDATE telemetry_accepted_events
       SET delivery_state = 'retrying', attempt_count = attempt_count + 1,
           next_attempt_at = ?, terminal_code = NULL
       WHERE event_id = ? AND delivery_state IN ('pending', 'retrying')`,
    ).bind(next.toISOString(), row.event_id);
  }));
  summary.retried += rows.length;
}

import {
  TELEMETRY_EVENTS,
  TelemetryEnvelopeSchema,
  type TelemetryEnvelope,
} from "@avalon/contracts/telemetry";
import { z } from "zod";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";

export const ANALYTICS_LAKEHOUSE_QUEUE_NAMES = new Set([
  "avalon-global-analytics-events-lakehouse",
]);

export const AnalyticsLakehousePointerSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  payloadHash: z.string().min(1),
  region: z.literal("global"),
}).strict();

export type AnalyticsLakehousePointer = z.infer<typeof AnalyticsLakehousePointerSchema>;

export interface AnalyticsLakehouseRecord {
  [key: string]: unknown;
  schema_version: 1;
  event_id: string;
  event_name: string;
  event_schema_version: number;
  context_schema_version: number;
  payload_hash: string;
  event_definition: string;
  product_question: string;
  owner: string;
  review_group: string;
  authoritative_source: string;
  priority: string;
  sample_rate: number;
  regional_retention: string;
  destination: string;
  source: string;
  category: string;
  identity_scope: string;
  route: "global";
  routing_basis: string;
  accepted_at: string;
  normalized_timestamp: string;
  acceptance_delete_at: string;
  original_timestamp: string;
  sent_at: string;
  analytics_subject_id: string;
  workspace_analytics_id?: string;
  environment: string;
  release: string;
  build_id: string;
  platform?: string;
  architecture?: string;
  channel?: string;
  launch_id?: string;
  session_id?: string;
  onboarding_journey_id?: string;
  operation_id?: string;
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  device_id?: string;
  window_id?: string;
  os_version?: string;
  locale?: string;
  timezone?: string;
  screen_width?: number;
  screen_height?: number;
  viewport_width?: number;
  viewport_height?: number;
  property_classifications: Record<string, unknown>;
  context: Record<string, unknown>;
  properties: Record<string, unknown>;
}

interface AcceptedAnalyticsRow {
  event_id: string;
  payload_hash: string;
  envelope_json: string;
  route: "global" | "eu";
  routing_basis: string;
  analytics_subject_id: string;
  workspace_analytics_id: string | null;
  accepted_at: string;
  normalized_timestamp: string;
  delete_at: string;
  subject_user_id: string | null;
  product_analytics_enabled: number | null;
}

export type AnalyticsLakehouseDeliveryResult =
  | { outcome: "delivered"; record: AnalyticsLakehouseRecord }
  | { outcome: "expired" | "suppressed" };

export function isAnalyticsLakehouseQueue(queue: string): boolean {
  return ANALYTICS_LAKEHOUSE_QUEUE_NAMES.has(queue);
}

export function analyticsLakehousePointer(eventId: string, payloadHash: string): AnalyticsLakehousePointer {
  return AnalyticsLakehousePointerSchema.parse({
    schemaVersion: 1,
    eventId,
    payloadHash,
    region: "global",
  });
}

function recordFromRow(row: AcceptedAnalyticsRow, envelope: TelemetryEnvelope): AnalyticsLakehouseRecord {
  const context = envelope.context;
  const registry = TELEMETRY_EVENTS[envelope.name as keyof typeof TELEMETRY_EVENTS];
  return {
    schema_version: 1,
    event_id: row.event_id,
    event_name: envelope.name,
    event_schema_version: envelope.schemaVersion,
    context_schema_version: "contextSchemaVersion" in envelope ? envelope.contextSchemaVersion : 1,
    payload_hash: row.payload_hash,
    event_definition: registry.definition,
    product_question: registry.productQuestion,
    owner: registry.owner,
    review_group: registry.reviewGroup,
    authoritative_source: registry.authoritativeSource,
    priority: registry.priority,
    sample_rate: registry.sampleRate,
    regional_retention: registry.regionalRetention,
    destination: registry.destination,
    source: envelope.source,
    category: envelope.category,
    identity_scope: envelope.identityScope,
    route: "global",
    routing_basis: row.routing_basis,
    accepted_at: row.accepted_at,
    normalized_timestamp: row.normalized_timestamp,
    acceptance_delete_at: row.delete_at,
    original_timestamp: envelope.originalTimestamp,
    sent_at: envelope.sentAt,
    analytics_subject_id: row.analytics_subject_id,
    ...(row.workspace_analytics_id ? { workspace_analytics_id: row.workspace_analytics_id } : {}),
    environment: context.environment,
    release: context.release,
    build_id: context.buildId,
    ...(context.platform ? { platform: context.platform } : {}),
    ...(context.arch ? { architecture: context.arch } : {}),
    ...(context.channel ? { channel: context.channel } : {}),
    ...(context.launchId ? { launch_id: context.launchId } : {}),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
    ...(context.onboardingJourneyId ? { onboarding_journey_id: context.onboardingJourneyId } : {}),
    ...(context.operationId ? { operation_id: context.operationId } : {}),
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    ...(context.spanId ? { span_id: context.spanId } : {}),
    ...(context.deviceId ? { device_id: context.deviceId } : {}),
    ...(context.windowId ? { window_id: context.windowId } : {}),
    ...(context.osVersion ? { os_version: context.osVersion } : {}),
    ...(context.locale ? { locale: context.locale } : {}),
    ...(context.timezone ? { timezone: context.timezone } : {}),
    ...(context.screenWidth ? { screen_width: context.screenWidth } : {}),
    ...(context.screenHeight ? { screen_height: context.screenHeight } : {}),
    ...(context.viewportWidth ? { viewport_width: context.viewportWidth } : {}),
    ...(context.viewportHeight ? { viewport_height: context.viewportHeight } : {}),
    property_classifications: registry.propertyClassifications,
    context,
    properties: envelope.properties,
  };
}

export async function enqueueAnalyticsLakehousePointer(
  env: Pick<Env, "AVALON_REGION" | "ANALYTICS_LAKEHOUSE_QUEUE" | "DB" | "LOG_LEVEL" | "APP_VERSION" | "BUILD_SHA">,
  eventId: string,
  payloadHash: string,
): Promise<boolean> {
  if (env.AVALON_REGION !== "global" || !env.ANALYTICS_LAKEHOUSE_QUEUE) return false;
  try {
    await env.ANALYTICS_LAKEHOUSE_QUEUE.send(analyticsLakehousePointer(eventId, payloadHash));
    await env.DB.prepare(
      `UPDATE telemetry_accepted_events
       SET analytics_lakehouse_state = 'queued'
       WHERE event_id = ? AND payload_hash = ? AND route = 'global'
         AND analytics_lakehouse_state = 'pending'`,
    ).bind(eventId, payloadHash).run();
    return true;
  } catch (error) {
    logStructuredEvent(env, "warn", "analytics_lakehouse_enqueue_failed", {
      event_id: eventId,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function recoverPendingAnalyticsLakehouseEvents(env: Env): Promise<number> {
  if (env.AVALON_REGION !== "global" || !env.ANALYTICS_LAKEHOUSE_QUEUE) return 0;
  // Fifty is the established telemetry outbox quantum and the maximum accepted
  // client batch, so recovery cannot create a larger burst than normal ingest.
  const rows = await env.DB.prepare(
    `SELECT event_id, payload_hash
     FROM telemetry_accepted_events
     WHERE route = 'global' AND analytics_lakehouse_state = 'pending' AND delete_at > ?
     ORDER BY accepted_at
     LIMIT 50`,
  ).bind(new Date().toISOString()).all<{ event_id: string; payload_hash: string }>();
  let queued = 0;
  for (const row of rows.results) {
    if (await enqueueAnalyticsLakehousePointer(env, row.event_id, row.payload_hash)) queued += 1;
  }
  return queued;
}

export async function deliverAnalyticsLakehousePointer(
  env: Pick<Env, "AVALON_REGION" | "ANALYTICS_LAKEHOUSE" | "DB">,
  body: unknown,
): Promise<AnalyticsLakehouseDeliveryResult> {
  const pointer = AnalyticsLakehousePointerSchema.parse(body);
  if (env.AVALON_REGION !== "global") {
    throw new Error(`analytics_lakehouse_pointer_misrouted:global:${env.AVALON_REGION}`);
  }
  if (!env.ANALYTICS_LAKEHOUSE) throw new Error("analytics_lakehouse_pipeline_binding_missing");
  const row = await env.DB.prepare(
    `SELECT event_id, payload_hash, envelope_json, route, routing_basis,
            e.analytics_subject_id, e.workspace_analytics_id, e.accepted_at,
            e.normalized_timestamp, e.delete_at, e.subject_user_id,
            u.product_analytics_enabled
     FROM telemetry_accepted_events e
     LEFT JOIN users u ON u.id = e.subject_user_id
     WHERE e.event_id = ?`,
  ).bind(pointer.eventId).first<AcceptedAnalyticsRow>();
  if (!row) return { outcome: "expired" };
  if (row.route !== "global" || row.payload_hash !== pointer.payloadHash) {
    throw new Error(`analytics_lakehouse_payload_integrity_failed:${pointer.eventId}`);
  }
  const envelope = TelemetryEnvelopeSchema.parse(JSON.parse(row.envelope_json)) as TelemetryEnvelope;
  if (row.subject_user_id !== null
    && envelope.category !== "essential"
    && row.product_analytics_enabled !== 1) {
    await env.DB.prepare(
      `UPDATE telemetry_accepted_events
       SET analytics_lakehouse_state = 'suppressed'
       WHERE event_id = ? AND payload_hash = ? AND route = 'global'`,
    ).bind(pointer.eventId, pointer.payloadHash).run();
    return { outcome: "suppressed" };
  }
  const record = recordFromRow(row, envelope);
  await env.ANALYTICS_LAKEHOUSE.send([record]);
  await env.DB.prepare(
    `UPDATE telemetry_accepted_events
     SET analytics_lakehouse_state = 'delivered', analytics_lakehouse_delivered_at = ?
     WHERE event_id = ? AND payload_hash = ? AND route = 'global'`,
  ).bind(new Date().toISOString(), pointer.eventId, pointer.payloadHash).run();
  return { outcome: "delivered", record };
}

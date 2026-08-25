import {
  TELEMETRY_EVENTS,
  TelemetryEnvelopeSchema,
  type TelemetryEnvelope,
} from "@avalon/contracts/telemetry";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { enqueueAnalyticsLakehousePointer } from "../services/analytics-lakehouse";

export type TelemetryRoutingBasis =
  | "explicit_binding"
  | "explicit_selection"
  | "ip_geolocation"
  | "geolocation_fallback";

export interface TelemetryAcceptanceContext {
  route: "global" | "eu";
  routingBasis: TelemetryRoutingBasis;
  analyticsSubjectId: string;
  subjectUserId: string | null;
  workspaceAnalyticsId: string | null;
}

export type TelemetryAcceptanceResult = {
  result: "accepted" | "duplicate" | "conflict" | "suppressed" | "route_mismatch";
  eventId: string;
};

const ACCEPTED_RETENTION_DAYS = 90;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalTelemetryJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

function addMonths(value: Date, months: number): string {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString();
}

function normalizedTimestamp(event: TelemetryEnvelope, receivedAt: Date): string {
  const original = Date.parse(event.originalTimestamp);
  const sent = Date.parse(event.sentAt);
  const offset = receivedAt.getTime() - sent;
  const candidate = original + offset;
  const replayFloor = receivedAt.getTime() - ACCEPTED_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  return new Date(Math.min(receivedAt.getTime(), Math.max(replayFloor, candidate))).toISOString();
}

async function preferenceAllows(env: Env, event: TelemetryEnvelope, userId: string | null): Promise<boolean> {
  if (event.category === "essential" || userId === null) return true;
  const row = await env.DB.prepare(
    "SELECT product_analytics_enabled FROM users WHERE id = ?",
  ).bind(userId).first<{ product_analytics_enabled: number }>();
  return row?.product_analytics_enabled === 1;
}

export class TelemetryCollector {
  constructor(private readonly env: Env) {}

  async accept(
    candidate: TelemetryEnvelope,
    context: TelemetryAcceptanceContext,
  ): Promise<TelemetryAcceptanceResult> {
    const parsed = TelemetryEnvelopeSchema.parse(candidate);
    const event = parsed as TelemetryEnvelope;
    if (context.route !== this.env.AVALON_REGION) {
      return { result: "route_mismatch", eventId: event.eventId };
    }
    if (!await preferenceAllows(this.env, event, context.subjectUserId)) {
      return { result: "suppressed", eventId: event.eventId };
    }

    const envelopeJson = canonicalTelemetryJson(event);
    const payloadHash = await sha256(canonicalTelemetryJson({
      envelope: event,
      route: context.route,
      analyticsSubjectId: context.analyticsSubjectId,
      subjectUserId: context.subjectUserId,
      workspaceAnalyticsId: context.workspaceAnalyticsId,
    }));
    const existing = await this.env.DB.prepare(
      "SELECT payload_hash FROM telemetry_accepted_events WHERE event_id = ?",
    ).bind(event.eventId).first<{ payload_hash: string }>();
    if (existing) {
      return {
        result: existing.payload_hash === payloadHash ? "duplicate" : "conflict",
        eventId: event.eventId,
      };
    }

    const acceptedAt = new Date();
    const acceptedDeadline = addDays(acceptedAt, ACCEPTED_RETENTION_DAYS);
    const occurrenceTimestamp = normalizedTimestamp(event, acceptedAt);
    const isEu = context.route === "eu";
    const registry = TELEMETRY_EVENTS[event.name as keyof typeof TELEMETRY_EVENTS];
    const regionalDeadline = registry.regionalRetention === "13-months"
      ? addMonths(new Date(occurrenceTimestamp), 13)
      : acceptedDeadline;
    const statements = [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO telemetry_accepted_events
          (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id,
           workspace_analytics_id, subject_user_id,
           accepted_at, normalized_timestamp, delete_at, delivery_state, terminal_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.eventId,
        payloadHash,
        envelopeJson,
        context.route,
        context.routingBasis,
        context.analyticsSubjectId,
        context.workspaceAnalyticsId,
        context.subjectUserId,
        acceptedAt.toISOString(),
        occurrenceTimestamp,
        acceptedDeadline,
        isEu ? "terminal" : "pending",
        isEu ? "eu_internal" : null,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO telemetry_delivery_receipts
          (event_id, payload_hash, route, result_code, created_at, delete_at)
         VALUES (?, ?, ?, 'accepted', ?, ?)`,
      ).bind(
        event.eventId,
        payloadHash,
        context.route,
        acceptedAt.toISOString(),
        acceptedDeadline,
      ),
    ];
    if (isEu) {
      statements.push(this.env.DB.prepare(
        `INSERT OR IGNORE INTO telemetry_eu_events
          (event_id, event_name, schema_version, identity_scope, analytics_subject_id,
           workspace_analytics_id, normalized_timestamp, environment, release, build_id,
           platform, architecture, channel, launch_id, session_id, operation_id,
           properties_json, delete_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM telemetry_accepted_events WHERE event_id = ? AND payload_hash = ?
         )`,
      ).bind(
        event.eventId,
        event.name,
        event.schemaVersion,
        event.identityScope,
        context.analyticsSubjectId,
        context.workspaceAnalyticsId,
        occurrenceTimestamp,
        event.context.environment,
        event.context.release,
        event.context.buildId,
        event.context.platform ?? null,
        event.context.arch ?? null,
        event.context.channel ?? null,
        event.context.launchId ?? null,
        event.context.sessionId ?? null,
        event.context.operationId ?? null,
        canonicalTelemetryJson(event.properties),
        regionalDeadline,
        event.eventId,
        payloadHash,
      ));
    }
    await this.env.DB.batch(statements);

    const stored = await this.env.DB.prepare(
      "SELECT payload_hash FROM telemetry_accepted_events WHERE event_id = ?",
    ).bind(event.eventId).first<{ payload_hash: string }>();
    const result = stored?.payload_hash === payloadHash ? "accepted" : "conflict";
    if (result === "accepted" && !isEu) {
      // D1 is the durable acceptance/outbox boundary. Queue availability must
      // never change the product request's result; a scheduled recovery pass
      // retries rows that remain pending.
      await enqueueAnalyticsLakehousePointer(this.env, event.eventId, payloadHash);
    }
    return {
      result,
      eventId: event.eventId,
    };
  }
}

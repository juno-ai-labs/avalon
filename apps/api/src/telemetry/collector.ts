import type { Region } from "@rally/contracts/regions";
import {
  TelemetryEnvelopeSchema,
  isRetiredMeetingTelemetry,
  type TelemetryEnvelope,
} from "@rally/contracts/telemetry";
import type { Env } from "../env";
import { enqueueAnalyticsLakehousePointer } from "../services/analytics-lakehouse";
import { canonicalTelemetryJson, telemetryPayloadHash } from "./payload-integrity";

export type TelemetryRoutingBasis =
  | "explicit_binding"
  | "explicit_selection"
  | "ip_geolocation"
  | "geolocation_fallback";

export interface TelemetryAcceptanceContext {
  route: Region;
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

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
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
    if (isRetiredMeetingTelemetry(event)) return { result: "suppressed", eventId: event.eventId };
    if (context.route !== this.env.AVALON_REGION) {
      return { result: "route_mismatch", eventId: event.eventId };
    }
    if (!await preferenceAllows(this.env, event, context.subjectUserId)) {
      return { result: "suppressed", eventId: event.eventId };
    }

    const envelopeJson = canonicalTelemetryJson(event);
    const payloadHash = await telemetryPayloadHash(event, context);
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
        "pending",
        null,
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
    await this.env.DB.batch(statements);

    const stored = await this.env.DB.prepare(
      "SELECT payload_hash FROM telemetry_accepted_events WHERE event_id = ?",
    ).bind(event.eventId).first<{ payload_hash: string }>();
    const result = stored?.payload_hash === payloadHash ? "accepted" : "conflict";
    if (result === "accepted") {
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

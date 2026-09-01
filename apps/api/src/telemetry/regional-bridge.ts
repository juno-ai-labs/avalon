import { IdSchema } from '@rally/contracts';
import { TelemetryEnvelopeSchema, type TelemetryEnvelope } from "@rally/contracts/telemetry";
import { z } from "zod";
import { TelemetryCollector, type TelemetryAcceptanceResult } from "./collector";
import type { Env } from "../env";
import { ensurePersonAnalyticsId, ensureWorkspaceAnalyticsId } from './authenticated';

const AnonymousTelemetryProjectionSchema = z.strictObject({
  event: TelemetryEnvelopeSchema,
  route: z.literal("eu"),
  routingBasis: z.enum(["ip_geolocation", "geolocation_fallback"]),
  analyticsSubjectId: z.string().uuid(),
  subjectUserId: z.null(),
  workspaceAnalyticsId: z.null(),
});

export interface AnonymousTelemetryProjection {
  event: TelemetryEnvelope;
  route: "global" | "eu";
  routingBasis: "ip_geolocation" | "geolocation_fallback";
  analyticsSubjectId: string;
  subjectUserId: null;
  workspaceAnalyticsId: null;
}

export interface RegionalTelemetryBridgeRpcBinding {
  acceptAnonymous(input: unknown): Promise<TelemetryAcceptanceResult>;
  acceptApiOutcome(input: unknown): Promise<TelemetryAcceptanceResult>;
}

const ApiOutcomeProjectionSchema = z.strictObject({
  event: TelemetryEnvelopeSchema,
  route: z.literal('eu'),
  subjectUserId: IdSchema,
  workspaceId: IdSchema.nullable(),
});

export async function acceptAnonymousTelemetryProjection(
  env: Env,
  input: unknown,
): Promise<TelemetryAcceptanceResult> {
  const parsed = AnonymousTelemetryProjectionSchema.parse(input);
  return new TelemetryCollector(env).accept(parsed.event as TelemetryEnvelope, parsed);
}

export async function acceptApiOutcomeProjection(
  env: Env,
  input: unknown,
): Promise<TelemetryAcceptanceResult> {
  const parsed = ApiOutcomeProjectionSchema.parse(input);
  if (parsed.event.source !== 'api' || parsed.event.context.region !== 'eu') {
    throw new Error('telemetry_api_projection_forbidden');
  }
  const personAnalyticsId = await ensurePersonAnalyticsId(env, parsed.subjectUserId);
  const workspaceAnalyticsId = parsed.workspaceId && parsed.event.identityScope === 'workspace-user'
    ? await ensureWorkspaceAnalyticsId(env, parsed.workspaceId)
    : null;
  return new TelemetryCollector(env).accept(parsed.event as TelemetryEnvelope, {
    route: 'eu',
    routingBasis: 'explicit_selection',
    analyticsSubjectId: personAnalyticsId,
    subjectUserId: parsed.subjectUserId,
    workspaceAnalyticsId,
  });
}
